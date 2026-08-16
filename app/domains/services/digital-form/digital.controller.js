const { ingestBatch } = require('../../canonical/ingest');
const { Donation } = require('../../canonical/canonical.model');
const scoring = require('../../../utils/scoring/client');
const { ENTITY_TYPES, TRANSACTION_KINDS } = require('../../vocabulary');

/**
 * Turn a submitted form row into an ingestion candidate.
 *
 * Submitted values are not re-interpreted. Unlike extracted text, a form field
 * says what the submitter meant it to say, so an amount that will not parse is
 * a problem to report back rather than something to guess at.
 */
function toCandidate(form) {
    const occurredAt = form.date ? new Date(String(form.date).replace(' ', 'T')) : null;
    const precision =
        typeof form.date === 'string' && /[ T]\d{2}:/.test(form.date) ? 'minute' : 'day';

    return {
        senderName: typeof form.sender === 'string' ? form.sender.trim() : null,
        senderType: ENTITY_TYPES.includes(form.sender_type) ? form.sender_type : 'unknown',
        receiverName: typeof form.receiver === 'string' ? form.receiver.trim() : null,
        receiverType: ENTITY_TYPES.includes(form.receiver_type) ? form.receiver_type : 'unknown',
        amountIdr: Number.isFinite(Number(form.amount)) ? Math.round(Number(form.amount)) : null,
        amountRaw: typeof form.amount === 'string' ? form.amount : null,
        occurredAt,
        occurredAtPrecision: precision,
        recordedAt: new Date(),
        transactionKind: TRANSACTION_KINDS.includes(form.transaction_kind)
            ? form.transaction_kind
            : 'unknown',
        channel: 'digital-form',
        electoralContext: form.electoral_context || null,
        isSelfFundedDeclared:
            typeof form.is_self_funded === 'boolean' ? form.is_self_funded : null,
        sourceReference: form.reference || null,
        provenance: ['sender', 'receiver', 'amount', 'date']
            .filter((field) => form[field] !== undefined && form[field] !== null)
            .map((field) => ({ field, provenance: 'submitted', confidence: 1, at: new Date() })),
        raw: form,
    };
}

const input = async (req, res) => {
    try {
        const submitted = Array.isArray(req.body) ? req.body : [req.body];
        if (submitted.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'No donations were submitted',
                data: {},
            });
        }

        const summary = await ingestBatch(submitted.map(toCandidate));

        const stored = await Donation.find({
            _id: {
                $in: summary.results
                    .filter((r) => r.status === 'ingested')
                    .map((r) => r.donationId),
            },
        });
        const scored = await scoring.scoreMany(stored, { requestId: `digital-${Date.now()}` });

        // Rows that could not be admitted are named with their reasons rather
        // than folded into a count. A submitter who is told "3 of 5 accepted"
        // has no way to correct the other two.
        const rejected = summary.results
            .map((result, index) => ({ index, ...result }))
            .filter((r) => r.status === 'quarantined' || r.status === 'failed')
            .map(({ index, problems, quarantineId }) => ({ index, problems, quarantineId }));

        return res.status(200).json({
            status: 'success',
            message: `Ingested ${summary.ingested} of ${submitted.length} submitted donation(s)`,
            data: {
                submitted: submitted.length,
                ingested: summary.ingested,
                duplicates: summary.duplicates,
                rejected,
                needsEntityReview: summary.needsEntityReview,
                scoring: {
                    available: scored.available,
                    scored: scored.scored.length,
                    pending: scored.pending.length,
                    reason: scored.reason || null,
                },
            },
        });
    } catch (err) {
        console.error(err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Bad Request',
            data: {},
        });
    }
};

module.exports = { input, toCandidate };
