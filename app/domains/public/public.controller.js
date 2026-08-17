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
    MIN_DONORS_PER_CELL,
    AMOUNT_ROUNDING_IDR,
} = require('./public.model');
const { log } = require('../../utils/observability/logging');

/** Quarter of the year a date falls in, which is the coarsest useful period. */
function periodOf(date) {
    const d = new Date(date);
    return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
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
 */
async function materialise({ now = new Date() } = {}) {
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

    const documents = [...cells.values()].map((cell) => {
        const donorCount = cell.donors.size;
        const suppressed = donorCount < MIN_DONORS_PER_CELL;
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
            sourceRecords: cell.donationCount,
        };
    });

    // Replaced wholesale rather than upserted. An incremental build that misses
    // a deletion leaves a published figure for a record that has since been
    // corrected or withdrawn.
    await PublicAggregate.deleteMany({});
    if (documents.length) await PublicAggregate.insertMany(documents);

    log.info('public dataset materialised', {
        cells: documents.length,
        suppressed: documents.filter((d) => d.suppressed).length,
        source_records: donations.length,
    });

    return {
        cells: documents.length,
        published: documents.filter((d) => !d.suppressed).length,
        suppressed: documents.filter((d) => d.suppressed).length,
        materialisedAt: now,
    };
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
        const filter = {};
        if (req.query.period) filter.period = req.query.period;
        if (req.query.electoral_context) filter.electoralContext = req.query.electoral_context;

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

module.exports = { materialise, dataset, operations, periodOf, round };
