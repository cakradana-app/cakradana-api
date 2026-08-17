/**
 * What this service promises about staying up, and about what it loses when it
 * does not.
 *
 * The three numbers below are stated here rather than in a runbook because a
 * target nobody can read from the code is a target nobody is held to. Each one
 * describes the deployment that actually exists — a single MongoDB process and
 * a single API container, with no replica set, no standby, and no automated
 * failover — and each records what would have to change before it could be
 * tightened. A number promising more than the architecture can deliver is worse
 * than no number: it is read as a commitment and discovered as a fiction during
 * the first incident.
 *
 * The recovery point objective is the one with teeth. A donation record that is
 * lost is not merely a missing row: every cumulative rule computes over the
 * donations it can see, so a lost record silently *lowers* a donor's running
 * total. The statutory limit tests then clear a donor who was over the limit,
 * and nothing anywhere reports a failure. That is a false negative produced by
 * data loss, and it is invisible in every queue, every total, and every metric
 * this system publishes. Which is why the RPO is bounded by a backup interval
 * and why the age of the last backup is exposed as a metric rather than left to
 * whoever remembers to check.
 *
 * How much is truly unrecoverable also depends on the channel. A paper form or
 * a scraped page can be ingested again from the source document. A digital-form
 * submission exists nowhere but here: losing it means asking a submitter to
 * file again, and near a filing deadline that request may arrive after the
 * deadline has passed.
 */

const crypto = require('node:crypto');
const mongoose = require('mongoose');

/**
 * The stated objectives.
 *
 * Provisional in the same sense as the retention periods: they are the numbers
 * this deployment can currently defend, not the numbers anyone would prefer.
 */
const OBJECTIVES = Object.freeze({
    availability: Object.freeze({
        target: 0.995,
        window: 'calendar month',
        // 0.5% of a 30-day month.
        budgetMinutes: Math.round(30 * 24 * 60 * 0.005),
        measuredOn: 'the ingestion write path (POST /service/*/input) and the review queue',
        because:
            'one MongoDB process and one API container, so every restart, host reboot, ' +
            'and database upgrade is downtime rather than a failover; and the work this ' +
            'serves is filings arriving in batches and a queue worked by people in ' +
            'business hours, neither of which is harmed by minutes of unavailability the ' +
            'way a payment authorisation would be',
        toTighten:
            'a MongoDB replica set, so losing the primary is an election rather than an ' +
            'outage; more than one API instance; and a load balancer that removes an ' +
            'instance failing /ready. Until all three exist, a higher figure is an ' +
            'aspiration written in the present tense',
    }),

    rpo: Object.freeze({
        hours: 6,
        because:
            'this is a full-dump-only deployment, so the worst case is exactly the backup ' +
            'interval. Six hours bounds a loss to a fraction of one business day. A day ' +
            'would be worse than it sounds: a lost donation lowers a donor cumulative ' +
            'total, so an over-limit donor is cleared by the limit rules and nothing ' +
            'reports an error. Digital-form submissions in the lost window exist nowhere ' +
            'else and can only be recovered by asking the submitter to file again',
        toTighten:
            'continuous oplog capture, which requires a replica set. With one, the bound ' +
            'becomes seconds and stops depending on when the last dump ran',
    }),

    rto: Object.freeze({
        hours: 4,
        because:
            'recovery is a manual procedure: somebody is paged, a database is provisioned, ' +
            'scripts/restore.js runs, and its verification is read. At this data volume the ' +
            'restore itself is minutes — the hours are people and provisioning. Claiming ' +
            'one hour would be claiming an automation that does not exist',
        toTighten:
            'a warm standby that is already restored and already current, with promotion ' +
            'triggered rather than performed by hand',
    }),
});

/**
 * How backups are taken, and how long the artefacts live.
 *
 * The interval is the RPO: with full dumps and nothing else, they are the same
 * number, and stating them separately would invite one to drift from the other.
 */
const BACKUP_POLICY = Object.freeze({
    intervalHours: OBJECTIVES.rpo.hours,
    /**
     * Archives hold the same personal data the live store does, so they inherit
     * the same handling standard. Thirty days is long enough to survive a
     * corruption discovered late and short enough that an archive does not
     * become an unmanaged second copy of political-affiliation data.
     *
     * The consequence is stated in the restore procedure: restoring an archive
     * taken before a retention sweep reinstates records that sweep deleted, so
     * retention has to be re-run afterwards.
     */
    archiveRetentionDays: 30,
    /**
     * How often the restore is proven to work outside CI, against real data
     * volumes. CI proves the mechanism on every commit; only a drill against a
     * production-sized store proves the RTO.
     */
    drillIntervalDays: 30,
});

