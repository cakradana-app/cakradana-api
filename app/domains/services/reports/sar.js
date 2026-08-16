/**
 * Suspicious activity reports.
 *
 * Assembles a draft from evidence the system already holds: the donations, the
 * parties, the statutory findings, the behavioural reasons, and the source
 * documents each value was read from. A report an analyst has to reconstruct by
 * hand from a dashboard is one that gets filed late or not at all, which is the
 * gap this closes.
 *
 * Three constraints shape everything here.
 *
 * Nothing is ever filed automatically. A report accuses named people of
 * financial crime, and the decision to make that accusation belongs to a person
 * who can be asked why they made it. This module produces a draft and records
 * an approval; it has no capability to transmit anything anywhere.
 *
 * A draft states what it rests on. Statutory findings carry their article;
 * behavioural scores are labelled as estimates; and anything drawn from a
 * fixture register is carried through as a demonstration rather than laundered
 * into the report as established fact.
 *
 * The structure has not been reviewed against the receiving authority's current
 * requirements. Until a compliance reviewer has confirmed it, every draft says
 * so, because a well-formatted document is exactly the kind of thing people
 * assume has been checked.
 */

const crypto = require('node:crypto');

const { Donation, Entity, Label, ScoringEvent } = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');

/**
 * Whether the draft structure has been confirmed against the receiving
 * authority's current submission requirements.
 *
 * False, and it stays false until a compliance reviewer says otherwise. The
 * consequence is stamped on every draft rather than tracked in a spreadsheet.
 */
const STRUCTURE_REVIEWED = false;

const UNREVIEWED_NOTICE =
    'This draft has not been reviewed against the receiving authority\'s current ' +
    'submission requirements. Its structure is derived from published AML ' +
    'guidance and may not satisfy them. Confirm the format before submitting.';

const STANDING_CAVEAT =
    'Prepared as an investigative aid. Behavioural scores are estimates about ' +
    'transaction patterns, not determinations that an offence occurred. ' +
    'Statutory findings state that a recorded figure exceeds a stated limit; ' +
    'whether that constitutes an offence is for the competent authority.';

/**
 * Assemble a draft covering a set of donations.
 *
 * Read-only. Produces a document and nothing else — no state changes, no
 * transmission, no side effect beyond the access being logged.
 */
async function assemble(donationIds, { actor, narrative = null, audit = record } = {}) {
    if (!Array.isArray(donationIds) || donationIds.length === 0) {
        throw new Error('a report needs at least one donation to describe');
    }

    const donations = await Donation.find({ _id: { $in: donationIds } }).lean();
    if (donations.length === 0) {
        throw new Error('none of the given donations exist');
    }

    const entityIds = [
        ...new Set(
            donations.flatMap((d) => [d.senderRef?.entityId, d.receiverRef?.entityId]).filter(Boolean),
        ),
    ];
    const entities = await Entity.find({ _id: { $in: entityIds } }).lean();

    const events = await ScoringEvent.find({ donationId: { $in: donationIds } })
        .sort({ scoredAt: -1 })
        .lean();

    const latestByDonation = new Map();
    for (const event of events) {
        const key = String(event.donationId);
        if (!latestByDonation.has(key)) latestByDonation.set(key, event);
    }

    const dispositions = await Label.find({
        donationId: { $in: donationIds },
        source: { $in: ['analyst_disposition', 'dispute_outcome'] },
        supersededBy: null,
    }).lean();

    await audit({
        actor,
        action: 'assemble-sar-draft',
        subjectType: 'Donation',
        subjectId: donationIds.map(String).join(','),
    });

    const findings = [];
    const estimates = [];
    let anyDemonstration = false;

    for (const donation of donations) {
        const event = latestByDonation.get(String(donation._id));
        if (!event) continue;

        for (const finding of event.legalFindings ?? []) {
            // Carried through with its provenance intact. A finding resting on
            // fixture data must not become established fact by being copied
            // into a formal-looking document.
            if (finding.authoritative === false) anyDemonstration = true;
            findings.push({
                donationId: String(donation._id),
                rule: finding.rule_id,
                statute: finding.statute,
                article: finding.article,
                thresholdIdr: finding.threshold_idr,
                observed: finding.observed,
                statement: finding.explanation,
                evidentiallySound: finding.authoritative !== false,
            });
        }

        if (event.behavioural) {
            estimates.push({
                donationId: String(donation._id),
                score: event.behavioural.score,
                band: event.behavioural.band,
                // Named as an estimate at every point it appears.
                basis: 'behavioural estimate, not a determination',
                reasons: (event.behavioural.reasons ?? []).map((r) => ({
                    statement: r.statement,
                    comparison: r.comparison,
                })),
                incomplete: Boolean(event.behavioural.degraded),
            });
        }
    }

    const draft = {
        draftId: crypto.randomUUID(),
        preparedAt: new Date().toISOString(),
        preparedBy: actor,
        status: 'draft',

        structureReviewed: STRUCTURE_REVIEWED,
        notices: [STANDING_CAVEAT, ...(STRUCTURE_REVIEWED ? [] : [UNREVIEWED_NOTICE])],

        subjects: entities.map((entity) => ({
            entityId: String(entity._id),
            name: entity.canonicalName,
            type: entity.entityType,
            jurisdiction: entity.jurisdiction,
            aliases: entity.aliases,
            // Named so a reader can see how firmly the identity is held. An
            // entity assembled from fuzzy name matches is a weaker subject than
            // one matched on a validated identifier.
            identityBasis: entity.identifiers?.length
                ? 'matched on a validated identifier'
                : 'matched on name',
        })),

        transactions: donations.map((donation) => ({
            donationId: String(donation._id),
            amountIdr: donation.amountIdr,
            occurredAt: donation.occurredAt,
            occurredAtPrecision: donation.occurredAtPrecision,
            recordedAt: donation.recordedAt,
            channel: donation.channel,
            from: donation.senderRef?.rawText ?? null,
            to: donation.receiverRef?.rawText ?? null,
            // Where each value came from, so a recipient of this report can go
            // back to the document rather than taking the figure on trust.
            provenance: (donation.provenance ?? []).map((p) => ({
                field: p.field,
                how: p.provenance,
                sourceSpan: p.sourceSpan,
                confidence: p.confidence,
            })),
            sourceDocument: donation.sourceDocument,
        })),

        statutoryFindings: findings,
        behaviouralEstimates: estimates,

        humanAssessment: dispositions.map((label) => ({
            value: label.value,
            source: label.source,
            typology: label.typology,
            actor: label.actor,
            at: label.createdAt,
            note: label.note,
        })),

        narrative,

        // Stated plainly rather than left for a reader to infer from an absence.
        limitations: buildLimitations({
            donations,
            events: [...latestByDonation.values()],
            dispositions,
            anyDemonstration,
        }),
    };

    return draft;
}

