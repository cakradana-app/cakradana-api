/**
 * Raising, deciding, and delivering notices to flagged subjects.
 *
 * Delivery is disabled unless `NOTIFY_SUBJECTS=true`. This is not a feature
 * flag awaiting a launch date — it is the difference between a system that can
 * email a named person to tell them they have been flagged and one that cannot.
 * A test run, a backfill, or a rescore of historical data would otherwise reach
 * real people, and no amount of care in the calling code makes that safe when
 * the capability is present by default.
 *
 * The notice itself carries no score. A behavioural estimate ranks donations
 * against each other for review; putting one to the person it concerns states
 * something the system has no standing to say. What the subject is told is what
 * was observed, and how to contest it.
 */

const { Donation, ScoringEvent } = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');
const { attributionBasis } = require('../disputes/dispute.controller');
const { Notification, WITHHOLDING_REASONS } = require('./notification.model');

/** Whether this deployment may contact subjects at all. */
function deliveryEnabled() {
    return process.env.NOTIFY_SUBJECTS === 'true';
}

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
 * Raise a candidate for a donation whose scoring produced findings.
 *
 * Idempotent per donation and party: re-scoring a donation must not queue a
 * second notice about the same attribution, which would reach the subject as
 * repetition of an accusation rather than as information.
 */
async function raiseCandidate(donation, event, { party = 'sender' } = {}) {
    const findings = event?.legalFindings || [];
    const band = event?.behavioural?.band || null;
    if (findings.length === 0 && !['high', 'critical'].includes(band)) {
        return null;
    }

    const ref = party === 'receiver' ? donation.receiverRef : donation.senderRef;
    const existing = await Notification.findOne({
        donationId: donation._id,
        party,
    });
    if (existing) return existing;

    return Notification.create({
        donationId: donation._id,
        subjectEntityId: ref?.entityId || null,
        subjectRawText: ref?.rawText || null,
        party,
        trigger: findings.length
            ? { kind: 'legal_finding', ruleIds: findings.map((f) => f.rule_id) }
            : { kind: 'behavioural_band', band },
    });
}

