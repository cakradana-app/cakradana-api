/**
 * Canonical collections.
 *
 * Donations and entities are independent documents. They previously lived as
 * two embedded arrays inside a single document, which caps the entire system
 * at MongoDB's 16 MB per-document limit — orders of magnitude below the volume
 * this is meant to hold, and a ceiling that arrives as a write failure rather
 * than as a warning.
 *
 * These collections are added alongside the existing document rather than
 * replacing it. The deployed service keeps reading and writing what it always
 * did; ingestion now writes both, so the canonical store fills up without
 * anything currently running having to change first.
 */

const mongoose = require('mongoose');

const {
    ENTITY_TYPES,
    CHANNELS,
    TRANSACTION_KINDS,
    TEMPORAL_PRECISIONS,
    PROVENANCE,
    IDENTITY_ABSENCE,
    LABEL_SOURCES,
    LABEL_VALUES,
} = require('../vocabulary');

/**
 * A reference to an entity, resolved or not.
 *
 * Unresolved references keep the raw observed text and are never treated as an
 * identity. Grouping by name would let a donor split across spellings form
 * separate groups and slip under a cumulative limit, which is the behaviour
 * those limits exist to catch.
 */
const entityRefSchema = new mongoose.Schema(
    {
        entityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', default: null },
        rawText: { type: String, default: null },
        entityType: { type: String, enum: ENTITY_TYPES, default: 'unknown' },
        resolutionConfidence: { type: Number, min: 0, max: 1, default: null },
    },
    { _id: false },
);

const fieldProvenanceSchema = new mongoose.Schema(
    {
        field: { type: String, required: true },
        provenance: { type: String, enum: PROVENANCE, required: true },
        confidence: { type: Number, min: 0, max: 1, default: null },
        extractorVersion: { type: String, default: null },
        // The exact source substring a value was read from. Without it a
        // subject cannot meaningfully contest an attribution: they can be told
        // what the system believes but not shown where it got it.
        sourceSpan: { type: String, default: null },
        actor: { type: String, default: null },
        at: { type: Date, default: null },
    },
    { _id: false },
);

const donationSchema = new mongoose.Schema(
    {
        donationVersion: { type: Number, default: 1, min: 1 },
        senderRef: { type: entityRefSchema, required: true },
        receiverRef: { type: entityRefSchema, required: true },

        amountIdr: { type: Number, required: true, min: 1 },
        // Retained whenever parsing was not unambiguous. Digit-grouping
        // conventions differ and a misread separator moves the value by three
        // orders of magnitude.
        amountRaw: { type: String, default: null },

        // When the donation happened, and when the system learned of it.
        // A single date cannot express both, and point-in-time feature
        // computation depends on knowing what was knowable when.
        occurredAt: { type: Date, required: true },
        occurredAtPrecision: { type: String, enum: TEMPORAL_PRECISIONS, default: 'day' },
        recordedAt: { type: Date, required: true },

        transactionKind: { type: String, enum: TRANSACTION_KINDS, default: 'unknown' },
        channel: { type: String, enum: CHANNELS, required: true },
        electoralContext: { type: String, default: null },
        isSelfFundedDeclared: { type: Boolean, default: null },
        identityAbsence: { type: String, enum: IDENTITY_ABSENCE, default: null },

        sourceDocument: {
            kind: { type: String, default: null },
            reference: { type: String, default: null },
            retrievedAt: { type: Date, default: null },
            page: { type: Number, default: null },
        },
        provenance: { type: [fieldProvenanceSchema], default: [] },

        // Deterministic key over the resolved parties, amount, date at its
        // stated precision, and electoral context. Double-counting a donation
        // inflates cumulative totals and can manufacture a statutory finding
        // that did not occur.
        dedupKey: { type: String, required: true },
        corroboratedBy: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Donation' }],
            default: [],
        },

        // Records are never edited in place. A correction is a new version
        // with an author and a reason, and the prior version stays retrievable
        // so a score can name the record version it scored.
        supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation', default: null },
        correctionReason: { type: String, default: null },

        // Retained so the existing document and the canonical store can be
        // reconciled while both are being written.
        legacyDonationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    { timestamps: true },
);

donationSchema.index({ dedupKey: 1 });
donationSchema.index({ 'senderRef.entityId': 1, occurredAt: 1 });
donationSchema.index({ 'receiverRef.entityId': 1, occurredAt: 1 });
donationSchema.index({ electoralContext: 1, occurredAt: 1 });
donationSchema.index({ recordedAt: 1 });

const identifierSchema = new mongoose.Schema(
    {
        scheme: { type: String, required: true },
        // A surrogate reference, never the identifier itself. Strong
        // identifiers are held separately with their own access control, and
        // feature computation and training see only the surrogate.
        valueRef: { type: String, required: true },
        validated: { type: Boolean, default: false },
    },
    { _id: false },
);

