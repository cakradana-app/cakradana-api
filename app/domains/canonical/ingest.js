/**
 * The single ingestion path.
 *
 * Digital submissions, scanned forms, and scraped pages all arrive here. Each
 * previously carried its own copy of "push a donation, then add the parties if
 * their names are not already present", which meant three places to fix
 * anything and three chances for them to disagree.
 *
 * A record that cannot be admitted is quarantined with a reason rather than
 * dropped. One unusable row does not fail the batch: the batch has already
 * cost an upload, an OCR pass, and a model call, and discarding the readable
 * rows alongside the unreadable one loses information the source did contain.
 *
 * Writes go to both the canonical collections and the existing document. The
 * deployed service keeps working unchanged while the canonical store fills in
 * behind it.
 */

const crypto = require('node:crypto');

const { Donation, Entity, Label, Quarantine } = require('./canonical.model');
const { resolveEntity } = require('./resolution');
const {
    raise: raiseResolutionReview,
} = require('../services/entities/resolution-review.controller');
const { Service } = require('../services/services.model');
const { CHANNELS, TEMPORAL_PRECISIONS } = require('../vocabulary');

/**
 * Truncate a timestamp to the precision the source actually stated.
 *
 * A scanned form usually yields a date with no time. Treating that as midnight
 * invents a time of day, and enough such records create a spike at midnight
 * that looks like coordinated timing — the very signal the behavioural rules
 * test for.
 */
function truncateToPrecision(date, precision) {
    const copy = new Date(date.getTime());
    switch (precision) {
        case 'day':
            copy.setUTCHours(0, 0, 0, 0);
            break;
        case 'hour':
            copy.setUTCMinutes(0, 0, 0);
            break;
        case 'minute':
            copy.setUTCSeconds(0, 0);
            break;
        default:
            copy.setUTCMilliseconds(0);
    }
    return copy;
}

