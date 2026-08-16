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

const { Donation, Label, ScoringEvent } = require('../../canonical/canonical.model');
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
        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);

        const events = await ScoringEvent.aggregate([
            { $sort: { donationId: 1, scoredAt: -1 } },
            { $group: { _id: '$donationId', latest: { $first: '$$ROOT' } } },
            { $replaceRoot: { newRoot: '$latest' } },
            {
                $addFields: {
                    hasFinding: { $gt: [{ $size: { $ifNull: ['$legalFindings', []] } }, 0] },
                    score: { $ifNull: ['$behavioural.score', 0] },
                },
            },
            { $sort: { hasFinding: -1, score: -1, scoredAt: -1 } },
            { $limit: limit },
        ]);

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
            data: events.map((event) => ({
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
        });
    } catch (err) {
        console.error('Error building queue:', err);
        return fail(res, 400, process.env.DEBUG ? err.message : 'Bad Request');
    }
};

module.exports = {
    confirmAsSender,
    confirmAsReceiver,
    disposition,
    disputeOutcome,
    queue,
    SOURCE_WEIGHTS,
};