const entitySchema = new mongoose.Schema(
    {
        canonicalName: { type: String, required: true },
        normalisedName: { type: String, required: true },
        aliases: { type: [String], default: [] },
        entityType: { type: String, enum: ENTITY_TYPES, default: 'unknown' },
        identifiers: { type: [identifierSchema], default: [] },
        // Never inferred from a name. Name-based nationality inference is
        // unreliable and discriminatory, and here it would attach a statutory
        // offence to someone on the basis of what they are called.
        jurisdiction: { type: String, default: null },
        registers: { type: [String], default: [] },
        firstSeen: { type: Date, default: null },
        lastSeen: { type: Date, default: null },
        // Every merge records its basis, confidence, and actor, and is
        // reversible. An incorrect merge attributes one person's donations to
        // another, which the affected subject must be able to contest.
        mergeHistory: {
            type: [
                new mongoose.Schema(
                    {
                        mergedEntityId: mongoose.Schema.Types.ObjectId,
                        basis: String,
                        confidence: Number,
                        actor: String,
                        at: Date,
                    },
                    { _id: false },
                ),
            ],
            default: [],
        },
    },
    { timestamps: true },
);

entitySchema.index({ normalisedName: 1, entityType: 1 });
entitySchema.index({ aliases: 1 });
entitySchema.index({ registers: 1 });

const labelSchema = new mongoose.Schema(
    {
        donationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation', required: true },
        donationVersion: { type: Number, required: true, min: 1 },
        value: { type: String, enum: LABEL_VALUES, required: true },
        source: { type: String, enum: LABEL_SOURCES, required: true },
        typology: { type: String, default: null },
        confidence: { type: Number, min: 0, max: 1, default: null },
        weight: { type: Number, min: 0, max: 1, required: true },
        actor: { type: String, default: null },
        note: { type: String, default: null },
        // Later labels supersede earlier ones without deleting them, so a
        // disposition history stays reconstructible.
        supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Label', default: null },
    },
    { timestamps: true },
);

labelSchema.index({ donationId: 1, createdAt: -1 });
labelSchema.index({ source: 1 });

/**
 * A recipient confirming a donation establishes that the transaction
 * occurred. That is a different claim from the transaction being legitimate,
 * and the difference matters most exactly where this system is most useful: a
 * smurfed donation is genuinely received, and its recipient confirms it
 * truthfully. Admitting confirmations as negative labels would teach a model
 * that verified splitting is clean.
 */
labelSchema.pre('validate', function guardConfirmation(next) {
    if (this.source === 'recipient_confirmation' && this.value !== 'indeterminate') {
        return next(
            new Error(
                'a recipient confirmation records that a donation occurred, not that it is ' +
                    'low risk; only an analyst disposition or an adjudicated dispute may carry ' +
                    'a risk value',
            ),
        );
    }
    return next();
});

const quarantineSchema = new mongoose.Schema(
    {
        channel: { type: String, enum: CHANNELS, required: true },
        // Why this record could not be admitted, in terms an operator can act
        // on. A quarantine with no reason is indistinguishable from data loss.
        reason: { type: String, required: true },
        detail: { type: [String], default: [] },
        payload: { type: mongoose.Schema.Types.Mixed, default: null },
        sourceReference: { type: String, default: null },
        resolvedAt: { type: Date, default: null },
        resolvedBy: { type: String, default: null },
    },
    { timestamps: true },
);

quarantineSchema.index({ createdAt: -1 });
quarantineSchema.index({ resolvedAt: 1 });

const scoringEventSchema = new mongoose.Schema(
    {
        donationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation', required: true },
        donationVersion: { type: Number, required: true },
        scoredAt: { type: Date, required: true },
        // Versions are stored with every event. A score that cannot name the
        // model, rules, and feature definitions behind it cannot be explained
        // later, and this system's output feeds processes where that gets
        // asked.
        modelVersion: { type: String, default: null },
        ruleSetVersion: { type: String, required: true },
        featureSetVersion: { type: String, required: true },
        legalFindings: { type: mongoose.Schema.Types.Mixed, default: [] },
        indeterminateRules: { type: mongoose.Schema.Types.Mixed, default: [] },
        behavioural: { type: mongoose.Schema.Types.Mixed, default: null },
        rescoreReason: { type: String, default: null },
    },
    { timestamps: true },
);

scoringEventSchema.index({ donationId: 1, scoredAt: -1 });
scoringEventSchema.index({ scoredAt: -1 });

const Donation = mongoose.model('Donation', donationSchema);
const Entity = mongoose.model('Entity', entitySchema);
const Label = mongoose.model('Label', labelSchema);
const Quarantine = mongoose.model('Quarantine', quarantineSchema);
const ScoringEvent = mongoose.model('ScoringEvent', scoringEventSchema);

module.exports = { Donation, Entity, Label, Quarantine, ScoringEvent };
