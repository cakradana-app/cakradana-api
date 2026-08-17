/**
 * Everything a person needs to judge one donation.
 *
 * A review step that shows a score and an approve button is automation with a
 * signature attached. It satisfies the human-in-the-loop requirement on paper
 * and defeats it in practice, because there is nothing to review — the analyst
 * can only agree or disagree with a number.
 *
 * So the bundle is assembled before anyone is asked to decide: the values the
 * score rests on with something to compare them against, the neighbourhood the
 * donation sits in, donations like it, where each field came from, and what
 * anyone has already said about it. Assembling it afterwards, on request, means
 * it does not exist at the moment the decision is made.
 */

const {
    Donation,
    Entity,
    Label,
    ScoringEvent,
} = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');
const { Dispute } = require('../disputes/dispute.model');

/** Neighbourhood bounds. Depth 2 over a party hub reaches most of the graph. */
const MAX_NEIGHBOURS = 50;
const COMPARABLE_LIMIT = 25;

/** Comparable means same recipient, same context, within this factor on amount. */
const COMPARABLE_AMOUNT_FACTOR = 2;

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

/**
 * Donations touching either party, most recent first.
 *
 * Bounded, and the bound is reported. A neighbourhood silently showing fifty of
 * four hundred flows would let an analyst conclude a donor is peripheral when
 * they are central.
 */
async function neighbourhood(donation) {
    const parties = [donation.senderRef?.entityId, donation.receiverRef?.entityId].filter(
        Boolean,
    );
    if (parties.length === 0) {
        return {
            edges: [],
            truncated: false,
            note:
                'neither party resolved to a known entity, so this donation has no ' +
                'neighbourhood the system can assert',
        };
    }

    const filter = {
        _id: { $ne: donation._id },
        supersededBy: null,
        $or: [
            { 'senderRef.entityId': { $in: parties } },
            { 'receiverRef.entityId': { $in: parties } },
        ],
    };

    const total = await Donation.countDocuments(filter);
    const edges = await Donation.find(filter)
        .sort({ occurredAt: -1 })
        .limit(MAX_NEIGHBOURS)
        .lean();

    return {
        edges: edges.map((edge) => ({
            donation_id: String(edge._id),
            amount_idr: edge.amountIdr,
            occurred_at: edge.occurredAt,
            from: edge.senderRef?.rawText ?? null,
            to: edge.receiverRef?.rawText ?? null,
            shares:
                String(edge.senderRef?.entityId) === String(donation.senderRef?.entityId)
                    ? 'donor'
                    : 'recipient',
        })),
        shown: edges.length,
        total,
        truncated: total > edges.length,
    };
}

/**
 * Donations the analyst can hold this one against.
 *
 * Same recipient, same electoral context, within a factor on amount. Without
 * them a figure is unreadable: Rp180,000,000 is unremarkable or extraordinary
 * depending entirely on what the recipient usually receives.
 */
async function comparables(donation) {
    const filter = {
        _id: { $ne: donation._id },
        supersededBy: null,
        'receiverRef.entityId': donation.receiverRef?.entityId ?? null,
        electoralContext: donation.electoralContext ?? null,
        amountIdr: {
            $gte: Math.floor(donation.amountIdr / COMPARABLE_AMOUNT_FACTOR),
            $lte: donation.amountIdr * COMPARABLE_AMOUNT_FACTOR,
        },
    };

    const found = await Donation.find(filter)
        .sort({ occurredAt: -1 })
        .limit(COMPARABLE_LIMIT)
        .lean();

    const amounts = found.map((d) => d.amountIdr).sort((a, b) => a - b);
    const median = amounts.length
        ? amounts[Math.floor(amounts.length / 2)]
        : null;

    return {
        basis: 'same recipient and electoral context, within a factor of two on amount',
        count: found.length,
        median_amount_idr: median,
        donations: found.map((d) => ({
            donation_id: String(d._id),
            amount_idr: d.amountIdr,
            occurred_at: d.occurredAt,
        })),
    };
}

/**
 * The case bundle for one donation.
 *
 * Read-only, and the read itself is logged: this assembles personal data about
 * named parties, which is precisely the access an audit log exists to record.
 */
