/**
 * Near matches waiting for a person to decide.
 *
 * Entity resolution sets the accuracy ceiling of every cumulative rule in the
 * system. A donor whose name appears three ways is three donors, each under the
 * limit, and the rule that exists to catch exactly that behaviour reports
 * nothing. So resolution is not a data-cleaning nicety here; it is the
 * difference between the limit rules working and not.
 *
 * Ingestion already refuses to merge on a near match. It creates a separate
 * entity so the donation is not lost, and carries the candidate along. That
 * decision was sound and incomplete: the candidate reached the ingestion
 * response and then nothing. The count of pending reviews was reported on every
 * upload with no place for the reviewing to happen, which reads as a working
 * queue and is a number with nowhere to go.
 *
 * Two properties are enforced here rather than left to the controller.
 *
 * A review carries its own deadline. It is computed when the review is raised
 * and stored on the record, so an overdue item is overdue in the data and a
 * query can find it. The deadline matters more here than elsewhere: while a
 * review sits open, the cumulative rules are being evaluated against a split
 * identity, and every donation ingested in the meantime is judged wrongly.
 *
 * A review is never decided automatically. There is no path that merges two
 * entities without a person's name on it, because a wrong merge attributes one
 * person's donations to another and produces a statutory finding against
 * somebody who did nothing.
 */

const mongoose = require('mongoose');

const { addWorkingDays } = require('../../../utils/time/working-days');

/**
 * Service levels, in working days.
 *
 * Shorter than the dispute deadlines, and deliberately so. A dispute concerns a
 * record already attributed; an open resolution review means the system is
 * currently miscounting, and the error grows with every donation ingested
 * under either spelling.
 */
const SLA = Object.freeze({
    reviewWithinWorkingDays: 5,
});

/**
 * How many open reviews one submitting account may put at the front of the
 * queue before the rest are set aside.
 *
 * Not a fraud control — a genuine bulk uploader legitimately produces many near
 * matches. It is a bound on how far one caller can reorder a queue whose whole
 * value is that its order reflects which donors are currently being miscounted.
 */
const MAX_OPEN_PER_ACTOR = 25;

const RESOLUTION_REVIEW_STATES = Object.freeze([
    'open',
    'merged',
    'kept-separate',
]);

const resolutionReviewSchema = new mongoose.Schema(
    {
        // The entity ingestion created for the observed name.
        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Entity',
            required: true,
        },
        // The existing entity it nearly matched.
        candidateId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Entity',
            required: true,
        },
        // Names as observed, kept alongside the references. An entity removed
        // by a later merge would otherwise leave a review nobody can read.
        observedName: { type: String, required: true },
        candidateName: { type: String, required: true },

        similarity: { type: Number, required: true, min: 0, max: 1 },
        basis: { type: String, required: true },

        // What prompted the review. A reviewer deciding whether two names are
        // one person needs to see the donation that raised the question.
        donationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Donation',
            default: null,
        },
        // Reviews are raised once per pair and accumulate sightings rather
        // than piling up one per donation. Forty copies of the same question
        // is a queue nobody works.
        occurrences: { type: Number, default: 1, min: 1 },

        // Who submitted the donation that raised this. Ingestion is open to
        // any authenticated account by design — submitters are the point — so
        // one account can raise unlimited near matches by inventing a new
        // spelling each time. Recording the source is what lets the queue tell
        // a reviewer's backlog from one caller's output.
        raisedByActor: { type: String, default: null },
        // Set when one account has already raised more open reviews than the
        // cap. Still queued and still decidable: the pair may be genuine, and
        // dropping it would lose a real near match. But it does not compete for
        // position with reviews the system found on its own.
        deprioritised: { type: Boolean, default: false },

        state: { type: String, enum: RESOLUTION_REVIEW_STATES, default: 'open' },
        raisedAt: { type: Date, default: Date.now },
        reviewBy: { type: Date, required: true },

        decidedBy: { type: String, default: null },
        decidedAt: { type: Date, default: null },
        // Required on every decision, in both directions. "Kept separate" with
        // no reason is indistinguishable from a review nobody looked at, and
        // the pair will be raised again by the next donation.
        decisionReason: { type: String, default: null },

        // What the decision cost downstream. Recorded because a merge changes
        // every cumulative total either entity took part in, and somebody
        // reading a re-scored finding later needs to know why it moved.
        donationsRepointed: { type: Number, default: 0 },
        scoringEventsNeedingRescore: { type: Number, default: 0 },
    },
    { timestamps: true },
);

// The queue is read oldest-deadline-first, and the pair lookup happens on every
// ingestion of a near match.
resolutionReviewSchema.index({ state: 1, deprioritised: 1, reviewBy: 1 });
resolutionReviewSchema.index({ raisedByActor: 1, state: 1 });
resolutionReviewSchema.index({ entityId: 1, candidateId: 1, state: 1 });

resolutionReviewSchema.pre('validate', function setDeadline(next) {
    const raisedAt = this.raisedAt || new Date();
    this.reviewBy =
        this.reviewBy || addWorkingDays(raisedAt, SLA.reviewWithinWorkingDays);

    if (this.state !== 'open') {
        if (!this.decidedBy) {
            return next(
                new Error(
                    'a decided review must name the person who decided it; a merge ' +
                        'attributes one person’s donations to another',
                ),
            );
        }
        if (!this.decisionReason) {
            return next(
                new Error(
                    'a decision requires a reason, including when the entities are ' +
                        'kept separate — without one the same pair is raised again ' +
                        'by the next donation and nobody knows it was considered',
                ),
            );
        }
    }
    return next();
});

/**
 * Whether this review is late, and by reference to what.
 *
 * The stated consequence travels with the status. An overdue resolution review
 * is not an administrative lapse; it means the limit rules are currently being
 * applied to a split identity.
 */
resolutionReviewSchema.methods.slaStatus = function slaStatus(now = new Date()) {
    const pending = this.state === 'open';
    return {
        state: this.state,
        review_by: this.reviewBy,
        overdue: pending && now > this.reviewBy,
        consequence_while_open: pending
            ? 'cumulative limits are being evaluated against a split identity'
            : null,
    };
};

const ResolutionReview = mongoose.model(
    'ResolutionReview',
    resolutionReviewSchema,
);

module.exports = {
    ResolutionReview,
    RESOLUTION_REVIEW_STATES,
    SLA,
    MAX_OPEN_PER_ACTOR,
};
