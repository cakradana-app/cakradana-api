/**
 * The label loop.
 *
 * Human judgement is where this system's accountability and its training
 * signal both come from, so what a person said and what a rule guessed stay
 * distinguishable for good.
 *
 * The distinction that matters most is between confirming and clearing. A
 * recipient confirming a donation establishes that the transaction happened.
 * That is a different claim from the transaction being legitimate, and the gap
 * between them is widest exactly where this system is most useful: a donation
 * split across many nominal donors is genuinely received, and its recipient
 * confirms it truthfully. Admitting confirmations as clean labels would teach a
 * model that verified splitting is fine.
 *
 * Only an analyst disposition or an adjudicated dispute carries a risk value.
 */

const mongoose = require('mongoose');

const { Donation, Label, ScoringEvent } = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');
const { LABEL_VALUES } = require('../../vocabulary');

/**
 * How far each source is trusted when it reaches training.
 *
 * Provisional, and reviewed against measured reliability rather than left as
 * constants. An adjudicated outcome was investigated; a heuristic is a
 * hypothesis about intent inferred from structure.
 */
const SOURCE_WEIGHTS = Object.freeze({
    dispute_outcome: 1.0,
    analyst_disposition: 0.9,
    recipient_confirmation: 0.7,
    rule_tier2: 0.5,
    synthetic: 0.3,
});

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

/**
 * Record that a party confirms a donation occurred.
 *
 * Stored as indeterminate on risk, deliberately. The schema refuses any other
 * value from this source, so the constraint cannot be lost by a later caller
 * passing something more convenient.
 */
async function recordOccurrence(req, res, party) {
    try {
        const { donation_id: donationId, note } = req.body || {};
        if (!donationId) {
            return fail(res, 400, 'donation_id is required');
        }

        const donation = await Donation.findById(donationId);
        if (!donation) {
            return fail(res, 404, 'No such donation');
        }

        const label = await Label.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            value: 'indeterminate',
            source: 'recipient_confirmation',
            weight: SOURCE_WEIGHTS.recipient_confirmation,
            actor: req.user?.email || null,
            note: note || `confirmed as ${party}`,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Recorded that this donation occurred',
            data: {
                label_id: label._id,
                records: 'that the transaction took place',
                does_not_record:
                    'that the donation is low risk; only an analyst disposition or an ' +
                    'adjudicated dispute can say that',
            },
        });
    } catch (err) {
        console.error('Error recording confirmation:', err);
        return fail(res, 400, process.env.DEBUG ? err.message : 'Bad Request');
    }
}

const confirmAsSender = (req, res) => recordOccurrence(req, res, 'sender');
const confirmAsReceiver = (req, res) => recordOccurrence(req, res, 'receiver');

/**
 * Record an analyst's judgement about a donation.
 *
 * This is the label the model is measured against. Agreement with the
 * behavioural heuristics is not a success metric — a model measured against
 * the rules it was trained on measures only how well it memorised them.
 */
const disposition = async (req, res) => {
    try {
        const { donation_id: donationId, value, typology, note } = req.body || {};

        if (!donationId) return fail(res, 400, 'donation_id is required');
        if (!LABEL_VALUES.includes(value)) {
            return fail(
                res,
                400,
                `value must be one of: ${LABEL_VALUES.join(', ')}`,
            );
        }

        const donation = await Donation.findById(donationId);
        if (!donation) return fail(res, 404, 'No such donation');

        // A later disposition supersedes an earlier one without deleting it,
        // so the history of what was decided, and when, stays reconstructible.
        const previous = await Label.findOne({
            donationId: donation._id,
            source: 'analyst_disposition',
            supersededBy: null,
        }).sort({ createdAt: -1 });

        const label = await Label.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            value,
            source: 'analyst_disposition',
            typology: typology || null,
            weight: SOURCE_WEIGHTS.analyst_disposition,
            actor: req.user?.email || null,
            note: note || null,
        });

        if (previous) {
            await Label.updateOne({ _id: previous._id }, { supersededBy: label._id });
        }

        return res.status(200).json({
            status: 'success',
            message: 'Disposition recorded',
            data: { label_id: label._id, supersedes: previous?._id || null },
        });
    } catch (err) {
        console.error('Error recording disposition:', err);
        return fail(res, 400, process.env.DEBUG ? err.message : 'Bad Request');
    }
};

/**
 * Record the outcome of a contested attribution.
 *
 * The strongest label available, because it was investigated and resolved. An
 * upheld dispute is also a correction to the record, not only a label, and the
 * donation is marked so that the correction propagates rather than leaving the
 * original error in every total that used it.
 */
