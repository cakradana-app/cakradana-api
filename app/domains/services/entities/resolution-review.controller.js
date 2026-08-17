/**
 * Working the entity-resolution queue.
 *
 * Ingestion refuses to merge a near match and creates a separate entity so the
 * donation survives. That is the right call unattended — merging two people on
 * a string similarity attributes one person's giving to another — but it is
 * only half a mechanism. Until somebody decides, the two records are two
 * donors, and every cumulative rule counts them separately.
 *
 * The queue exists so the decision can be made, and the merge exists so the
 * decision reaches the figures. A merge that repoints donations without marking
 * the derived totals stale would leave findings computed against the split
 * identity standing, which is the same defect one step further along.
 */

const {
    Donation,
    Entity,
    ScoringEvent,
} = require('../../canonical/canonical.model');
const { record } = require('../../canonical/retention');
const { ResolutionReview } = require('./resolution-review.model');

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

function actorOf(req) {
    return req.user?.email || req.user?.id || req.body?.actor || null;
}

/**
 * Raise a review for a near match, or note another sighting of one.
 *
 * Called from ingestion and deliberately forgiving: a failure to record the
 * review must not fail the ingestion that prompted it. The donation being
 * admitted is worth more than the queue entry, and the pair will be seen again
 * on the next donation under either name.
 */
async function raise({ resolution, donationId, observedName }) {
    if (!resolution?.requiresReview || !resolution.candidate || !resolution.entity) {
        return null;
    }
    const entityId = resolution.entity._id;
    const candidateId = resolution.candidate._id;
    if (String(entityId) === String(candidateId)) return null;

    try {
        const existing = await ResolutionReview.findOne({
            entityId,
            candidateId,
            state: 'open',
        });
        if (existing) {
            // One question, however many donations ask it. Forty copies of the
            // same pair is a queue nobody works.
            existing.occurrences += 1;
            await existing.save();
            return existing;
        }

        return await ResolutionReview.create({
            entityId,
            candidateId,
            observedName: observedName || resolution.entity.canonicalName,
            candidateName: resolution.candidate.canonicalName,
            similarity: resolution.confidence,
            basis: resolution.basis,
            donationId: donationId || null,
        });
    } catch (err) {
        console.error('raising a resolution review failed:', err);
        return null;
    }
}

/**
 * What is waiting, soonest deadline first.
 *
 * Not newest first: while a review is open the cumulative rules are counting
 * one donor as two, so the oldest open pair is the one doing the most damage.
 */
const list = async (req, res) => {
    try {
        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
        const filter = {};
        if (req.query.state) filter.state = req.query.state;
        else filter.state = 'open';
        if (req.query.overdue === 'true') {
            filter.reviewBy = { $lt: new Date() };
            filter.state = 'open';
        }

        const total = await ResolutionReview.countDocuments(filter);
        const overdue = await ResolutionReview.countDocuments({
            state: 'open',
            reviewBy: { $lt: new Date() },
        });
        const reviews = await ResolutionReview.find(filter)
            .sort({ reviewBy: 1 })
            .limit(limit);

        return res.status(200).json({
            status: 'success',
            message: 'Entity resolution reviews',
            data: {
                total,
                returned: reviews.length,
                open_and_overdue: overdue,
                // Stated on the queue rather than left to be inferred. The
                // count is the number of donors currently being counted twice.
                what_open_means:
                    'each open review is one donor the cumulative limit rules ' +
                    'are currently treating as two',
                items: reviews.map((review) => ({
                    id: review._id,
                    observed_name: review.observedName,
                    candidate_name: review.candidateName,
                    similarity: review.similarity,
                    basis: review.basis,
                    occurrences: review.occurrences,
                    donation_id: review.donationId,
                    raised_at: review.raisedAt,
                    sla: review.slaStatus(),
                })),
            },
        });
    } catch (err) {
        return serverError(res, err, 'listing resolution reviews');
    }
};

