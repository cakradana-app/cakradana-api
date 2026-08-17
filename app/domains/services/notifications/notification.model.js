/**
 * Telling someone that a donation attributed to them has been flagged.
 *
 * Two obligations pull against each other here and both are real. A person the
 * system has singled out has an interest in knowing, and a route to respond is
 * worth little if nobody is told there is anything to respond to. Against that,
 * telling a subject they are under examination can defeat the examination.
 *
 * The resolution is that nothing is sent automatically. A candidate is raised,
 * a person decides, and the decision — including a decision to say nothing —
 * is recorded with its reason. An unrecorded decision to withhold is
 * indistinguishable from an oversight, and the difference matters most when
 * somebody later asks why a subject was never told.
 *
 * Delivery is off by default and gated on configuration. Notifying a real
 * person is not reversible, and a system that can do it as a side effect of a
 * test run should not be able to do it at all.
 */

const mongoose = require('mongoose');

/**
 * Why a subject was not told.
 *
 * A controlled list, because "operationally inappropriate" covers both a
 * genuine investigative exemption and a decision nobody wants to write down.
 */
const WITHHOLDING_REASONS = Object.freeze([
    'active_investigation',
    'no_contact_route',
    'subject_unresolved',
    'duplicate_of_earlier_notice',
    'other',
]);

const NOTIFICATION_STATES = Object.freeze([
    'pending_decision',
    'approved',
    'withheld',
    'delivered',
    'failed',
]);

const notificationSchema = new mongoose.Schema(
    {
        donationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Donation',
            required: true,
        },
        subjectEntityId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Entity',
            default: null,
        },
        // Recorded even when the entity is unresolved, so a candidate can be
        // raised and then correctly withheld for want of anyone to send it to,
        // rather than never appearing at all.
        subjectRawText: { type: String, default: null },
        party: { type: String, enum: ['sender', 'receiver'], required: true },

        // What prompted this. A statutory finding and a behavioural score are
        // different grounds, and only the first is a fact.
        trigger: {
            kind: { type: String, enum: ['legal_finding', 'behavioural_band'], required: true },
            ruleIds: { type: [String], default: [] },
            band: { type: String, default: null },
        },

        state: { type: String, enum: NOTIFICATION_STATES, default: 'pending_decision' },
        decidedBy: { type: String, default: null },
        decidedAt: { type: Date, default: null },
        withholdingReason: { type: String, enum: WITHHOLDING_REASONS, default: null },
        withholdingDetail: { type: String, default: null },

        deliveredAt: { type: Date, default: null },
        deliveryChannel: { type: String, default: null },
        deliveryError: { type: String, default: null },
    },
    { timestamps: true },
);

notificationSchema.index({ state: 1, createdAt: -1 });
notificationSchema.index({ donationId: 1 });
notificationSchema.index({ subjectEntityId: 1, createdAt: -1 });

notificationSchema.pre('validate', function guardDecision(next) {
    if (this.state === 'withheld' && !this.withholdingReason) {
        return next(
            new Error(
                'withholding a notice must record why; an unrecorded decision ' +
                    'not to tell someone is indistinguishable from an oversight',
            ),
        );
    }
    if (
        this.withholdingReason === 'other' &&
        !this.withholdingDetail
    ) {
        return next(
            new Error('a withholding reason of "other" must say what it was'),
        );
    }
    if ((this.state === 'approved' || this.state === 'withheld') && !this.decidedBy) {
        return next(
            new Error(
                'a notification decision must name the person who made it; ' +
                    'nothing here is sent or suppressed automatically',
            ),
        );
    }
    return next();
});

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = { Notification, WITHHOLDING_REASONS, NOTIFICATION_STATES };