/**
 * What is dumped, and why each collection cannot simply be rebuilt.
 *
 * Written as data so the set can be read by a person deciding whether something
 * new belongs in it. The test for inclusion is not importance — it is whether
 * losing it destroys something no other system holds.
 */
const BACKUP_SET = Object.freeze([
    Object.freeze({
        collection: 'donations',
        model: () => require('./canonical.model').Donation,
        because:
            'the record itself. A missing donation lowers every cumulative total ' +
            'computed over it and raises no error anywhere',
    }),
    Object.freeze({
        collection: 'entities',
        model: () => require('./canonical.model').Entity,
        because:
            'resolution decisions, including merges a person reviewed. Rebuilt from ' +
            'names alone, a donor split across spellings becomes several donors, each ' +
            'under the limit the merge existed to enforce',
    }),
    Object.freeze({
        collection: 'labels',
        model: () => require('./canonical.model').Label,
        because:
            'human judgements. Nothing regenerates an analyst disposition, and every ' +
            'precision figure quoted for this system is computed from them',
    }),
    Object.freeze({
        collection: 'quarantines',
        model: () => require('./canonical.model').Quarantine,
        because:
            'records that were held rather than admitted. Losing them discards ' +
            'submissions that were never rejected, only set aside for review',
    }),
    Object.freeze({
        collection: 'scoringevents',
        model: () => require('./canonical.model').ScoringEvent,
        because:
            'the explanation of a score that may already have fed a regulatory ' +
            'process. Re-scoring later produces a different event, not the one that ' +
            'was acted on',
    }),
    Object.freeze({
        collection: 'services',
        model: () => require('../services/services.model').Service,
        because:
            'the legacy document, which holds donations that exist nowhere else until ' +
            'scripts/backfill-canonical.js has been run against this deployment. ' +
            'Ingestion no longer writes it, which makes it look derived; the rows ' +
            'written before the canonical collections existed were never copied ' +
            'anywhere, so for those it is the only copy. Excluding it would lose them ' +
            'in a restore and the backfill afterwards would report "nothing to move", ' +
            'which reads as success. `legacySingletonStatus` measures whether that is ' +
            'still true rather than assuming either answer',
    }),
    Object.freeze({
        collection: 'auditentries',
        model: () => require('./retention').AuditEntry,
        because:
            'the access log. A log that can be lost proves nothing about who read ' +
            'what, which is the only thing it is for',
    }),
    Object.freeze({
        collection: 'disputes',
        model: () => require('../services/disputes/dispute.model').Dispute,
        because:
            'a subject contesting an attribution, with deadlines that are already ' +
            'running. Losing one loses the contest and the clock on it',
    }),
    Object.freeze({
        collection: 'entityidentifiers',
        model: () => require('../identity/identifier.model').EntityIdentifier,
        because:
            'the strong identifiers that make an attribution certain, and the keyed ' +
            'hashes that let two records be recognised as one person. Nothing ' +
            'regenerates either: an identifier is recorded by somebody who saw a ' +
            'document. The values are encrypted at rest, so the archive is worth ' +
            'nothing without IDENTIFIER_KEY and IDENTIFIER_PEPPER — which are ' +
            'deliberately not in it, and without which a restore recovers records ' +
            'nobody can read',
    }),
    Object.freeze({
        collection: 'users',
        model: () => require('../users/user.model').User,
        because:
            'accounts and their roles. Without them nobody can sign in to work the ' +
            'queue, so this is part of the service being restored, not only the data',
    }),
]);

const BACKUP_RUN_COLLECTION = 'backupruns';

/**
 * Deliberately excluded, with the reason.
 *
 * Listed because an exclusion nobody wrote down is indistinguishable from an
 * oversight, and the next person to read the backup script should not have to
 * guess which one this was.
 */
const NOT_BACKED_UP = Object.freeze([
    Object.freeze({
        collection: 'publicaggregates',
        because:
            'materialised from donations on a schedule. Restoring it would restore a ' +
            'published view of data that may itself have been corrected in the meantime',
    }),
    Object.freeze({
        collection: 'jobs',
        because:
            'progress handles for uploads in flight. A job restored into a new ' +
            'process describes work that process never started',
    }),
    Object.freeze({
        collection: BACKUP_RUN_COLLECTION,
        because:
            'the history of backups taken against the store that was lost. Carried ' +
            'into a recovered store it would claim recoverable copies that describe ' +
            'a different database, which is the one claim a recovery must not inherit',
    }),
]);

/**
 * The shape an archive is expected to restore into.
 *
 * Bumped by hand when a canonical schema changes such that an older archive
 * would no longer restore into a usable store, and when the backup set itself
 * changes — an archive taken before a collection was added does not contain it,
 * and a restore that says so is better than one that silently omits it. Because
 * a version somebody has to remember to bump is a version that will be wrong at
 * least once, the manifest also records a fingerprint computed from the schemas
 * themselves, so a restore can report drift the constant did not.
 */