/**
 * What this draft does not establish.
 *
 * Assembled from the evidence rather than boilerplate, so it says something
 * specific about this report: which rules could not be evaluated, whether a
 * person has looked at it, and whether any finding rests on fixture data.
 */
function buildLimitations({ donations, events, dispositions, anyDemonstration }) {
    const limitations = [];

    const unevaluated = new Set();
    for (const event of events) {
        for (const rule of event.indeterminateRules ?? []) {
            unevaluated.add(`${rule.rule_id}: ${rule.reason}`);
        }
    }
    if (unevaluated.size > 0) {
        limitations.push({
            kind: 'incomplete-evaluation',
            detail:
                'Some checks could not be run against these donations. Their absence ' +
                'from the findings is not evidence of compliance.',
            items: [...unevaluated],
        });
    }

    if (dispositions.length === 0) {
        limitations.push({
            kind: 'no-human-assessment',
            detail:
                'No analyst has yet recorded a judgement on these donations. This ' +
                'draft reflects automated output only.',
        });
    }

    if (anyDemonstration) {
        limitations.push({
            kind: 'non-authoritative-evidence',
            detail:
                'At least one finding rests on fixture reference data rather than an ' +
                'authoritative register. Those findings demonstrate that a check runs ' +
                'and establish nothing about any party. This draft must not be ' +
                'submitted.',
            blocking: true,
        });
    }

    const unresolved = donations.filter(
        (d) => !d.senderRef?.entityId || !d.receiverRef?.entityId,
    );
    if (unresolved.length > 0) {
        limitations.push({
            kind: 'unresolved-parties',
            detail:
                `${unresolved.length} of ${donations.length} donations have a party ` +
                'that could not be resolved to a known entity, so any total computed ' +
                'across them may be attributing transactions to the wrong person.',
        });
    }

    return limitations;
}

/**
 * Record a person's approval of a draft.
 *
 * Approval is recorded; nothing is transmitted. This system has no route to any
 * receiving authority and is not going to acquire one: an accusation of
 * financial crime against a named person should leave the building by a
 * deliberate human act, not as a side effect of a score crossing a threshold.
 */
async function approve(draft, { actor, note = null, audit = record }) {
    if (!actor) {
        throw new Error('an approval must name the person giving it');
    }

    const blocking = (draft.limitations ?? []).filter((l) => l.blocking);
    if (blocking.length > 0) {
        throw new Error(
            `this draft cannot be approved: ${blocking.map((l) => l.detail).join(' ')}`,
        );
    }

    await audit({
        actor,
        action: 'approve-sar-draft',
        subjectType: 'SarDraft',
        subjectId: draft.draftId,
        reason: note,
    });

    return {
        ...draft,
        status: 'approved-for-manual-submission',
        approvedBy: actor,
        approvedAt: new Date().toISOString(),
        approvalNote: note,
        transmission: {
            automatic: false,
            detail:
                'This system does not transmit reports. Submission is a manual act ' +
                'performed through the receiving authority\'s own channel.',
        },
    };
}

module.exports = {
    assemble,
    approve,
    buildLimitations,
    STRUCTURE_REVIEWED,
    UNREVIEWED_NOTICE,
    STANDING_CAVEAT,
};