/**
 * One review, with what a person needs to decide it.
 *
 * Both entities' donation histories are summarised, because the question is
 * whether these are one donor, and the strongest evidence is usually the
 * pattern: the same recipient, adjacent dates, amounts that only make sense
 * together.
 */
const detail = async (req, res) => {
    try {
        const review = await ResolutionReview.findById(req.params.id);
        if (!review) return fail(res, 404, 'No such review');

        const [entity, candidate] = await Promise.all([
            Entity.findById(review.entityId).lean(),
            Entity.findById(review.candidateId).lean(),
        ]);

        const summarise = async (id) => {
            const donations = await Donation.find({
                $or: [{ 'senderRef.entityId': id }, { 'receiverRef.entityId': id }],
                supersededBy: null,
            })
                .sort({ occurredAt: 1 })
                .limit(50)
                .lean();
            return {
                donation_count: donations.length,
                total_idr: donations.reduce((sum, d) => sum + (d.amountIdr || 0), 0),
                first_seen: donations[0]?.occurredAt || null,
                last_seen: donations[donations.length - 1]?.occurredAt || null,
                recipients: [
                    ...new Set(
                        donations
                            .map((d) => String(d.receiverRef?.entityId || ''))
                            .filter(Boolean),
                    ),
                ],
                donations: donations.map((d) => ({
                    id: d._id,
                    amount_idr: d.amountIdr,
                    occurred_at: d.occurredAt,
                    channel: d.channel,
                    // What the source document actually said, which is the
                    // thing being judged. The canonical name is this system's
                    // reading of it and would beg the question.
                    sender_raw_text: d.senderRef?.rawText || null,
                    receiver_raw_text: d.receiverRef?.rawText || null,
                })),
            };
        };

        return res.status(200).json({
            status: 'success',
            message: 'Resolution review',
            data: {
                id: review._id,
                similarity: review.similarity,
                basis: review.basis,
                occurrences: review.occurrences,
                sla: review.slaStatus(),
                observed: {
                    entity_id: review.entityId,
                    name: review.observedName,
                    aliases: entity?.aliases || [],
                    identifiers: (entity?.identifiers || []).map((i) => i.scheme),
                    history: await summarise(review.entityId),
                },
                candidate: {
                    entity_id: review.candidateId,
                    name: review.candidateName,
                    aliases: candidate?.aliases || [],
                    identifiers: (candidate?.identifiers || []).map((i) => i.scheme),
                    history: await summarise(review.candidateId),
                },
                // Named so a reviewer knows what they are deciding, not only
                // which button they are pressing.
                effect_of_merge:
                    'donations move to the surviving entity and every derived ' +
                    'figure either entity took part in is marked for re-scoring',
                effect_of_keeping_separate:
                    'the two remain distinct donors and this pair is not raised ' +
                    'again',
            },
        });
    } catch (err) {
        return serverError(res, err, 'reading a resolution review');
    }
};

/**
 * Merge the two entities, repoint the donations, and mark the totals stale.
 *
 * The survivor is the candidate — the entity that already existed — so that
 * merging does not silently change which record other systems hold a reference
 * to. The merged entity is retained rather than deleted, carrying a pointer to
 * the survivor: an incorrect merge is exactly what a subject would contest, and
 * a deleted record cannot be un-merged.
 */