const SCHEMA_VERSION = '2026.08.3';

/**
 * A digest over the declared field paths of every backed-up collection.
 *
 * Not a migration mechanism and not a guarantee of compatibility: it detects
 * that the shape changed, which is enough to turn a silent partial restore into
 * a stated warning.
 */
function schemaFingerprint() {
    const hash = crypto.createHash('sha256');
    for (const entry of BACKUP_SET) {
        const paths = Object.keys(entry.model().schema.paths).sort();
        hash.update(`${entry.collection}:${paths.join(',')}\n`);
    }
    return hash.digest('hex').slice(0, 16);
}

/**
 * The record of a backup having run.
 *
 * Written into the database rather than left on the backup host's disk, because
 * the question "when did we last have a recoverable copy" is asked from the
 * service, by a dashboard and by an alert, neither of which can see that disk.
 *
 * Failed runs are recorded too. A run that fails and writes nothing is
 * indistinguishable from a run that was never scheduled, and those call for
 * different responses.
 */
const backupRunSchema = new mongoose.Schema(
    {
        startedAt: { type: Date, required: true },
        completedAt: { type: Date, default: null },
        outcome: { type: String, enum: ['success', 'failed'], required: true },
        // Where the archive was written. Recorded so a restore can be pointed
        // at it without anyone having to guess the naming convention.
        archive: { type: String, default: null },
        documents: { type: Number, default: 0 },
        collections: { type: Number, default: 0 },
        schemaVersion: { type: String, default: null },
        schemaFingerprint: { type: String, default: null },
        durationMs: { type: Number, default: null },
        error: { type: String, default: null },
    },
    { timestamps: false, collection: BACKUP_RUN_COLLECTION },
);

backupRunSchema.index({ completedAt: -1 });
backupRunSchema.index({ outcome: 1, completedAt: -1 });

const BackupRun = mongoose.model('BackupRun', backupRunSchema);

/** The most recent run that produced a verified archive, or null if there has never been one. */
async function lastSuccessfulBackup() {
    return BackupRun.findOne({ outcome: 'success' }).sort({ completedAt: -1 }).lean();
}

/**
 * Whether the RPO is currently being met, and by how much margin.
 *
 * Three outcomes rather than a boolean. `unknown` means the store could not be
 * read, which is not the same as a breach and must not be reported as one — an
 * alert that fires identically for "the backups stopped" and "the monitoring
 * stopped" trains people to check the wrong thing first. `never` is separated
 * from `breaching` for the same reason: a deployment that has never taken a
 * backup is a configuration that was never finished, not a schedule that
 * slipped.
 */
async function rpoStatus({ now = new Date() } = {}) {
    const objectiveHours = OBJECTIVES.rpo.hours;
    let last;
    try {
        last = await lastSuccessfulBackup();
    } catch (error) {
        return {
            state: 'unknown',
            objectiveHours,
            lastBackupAt: null,
            ageHours: null,
            reason: `the backup record could not be read: ${error.message}`,
        };
    }

    if (!last || !last.completedAt) {
        return {
            state: 'never',
            objectiveHours,
            lastBackupAt: null,
            ageHours: null,
            reason:
                'no backup has ever completed, so everything since this deployment ' +
                'started is unrecoverable',
        };
    }

    const ageHours = (now.getTime() - new Date(last.completedAt).getTime()) / 3_600_000;
    return {
        state: ageHours <= objectiveHours ? 'meeting' : 'breaching',
        objectiveHours,
        lastBackupAt: new Date(last.completedAt).toISOString(),
        ageHours: Number(ageHours.toFixed(3)),
        archive: last.archive || null,
        documents: last.documents ?? null,
        reason:
            ageHours <= objectiveHours
                ? null
                : `the last backup is ${ageHours.toFixed(1)}h old against a ${objectiveHours}h objective`,
    };
}

/**
 * Whether the legacy document still holds anything that exists nowhere else.
 *
 * Ingestion stopped writing it, which makes it look derived — and it is, for
 * every row written while both stores were being updated. It is not derived for
 * the rows written before the canonical collections existed: those were never
 * copied anywhere, and `scripts/backfill-canonical.js` is what moves them.
 * Until that has run against a deployment, the legacy document is the only copy
 * of those donations.
 *
 * That distinction cannot be assumed either way, because getting it wrong in
 * the safe-sounding direction loses data in silence: a restore from an archive
 * that skipped the singleton drops those donations, and a backfill run
 * afterwards finds an empty document and reports "nothing to move", which reads
 * as success. So it is measured. Zero legacy-only rows means the document
 * really is derived and could be dropped from the backup set; anything above
 * zero means it is load-bearing and must not be.
 *
 * "Legacy-only" is defined the way the backfill defines it: a row in the
 * document whose `_id` appears in no `Donation.legacyDonationId`.
 */
