/**
 * The published dataset.
 *
 * A separate collection, built on a schedule, holding only aggregates. It is
 * not a view over the operational store and must never become one: a filter bug
 * in a query-time path would put live risk scores on a public endpoint, and the
 * damage from that is not recoverable by fixing the filter afterwards.
 *
 * What is published is a decision, not a default. Aggregate flows above a
 * re-identification threshold, and statistics about how the system itself is
 * operating. Never a score, never a flag, never a structural alert, never
 * anything about a private individual.
 */

const mongoose = require('mongoose');

/**
 * Donors below which a cell is not published.
 *
 * An aggregate over two donors is two donors. Publishing "Rp1.2 billion from 2
 * donors to this candidate" alongside a known large donation identifies the
 * second one by arithmetic, which is the ordinary way aggregate releases leak.
 */
const MIN_DONORS_PER_CELL = 5;

/** Rounding applied to published totals, blunting differencing between releases. */
const AMOUNT_ROUNDING_IDR = 1_000_000;

const publicAggregateSchema = new mongoose.Schema(
    {
        // What the cell groups by. Recipient and period only: adding donor
        // attributes would narrow cells until they identify people.
        recipientName: { type: String, required: true },
        recipientType: { type: String, required: true },
        electoralContext: { type: String, default: null },
        period: { type: String, required: true },

        donorCount: { type: Number, required: true },
        donationCount: { type: Number, required: true },
        totalIdr: { type: Number, required: true },

        // Recorded so a reader can tell a small true figure from a suppressed
        // one. A cell that vanishes without explanation looks like an absence
        // of donations rather than an absence of publishable detail.
        suppressed: { type: Boolean, default: false },
        suppressionReason: { type: String, default: null },

        materialisedAt: { type: Date, required: true },
        sourceRecords: { type: Number, required: true },
    },
    { timestamps: true },
);

publicAggregateSchema.index({ period: 1, recipientName: 1 });
publicAggregateSchema.index({ materialisedAt: -1 });

/**
 * Nothing here may carry a score.
 *
 * Enforced in the schema rather than trusted to the materialiser, because the
 * materialiser is the thing most likely to be extended by someone who does not
 * know this rule.
 */
publicAggregateSchema.pre('validate', function refuseAnyVerdict(next) {
    const forbidden = ['score', 'band', 'risk', 'findings', 'flags', 'alerts'];
    const present = forbidden.filter((field) => this.get(field) !== undefined);
    if (present.length) {
        return next(
            new Error(
                `the published dataset must not carry ${present.join(', ')}; model ` +
                    'output is never published at any granularity',
            ),
        );
    }
    return next();
});

const PublicAggregate = mongoose.model('PublicAggregate', publicAggregateSchema);

module.exports = { PublicAggregate, MIN_DONORS_PER_CELL, AMOUNT_ROUNDING_IDR };