const disputeOutcome = async (req, res) => {
    try {
        const { donation_id: donationId, upheld, value, note } = req.body || {};

        if (!donationId) return fail(res, 400, 'donation_id is required');
        if (typeof upheld !== 'boolean') {
            return fail(res, 400, 'upheld must be true or false');
        }
        if (!LABEL_VALUES.includes(value)) {
            return fail(res, 400, `value must be one of: ${LABEL_VALUES.join(', ')}`);
        }

        const donation = await Donation.findById(donationId);
        if (!donation) return fail(res, 404, 'No such donation');

        const label = await Label.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            value,
            source: 'dispute_outcome',
            weight: SOURCE_WEIGHTS.dispute_outcome,
            actor: req.user?.email || null,
            note: note || null,
        });

        if (upheld) {
            await Donation.updateOne(
                { _id: donation._id },
                { correctionReason: note || 'dispute upheld' },
            );
        }

        return res.status(200).json({
            status: 'success',
            message: upheld ? 'Dispute upheld and recorded' : 'Dispute outcome recorded',
            data: {
                label_id: label._id,
                requires_rescore: upheld,
            },
        });
    } catch (err) {
        console.error('Error recording dispute outcome:', err);
        return fail(res, 400, process.env.DEBUG ? err.message : 'Bad Request');
    }
};

/**
 * The review queue.
 *
 * Ordered so that statutory findings come first and behavioural scores rank
 * beneath them. A breach of a stated limit is a fact with an article behind it;
 * a behavioural score is an estimate. Interleaving them by magnitude would put
 * an estimate above a fact.
 */