const LEGACY_SINGLETON_CACHE_MS = 5 * 60 * 1000;
let legacyStatusCache = null;

async function legacySingletonStatus({ maxAgeMs = LEGACY_SINGLETON_CACHE_MS } = {}) {
    if (legacyStatusCache && Date.now() - legacyStatusCache.at < maxAgeMs) {
        return { ...legacyStatusCache.value, cached: true };
    }

    let value;
    try {
        const { Service } = require('../services/services.model');
        const { Donation } = require('./canonical.model');

        // Projected to the ids alone. The document this reads can approach
        // MongoDB's sixteen-megabyte limit — that ceiling is why it is being
        // retired — and the lookup below is unindexed, so the pair is cached
        // rather than recomputed on every metrics scrape. The number changes
        // only when a backfill runs. Both sides are bounded by the same
        // ceiling: there is at most one link per row the document can hold.
        const document = await Service.findOne().select('donations._id').lean();
        if (!document) {
            value = {
                state: 'absent',
                held: 0,
                migrated: 0,
                legacyOnly: 0,
                because:
                    'this deployment has no legacy document, so the collection is ' +
                    'backed up empty and nothing depends on it',
            };
        } else {
            const rows = document.donations || [];
            const migratedIds = new Set(
                (
                    await Donation.find({ legacyDonationId: { $ne: null } })
                        .select('legacyDonationId')
                        .lean()
                ).map((donation) => String(donation.legacyDonationId)),
            );
            const legacyOnly = rows.filter(
                (row) => !migratedIds.has(String(row._id)),
            ).length;

            value = {
                state: legacyOnly > 0 ? 'load-bearing' : 'derived',
                held: rows.length,
                migrated: rows.length - legacyOnly,
                legacyOnly,
                because:
                    legacyOnly > 0
                        ? `${legacyOnly} of ${rows.length} rows in the legacy document have no ` +
                          'canonical counterpart and exist nowhere else. Run ' +
                          '`npm run backfill -- --apply` to move them; until then the ' +
                          'legacy collection is load-bearing and a backup that omitted it ' +
                          'would lose those donations'
                        : 'every row in the legacy document has a canonical counterpart, so ' +
                          'the document is derived. It stays in the backup set until it is ' +
                          'dropped from the deployment, because a row arriving in it later ' +
                          'would otherwise be unprotected',
            };
        }
    } catch (error) {
        // Not zero. A count that could not be read and a count that is zero
        // lead to opposite decisions about whether the singleton can be
        // dropped from the backup set.
        return {
            state: 'unknown',
            held: null,
            migrated: null,
            legacyOnly: null,
            because: `the legacy document could not be read: ${error.message}`,
            cached: false,
        };
    }

    legacyStatusCache = { at: Date.now(), value };
    return { ...value, cached: false };
}

/** Forget the cached reading. For tests, and for a caller that has just run a backfill. */
function forgetLegacySingletonStatus() {
    legacyStatusCache = null;
}

/**
 * The objectives and the current position against them, in one object.
 *
 * Serves the monitoring endpoint and the readiness probe. It carries the stated
 * reasoning as well as the numbers: a dashboard showing "RPO 6h" without saying
 * what makes six defensible invites somebody to change it to one.
 */
async function resilienceReport({ now = new Date() } = {}) {
    return {
        objectives: OBJECTIVES,
        backupPolicy: BACKUP_POLICY,
        schemaVersion: SCHEMA_VERSION,
        schemaFingerprint: schemaFingerprint(),
        backupSet: BACKUP_SET.map(({ collection, because }) => ({ collection, because })),
        notBackedUp: NOT_BACKED_UP,
        rpo: await rpoStatus({ now }),
        // Measured, never assumed. Whether the legacy document is a second copy
        // or the only copy decides whether omitting it from a backup loses
        // donations, and the answer changes when a backfill runs.
        legacySingleton: await legacySingletonStatus({ maxAgeMs: 0 }),
        // Said plainly, because the gap between "we have backups" and "we can
        // recover" is where recovery plans usually fail.
        notCovered: [
            'no multi-region deployment; the loss of the hosting region is not covered by these objectives',
            'no automated failover; every recovery starts with a person being paged',
            'backups are scheduled by the operator, not by this process, so a schedule that was never created reports as `never` here rather than failing anywhere',
        ],
    };
}

module.exports = {
    OBJECTIVES,
    BACKUP_POLICY,
    BACKUP_SET,
    NOT_BACKED_UP,
    SCHEMA_VERSION,
    BACKUP_RUN_COLLECTION,
    BackupRun,
    schemaFingerprint,
    lastSuccessfulBackup,
    rpoStatus,
    legacySingletonStatus,
    forgetLegacySingletonStatus,
    resilienceReport,
};
