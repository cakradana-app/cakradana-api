/**
 * A case: several donations and the parties to them, held together by an
 * analyst's account of what connects them.
 *
 * The narrative is the part that matters. The system can say that twenty-three
 * donations converged on one recipient in nine days; it cannot say why that is
 * worth an authority's attention, and the sentence that says so has to come
 * from a person who can be asked to defend it.
 *
 * A case is also the unit a report is drawn from. Nothing is reported that
 * somebody did not first assemble and describe, which is what keeps a formal
 * document from being a rendering of a score.
 */

const mongoose = require('mongoose');

const CASE_STATES = Object.freeze([
    'open',
    'assembled',
    'reported',
    'closed',
]);

const caseSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        // What the analyst says connects these records. Required before a case
        // can leave 'open': a set of donations with no account of why they are
        // together is a selection, not a case.
        narrative: { type: String, default: null },

        donationIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Donation' }],
            default: [],
        },
        entityIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Entity' }],
            default: [],
        },
        // Structural alerts this case was built from, by their cluster id. A
        // case assembled from a detected cluster should name it, so the
        // reasoning is traceable back to what surfaced it.
        alertIds: { type: [String], default: [] },

        state: { type: String, enum: CASE_STATES, default: 'open' },
        openedBy: { type: String, required: true },
        assignee: { type: String, default: null },
        closedAt: { type: Date, default: null },
        closingNote: { type: String, default: null },
    },
    { timestamps: true },
);

caseSchema.index({ state: 1, updatedAt: -1 });
caseSchema.index({ donationIds: 1 });
caseSchema.index({ assignee: 1, state: 1 });

caseSchema.pre('validate', function requireNarrativeToAdvance(next) {
    if (this.state !== 'open' && !this.narrative) {
        return next(
            new Error(
                'a case needs an account of what connects its donations before it ' +
                    'can be assembled or reported; a set with no narrative is a ' +
                    'selection, not a case',
            ),
        );
    }
    if (this.state !== 'open' && this.donationIds.length === 0) {
        return next(new Error('a case with no donations describes nothing'));
    }
    return next();
});

const Case = mongoose.model('Case', caseSchema);

module.exports = { Case, CASE_STATES };
