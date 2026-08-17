/**
 * Assembling cases, and drawing reports from them.
 *
 * The report path runs through a case deliberately. A draft generated straight
 * from a score would be a formatted rendering of a model output, presented to a
 * receiving authority as an accusation. Requiring a case first means a person
 * chose these records, wrote down what connects them, and can be asked why.
 *
 * Export is recorded, never transmitted. This system has no route to any
 * authority and is not going to acquire one: an accusation of financial crime
 * against a named person should leave the building by a deliberate human act,
 * not as a side effect of a threshold.
 */

const { Donation, Entity } = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');
const sar = require('../reports/sar');
const { Case } = require('./case.model');

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

function actorOf(req) {
    return req.user?.email || null;
}

/**
 * Open a case.
 *
 * The entities are derived from the donations rather than supplied, so a case
 * cannot name a party to a transaction it does not contain.
 */
const open = async (req, res) => {
    try {
        const {
            title,
            narrative,
            donation_ids: donationIds = [],
            alert_ids: alertIds = [],
        } = req.body || {};

        if (!title) return fail(res, 400, 'title is required');
        const actor = actorOf(req);
        if (!actor) return fail(res, 400, 'opening a case must name the person doing it');

        const donations = await Donation.find({ _id: { $in: donationIds } }).lean();
        const entityIds = [
            ...new Set(
                donations
                    .flatMap((d) => [d.senderRef?.entityId, d.receiverRef?.entityId])
                    .filter(Boolean)
                    .map(String),
            ),
        ];

        const file = await Case.create({
            title,
            narrative: narrative || null,
            donationIds: donations.map((d) => d._id),
            entityIds,
            alertIds,
            openedBy: actor,
            assignee: actor,
        });

        await record({
            actor,
            action: 'open-case',
            subjectType: 'Case',
            subjectId: String(file._id),
            reason: title,
        });

        return res.status(201).json({
            status: 'success',
            message: 'Case opened',
            data: {
                case_id: file._id,
                donations: file.donationIds.length,
                entities: file.entityIds.length,
                // Named rather than silently dropped, so a caller can see
                // which of the ids they sent do not exist.
                not_found: donationIds.filter(
                    (id) => !donations.some((d) => String(d._id) === String(id)),
                ),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error opening case');
    }
};

const list = async (req, res) => {
    try {
        const filter = {};
        if (req.query.state) filter.state = req.query.state;
        if (req.query.assignee) filter.assignee = req.query.assignee;

        const cases = await Case.find(filter)
            .sort({ updatedAt: -1 })
            .limit(Math.min(Number.parseInt(req.query.limit, 10) || 50, 200))
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Cases',
            data: cases.map((file) => ({
                case_id: String(file._id),
                title: file.title,
                state: file.state,
                donations: file.donationIds.length,
                entities: file.entityIds.length,
                assignee: file.assignee,
                updated_at: file.updatedAt,
            })),
        });
    } catch (err) {
        return serverError(res, err, 'Error listing cases');
    }
};

const detail = async (req, res) => {
    try {
        const file = await Case.findById(req.params.caseId).lean();
        if (!file) return fail(res, 404, 'No such case');

        const [donations, entities] = await Promise.all([
            Donation.find({ _id: { $in: file.donationIds } }).lean(),
            Entity.find({ _id: { $in: file.entityIds } }).lean(),
        ]);

        await record({
            actor: actorOf(req),
            action: 'read-case',
            subjectType: 'Case',
            subjectId: String(file._id),
        });

        return res.status(200).json({
            status: 'success',
            message: 'Case',
            data: {
                case_id: String(file._id),
                title: file.title,
                narrative: file.narrative,
                state: file.state,
                opened_by: file.openedBy,
                assignee: file.assignee,
                alert_ids: file.alertIds,
                donations: donations.map((d) => ({
                    donation_id: String(d._id),
                    amount_idr: d.amountIdr,
                    occurred_at: d.occurredAt,
                    from: d.senderRef?.rawText ?? null,
                    to: d.receiverRef?.rawText ?? null,
                })),
                entities: entities.map((e) => ({
                    entity_id: String(e._id),
                    name: e.canonicalName,
                    type: e.entityType,
                })),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error reading case');
    }
};

/**
 * Add donations to a case, or set its narrative.
 *
 * Entities are recomputed from the donations each time rather than accumulated,
 * so removing a donation removes the party it brought with it.
 */
const update = async (req, res) => {
    try {
        const { case_id: caseId, narrative, donation_ids: donationIds, state } = req.body || {};
        if (!caseId) return fail(res, 400, 'case_id is required');

        const file = await Case.findById(caseId);
        if (!file) return fail(res, 404, 'No such case');
        if (file.state === 'closed') return fail(res, 409, 'This case is closed');

        if (narrative !== undefined) file.narrative = narrative;
        if (Array.isArray(donationIds)) {
            const donations = await Donation.find({ _id: { $in: donationIds } }).lean();
            file.donationIds = donations.map((d) => d._id);
            file.entityIds = [
                ...new Set(
                    donations
                        .flatMap((d) => [d.senderRef?.entityId, d.receiverRef?.entityId])
                        .filter(Boolean)
                        .map(String),
                ),
            ];
        }
        if (state) file.state = state;
        await file.save();

        await record({
            actor: actorOf(req),
            action: 'update-case',
            subjectType: 'Case',
            subjectId: String(file._id),
        });

        return res.status(200).json({
            status: 'success',
            message: 'Case updated',
            data: {
                case_id: file._id,
                state: file.state,
                donations: file.donationIds.length,
            },
        });
    } catch (err) {
        if (err.name === 'ValidationError') {
            return fail(res, 400, err.message);
        }
        return serverError(res, err, 'Error updating case');
    }
};

/**
 * Draft a report from a case.
 *
 * Read-only. Produces a document and nothing else — the draft is returned, not
 * stored as an approved report, and approving it is a separate act by a person
 * whose name goes on it.
 */
const draft = async (req, res) => {
    try {
        const file = await Case.findById(req.params.caseId).lean();
        if (!file) return fail(res, 404, 'No such case');
        if (!file.narrative) {
            return fail(
                res,
                409,
                'This case has no narrative. A report drawn from a set of donations ' +
                    'with no account of what connects them is a rendering of a score.',
            );
        }

        const assembled = await sar.assemble(file.donationIds, {
            actor: actorOf(req),
            narrative: file.narrative,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Draft assembled',
            data: {
                case_id: String(file._id),
                draft: assembled,
                // Surfaced at the top so a caller does not have to read the
                // limitations array to discover the draft cannot be submitted.
                blocked: assembled.limitations.some((l) => l.blocking),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error drafting report');
    }
};

/**
 * Record a person's approval of a draft.
 *
 * Approval is recorded; nothing is transmitted. The response says so plainly,
 * because a caller that reads "approved" as "filed" would leave an analyst
 * believing a report had reached an authority that never received it.
 */
const approve = async (req, res) => {
    try {
        const { case_id: caseId, draft: submitted, note } = req.body || {};
        if (!caseId) return fail(res, 400, 'case_id is required');
        if (!submitted) return fail(res, 400, 'draft is required');

        const file = await Case.findById(caseId);
        if (!file) return fail(res, 404, 'No such case');

        const actor = actorOf(req);
        let approved;
        try {
            approved = await sar.approve(submitted, { actor, note });
        } catch (error) {
            // A refused approval is the caller's answer, not a server fault:
            // the draft rests on evidence that cannot support it, or nobody
            // signed for it.
            return fail(res, 422, error.message);
        }

        file.state = 'reported';
        await file.save();

        await record({
            actor,
            action: 'approve-report',
            subjectType: 'Case',
            subjectId: String(file._id),
            reason: note || null,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Report approved for manual submission',
            data: {
                case_id: String(file._id),
                report: approved,
                transmitted: false,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error approving report');
    }
};

/**
 * The export log.
 *
 * Every approval and every read of a report is already recorded; this reads
 * that record back for a case. An export trail nobody can read is a trail that
 * cannot answer the question it exists for.
 */
const exportLog = async (req, res) => {
    try {
        const { AuditEntry } = require('../../canonical/retention');
        const entries = await AuditEntry.find({
            subjectType: 'Case',
            subjectId: req.params.caseId,
        })
            .sort({ at: -1 })
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Case audit trail',
            data: entries.map((entry) => ({
                actor: entry.actor,
                action: entry.action,
                outcome: entry.outcome,
                reason: entry.reason,
                at: entry.at,
            })),
        });
    } catch (err) {
        return serverError(res, err, 'Error reading case audit trail');
    }
};

module.exports = { open, list, detail, update, draft, approve, exportLog };