const queue = async (req, res) => {
    try {
        const { limit, budget } = queueBudget(req.query);
        const filters = queueFilters(req.query);

        const pipeline = [
            { $sort: { donationId: 1, scoredAt: -1 } },
            { $group: { _id: '$donationId', latest: { $first: '$$ROOT' } } },
            { $replaceRoot: { newRoot: '$latest' } },
            {
                $addFields: {
                    hasFinding: { $gt: [{ $size: { $ifNull: ['$legalFindings', []] } }, 0] },
                    score: { $ifNull: ['$behavioural.score', 0] },
                },
            },
        ];

        if (Object.keys(filters.event).length > 0) {
            pipeline.push({ $match: filters.event });
        }

        // Filters on the donation rather than the score need the donation, so
        // they are resolved first and applied as an id set. The alternative —
        // a lookup per event — turns one query into one per queue item.
        if (Object.keys(filters.donation).length > 0) {
            const matching = await Donation.find(filters.donation)
                .select('_id')
                .limit(5_000)
                .lean();
            pipeline.push({
                $match: { donationId: { $in: matching.map((d) => d._id) } },
            });
        }

        pipeline.push({ $sort: { hasFinding: -1, score: -1, scoredAt: -1 } });
        pipeline.push({ $limit: limit });

        const events = await ScoringEvent.aggregate(pipeline);

        const donations = await Donation.find({
            _id: { $in: events.map((e) => e.donationId) },
        }).lean();
        const byId = new Map(donations.map((d) => [String(d._id), d]));

        const dispositioned = await Label.find({
            donationId: { $in: events.map((e) => e.donationId) },
            source: { $in: ['analyst_disposition', 'dispute_outcome'] },
            supersededBy: null,
        }).lean();
        const decided = new Set(dispositioned.map((l) => String(l.donationId)));

        return res.status(200).json({
            status: 'success',
            message: 'Review queue',
            data: {
                // The budget the queue was cut to, stated. A list of fifty is
                // otherwise indistinguishable from there being fifty items,
                // and the difference is the whole basis of precision@B.
                budget,
                returned: events.length,
                bounded_by_budget: events.length >= limit,
                filters: filters.applied,
                items: events.map((event) => ({
                    donation: byId.get(String(event.donationId)) || null,
                    legal_findings: event.legalFindings,
                    // Rules that could not be evaluated travel with the item. A
                    // donation with no findings and several unevaluated rules has
                    // been partly examined, not cleared.
                    indeterminate_rules: event.indeterminateRules,
                    behavioural: event.behavioural,
                    versions: {
                        model: event.modelVersion,
                        rule_set: event.ruleSetVersion,
                        features: event.featureSetVersion,
                    },
                    scored_at: event.scoredAt,
                    already_dispositioned: decided.has(String(event.donationId)),
                })),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error building queue');
    }
};

/**
 * How many items the queue returns.
 *
 * Defaults to the configured review budget rather than to a round number. The
 * budget is how many donations a team can actually process in a period, and a
 * queue longer than it is a queue whose tail nobody reaches — which makes every
 * precision figure computed over it describe an operating point that does not
 * exist.
 */
function queueBudget(query) {
    const configured = Number.parseInt(process.env.REVIEW_BUDGET, 10) || 50;
    const requested = Number.parseInt(query.limit, 10);
    return {
        budget: configured,
        limit: Math.min(requested || configured, 500),
    };
}

/**
 * Queue filters, split by which collection they constrain.
 *
 * `district` is served through the electoral context, which is where DR-01 puts
 * it. Adding a separate district column that nothing else populates would give
 * the filter something to match and the rest of the system nothing to fill in.
 */
function queueFilters(query) {
    const event = {};
    const donation = {};
    const applied = {};

    if (query.tier === '1') {
        event.hasFinding = true;
        applied.tier = 'statutory findings only';
    } else if (query.tier === '2') {
        event.hasFinding = false;
        applied.tier = 'behavioural only, no statutory finding';
    }

    if (query.lane) {
        // A lane fired if it contributed anything. Filtering on the reason
        // codes instead would miss a lane that ran and found nothing, which is
        // a different state from a lane that did not run.
        event['behavioural.lanes'] = {
            $elemMatch: { lane: query.lane, available: true, contribution: { $gt: 0 } },
        };
        applied.lane = query.lane;
    }

    if (query.band) {
        event['behavioural.band'] = query.band;
        applied.band = query.band;
    }

    if (query.min_score) {
        event.score = { $gte: Number.parseInt(query.min_score, 10) };
        applied.min_score = Number.parseInt(query.min_score, 10);
    }

    if (query.electoral_context || query.district) {
        donation.electoralContext = query.electoral_context || query.district;
        applied.electoral_context = donation.electoralContext;
    }

    if (query.recipient) {
        donation['receiverRef.entityId'] = query.recipient;
        applied.recipient = query.recipient;
    }

    if (query.from || query.to) {
        donation.occurredAt = {};
        if (query.from) donation.occurredAt.$gte = new Date(query.from);
        if (query.to) donation.occurredAt.$lte = new Date(query.to);
        applied.period = { from: query.from || null, to: query.to || null };
    }

    return { event, donation, applied };
}

/**
 * Clear a set of donations that share one cause.
 *
 * The recorded reason is the point. A hundred donations cleared one at a time
 * are a hundred unrelated judgements; the same hundred cleared together with
 * "recurring monthly transfer from a registered party branch" is one
 * diagnosable signal that something in the detection is systematically wrong.
 */
const bulkClear = async (req, res) => {
    try {
        const { donation_ids: donationIds, reason, typology, value } = req.body || {};

        if (!Array.isArray(donationIds) || donationIds.length === 0) {
            return fail(res, 400, 'donation_ids must be a non-empty array');
        }
        if (!reason) {
            return fail(
                res,
                400,
                'reason is required: clearing a set without recording what they have ' +
                    'in common loses the only thing that makes the set useful',
            );
        }
        const labelValue = value || 'not_risky';
        if (!LABEL_VALUES.includes(labelValue)) {
            return fail(res, 400, `value must be one of: ${LABEL_VALUES.join(', ')}`);
        }
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a disposition must name the person making it');

        const donations = await Donation.find({ _id: { $in: donationIds } }).lean();
        const found = new Set(donations.map((d) => String(d._id)));
        const missing = donationIds.filter((id) => !found.has(String(id)));

        const bulkId = new mongoose.Types.ObjectId();
        const created = [];
        for (const donation of donations) {
            const previous = await Label.findOne({
                donationId: donation._id,
                source: 'analyst_disposition',
                supersededBy: null,
            }).sort({ createdAt: -1 });

            const label = await Label.create({
                donationId: donation._id,
                donationVersion: donation.donationVersion || 1,
                value: labelValue,
                source: 'analyst_disposition',
                typology: typology || null,
                weight: SOURCE_WEIGHTS.analyst_disposition,
                actor,
                note: reason,
                bulkId,
            });
            if (previous) {
                await Label.updateOne({ _id: previous._id }, { supersededBy: label._id });
            }
            created.push(String(label._id));
        }

        await record({
            actor,
            action: 'bulk-clear',
            subjectType: 'Donation',
            subjectId: donations.map((d) => String(d._id)).join(','),
            reason,
        });

        return res.status(200).json({
            status: 'success',
            message: `Recorded ${created.length} disposition(s) sharing one reason`,
            data: {
                bulk_id: String(bulkId),
                labels: created,
                // Named rather than counted, so a caller can see which ids did
                // not exist instead of inferring it from a total.
                not_found: missing,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error clearing donations in bulk');
    }
};

/**
 * A failure on our side is a 5xx.
 *
 * Returning 400 for a database fault reports a service error as the caller's
 * mistake, which hides it from monitoring and from anyone counting client
 * errors.
 */
function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

module.exports = {
    confirmAsSender,
    confirmAsReceiver,
    disposition,
    disputeOutcome,
    queue,
    bulkClear,
    queueFilters,
    queueBudget,
    SOURCE_WEIGHTS,
};