function buildDedupKey({ senderId, receiverId, amountIdr, occurredAt, precision, electoralContext }) {
    const stamp = truncateToPrecision(occurredAt, precision).toISOString();
    const parts = [
        senderId ? String(senderId) : 'unresolved',
        receiverId ? String(receiverId) : 'unresolved',
        String(amountIdr),
        stamp,
        electoralContext || 'none',
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Check a candidate before anything is written.
 *
 * Returns the problems rather than throwing on the first, so a quarantined
 * record carries everything wrong with it and can be corrected in one pass.
 */
function validate(candidate) {
    const problems = [];

    if (!Number.isInteger(candidate.amountIdr) || candidate.amountIdr <= 0) {
        problems.push('amount is missing or not a positive whole number of rupiah');
    }
    if (!(candidate.occurredAt instanceof Date) || Number.isNaN(candidate.occurredAt.getTime())) {
        problems.push('the date the donation occurred is missing or unreadable');
    }
    if (!CHANNELS.includes(candidate.channel)) {
        problems.push(`channel '${candidate.channel}' is not one this system ingests`);
    }
    if (candidate.occurredAtPrecision && !TEMPORAL_PRECISIONS.includes(candidate.occurredAtPrecision)) {
        problems.push(`date precision '${candidate.occurredAtPrecision}' is not recognised`);
    }
    if (!candidate.receiverName && !candidate.receiverId) {
        problems.push('no recipient is identified, so the donation cannot be attributed');
    }

    if (
        candidate.recordedAt instanceof Date &&
        candidate.occurredAt instanceof Date &&
        candidate.recordedAt < candidate.occurredAt
    ) {
        problems.push(
            'the system is recorded as having learned of this donation before it happened',
        );
    }

    return problems;
}

/**
 * Admit one donation.
 *
 * Resolves both parties, deduplicates, writes the canonical record, and mirrors
 * it into the existing document. Returns what happened rather than throwing, so
 * a caller processing a page can report per row.
 */
async function ingestOne(candidate, options = {}) {
    const { legacyService = null, actor = null } = options;

    const problems = validate(candidate);
    if (problems.length) {
        const quarantined = await Quarantine.create({
            channel: CHANNELS.includes(candidate.channel) ? candidate.channel : 'import',
            reason: 'failed validation before persistence',
            detail: problems,
            payload: candidate.raw || null,
            sourceReference: candidate.sourceReference || null,
        });
        return { status: 'quarantined', problems, quarantineId: quarantined._id };
    }

    const recordedAt = candidate.recordedAt instanceof Date ? candidate.recordedAt : new Date();

    const sender = await resolveEntity(candidate.senderName, candidate.senderType, {
        observedAt: candidate.occurredAt,
    });
    const receiver = await resolveEntity(candidate.receiverName, candidate.receiverType, {
        observedAt: candidate.occurredAt,
    });

    const dedupKey = buildDedupKey({
        senderId: sender.entity?._id,
        receiverId: receiver.entity?._id,
        amountIdr: candidate.amountIdr,
        occurredAt: candidate.occurredAt,
        precision: candidate.occurredAtPrecision || 'day',
        electoralContext: candidate.electoralContext,
    });

    // The same donation reaching us through two channels is one donation.
    // Counting it twice inflates a donor's running total and can manufacture a
    // limit breach that never happened.
    const existing = await Donation.findOne({ dedupKey });
    if (existing) {
        // A duplicate from a source we have not heard from before is
        // corroboration; the same document arriving twice is not. Only the
        // first is recorded, because counting a re-upload would let a single
        // source manufacture its own confirmation.
        const corroborating = isIndependentSource(existing, candidate);
        if (corroborating) {
            // Swallowed deliberately. The donation already exists and is
            // correct; a failed corroboration note is a lost annotation, and
            // throwing here would quarantine a record that needed nothing and
            // send an operator to review it.
            await Donation.updateOne(
                { _id: existing._id },
                {
                    $push: {
                        corroboration: {
                            channel: candidate.channel,
                            sourceReference: candidate.sourceReference || null,
                            retrievedAt: candidate.retrievedAt || null,
                            observedAt: recordedAt,
                        },
                    },
                },
            ).catch((error) => {
                console.error('recording corroboration failed:', error);
            });
        }
        return {
            status: 'duplicate',
            donationId: existing._id,
            dedupKey,
            corroborating,
            // The count includes the original observation, so a record only
            // one source has ever mentioned reads as 1 rather than 0.
            sources: (existing.corroboration?.length || 0) + (corroborating ? 2 : 1),
        };
    }

    const donation = await Donation.create({
        senderRef: {
            entityId: sender.entity?._id || null,
            rawText: candidate.senderName || null,
            entityType: candidate.senderType || 'unknown',
            resolutionConfidence: sender.entity ? sender.confidence : null,
        },
        receiverRef: {
            entityId: receiver.entity?._id || null,
            rawText: candidate.receiverName || null,
            entityType: candidate.receiverType || 'unknown',
            resolutionConfidence: receiver.entity ? receiver.confidence : null,
        },
        amountIdr: candidate.amountIdr,
        amountRaw: candidate.amountRaw || null,
        occurredAt: candidate.occurredAt,
        occurredAtPrecision: candidate.occurredAtPrecision || 'day',
        recordedAt,
        transactionKind: candidate.transactionKind || 'unknown',
        channel: candidate.channel,
        electoralContext: candidate.electoralContext || null,
        isSelfFundedDeclared: candidate.isSelfFundedDeclared ?? null,
        identityAbsence: candidate.identityAbsence || null,
        sourceDocument: {
            kind: candidate.sourceKind || candidate.channel,
            reference: candidate.sourceReference || null,
            retrievedAt: candidate.retrievedAt || recordedAt,
            page: candidate.page ?? null,
        },
        provenance: candidate.provenance || [],
        dedupKey,
    });

    const mirrored = await mirrorToLegacy(candidate, legacyService);

    if (mirrored?.legacyId) {
        await Donation.updateOne({ _id: donation._id }, { legacyDonationId: mirrored.legacyId });
    }

    // A near match that reaches nobody is a near match that never gets
    // decided, and until it is, the cumulative rules count one donor as two.
    // Raising is deliberately unable to fail the ingestion: the donation is
    // worth more than the queue entry, and the pair recurs on the next record.
    // Wrapped here as well as inside `raise`. The guard clauses and the module
    // resolution both sit outside that function's own try, and this runs after
    // the donation is already persisted — an error escaping would quarantine a
    // record that was admitted successfully.
    try {
        await Promise.all([
            raiseResolutionReview({
                resolution: sender,
                donationId: donation._id,
                observedName: candidate.senderName,
                actor,
            }),
            raiseResolutionReview({
                resolution: receiver,
                donationId: donation._id,
                observedName: candidate.receiverName,
                actor,
            }),
        ]);
    } catch (error) {
        console.error('raising a resolution review failed:', error);
    }

    return {
        status: 'ingested',
        donationId: donation._id,
        dedupKey,
        // Only counts what actually reached the queue. A name that folds to
        // nothing — "PT", "CV" — is flagged for review by the resolver but has
        // no candidate to compare against, so no review is raised. Counting it
        // reproduced the defect the queue was built to fix: a number on the
        // upload response with nowhere for the work to happen.
        needsEntityReview: Boolean(
            (sender.requiresReview && sender.candidate) ||
                (receiver.requiresReview && receiver.candidate),
        ),
        unresolvableNames: [
            sender.basis === 'no-identifying-tokens' ? candidate.senderName : null,
            receiver.basis === 'no-identifying-tokens' ? candidate.receiverName : null,
        ].filter(Boolean),
        senderResolution: sender.basis,
        receiverResolution: receiver.basis,
        actor,
    };
}

/**
 * Mirror a donation into the existing document.
 *
 * The document is created when absent rather than only updated when present.
 * The previous ingestion created an empty one on first use and then took the
 * branch that writes nothing, so the very first upload against a fresh
 * database was accepted, reported as successful, and silently discarded.
 */
async function mirrorToLegacy(candidate, provided) {
    let service = provided;
    if (!service) {
        service = await Service.findOne();
        if (!service) {
            service = await Service.create({ entities: [], donations: [] });
        }
    }

    service.donations.push({
        sender: candidate.senderName || null,
        receiver: candidate.receiverName || null,
        amount: candidate.amountIdr,
        date: candidate.occurredAt,
        type: candidate.channel === 'import' ? 'digital-form' : candidate.channel,
    });

    for (const [name, type] of [
        [candidate.senderName, candidate.senderType],
        [candidate.receiverName, candidate.receiverType],
    ]) {
        if (typeof name !== 'string' || name.trim() === '') continue;
        if (service.entities.some((entity) => entity.name === name.trim())) continue;
        service.entities.push({
            name: name.trim(),
            // The existing document's vocabulary is narrower than the shared
            // one. A value it cannot store is omitted rather than coerced into
            // a neighbouring category that would be wrong.
            type: LEGACY_ENTITY_TYPES.has(type) ? type : undefined,
        });
    }

    await service.save();
    const legacyId = service.donations[service.donations.length - 1]?._id || null;
    return { service, legacyId };
}

const LEGACY_ENTITY_TYPES = new Set([
    'individual', 'corporation', 'organization', 'political-party', 'government', 'other',
]);

/**
 * Admit a batch, reporting per row.
 */
async function ingestBatch(candidates, options = {}) {
    const results = [];
    let service = null;

    for (const candidate of candidates) {
        try {
            if (!service) {
                service = await Service.findOne();
                if (!service) service = await Service.create({ entities: [], donations: [] });
            }
            const outcome = await ingestOne(candidate, { ...options, legacyService: service });
            results.push(outcome);
        } catch (error) {
            const quarantined = await Quarantine.create({
                channel: CHANNELS.includes(candidate.channel) ? candidate.channel : 'import',
                reason: 'ingestion failed',
                detail: [error.message],
                payload: candidate.raw || null,
                sourceReference: candidate.sourceReference || null,
            }).catch(() => null);
            results.push({
                status: 'failed',
                problems: [error.message],
                quarantineId: quarantined?._id || null,
            });
        }
    }

    return {
        results,
        ingested: results.filter((r) => r.status === 'ingested').length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
        quarantined: results.filter((r) => r.status === 'quarantined' || r.status === 'failed').length,
        needsEntityReview: results.filter((r) => r.needsEntityReview).length,
    };
}

/**
 * Turn an extraction result into ingestion candidates.
 */
function candidatesFromExtraction(extraction, { channel, sourceReference = null, retrievedAt = null }) {
    return extraction.donations.map((record) => {
        const fields = record.fields;
        const occurredAt = fields.date ? new Date(String(fields.date).replace(' ', 'T')) : null;

        return {
            senderName: fields.sender || null,
            senderType: fields.sender_type || 'unknown',
            receiverName: fields.receiver || null,
            receiverType: fields.receiver_type || 'unknown',
            amountIdr: fields.amount ?? null,
            occurredAt,
            occurredAtPrecision: fields.date_precision || 'day',
            recordedAt: new Date(),
            identityAbsence: fields.identity_absence || null,
            channel,
            sourceReference,
            retrievedAt,
            // Each field carries the span it was read from, so an attribution
            // can be shown to the person it concerns rather than merely
            // asserted to them.
            provenance: Object.entries(record.spans || {}).map(([field, span]) => ({
                field,
                provenance: channel === 'web-scrape' ? 'scraped' : 'extracted',
                sourceSpan: span,
                at: new Date(),
            })),
            raw: record,
        };
    });
}

/**
 * Whether a duplicate came from a source we have not already counted.
 *
 * Corroboration only means something if the sources are independent. The same
 * scraped page fetched twice, or the same scan re-uploaded, says nothing new;
 * treating it as confirmation would let one source vouch for itself, and the
 * confidence that follows would rest on a single observation counted
 * repeatedly.
 *
 * Both conditions have to hold, and the earlier version checked only one. It
 * returned on the reference alone whenever a reference was present, and the
 * digital-form channel takes `sourceReference` verbatim from the request body
 * — so one caller resubmitting the same donation with a different reference
 * string each time was judged independent every time, and the case bundle told
 * the reviewer the donation had four sources before a finding was put to the
 * person it names.
 *
 * The channel is the coarse bound: one channel is one route into the system,
 * and a second report through it is only independent if it carries a document
 * identifier we have not seen. That does mean two filed returns scraped from
 * the same site count once. The trade is deliberate — under-counting genuine
 * corroboration weakens a signal, and over-counting it manufactures evidence.
 */
function isIndependentSource(existing, candidate) {
    const reference = candidate.sourceReference || null;
    const seenReferences = new Set(
        [
            existing.sourceDocument?.reference || null,
            ...(existing.corroboration || []).map((c) => c.sourceReference || null),
        ].filter(Boolean),
    );
    if (reference && seenReferences.has(reference)) return false;

    const seenChannels = new Set([
        existing.channel,
        ...(existing.corroboration || []).map((c) => c.channel),
    ]);
    return !seenChannels.has(candidate.channel);
}

module.exports = {
    ingestOne,
    ingestBatch,
    candidatesFromExtraction,
    buildDedupKey,
    truncateToPrecision,
    validate,
    mirrorToLegacy,
    isIndependentSource,
};
