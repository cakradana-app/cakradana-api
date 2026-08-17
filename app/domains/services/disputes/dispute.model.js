/**
 * Contested attributions.
 *
 * The system attributes donations to people from sources those people never
 * touched — a scan of somebody else's paper form, a scraped page. Without a
 * route to say "this is not mine", it can attach a name to a payment and offer
 * the named person nothing to do about it. That is the gap this closes.
 *
 * Two properties are enforced here rather than trusted to the controller.
 *
 * A dispute carries its own deadlines. Acknowledgement and resolution dates are
 * computed when the dispute is raised and stored on the record, so an overdue
 * item is overdue in the data and a query can find it. A deadline that exists
 * only in a policy document is not a deadline.
 *
 * A dispute is never resolved automatically. There is no code path that sets an
 * outcome without an adjudicator's name on it, because the whole point of the
 * mechanism is that a person looks at a case the system got wrong.
 */

const mongoose = require('mongoose');

const {
    DISPUTE_REASONS,
    DISPUTE_STATES,
    DISPUTE_OUTCOMES,
} = require('../../vocabulary');
const { addWorkingDays } = require('../../../utils/time/working-days');

/**
 * Service levels, in working days.
 *
 * Provisional pending confirmation by the operating authority. They are stated
 * as constants rather than configuration so that changing them is a visible
 * commit rather than an environment variable someone edits under pressure.
 */
const SLA = Object.freeze({
    acknowledgeWithinWorkingDays: 3,
    resolveWithinWorkingDays: 20,
});

const disputeSchema = new mongoose.Schema(
    {
        donationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Donation',
            required: true,
        },
        // Pinned to the version disputed. A record corrected for an unrelated
        // reason afterwards must not make it look as though the subject was
        // contesting something else.
        donationVersion: { type: Number, required: true, min: 1 },

        raisedBy: { type: String, required: true },
        // Which side of the transaction the subject says they are. A third
        // party disputing somebody else's attribution is a different case and
        // is recorded as one.
        party: {
            type: String,
            enum: ['sender', 'receiver', 'third-party'],
            required: true,
        },

        reason: { type: String, enum: DISPUTE_REASONS, required: true },
        detail: { type: String, default: null },
        // What the subject says the record should say instead. Optional: a
        // subject who knows an attribution is wrong is not obliged to know
        // what the right answer is.
        proposedCorrection: { type: mongoose.Schema.Types.Mixed, default: null },

        state: { type: String, enum: DISPUTE_STATES, default: 'open' },
        acknowledgeBy: { type: Date, required: true },
        resolveBy: { type: Date, required: true },
        acknowledgedAt: { type: Date, default: null },
        acknowledgedBy: { type: String, default: null },
        assignee: { type: String, default: null },

        resolvedAt: { type: Date, default: null },
        // Never set without one. A dispute resolved by nobody is the failure
        // this mechanism exists to prevent, dressed as a completed case.
        adjudicator: { type: String, default: null },
        outcome: { type: String, enum: DISPUTE_OUTCOMES, default: null },
        outcomeNote: { type: String, default: null },
        labelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Label', default: null },
        correctedDonationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Donation',
            default: null,
        },
    },
    { timestamps: true },
);

disputeSchema.index({ state: 1, resolveBy: 1 });
disputeSchema.index({ donationId: 1, createdAt: -1 });
disputeSchema.index({ assignee: 1, state: 1 });
disputeSchema.index({ raisedBy: 1, createdAt: -1 });

disputeSchema.pre('validate', function setDeadlines(next) {
    if (this.isNew) {
        const raisedAt = this.createdAt || new Date();
        this.acknowledgeBy =
            this.acknowledgeBy ||
            addWorkingDays(raisedAt, SLA.acknowledgeWithinWorkingDays);
        this.resolveBy =
            this.resolveBy || addWorkingDays(raisedAt, SLA.resolveWithinWorkingDays);
    }
    if (this.reason === 'other' && !this.detail) {
        return next(
            new Error(
                'a dispute given as "other" must say what the objection is, or ' +
                    'nobody can adjudicate it',
            ),
        );
    }
    if (this.state === 'resolved' && !this.adjudicator) {
        return next(
            new Error(
                'a dispute cannot be resolved without naming the person who ' +
                    'resolved it; automatic resolution defeats the mechanism',
            ),
        );
    }
    return next();
});

/** Overdue against the service level, and by how much. */
disputeSchema.methods.slaStatus = function slaStatus(now = new Date()) {
    const pending = this.state === 'open' || this.state === 'acknowledged';
    return {
        acknowledged: Boolean(this.acknowledgedAt),
        acknowledgementOverdue:
            !this.acknowledgedAt && pending && now > this.acknowledgeBy,
        resolutionOverdue: pending && now > this.resolveBy,
        acknowledgeBy: this.acknowledgeBy,
        resolveBy: this.resolveBy,
    };
};

const Dispute = mongoose.model('Dispute', disputeSchema);

module.exports = { Dispute, SLA };
