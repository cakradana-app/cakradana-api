/**
 * The donation network, as a graph.
 *
 * Structure is where this domain's hardest patterns live. Splitting a
 * contribution shows up as many donors converging on one recipient; routing one
 * through an intermediary shows up as money arriving and leaving the same
 * entity within days. Neither is visible in any single donation's own fields,
 * which is why a graph view is worth building rather than decorative.
 *
 * Nodes carry what the system knows, not a verdict. An entity has no risk
 * score: scores belong to donations, and colouring a person by the average of
 * transactions they were party to would put a judgement on a name — the one
 * thing this system is built not to do.
 */

const { Donation, Entity, ScoringEvent } = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');

/** Beyond this the picture stops being readable and starts being a hairball. */
const MAX_EDGES = 750;

/**
 * Build the graph.
 *
 * Bounded by edge count, and the bound is reported. A view silently showing the
 * largest 750 of 40,000 flows would let an analyst conclude that a recipient
 * has few donors when the opposite is true.
 */
const network = async (req, res) => {
    try {
        const limit = Math.min(
            Number.parseInt(req.query.limit, 10) || MAX_EDGES,
            MAX_EDGES,
        );

        const total = await Donation.countDocuments({ supersededBy: null });
        const donations = await Donation.find({ supersededBy: null })
            .sort({ amountIdr: -1 })
            .limit(limit)
            .lean();

        const entityIds = [
            ...new Set(
                donations
                    .flatMap((d) => [d.senderRef?.entityId, d.receiverRef?.entityId])
                    .filter(Boolean)
                    .map(String),
            ),
        ];
        const entities = await Entity.find({ _id: { $in: entityIds } }).lean();
        const byId = new Map(entities.map((e) => [String(e._id), e]));

        // Findings are attached to the edges they concern, never to a node.
        const events = await ScoringEvent.find({
            donationId: { $in: donations.map((d) => d._id) },
        })
            .sort({ scoredAt: -1 })
            .lean();
        const latest = new Map();
        for (const event of events) {
            const key = String(event.donationId);
            if (!latest.has(key)) latest.set(key, event);
        }

        const nodes = entityIds.map((id) => {
            const entity = byId.get(id);
            return {
                id,
                name: entity?.canonicalName ?? 'Unresolved',
                type: entity?.entityType ?? 'unknown',
                jurisdiction: entity?.jurisdiction ?? null,
                // How firmly this identity is held. An entity assembled from
                // fuzzy name matches may be several people, and a viewer
                // reading structure off the graph needs to know that.
                identityBasis: entity?.identifiers?.length
                    ? 'validated identifier'
                    : 'name match',
                registers: entity?.registers ?? [],
            };
        });

        const edges = donations
            .filter((d) => d.senderRef?.entityId && d.receiverRef?.entityId)
            .map((donation) => {
                const event = latest.get(String(donation._id));
                return {
                    id: String(donation._id),
                    source: String(donation.senderRef.entityId),
                    target: String(donation.receiverRef.entityId),
                    amount: donation.amountIdr,
                    date: donation.occurredAt,
                    channel: donation.channel,
                    // Carried per flow. A statutory finding concerns a
                    // transaction, and moving it onto a party would turn a fact
                    // about a payment into a label on a person.
                    findings: (event?.legalFindings ?? []).map((f) => f.rule_id),
                    score: event?.behavioural?.score ?? null,
                    band: event?.behavioural?.band ?? null,
                    scored: Boolean(event),
                };
            });

        await record({
            actor: req.user?.email || null,
            action: 'read-donation-network',
            subjectType: 'Entity',
            subjectId: String(entityIds.length),
        });

        return res.status(200).json({
            status: 'success',
            message: 'Donation network',
            data: {
                nodes,
                edges,
                truncated: total > donations.length,
                shown: donations.length,
                total,
                // Named so a reader knows the picture is the largest flows
                // rather than a sample or the whole graph.
                selection: 'largest donations by amount',
            },
        });
    } catch (err) {
        console.error('Error building network:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

module.exports = { network, MAX_EDGES };