const merge = async (req, res) => {
    try {
        const actor = actorOf(req);
        if (!actor) {
            return fail(res, 400, 'a merge must name the person making it');
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return fail(
                res,
                400,
                'a merge requires a reason; it attributes one person’s donations ' +
                    'to another and the basis has to be readable afterwards',
            );
        }

        const review = await ResolutionReview.findById(req.params.id);
        if (!review) return fail(res, 404, 'No such review');
        if (review.state !== 'open') {
            return fail(res, 409, `This review is already ${review.state}`);
        }

        const survivorId = review.candidateId;
        const mergedId = review.entityId;

        const [asSender, asReceiver] = await Promise.all([
            Donation.updateMany(
                { 'senderRef.entityId': mergedId },
                { $set: { 'senderRef.entityId': survivorId } },
            ),
            Donation.updateMany(
                { 'receiverRef.entityId': mergedId },
                { $set: { 'receiverRef.entityId': survivorId } },
            ),
        ]);
        const repointed =
            (asSender.modifiedCount ?? 0) + (asReceiver.modifiedCount ?? 0);

        // Every cumulative figure either entity took part in was computed
        // against the split identity and is now wrong. Marking them is what
        // makes the merge reach the findings rather than stopping at the
        // records.
        const affected = await Donation.find({
            $or: [
                { 'senderRef.entityId': survivorId },
                { 'receiverRef.entityId': survivorId },
            ],
        })
            .select('_id')
            .lean();
        const stale = await ScoringEvent.updateMany(
            { donationId: { $in: affected.map((d) => d._id) } },
            {
                rescoreReason: `entities merged by ${actor}: ${reason}`,
            },
        );

        await Entity.updateOne(
            { _id: survivorId },
            {
                $addToSet: { aliases: review.observedName },
                $push: {
                    mergeHistory: {
                        mergedEntityId: mergedId,
                        basis: review.basis,
                        confidence: review.similarity,
                        actor,
                        at: new Date(),
                    },
                },
            },
        );
        // Retained, not removed. An un-merge needs something to un-merge.
        await Entity.updateOne({ _id: mergedId }, { $set: { mergedInto: survivorId } });

        review.state = 'merged';
        review.decidedBy = actor;
        review.decidedAt = new Date();
        review.decisionReason = reason;
        review.donationsRepointed = repointed;
        review.scoringEventsNeedingRescore = stale.modifiedCount ?? 0;
        await review.save();

        await record({
            actor,
            action: 'merge-entities',
            subjectType: 'Entity',
            subjectId: String(mergedId),
            reason: `merged into ${survivorId}: ${reason}`,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Entities merged',
            data: {
                surviving_entity_id: survivorId,
                merged_entity_id: mergedId,
                donations_repointed: repointed,
                scoring_events_needing_rescore: stale.modifiedCount ?? 0,
                // The queue's own numbers change too, and saying so avoids a
                // reviewer wondering why the count moved by more than one.
                note:
                    'cumulative totals for the surviving entity now include both ' +
                    'histories; rules already evaluated against them are queued ' +
                    'for re-scoring',
            },
        });
    } catch (err) {
        return serverError(res, err, 'merging entities');
    }
};

/**
 * Record that the two are different people.
 *
 * A reason is required in this direction too. Without one the outcome is
 * indistinguishable from an untouched review, and the pair is raised again by
 * the next donation under either name — which is how a queue comes to contain
 * the same five questions permanently.
 */
const keepSeparate = async (req, res) => {
    try {
        const actor = actorOf(req);
        if (!actor) {
            return fail(res, 400, 'a decision must name the person making it');
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return fail(
                res,
                400,
                'a reason is required; without it this pair is raised again by ' +
                    'the next donation and nobody can tell it was considered',
            );
        }

        const review = await ResolutionReview.findById(req.params.id);
        if (!review) return fail(res, 404, 'No such review');
        if (review.state !== 'open') {
            return fail(res, 409, `This review is already ${review.state}`);
        }

        review.state = 'kept-separate';
        review.decidedBy = actor;
        review.decidedAt = new Date();
        review.decisionReason = reason;
        await review.save();

        await record({
            actor,
            action: 'keep-entities-separate',
            subjectType: 'Entity',
            subjectId: String(review.entityId),
            reason: `distinct from ${review.candidateId}: ${reason}`,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Entities kept separate',
            data: { id: review._id, state: review.state },
        });
    } catch (err) {
        return serverError(res, err, 'keeping entities separate');
    }
};

module.exports = { raise, list, detail, merge, keepSeparate };
