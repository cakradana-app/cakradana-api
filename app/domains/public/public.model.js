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

        // When this cell's figures were first published, and never updated
        // afterwards. A published figure is frozen: see the note on
        // differencing in the materialiser.
        firstPublishedAt: { type: Date, default: null },
        // Set when a rebuild computed different figures for a cell that has
        // already been published. The published figures do not change; this
        // says that they no longer match the records, so a reader is not left
        // believing a stale figure is current and a person can decide whether
        // releasing the correction is worth what releasing it discloses.
        revisionPending: { type: Boolean, default: false },
        revisionNote: { type: String, default: null },
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

/**
 * The operation statistics, materialised.
 *
 * Counted on the schedule and served from here, rather than counted per
 * request. Two reasons, and the second is the one that matters. The endpoint is
 * unauthenticated and uncached, so counting live meant three collection scans
 * on demand for anybody who asked, repeatedly, for free. And a live count of
 * donations held, at single-record granularity, is a feed: polling it reveals
 * when records are ingested and how many, which is information about the
 * subjects of those records that nobody decided to publish.
 *
 * It also restores the property this domain is built on — that the public
 * endpoints read the materialised collection and nothing else — which
 * `operations` was the one exception to.
 */
const publicOperationsSchema = new mongoose.Schema(
    {
        donationsHeld: { type: Number, required: true },
        disputesRaised: { type: Number, required: true },
        disputesUpheld: { type: Number, required: true },
        // Null rather than zero when there are no disputes. A rate over no
        // disputes is not zero, it is unmeasured, and the difference is the
        // whole point of publishing the figure.
        disputeUpheldRate: { type: Number, default: null },
        materialisedAt: { type: Date, required: true },
        // A constant, uniquely indexed below. The replace above targets it, and
        // the index is what makes "at most one of these" a guarantee rather
        // than something the writer is trusted to maintain.
        singleton: { type: Boolean, default: true },
    },
    { timestamps: true },
);

publicOperationsSchema.index({ singleton: 1 }, { unique: true });

const PublicOperations = mongoose.model('PublicOperations', publicOperationsSchema);

const PublicAggregate = mongoose.model('PublicAggregate', publicAggregateSchema);

/**
 * The collection a rebuild is assembled in before it becomes the dataset.
 *
 * Building in place meant deleting every cell and then inserting the new ones,
 * with a window between the two in which the published dataset was empty — and
 * an empty dataset reads as an absence of donations, which is the one thing
 * this collection exists to avoid saying by accident. A build that failed in
 * that window left it empty until the next day's run.
 */
const BUILDING_COLLECTION = 'publicaggregates_building';

/**
 * What each rebuild did.
 *
 * A failed build leaves the previous dataset in place, which is the right
 * behaviour and an invisible one: the endpoint keeps answering and nothing says
 * the figures stopped being refreshed. This is where that is visible, and it is
 * why failures are recorded as well as successes.
 */
/**
 * The same schema, bound to the staging collection.
 *
 * A rebuild is written through this rather than through the raw driver, so that
 * it passes the same validation as every other write. The hook above is the one
 * place the "never a score" rule is enforced rather than trusted, and the
 * rebuild is precisely the writer it exists to check — inserting into staging
 * with the driver would skip it, and the collection would then become the
 * published dataset without anything having looked at it.
 *
 * Indexing is off: the staging collection is dropped and recreated by every
 * build, and the indexes that matter are the ones created on it just before the
 * swap, which the rename carries across.
 */
const PublicAggregateStaging = mongoose.model(
    'PublicAggregateStaging',
    publicAggregateSchema.clone().set('autoIndex', false),
    BUILDING_COLLECTION,
);

const publicDatasetBuildSchema = new mongoose.Schema(
    {
        startedAt: { type: Date, required: true },
        completedAt: { type: Date, default: null },
        outcome: { type: String, enum: ['success', 'failed'], required: true },
        cells: { type: Number, default: 0 },
        published: { type: Number, default: 0 },
        suppressed: { type: Number, default: 0 },
        sourceRecords: { type: Number, default: 0 },
        durationMs: { type: Number, default: null },
        error: { type: String, default: null },
    },
    { timestamps: false, collection: 'publicdatasetbuilds' },
);

publicDatasetBuildSchema.index({ completedAt: -1 });
publicDatasetBuildSchema.index({ outcome: 1, completedAt: -1 });

const PublicDatasetBuild = mongoose.model('PublicDatasetBuild', publicDatasetBuildSchema);

module.exports = {
    PublicAggregate,
    PublicOperations,
    PublicAggregateStaging,
    PublicDatasetBuild,
    BUILDING_COLLECTION,
    MIN_DONORS_PER_CELL,
    AMOUNT_ROUNDING_IDR,
};
