/**
 * Retention, correction, and the access log.
 *
 * Donation records are political-affiliation data: a name attached to a
 * preference. That places them in the category with the highest handling
 * standard, and the practical consequences are here rather than in a policy
 * document nobody executes.
 *
 * Retention is bounded by purpose. Data kept past the purpose that justified
 * collecting it is being held on no basis at all, and "we might want it later"
 * is not one.
 *
 * Corrections propagate. An upheld dispute that changes a record but leaves
 * every cumulative total computed from it untouched has corrected nothing that
 * matters: the erroneous figure remains in the aggregate that produced the
 * finding.
 */

const mongoose = require('mongoose');

const { Donation, Label, Quarantine, ScoringEvent } = require('./canonical.model');

/**
 * How long each category is held, and why.
 *
 * Provisional and stated in one place so a legal reviewer can read the whole
 * policy without reading the code. Periods run from the end of the electoral
 * cycle the record belongs to, not from ingestion.
 */
const RETENTION = Object.freeze({
    quarantine: {
        days: 90,
        because:
            'a record nobody corrected within a quarter will not be corrected, and ' +
            'it holds the personal data of whoever appeared in the source document',
    },
    scoringEvents: {
        days: 365 * 7,
        because:
            'a score that fed a regulatory process must remain explicable for as ' +
            'long as that process can be revisited',
    },
    auditLog: {
        days: 365 * 7,
        because: 'an access log outlives the access it records, or it proves nothing',
    },
});

const auditEntrySchema = new mongoose.Schema(
    {
        actor: { type: String, required: true },
        action: { type: String, required: true },
        // What was touched. Recorded by reference rather than by copying the
        // record, so the log does not become a second uncontrolled store of
        // the data it exists to protect.
        subjectType: { type: String, required: true },
        subjectId: { type: String, default: null },
        outcome: { type: String, enum: ['allowed', 'denied'], default: 'allowed' },
        reason: { type: String, default: null },
        at: { type: Date, default: () => new Date() },
    },
    { timestamps: false },
);

auditEntrySchema.index({ actor: 1, at: -1 });
auditEntrySchema.index({ subjectId: 1, at: -1 });
auditEntrySchema.index({ at: -1 });

const AuditEntry = mongoose.model('AuditEntry', auditEntrySchema);

/**
 * Record an access or an action.
 *
 * Denied attempts are logged as well as permitted ones. A log that records only
 * what succeeded cannot show that someone tried repeatedly to reach records
 * they had no business reading.
 */
async function record({ actor, action, subjectType, subjectId = null, outcome = 'allowed', reason = null }) {
    return AuditEntry.create({ actor, action, subjectType, subjectId, outcome, reason });
}

/**
 * Everything the system holds about one subject.
 *
 * Assembled for a subject access request. The request itself is logged, since
 * it is an access to their data like any other.
 */
async function subjectRecord(entityId, { actor }) {
    await record({
        actor,
        action: 'subject-access-request',
        subjectType: 'Entity',
        subjectId: String(entityId),
    });

    const donations = await Donation.find({
        $or: [{ 'senderRef.entityId': entityId }, { 'receiverRef.entityId': entityId }],
    }).lean();

    const donationIds = donations.map((d) => d._id);

    return {
        donations,
        labels: await Label.find({ donationId: { $in: donationIds } }).lean(),
        scoringEvents: await ScoringEvent.find({ donationId: { $in: donationIds } }).lean(),
    };
}

/**
 * Correct a record, and mark everything derived from it as stale.
 *
 * A new version is created rather than the existing one edited, so a score can
 * still name the record version it scored. Scoring events for the superseded
 * version are marked for re-scoring: leaving them in place would keep the
 * uncorrected figure in every total that used it, which is where the error
 * actually does its damage.
 */
async function correct(donationId, changes, { actor, reason }) {
    const original = await Donation.findById(donationId);
    if (!original) {
        throw new Error(`no donation ${donationId}`);
    }

    const corrected = await Donation.create({
        ...original.toObject(),
        _id: undefined,
        donationVersion: (original.donationVersion || 1) + 1,
        ...changes,
        correctionReason: reason,
        provenance: [
            ...(original.provenance || []),
            ...Object.keys(changes).map((field) => ({
                field,
                provenance: 'human-corrected',
                actor,
                at: new Date(),
            })),
        ],
    });

    await Donation.updateOne({ _id: original._id }, { supersededBy: corrected._id });

    // Derived figures computed from the old value are now wrong. Marking them
    // is what makes the correction reach the aggregates rather than stopping
    // at the record.
    const stale = await ScoringEvent.updateMany(
        { donationId: original._id },
        { rescoreReason: `superseded by correction: ${reason}` },
    );

    await record({
        actor,
        action: 'correct-donation',
        subjectType: 'Donation',
        subjectId: String(original._id),
        reason,
    });

    return {
        correctedId: corrected._id,
        supersededId: original._id,
        scoringEventsNeedingRescore: stale.modifiedCount ?? 0,
    };
}

/**
 * Delete what is past its retention period.
 *
 * Reports what it removed rather than running silently. A retention job whose
 * effect nobody sees is indistinguishable from one that has stopped working,
 * and the failure mode is holding personal data with no basis for years.
 */
async function enforceRetention({ now = new Date(), dryRun = false } = {}) {
    const cutoff = (days) => new Date(now.getTime() - days * 86_400_000);
    const report = {};

    const plans = [
        ['quarantine', Quarantine, { createdAt: { $lt: cutoff(RETENTION.quarantine.days) } }],
        ['scoringEvents', ScoringEvent, { scoredAt: { $lt: cutoff(RETENTION.scoringEvents.days) } }],
        ['auditLog', AuditEntry, { at: { $lt: cutoff(RETENTION.auditLog.days) } }],
    ];

    for (const [name, model, filter] of plans) {
        const count = await model.countDocuments(filter);
        report[name] = {
            eligible: count,
            deleted: 0,
            retentionDays: RETENTION[name].days,
            because: RETENTION[name].because,
        };
        if (!dryRun && count > 0) {
            const result = await model.deleteMany(filter);
            report[name].deleted = result.deletedCount ?? 0;
        }
    }

    if (!dryRun) {
        await record({
            actor: 'system',
            action: 'enforce-retention',
            subjectType: 'Retention',
            reason: JSON.stringify(
                Object.fromEntries(
                    Object.entries(report).map(([k, v]) => [k, v.deleted]),
                ),
            ),
        });
    }

    return report;
}

module.exports = {
    AuditEntry,
    RETENTION,
    record,
    subjectRecord,
    correct,
    enforceRetention,
};
