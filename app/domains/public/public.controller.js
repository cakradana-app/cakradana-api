/**
 * Building and serving the published dataset.
 *
 * The materialiser is the only writer, and the endpoints read nothing else.
 * That separation is the requirement: a public endpoint that filters the
 * operational store is one filter bug away from publishing risk scores about
 * named people, and no amount of care in the filter makes that acceptable when
 * the alternative costs a scheduled job.
 */

const {
    Donation,
    Entity,
} = require('../canonical/canonical.model');
const {
    PublicAggregate,
    PublicAggregateStaging,
    PublicDatasetBuild,
    BUILDING_COLLECTION,
    MIN_DONORS_PER_CELL,
    AMOUNT_ROUNDING_IDR,
} = require('./public.model');
const { log } = require('../../utils/observability/logging');

function refuse(res, message) {
    return res.status(400).json({ status: 'error', message, data: {} });
}

/** Quarter of the year a date falls in, which is the coarsest useful period. */
function periodOf(date) {
    const d = new Date(date);
    return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/**
 * Whether a period has ended.
 *
 * Only closed quarters are published, and this is most of the defence against
 * differencing. The threshold and the rounding are applied within one release;
 * neither says anything about two. An observer polling this endpoint across
 * releases of an open quarter watches cells grow, and a cell that gains one
 * donor and Rp250,000,000 between Tuesday and Wednesday has disclosed one
 * person's donation to the rupiah, tied to a named recipient — which is the
 * leak the suppression threshold exists to prevent, arrived at by subtraction.
 * A closed quarter has no new donations to add.
 */
function periodIsClosed(period, now) {
    return period < periodOf(now);
}

function round(amount) {
    return Math.round(amount / AMOUNT_ROUNDING_IDR) * AMOUNT_ROUNDING_IDR;
}

/**
 * Rebuild the published dataset from canonical records.
 *
 * Suppressed cells are written rather than omitted. A cell that simply vanishes
 * reads as an absence of donations; one marked suppressed reads as what it is,
 * which is an absence of publishable detail.
 *
 * The rebuild is assembled somewhere else and swapped in, rather than written
 * over the live dataset. Building in place meant `deleteMany` followed by
 * `insertMany`, and between those two calls the published dataset was empty —
 * so a build that failed there, or a process that restarted there, left
 * `/public/aggregates` answering with no cells at all until the next day's run.
 * By this collection's own reasoning an empty cell list reads as an absence of
 * donations, which is precisely the claim it must never make by accident. The
 * window also opened on every successful build, briefly, for no reason.
 *
 * The swap is a rename with `dropTarget`, which is a catalogue operation: a
 * reader sees the whole previous dataset or the whole new one, never a
 * half-written mixture. A transaction would express the same thing more
 * directly and is not available — transactions need a replica set, and this
 * deployment is a single MongoDB process, which is the same fact the recovery
 * objectives in `canonical/resilience.js` are written around. A single rename
 * is the widest atomic unit there is here.
 *
 * A rebuild that comes out empty against a dataset that is not is refused
 * rather than published. Every publishable cell disappearing at once is far
 * more likely to be an upstream failure — resolution stopped, the donation
 * query returned nothing — than a real collapse in political donations, and
 * publishing it is not reversible in the way that matters.
 */
async function materialise({ now = new Date(), allowEmpty = false } = {}) {
    const donations = await Donation.find({ supersededBy: null })
        .select('receiverRef senderRef amountIdr occurredAt electoralContext')
        .lean();

    const entities = await Entity.find({}).select('canonicalName entityType').lean();
    const byId = new Map(entities.map((e) => [String(e._id), e]));

    const cells = new Map();
    for (const donation of donations) {
        const receiver = donation.receiverRef?.entityId
            ? byId.get(String(donation.receiverRef.entityId))
            : null;
        // Unresolved recipients are not published at all. An aggregate keyed on
        // raw text would publish whatever a scanner happened to read, including
        // a misspelling of somebody's name.
        if (!receiver) continue;

        const period = periodOf(donation.occurredAt);
        // The quarter in progress is not published at all. Its figures change
        // with every donation admitted, and publishing the sequence is
        // publishing the donations.
        if (!periodIsClosed(period, now)) continue;
        const key = `${receiver.canonicalName}|${donation.electoralContext || ''}|${period}`;
        const cell = cells.get(key) || {
            recipientName: receiver.canonicalName,
            recipientType: receiver.entityType,
            electoralContext: donation.electoralContext || null,
            period,
            donors: new Set(),
            donationCount: 0,
            totalIdr: 0,
        };
        if (donation.senderRef?.entityId) cell.donors.add(String(donation.senderRef.entityId));
        cell.donationCount += 1;
        cell.totalIdr += donation.amountIdr;
        cells.set(key, cell);
    }

    // What has already been published, so it can be carried forward unchanged.
    // A figure published once is frozen: republishing a revised one is a second
    // observation of the same cell, and the difference between the two is
    // exactly what an observer differences. A closed quarter's figures should
    // not move anyway — when they do it is a correction, and a correction
    // released silently is indistinguishable from the leak.
    const published = new Map(
        (await PublicAggregate.find({ firstPublishedAt: { $ne: null } }).lean()).map(
            (cell) => [
                `${cell.recipientName}|${cell.electoralContext || ''}|${cell.period}`,
                cell,
            ],
        ),
    );

    const documents = [...cells.values()].map((cell) => {
        const donorCount = cell.donors.size;
        const suppressed = donorCount < MIN_DONORS_PER_CELL;
        const key = `${cell.recipientName}|${cell.electoralContext || ''}|${cell.period}`;
        const already = published.get(key);
        if (already) {
            const moved =
                already.donorCount !== (suppressed ? 0 : donorCount) ||
                already.donationCount !== (suppressed ? 0 : cell.donationCount) ||
                already.totalIdr !== (suppressed ? 0 : round(cell.totalIdr)) ||
                already.suppressed !== suppressed;
            return {
                ...already,
                _id: undefined,
                materialisedAt: now,
                revisionPending: moved,
                revisionNote: moved
                    ? 'the records behind this cell have changed since it was ' +
                      'published; the published figures are unchanged because ' +
                      'releasing a revision discloses the difference between the two'
                    : null,
            };
        }
        return {
            recipientName: cell.recipientName,
            recipientType: cell.recipientType,
            electoralContext: cell.electoralContext,
            period: cell.period,
            // Suppressed cells publish neither the total nor the counts. The
            // count alone is enough to identify a donor by differencing when
            // one large donation is already known.
            donorCount: suppressed ? 0 : donorCount,
            donationCount: suppressed ? 0 : cell.donationCount,
            totalIdr: suppressed ? 0 : round(cell.totalIdr),
            suppressed,
            suppressionReason: suppressed
                ? `fewer than ${MIN_DONORS_PER_CELL} distinct donors; publishing would ` +
                  'identify them by arithmetic against any known donation'
                : null,
            materialisedAt: now,
            // Suppressed here too, which it was not. It is provenance — how
            // many records the cell was built from — and for a suppressed cell
            // that is the number suppression exists to withhold, stored under a
            // different name in the collection described as the published
            // dataset. No endpoint served it, so nothing leaked; but the whole
            // design rests on this collection containing only what may be
            // published, so that nobody has to remember which of its fields are
            // safe when the next endpoint is written.
            sourceRecords: suppressed ? 0 : cell.donationCount,
            firstPublishedAt: now,
            revisionPending: false,
            revisionNote: null,
        };
    });

    // Replaced wholesale rather than upserted. An incremental build that misses
    // a deletion leaves a published figure for a record that has since been
    // corrected or withdrawn.
    await swapIn(documents, { allowEmpty });

    const report = {
        cells: documents.length,
        published: documents.filter((d) => !d.suppressed).length,
        suppressed: documents.filter((d) => d.suppressed).length,
        sourceRecords: donations.length,
        materialisedAt: now,
    };

    log.info('public dataset materialised', {
        cells: report.cells,
        suppressed: report.suppressed,
        source_records: report.sourceRecords,
    });

    return report;
}

/**
 * Assemble the new dataset elsewhere, then make it the dataset in one step.
 *
 * The indexes are created on the staging collection before the swap. A rename
 * carries a collection's indexes with it, so building them here is what stops
 * the published dataset losing the indexes it is queried through every time it
 * is rebuilt. They are read from the schema rather than restated, so a new
 * index added to the model cannot quietly stop existing in production.
 */
async function swapIn(documents, { allowEmpty = false } = {}) {
    const db = PublicAggregate.db.db;
    const live = PublicAggregate.collection.collectionName;

    if (documents.length === 0 && !allowEmpty) {
        const existing = await PublicAggregate.countDocuments({});
        if (existing > 0) {
            throw new Error(
                `refusing to replace ${existing} published cells with none. Every cell ` +
                'disappearing at once is more likely to be an upstream failure than a ' +
                'collapse in donations, and an empty dataset reads as an absence of ' +
                'donations rather than an absence of a build',
            );
        }
    }

    // Debris from a build that died before its swap. It is not the dataset and
    // never was; dropping it is how a failed run stops affecting the next one.
    await db.collection(BUILDING_COLLECTION).drop().catch((error) => {
        if (error.codeName !== 'NamespaceNotFound') throw error;
    });

    // Created explicitly so that an empty rebuild still has something to swap
    // in, rather than renaming a collection that inserting nothing never made.
    await db.createCollection(BUILDING_COLLECTION);
    const staging = db.collection(BUILDING_COLLECTION);

    // Written through the model, not the driver. The schema refuses any cell
    // carrying a verdict, and that check exists precisely because the rebuild is
    // the writer most likely to be extended by somebody who does not know the
    // rule. Inserting into staging with the driver would skip it, and staging
    // becomes the published dataset one line later.
    if (documents.length) {
        await PublicAggregateStaging.insertMany(documents, { ordered: true });
    }

    for (const [keys, options] of PublicAggregate.schema.indexes()) {
        await staging.createIndex(keys, options);
    }

    // Checked before the swap, not after. A short collection published is a set
    // of aggregates that silently omits recipients, and nothing downstream can
    // tell that from a period in which they received nothing.
    const staged = await staging.countDocuments();
    if (staged !== documents.length) {
        await staging.drop().catch(() => {});
        throw new Error(
            `staged ${staged} cells of ${documents.length}; the previous dataset is ` +
            'left in place rather than replaced by a partial one',
        );
    }

    await db.renameCollection(BUILDING_COLLECTION, live, { dropTarget: true });
}

/**
 * The published aggregates.
 *
 * Unauthenticated, and served only from the materialised collection. The
 * freshness stamp is part of the answer: an aggregate with no date attached
 * gets quoted years later as though it were current.
 */
const dataset = async (req, res) => {
    try {
        // Express parses `?period[$ne]=x` into an object, which reaches mongoose
        // as an operator rather than a value. On this endpoint that is worse
        // than elsewhere: it is the one route with no token in front of it, so
        // a `$regex` supplied by anybody at all becomes a query the database
        // runs. The values are checked for shape rather than passed through —
        // a period is a quarter and an electoral context is a plain label, and
        // neither has a legitimate form that a string cannot express.
        const filter = {};
        const period = req.query.period;
        if (period !== undefined) {
            if (typeof period !== 'string' || !/^\d{4}-Q[1-4]$/.test(period)) {
                return refuse(res, 'period must be a quarter, as YYYY-Qn');
            }
            filter.period = period;
        }
        const context = req.query.electoral_context;
        if (context !== undefined) {
            if (typeof context !== 'string' || context.length > 200) {
                return refuse(res, 'electoral_context must be a single label');
            }
            filter.electoralContext = context;
        }

        const cells = await PublicAggregate.find(filter)
            .sort({ totalIdr: -1 })
            .limit(Math.min(Number.parseInt(req.query.limit, 10) || 200, 1_000))
            .lean();

        const materialisedAt = cells[0]?.materialisedAt || null;

        return res.status(200).json({
            status: 'success',
            message: 'Published donation aggregates',
            data: {
                materialised_at: materialisedAt,
                // Said outright, because a reader has no other way to know what
                // is missing from a list of aggregates.
                excludes:
                    'risk scores, flags, structural alerts, and any cell with fewer ' +
                    `than ${MIN_DONORS_PER_CELL} distinct donors`,
                rounding_idr: AMOUNT_ROUNDING_IDR,
                // Said outright, because a reader comparing this against
                // another source needs to know the current quarter is absent by
                // design rather than because nothing was donated in it.
                covers: 'closed quarters only; the quarter in progress is not published',
                cells: cells.map((cell) => ({
                    recipient: cell.recipientName,
                    recipient_type: cell.recipientType,
                    electoral_context: cell.electoralContext,
                    period: cell.period,
                    donors: cell.donorCount,
                    donations: cell.donationCount,
                    total_idr: cell.totalIdr,
                    suppressed: cell.suppressed,
                    suppression_reason: cell.suppressionReason,
                    // A published figure is never revised in place. When the
                    // records behind it change, the figure stays and this says
                    // so, rather than a reader being shown a new number and
                    // having no way to tell it moved.
                    revision_pending: Boolean(cell.revisionPending),
                    revision_note: cell.revisionNote || null,
                    first_published_at: cell.firstPublishedAt || null,
                })),
            },
        });
    } catch (err) {
        console.error('Error reading published dataset:', err);
        return res.status(500).json({
            status: 'error',
            message: 'Internal Server Error',
            data: {},
        });
    }
};

/**
 * Whether there is a published dataset, and how recently it was built.
 *
 * `/public/aggregates` answers with a list of cells, and an empty list there has
 * three quite different causes: nothing has ever been built, the last build
 * produced no publishable cell, or builds have been failing and the figures on
 * offer are old. The endpoint cannot tell them apart from the cells alone, so
 * this says which it is.
 */
async function datasetState() {
    const [cells, lastSuccess, lastBuild] = await Promise.all([
        PublicAggregate.countDocuments({}),
        PublicDatasetBuild.findOne({ outcome: 'success' }).sort({ completedAt: -1 }).lean(),
        PublicDatasetBuild.findOne({}).sort({ startedAt: -1 }).lean(),
    ]);

    let state;
    if (!lastSuccess && cells === 0) state = 'never-built';
    else if (cells === 0) state = 'built-and-empty';
    else state = 'published';

    return {
        state,
        cells,
        built_at: lastSuccess?.completedAt || null,
        last_build_outcome: lastBuild?.outcome || null,
        last_build_at: lastBuild?.completedAt || lastBuild?.startedAt || null,
        // Said outright when it applies. A reader has no other way to learn
        // that the figures they are quoting stopped being refreshed.
        note:
            lastBuild?.outcome === 'failed'
                ? 'the most recent build failed; the aggregates on offer are from the ' +
                  'last successful one and are not current'
                : state === 'never-built'
                  ? 'no dataset has been built, which is not the same as no donations'
                  : state === 'built-and-empty'
                    ? 'a build completed and produced no publishable cell, which is not ' +
                      'the same as no donations: every cell may be below the ' +
                      'publication threshold'
                    : null,
    };
}

/**
 * How the system itself is running.
 *
 * Volumes and dispute rates are publishable and worth publishing: they are the
 * figures by which an outside reader can judge whether the thing is working,
 * and they say nothing about any person.
 */
const operations = async (req, res) => {
    try {
        const { Dispute } = require('../services/disputes/dispute.model');
        const [donations, disputes, upheld] = await Promise.all([
            Donation.countDocuments({ supersededBy: null }),
            Dispute.countDocuments({}),
            Dispute.countDocuments({ outcome: { $in: ['upheld', 'partially_upheld'] } }),
        ]);

        return res.status(200).json({
            status: 'success',
            message: 'System operation statistics',
            data: {
                donations_held: donations,
                disputes_raised: disputes,
                disputes_upheld: upheld,
                // The rate matters more than the count and is the one figure
                // that would embarrass the system if it were high, which is
                // exactly why it belongs here.
                dispute_upheld_rate: disputes ? upheld / disputes : null,
                published_dataset: await datasetState(),
            },
        });
    } catch (err) {
        console.error('Error reading operation statistics:', err);
        return res.status(500).json({
            status: 'error',
            message: 'Internal Server Error',
            data: {},
        });
    }
};

module.exports = {
    materialise,
    swapIn,
    datasetState,
    dataset,
    operations,
    periodOf,
    round,
};
