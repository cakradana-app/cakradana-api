/**
 * Reviewing what could not be admitted.
 *
 * Quarantine only earns its place if somebody empties it. A record set aside
 * with a reason and never looked at again is data loss with better bookkeeping:
 * the donation is as absent from every cumulative total as if it had been
 * dropped, and the reason nobody read makes no difference to the figures.
 *
 * So the queue is readable, a quarantined record is correctable, and a
 * corrected one goes back through the same ingestion path as everything else —
 * not a special one that skips the validation that rejected it in the first
 * place.
 */

const { Quarantine } = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');
const { ingestBatch } = require('../../canonical/ingest');
const { RETENTION } = require('../../canonical/retention');

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

/**
 * What is waiting, oldest first.
 *
 * Oldest first because quarantine has a retention period: a record nobody
 * corrects within it is deleted, taking with it whatever the source document
 * did contain. Working newest-first would let the tail expire unread.
 */
const list = async (req, res) => {
    try {
        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
        const filter = {};
        if (req.query.resolved === 'true') filter.resolvedAt = { $ne: null };
        else if (req.query.resolved !== 'all') filter.resolvedAt = null;
        if (req.query.channel) filter.channel = req.query.channel;

        const total = await Quarantine.countDocuments(filter);
        const items = await Quarantine.find(filter)
            .sort({ createdAt: 1 })
            .limit(limit)
            .lean();

        const expiryDays = RETENTION.quarantine.days;
        const now = Date.now();

        return res.status(200).json({
            status: 'success',
            message: 'Quarantined records',
            data: {
                total,
                shown: items.length,
                retention_days: expiryDays,
                items: items.map((item) => ({
                    quarantine_id: String(item._id),
                    channel: item.channel,
                    reason: item.reason,
                    detail: item.detail,
                    source_reference: item.sourceReference,
                    payload: item.payload,
                    created_at: item.createdAt,
                    resolved_at: item.resolvedAt,
                    resolved_by: item.resolvedBy,
                    // Surfaced per item rather than left to be inferred from a
                    // policy constant, because what expires is a record of a
                    // donation somebody may still be able to recover.
                    days_until_deleted: Math.max(
                        0,
                        expiryDays -
                            Math.floor((now - new Date(item.createdAt).getTime()) / 86_400_000),
                    ),
                })),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error listing quarantined records');
    }
};

/**
 * Correct a quarantined record and put it back through ingestion.
 *
 * The corrected payload runs through the same validation that rejected it, so
 * a correction that does not actually fix the problem is quarantined again with
 * the new reason rather than admitted because a human vouched for it.
 *
 * The correction is marked as human-corrected provenance on the way through: a
 * value somebody typed is a different kind of evidence from a value read out of
 * a document, and the difference has to survive into the record.
 */
const resubmit = async (req, res) => {
    try {
        const { quarantine_id: quarantineId, payload, note } = req.body || {};
        if (!quarantineId) return fail(res, 400, 'quarantine_id is required');
        if (!payload || typeof payload !== 'object') {
            return fail(res, 400, 'payload is required: the corrected record');
        }
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a correction must name the person making it');

        const item = await Quarantine.findById(quarantineId);
        if (!item) return fail(res, 404, 'No such quarantined record');
        if (item.resolvedAt) {
            return fail(res, 409, 'This record has already been resolved');
        }

        const candidate = {
            ...payload,
            channel: payload.channel || item.channel,
            sourceReference: payload.sourceReference || item.sourceReference,
            provenance: [
                ...(payload.provenance || []),
                ...Object.keys(payload)
                    .filter((field) => field !== 'provenance')
                    .map((field) => ({
                        field,
                        provenance: 'human-corrected',
                        actor,
                        at: new Date(),
                    })),
            ],
        };

        const summary = await ingestBatch([candidate]);
        const outcome = summary.results[0];
        const admitted = outcome?.status === 'ingested';

        if (admitted) {
            item.resolvedAt = new Date();
            item.resolvedBy = actor;
            await item.save();
        }

        await record({
            actor,
            action: admitted ? 'resubmit-quarantined-record' : 'resubmit-rejected-again',
            subjectType: 'Quarantine',
            subjectId: String(item._id),
            outcome: admitted ? 'allowed' : 'denied',
            reason: note || outcome?.reason || null,
        });

        return res.status(admitted ? 200 : 422).json({
            status: admitted ? 'success' : 'error',
            message: admitted
                ? 'Corrected record admitted'
                : 'The corrected record still cannot be admitted',
            data: {
                quarantine_id: String(item._id),
                outcome,
                // Named so an operator sees why the second attempt failed
                // rather than being told only that it did.
                still_quarantined: !admitted,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error resubmitting quarantined record');
    }
};

/**
 * Close a quarantined record without admitting it.
 *
 * For records that are genuinely not donations — a page header the extractor
 * mistook for a row, a duplicate of something already held. The reason is
 * required: a record closed with no explanation is indistinguishable from one
 * dismissed because it was inconvenient.
 */
const dismiss = async (req, res) => {
    try {
        const { quarantine_id: quarantineId, reason } = req.body || {};
        if (!quarantineId) return fail(res, 400, 'quarantine_id is required');
        if (!reason) {
            return fail(res, 400, 'reason is required to dismiss a quarantined record');
        }
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a dismissal must name the person making it');

        const item = await Quarantine.findById(quarantineId);
        if (!item) return fail(res, 404, 'No such quarantined record');

        item.resolvedAt = new Date();
        item.resolvedBy = actor;
        item.detail = [...(item.detail || []), `dismissed: ${reason}`];
        await item.save();

        await record({
            actor,
            action: 'dismiss-quarantined-record',
            subjectType: 'Quarantine',
            subjectId: String(item._id),
            reason,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Quarantined record dismissed',
            data: { quarantine_id: String(item._id) },
        });
    } catch (err) {
        return serverError(res, err, 'Error dismissing quarantined record');
    }
};

module.exports = { list, resubmit, dismiss };
