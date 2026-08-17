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
const { EntityIdentifier } = require('../../identity/identifier.model');
const {
    ResolutionReview,
    RESOLUTION_REVIEW_STATES,
    MAX_OPEN_PER_ACTOR,
} = require('./resolution-review.model');

//: Donations marked stale per round trip. Small enough that the `$in` stays
//: far inside MongoDB's document limit, large enough that a party with a long
//: history does not take thousands of round trips.
const RESCORE_PAGE = 1000;

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
 * Who is making this decision, from the token and nowhere else.
 *
 * A caller-supplied actor would let somebody name themselves — or anybody
 * else — on the permanent record of an irreversible merge. That record is what
 * a subject contesting the merge is shown, so it has to be the one thing in
 * the request the caller could not choose.
 */
function actorOf(req) {
    return req.user?.email || null;
}

/**
 * Raise a review for a near match, or note another sighting of one.
 *
 * Called from ingestion and deliberately forgiving: a failure to record the
 * review must not fail the ingestion that prompted it. The donation being
 * admitted is worth more than the queue entry, and the pair will be seen again
 * on the next donation under either name.
 */
async function raise({ resolution, donationId, observedName, actor = null }) {
    if (!resolution?.requiresReview || !resolution.candidate || !resolution.entity) {
        return null;
    }
    const entityId = resolution.entity._id;
    const candidateId = resolution.candidate._id;
    if (String(entityId) === String(candidateId)) return null;

    try {
        // Matched in either direction and against a decision already made.
        //
        // Direction, because a later resolution can produce the same pair with
        // the roles swapped, which would read as a new question.
        //
        // And `kept-separate`, because the API tells the reviewer their
        // decision means "this pair is not raised again" — while the lookup
        // only matched open reviews, so the next donation under either spelling
        // asked it again. That is the "same five questions permanently" outcome
        // the reason field was supposed to prevent.
        const pair = [
            { entityId, candidateId },
            { entityId: candidateId, candidateId: entityId },
        ];
        const existing = await ResolutionReview.findOne({
            $or: pair,
            state: { $in: ['open', 'kept-separate'] },
        });
        if (existing) {
            // One question, however many donations ask it. Forty copies of the
            // same pair is a queue nobody works, and a decided pair stays
            // decided — the sighting is counted, not re-opened.
            existing.occurrences += 1;
            await existing.save();
            return existing;
        }

        // Ingestion is open to any authenticated account by design, and a
        // caller inventing a new spelling on each submission raises a new pair
        // every time. Past the cap the review is still recorded — the pair may
        // be genuine and dropping it would lose a real near match — but it
        // stops competing for position in a queue whose order is supposed to
        // say which donors are currently being miscounted.
        const outstanding = actor
            ? await ResolutionReview.countDocuments({
                  raisedByActor: actor,
                  state: 'open',
              })
            : 0;

        return await ResolutionReview.create({
            entityId,
            candidateId,
            observedName: observedName || resolution.entity.canonicalName,
            candidateName: resolution.candidate.canonicalName,
            similarity: resolution.confidence,
            basis: resolution.basis,
            donationId: donationId || null,
            raisedByActor: actor,
            deprioritised: outstanding >= MAX_OPEN_PER_ACTOR,
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
        // Checked against the vocabulary rather than passed through. Express
        // parses `?state[$ne]=open` into an object, which would reach mongoose
        // as an operator instead of a value.
        const requested = String(req.query.state ?? '');
        const filter = {
            state: RESOLUTION_REVIEW_STATES.includes(requested) ? requested : 'open',
        };
        if (req.query.overdue === 'true') {
            filter.reviewBy = { $lt: new Date() };
            filter.state = 'open';
        }

        const total = await ResolutionReview.countDocuments(filter);
        // The headline count excludes what one submitter queued past the cap.
        // It is read as "how wrong the limit evaluation is right now", and a
        // figure any caller can inflate does not support that reading.
        const overdue = await ResolutionReview.countDocuments({
            state: 'open',
            deprioritised: false,
            reviewBy: { $lt: new Date() },
        });
        const setAside = await ResolutionReview.countDocuments({
            state: 'open',
            deprioritised: true,
        });
        const reviews = await ResolutionReview.find(filter)
            .sort({ deprioritised: 1, reviewBy: 1 })
            .limit(limit);

        return res.status(200).json({
            status: 'success',
            message: 'Entity resolution reviews',
            data: {
                total,
                returned: reviews.length,
                open_and_overdue: overdue,
                // Reported rather than hidden: these are real near matches and
                // still need deciding, they just do not set the queue's order.
                set_aside_from_one_submitter: setAside,
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
                    set_aside: review.deprioritised,
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

        // Neither side may already have been merged away. Repointing into a
        // tombstone would bury the donations one level deeper, and overwriting
        // an existing `mergedInto` would destroy the trail a subject contesting
        // the earlier merge has to follow.
        const [merged, survivor] = await Promise.all([
            Entity.findById(review.entityId).lean(),
            Entity.findById(review.candidateId).lean(),
        ]);
        if (!merged || !survivor) {
            return fail(res, 404, 'One of these entities no longer exists');
        }
        for (const [label, entity] of [['observed', merged], ['candidate', survivor]]) {
            if (entity.mergedInto) {
                return fail(
                    res,
                    409,
                    `The ${label} entity was already merged into another record; ` +
                        'this review was raised before that happened and has to be ' +
                        're-examined against the surviving entity',
                    { merged_into: entity.mergedInto },
                );
            }
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
        // Paged rather than collected. Merging two spellings of a party name
        // is entirely plausible at this similarity threshold, and that party's
        // every donation would otherwise be loaded into memory and then turned
        // into one query document — which exceeds MongoDB's 16 MB limit outright
        // well before it finishes, and stalls the request long before that.
        const rescoreReason = `entities merged by ${actor}: ${reason}`;
        let staleCount = 0;
        let cursorId = null;
        for (;;) {
            const filter = {
                $or: [
                    { 'senderRef.entityId': survivorId },
                    { 'receiverRef.entityId': survivorId },
                ],
            };
            if (cursorId) filter._id = { $gt: cursorId };
            const page = await Donation.find(filter)
                .select('_id')
                .sort({ _id: 1 })
                .limit(RESCORE_PAGE)
                .lean();
            if (page.length === 0) break;

            const marked = await ScoringEvent.updateMany(
                { donationId: { $in: page.map((d) => d._id) } },
                { rescoreReason },
            );
            staleCount += marked.modifiedCount ?? 0;
            cursorId = page[page.length - 1]._id;
            if (page.length < RESCORE_PAGE) break;
        }
        const stale = { modifiedCount: staleCount };

        // The survivor takes on everything the absorbed record held, not just
        // its name. `firstSeen` is load-bearing — a donor's first appearance
        // being a large donation is itself a signal — and losing a register
        // membership would stop a statutory rule firing for that donor.
        const carried = {
            $addToSet: {
                aliases: { $each: [review.observedName, ...(merged.aliases || [])] },
                // The folded form is what resolution queries. Without it the
                // next donation under the old spelling creates the split again.
                normalisedAliases: {
                    $each: [
                        merged.normalisedName,
                        ...(merged.normalisedAliases || []),
                    ].filter(Boolean),
                },
                identifiers: { $each: merged.identifiers || [] },
                registers: { $each: merged.registers || [] },
            },
            $push: {
                mergeHistory: {
                    mergedEntityId: mergedId,
                    basis: review.basis,
                    confidence: review.similarity,
                    actor,
                    at: new Date(),
                },
            },
        };
        if (merged.firstSeen) carried.$min = { firstSeen: merged.firstSeen };
        if (merged.lastSeen) carried.$max = { lastSeen: merged.lastSeen };
        await Entity.updateOne({ _id: survivorId }, carried);

        // The surrogates moved with the entity document above; the records
        // they point at have to move too. Left behind, the survivor lists
        // identifiers whose backing records still name the absorbed entity, so
        // the entity claims to be identified and the identifier store says it
        // is not — and the two answers come from different endpoints, which is
        // how a disagreement like that survives.
        await EntityIdentifier.updateMany(
            { entityId: mergedId },
            { $set: { entityId: survivorId } },
        );

        // Retained, not removed. An un-merge needs something to un-merge.
        await Entity.updateOne({ _id: mergedId }, { $set: { mergedInto: survivorId } });

        // Any other open review naming the absorbed entity is now about a
        // record that no longer resolves. Left open, merging one of them would
        // repoint nothing and overwrite the trail this merge just wrote.
        await ResolutionReview.updateMany(
            {
                state: 'open',
                _id: { $ne: review._id },
                $or: [{ entityId: mergedId }, { candidateId: mergedId }],
            },
            {
                $set: {
                    state: 'kept-separate',
                    decidedBy: actor,
                    decidedAt: new Date(),
                    decisionReason:
                        `superseded: ${mergedId} was merged into ${survivorId} — ` +
                        're-raised automatically if the pair recurs',
                },
            },
        );

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