const detail = async (req, res) => {
    try {
        const donation = await Donation.findById(req.params.donationId).lean();
        if (!donation) return fail(res, 404, 'No such donation');

        const [event, labels, disputes] = await Promise.all([
            ScoringEvent.findOne({ donationId: donation._id }).sort({ scoredAt: -1 }).lean(),
            Label.find({ donationId: donation._id }).sort({ createdAt: -1 }).lean(),
            Dispute.find({ donationId: donation._id }).sort({ createdAt: -1 }).lean(),
        ]);

        const entityIds = [donation.senderRef?.entityId, donation.receiverRef?.entityId].filter(
            Boolean,
        );
        const entities = await Entity.find({ _id: { $in: entityIds } }).lean();
        const byId = new Map(entities.map((e) => [String(e._id), e]));

        await record({
            actor: req.user?.email || null,
            action: 'read-case-detail',
            subjectType: 'Donation',
            subjectId: String(donation._id),
        });

        const describe = (ref) => {
            const entity = ref?.entityId ? byId.get(String(ref.entityId)) : null;
            return {
                entity_id: ref?.entityId ? String(ref.entityId) : null,
                raw_text: ref?.rawText ?? null,
                type: entity?.entityType ?? ref?.entityType ?? 'unknown',
                canonical_name: entity?.canonicalName ?? null,
                // How firmly the identity is held. An entity assembled from
                // fuzzy name matches may be several people, and every
                // cumulative figure below inherits that uncertainty.
                identity_basis: entity?.identifiers?.length
                    ? 'matched on a validated identifier'
                    : 'matched on name',
                resolution_confidence: ref?.resolutionConfidence ?? null,
            };
        };

        return res.status(200).json({
            status: 'success',
            message: 'Case detail',
            data: {
                donation: {
                    donation_id: String(donation._id),
                    version: donation.donationVersion,
                    amount_idr: donation.amountIdr,
                    amount_raw: donation.amountRaw,
                    occurred_at: donation.occurredAt,
                    occurred_at_precision: donation.occurredAtPrecision,
                    recorded_at: donation.recordedAt,
                    channel: donation.channel,
                    transaction_kind: donation.transactionKind,
                    electoral_context: donation.electoralContext,
                    identity_absence: donation.identityAbsence,
                    superseded: Boolean(donation.supersededBy),
                },
                parties: {
                    sender: describe(donation.senderRef),
                    receiver: describe(donation.receiverRef),
                },
                // Where each value came from, quoted from the source. An
                // analyst who cannot check a figure against the document is
                // reviewing the system's transcription, not the evidence.
                provenance: (donation.provenance || []).map((p) => ({
                    field: p.field,
                    how: p.provenance,
                    quoted_from_source: p.sourceSpan,
                    confidence: p.confidence,
                    extractor_version: p.extractorVersion,
                    actor: p.actor,
                })),
                source_document: donation.sourceDocument || null,
                // How many independent sources reported this donation, and
                // which. A record a filed return and a scraped page both
                // describe stands on better evidence than either alone; one
                // that only a scrape has ever mentioned is worth knowing about
                // before a finding is put to the person it names.
                corroboration: {
                    sources: 1 + (donation.corroboration?.length || 0),
                    single_source: (donation.corroboration?.length || 0) === 0,
                    observations: [
                        {
                            channel: donation.channel,
                            source_reference: donation.sourceDocument?.reference || null,
                            observed_at: donation.recordedAt,
                        },
                        ...(donation.corroboration || []).map((c) => ({
                            channel: c.channel,
                            source_reference: c.sourceReference,
                            observed_at: c.observedAt,
                        })),
                    ],
                },

                // Facts first, estimates second, and never merged.
                legal_findings: event?.legalFindings || [],
                unevaluated_rules: event?.indeterminateRules || [],
                behavioural: event?.behavioural || null,
                versions: event
                    ? {
                          model: event.modelVersion,
                          rule_set: event.ruleSetVersion,
                          features: event.featureSetVersion,
                      }
                    : null,
                scored_at: event?.scoredAt || null,
                needs_rescore: event?.rescoreReason || null,

                neighbourhood: await neighbourhood(donation),
                comparables: await comparables(donation),

                human_record: {
                    labels: labels.map((label) => ({
                        value: label.value,
                        source: label.source,
                        weight: label.weight,
                        actor: label.actor,
                        note: label.note,
                        at: label.createdAt,
                        superseded: Boolean(label.supersededBy),
                    })),
                    disputes: disputes.map((dispute) => ({
                        dispute_id: String(dispute._id),
                        reason: dispute.reason,
                        state: dispute.state,
                        outcome: dispute.outcome,
                        raised_at: dispute.createdAt,
                    })),
                },
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error assembling case detail');
    }
};

module.exports = { detail, neighbourhood, comparables, MAX_NEIGHBOURS, COMPARABLE_LIMIT };