/** Candidates awaiting a human decision. */
const pending = async (req, res) => {
    try {
        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
        const notices = await Notification.find({
            state: req.query.state || 'pending_decision',
        })
            .sort({ createdAt: 1 })
            .limit(limit)
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Notification candidates',
            data: {
                delivery_enabled: deliveryEnabled(),
                // Stated rather than implied by an empty result. A queue of
                // approved-but-undelivered notices means something different
                // from a queue of nothing to send.
                delivery_note: deliveryEnabled()
                    ? 'approved notices are delivered'
                    : 'delivery is disabled; approved notices are recorded and held',
                withholding_reasons: WITHHOLDING_REASONS,
                notifications: notices,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error listing notification candidates');
    }
};

/**
 * Decide whether to tell the subject.
 *
 * Both outcomes are decisions and both are recorded with the name of whoever
 * made them. Withholding is the one that most needs a record: a notice never
 * sent leaves no trace of its own absence.
 */
const decide = async (req, res) => {
    try {
        const {
            notification_id: notificationId,
            notify,
            withholding_reason: withholdingReason,
            detail,
        } = req.body || {};

        if (!notificationId) return fail(res, 400, 'notification_id is required');
        if (typeof notify !== 'boolean') {
            return fail(res, 400, 'notify must be true or false');
        }
        const actor = req.user?.email || null;
        if (!actor) {
            return fail(res, 400, 'a notification decision must name the person making it');
        }

        const notice = await Notification.findById(notificationId);
        if (!notice) return fail(res, 404, 'No such notification');
        if (notice.state !== 'pending_decision') {
            return fail(res, 409, `This notification is already ${notice.state}`);
        }

        if (!notify && !WITHHOLDING_REASONS.includes(withholdingReason)) {
            return fail(
                res,
                400,
                `withholding_reason must be one of: ${WITHHOLDING_REASONS.join(', ')}`,
            );
        }

        notice.state = notify ? 'approved' : 'withheld';
        notice.decidedBy = actor;
        notice.decidedAt = new Date();
        notice.withholdingReason = notify ? null : withholdingReason;
        notice.withholdingDetail = notify ? null : detail || null;
        await notice.save();

        await record({
            actor,
            action: notify ? 'approve-subject-notice' : 'withhold-subject-notice',
            subjectType: 'Notification',
            subjectId: String(notice._id),
            reason: notify ? null : withholdingReason,
        });

        return res.status(200).json({
            status: 'success',
            message: notify ? 'Notice approved' : 'Notice withheld',
            data: {
                notification_id: notice._id,
                state: notice.state,
                delivery_enabled: deliveryEnabled(),
                delivered: false,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error deciding notification');
    }
};

/**
 * What an approved notice would say.
 *
 * Assembled from the same basis a contesting subject receives: what was
 * observed, where it was read from, and the statutory findings with their
 * articles. No behavioural score, no lane output, no analyst notes.
 *
 * Exposed as its own read so the person approving a notice can see what the
 * subject will see before approving it, rather than after.
 */
async function composeNotice(notificationId) {
    const notice = await Notification.findById(notificationId).lean();
    if (!notice) throw new Error('no such notification');

    const donation = await Donation.findById(notice.donationId).lean();
    const event = await ScoringEvent.findOne({ donationId: notice.donationId })
        .sort({ scoredAt: -1 })
        .lean();

    return {
        notification_id: String(notice._id),
        subject: notice.subjectRawText,
        says: 'A donation recorded in this system names you as a party to it.',
        basis: attributionBasis(donation, event?.legalFindings || []),
        // The point of telling someone. A notice with no route to respond
        // informs a subject of a conclusion and leaves them with nothing to do
        // about it.
        how_to_respond: {
            contest: 'POST /service/disputes',
            see_basis: `GET /service/disputes/basis/${notice.donationId}`,
            acknowledgement_within_working_days: 3,
            resolution_within_working_days: 20,
        },
        does_not_say:
            'any assessment of risk; a behavioural score ranks donations for ' +
            'review and is not a determination about a person',
    };
}

const preview = async (req, res) => {
    try {
        return res.status(200).json({
            status: 'success',
            message: 'Notice as the subject would receive it',
            data: await composeNotice(req.params.notificationId),
        });
    } catch (err) {
        if (/no such notification/.test(err.message)) {
            return fail(res, 404, 'No such notification');
        }
        return serverError(res, err, 'Error composing notice');
    }
};

/**
 * Send an approved notice.
 *
 * Refuses when delivery is disabled, and says so rather than reporting success
 * for something that did not happen. A caller that treats "recorded" as "sent"
 * would leave a subject believing they had been told.
 */
const deliver = async (req, res) => {
    try {
        const { notification_id: notificationId } = req.body || {};
        if (!notificationId) return fail(res, 400, 'notification_id is required');

        const notice = await Notification.findById(notificationId);
        if (!notice) return fail(res, 404, 'No such notification');
        if (notice.state !== 'approved') {
            return fail(res, 409, `Only an approved notice can be delivered; this one is ${notice.state}`);
        }
        if (!deliveryEnabled()) {
            return fail(
                res,
                503,
                'Subject notification delivery is disabled in this deployment. The ' +
                    'notice is recorded and approved; nothing has been sent.',
                { notification_id: String(notice._id), state: notice.state },
            );
        }

        const { sendmail } = require('../../../utils/mail/sender');
        const content = await composeNotice(notice._id);
        const recipient = req.body.to;
        if (!recipient) {
            return fail(res, 400, 'to is required: the address the notice is sent to');
        }

        try {
            await sendmail({
                fromaddres: process.env.EMAIL_FROM || process.env.EMAIL_USER,
                receipients: recipient,
                subject: 'A donation record names you as a party',
                html: true,
                message: `<pre>${JSON.stringify(content, null, 2)}</pre>`,
            });
            notice.state = 'delivered';
            notice.deliveredAt = new Date();
            notice.deliveryChannel = 'email';
        } catch (error) {
            // Recorded as failed rather than retried silently. A notice that
            // nobody knows failed is a notice nobody knows was never received.
            notice.state = 'failed';
            notice.deliveryError = error.message;
            await notice.save();
            throw error;
        }

        await notice.save();
        await record({
            actor: req.user?.email || null,
            action: 'deliver-subject-notice',
            subjectType: 'Notification',
            subjectId: String(notice._id),
        });

        return res.status(200).json({
            status: 'success',
            message: 'Notice delivered',
            data: { notification_id: notice._id, delivered_at: notice.deliveredAt },
        });
    } catch (err) {
        return serverError(res, err, 'Error delivering notice');
    }
};

module.exports = {
    raiseCandidate,
    pending,
    decide,
    preview,
    deliver,
    composeNotice,
    deliveryEnabled,
};
