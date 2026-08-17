/**
 * The merge, against a database.
 *
 * `resolution-review.test.js` covers what can be decided without one: that a
 * queued pair carries a deadline, that neither decision can be made by nobody
 * or without a reason, that the state vocabulary is closed. Those are rules,
 * and they are the right things to test in isolation.
 *
 * A merge is not a rule. It is five writes across four collections — repoint
 * the donations, fold the absorbed record's names and registers into the
 * survivor, mark every derived figure stale, tombstone the absorbed entity,
 * close the reviews that named it — and each is only correct in relation to the
 * others. Testing the parts in isolation established that each write was
 * well-formed and said nothing about whether the merge held.
 *
 * It did not hold. `resolveEntity` matched on a name without excluding entities
 * that had been merged away, so the next donation under the old spelling
 * resolved to the tombstone and recreated the split the merge had just closed.
 * The merge was undone, permanently, and nothing reported it: the review said
 * `merged`, the audit record said `merge-entities`, and the totals were wrong
 * again by the next upload. Every assertion in the isolated suite still passed.
 *
 * So what is tested here is the merge as a whole, and first among it the thing
 * that broke.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { useDatabase } = require('./helpers/database');
const {
    Donation,
    Entity,
    ScoringEvent,
} = require('../app/domains/canonical/canonical.model');
const {
    ResolutionReview,
    MAX_OPEN_PER_ACTOR,
} = require('../app/domains/services/entities/resolution-review.model');
const {
    EntityIdentifier,
} = require('../app/domains/identity/identifier.model');
const controller = require('../app/domains/services/entities/resolution-review.controller');
const { resolveEntity, normaliseName } = require('../app/domains/canonical/resolution');

useDatabase();

const ACTOR = 'analyst@cakradana.faizath.com';

/** Collect what a controller sent, without an HTTP server in the way. */
function reply() {
    const sent = {};
    return {
        sent,
        status(code) {
            sent.status = code;
            return this;
        },
        json(body) {
            sent.body = body;
            return this;
        },
    };
}

function request(overrides = {}) {
    return { params: {}, body: {}, query: {}, user: { email: ACTOR }, ...overrides };
}

async function makeEntity(name, extra = {}) {
    return Entity.create({
        canonicalName: name,
        normalisedName: normaliseName(name),
        ...extra,
    });
}

async function makeDonation(sender, receiver, extra = {}) {
    const occurredAt = extra.occurredAt || new Date('2026-06-05T00:00:00Z');
    return Donation.create({
        senderRef: { entityId: sender._id, rawText: sender.canonicalName },
        receiverRef: { entityId: receiver._id, rawText: receiver.canonicalName },
        amountIdr: extra.amountIdr || 10_000_000,
        occurredAt,
        recordedAt: extra.recordedAt || occurredAt,
        channel: extra.channel || 'digital-form',
        dedupKey: extra.dedupKey || `k-${Math.random().toString(36).slice(2)}`,
    });
}

/** A scoring event over a donation, with the versions a real one carries. */
async function makeScoringEvent(donation) {
    return ScoringEvent.create({
        donationId: donation._id,
        donationVersion: donation.donationVersion || 1,
        scoredAt: new Date('2026-06-06T00:00:00Z'),
        ruleSetVersion: 'rules-2026.07',
        featureSetVersion: 'features-2026.07',
    });
}

/** Raise a review for a pair, the way ingestion would. */
async function openReview(observed, candidate) {
    return ResolutionReview.create({
        entityId: observed._id,
        candidateId: candidate._id,
        observedName: observed.canonicalName,
        candidateName: candidate.canonicalName,
        similarity: 0.91,
        basis: 'fuzzy-below-threshold',
    });
}

async function merge(review, reason = 'same donor, confirmed against the filed return') {
    const res = reply();
    await controller.merge(
        request({ params: { id: String(review._id) }, body: { reason } }),
        res,
    );
    return res.sent;
}

test('the next donation under the old spelling does not undo the merge', async () => {
    // The defect this file exists for. Resolution matched a folded name
    // without excluding entities that had been merged away, so the tombstone
    // was still the best match for the name it had been merged out of — and
    // the split the merge had just closed reopened on the next upload.
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const review = await openReview(observed, candidate);

    const sent = await merge(review);
    assert.equal(sent.status, 200);

    const again = await resolveEntity('Budi Santosa', 'individual');
    assert.ok(again.entity, 'resolution returned nothing for a name it had just merged');
    assert.notEqual(
        String(again.entity._id),
        String(observed._id),
        'resolution returned the merged-away entity, which recreates the split',
    );
    assert.equal(String(again.entity._id), String(candidate._id));
});

test('a merged-away entity is never returned by resolution under any of its names', async () => {
    // Not only the observed spelling: the absorbed record's own aliases are
    // folded into the survivor, and each is a way back to the tombstone.
    const observed = await makeEntity('P.T. Maju Bersama', {
        aliases: ['PT Maju Bersama'],
        normalisedAliases: [normaliseName('PT Maju Bersama')],
    });
    const candidate = await makeEntity('PT. Maju Bersama');
    const review = await openReview(observed, candidate);
    await merge(review);

    for (const name of ['P.T. Maju Bersama', 'PT Maju Bersama']) {
        const resolved = await resolveEntity(name, 'corporation');
        assert.notEqual(
            String(resolved.entity?._id),
            String(observed._id),
            `resolution returned the tombstone for "${name}"`,
        );
    }
});

test('donations move to the survivor on both sides of the transaction', async () => {
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const party = await makeEntity('Partai Maju');

    await makeDonation(observed, party);
    await makeDonation(observed, party);
    await makeDonation(party, observed);

    const review = await openReview(observed, candidate);
    const sent = await merge(review);

    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.donations_repointed, 3);
    assert.equal(await Donation.countDocuments({ 'senderRef.entityId': observed._id }), 0);
    assert.equal(await Donation.countDocuments({ 'receiverRef.entityId': observed._id }), 0);
    assert.equal(await Donation.countDocuments({ 'senderRef.entityId': candidate._id }), 2);
    assert.equal(await Donation.countDocuments({ 'receiverRef.entityId': candidate._id }), 1);
});

test('every derived figure the survivor takes part in is marked for re-scoring', async () => {
    // The step that makes a merge reach the findings rather than stopping at
    // the records. Without it a limit finding computed against half a donor's
    // giving stands unchanged after the two halves are joined.
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const party = await makeEntity('Partai Maju');

    const moved = await makeDonation(observed, party);
    const already = await makeDonation(candidate, party);
    await makeScoringEvent(moved);
    await makeScoringEvent(already);

    const review = await openReview(observed, candidate);
    const sent = await merge(review, 'one donor');

    assert.equal(sent.body.data.scoring_events_needing_rescore, 2);
    const events = await ScoringEvent.find({}).lean();
    assert.equal(events.length, 2);
    for (const event of events) {
        assert.match(event.rescoreReason, /entities merged by /);
        assert.match(event.rescoreReason, /one donor/);
    }
});

test('re-scoring is marked past a single page of donations', async () => {
    // The paging loop is the part that cannot be checked by reading it. A
    // party name is entirely plausible at this similarity threshold, and that
    // party's every donation passes through this loop; an off-by-one in the
    // cursor leaves the tail unmarked, which is silent and permanent.
    const observed = await makeEntity('Partai Maju Bersama');
    const candidate = await makeEntity('Partai Maju Bersatu');
    const donor = await makeEntity('Budi Santoso');

    const PAGE = 1000;
    const count = PAGE + 7;
    const donations = Array.from({ length: count }, (_, index) => ({
        senderRef: { entityId: donor._id, rawText: 'Budi Santoso' },
        receiverRef: { entityId: observed._id, rawText: 'Partai Maju Bersama' },
        amountIdr: 1_000_000,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'digital-form',
        dedupKey: `page-${index}`,
    }));
    const inserted = await Donation.insertMany(donations);
    await ScoringEvent.insertMany(
        inserted.map((donation) => ({
            donationId: donation._id,
            donationVersion: 1,
            scoredAt: new Date('2026-06-06T00:00:00Z'),
            ruleSetVersion: 'rules-2026.07',
            featureSetVersion: 'features-2026.07',
        })),
    );

    const review = await openReview(observed, candidate);
    const sent = await merge(review, 'same party, two spellings');

    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.donations_repointed, count);
    assert.equal(sent.body.data.scoring_events_needing_rescore, count);
    assert.equal(await ScoringEvent.countDocuments({ rescoreReason: null }), 0);
});

test('the survivor carries the absorbed record’s names, registers and dates', async () => {
    // `firstSeen` is load-bearing — a donor whose first appearance is a large
    // donation is itself a signal — and a lost register membership stops a
    // statutory rule firing for that donor.
    const early = new Date('2025-01-01T00:00:00Z');
    const late = new Date('2026-12-31T00:00:00Z');
    const observed = await makeEntity('Budi Santosa', {
        aliases: ['Bpk. Budi Santosa'],
        normalisedAliases: [normaliseName('Bpk. Budi Santosa')],
        identifiers: [{ scheme: 'nik', valueRef: `idref_${'a'.repeat(32)}` }],
        registers: ['prohibited-source'],
        firstSeen: early,
        lastSeen: new Date('2026-01-01T00:00:00Z'),
    });
    const candidate = await makeEntity('Budi Santoso', {
        firstSeen: new Date('2026-01-01T00:00:00Z'),
        lastSeen: late,
    });

    const review = await openReview(observed, candidate);
    await merge(review);

    const survivor = await Entity.findById(candidate._id).lean();
    assert.ok(survivor.aliases.includes('Budi Santosa'));
    assert.ok(survivor.aliases.includes('Bpk. Budi Santosa'));
    assert.ok(survivor.normalisedAliases.includes(normaliseName('Budi Santosa')));
    assert.deepEqual(
        survivor.identifiers.map((i) => i.scheme),
        ['nik'],
    );
    assert.deepEqual(survivor.registers, ['prohibited-source']);
    assert.equal(survivor.firstSeen.getTime(), early.getTime());
    assert.equal(survivor.lastSeen.getTime(), late.getTime());
    assert.equal(survivor.mergeHistory.length, 1);
    assert.equal(survivor.mergeHistory[0].actor, ACTOR);
});

test('the identifier records move with the entity that held them', async () => {
    // The surrogates move with the entity document. Left behind, the records
    // they point at still name the absorbed entity, so the entity claims to be
    // identified and the identifier store says it is not — and the two answers
    // come from different endpoints, which is how a disagreement like that
    // survives.
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const held = await EntityIdentifier.create({
        entityId: observed._id,
        scheme: 'nik',
        lookupHash: 'f'.repeat(64),
        iv: '0'.repeat(24),
        ciphertext: 'aa',
        tag: '0'.repeat(32),
        recordedBy: ACTOR,
    });

    const review = await openReview(observed, candidate);
    assert.equal((await merge(review)).status, 200);

    const reread = await EntityIdentifier.findById(held._id).lean();
    assert.equal(String(reread.entityId), String(candidate._id));
    assert.equal(await EntityIdentifier.countDocuments({ entityId: observed._id }), 0);
});

test('the absorbed entity is kept, pointing at the survivor', async () => {
    // An incorrect merge is exactly what a subject contests, and a deleted
    // record cannot be un-merged.
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const review = await openReview(observed, candidate);
    await merge(review);

    const tombstone = await Entity.findById(observed._id).lean();
    assert.ok(tombstone, 'the absorbed entity was deleted');
    assert.equal(String(tombstone.mergedInto), String(candidate._id));
});

test('a second merge of an already-merged record is refused, not applied', async () => {
    // Repointing into a tombstone would bury the donations a level deeper and
    // overwrite the trail the first merge wrote.
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const third = await makeEntity('Budi Santoso B.');

    const first = await openReview(observed, candidate);
    await merge(first);

    const second = await openReview(observed, third);
    const sent = await merge(second, 'looks like the same person again');

    assert.equal(sent.status, 409);
    assert.equal(String(sent.body.data.merged_into), String(candidate._id));
    const reread = await ResolutionReview.findById(second._id);
    assert.equal(reread.state, 'open', 'a refused merge still closed the review');
});

test('other open reviews naming the absorbed entity are closed with their basis', async () => {
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const other = await makeEntity('Budi Santoso S.E.');

    const stale = await openReview(observed, other);
    const decided = await openReview(observed, candidate);
    await merge(decided);

    const reread = await ResolutionReview.findById(stale._id).lean();
    assert.equal(reread.state, 'kept-separate');
    assert.equal(reread.decidedBy, ACTOR);
    assert.match(reread.decisionReason, /superseded/);
});

test('a merge of a review already decided is refused', async () => {
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const review = await openReview(observed, candidate);

    assert.equal((await merge(review)).status, 200);
    const second = await merge(review, 'again');
    assert.equal(second.status, 409);
});

test('the same pair raised from either direction is one question', async () => {
    // A later resolution can produce the same pair with the roles swapped,
    // which reads as a new question and puts the reviewer back where they
    // started.
    const a = await makeEntity('Budi Santosa');
    const b = await makeEntity('Budi Santoso');

    const first = await controller.raise({
        resolution: {
            requiresReview: true,
            entity: a,
            candidate: b,
            confidence: 0.91,
            basis: 'fuzzy-below-threshold',
        },
        observedName: 'Budi Santosa',
    });
    const second = await controller.raise({
        resolution: {
            requiresReview: true,
            entity: b,
            candidate: a,
            confidence: 0.91,
            basis: 'fuzzy-below-threshold',
        },
        observedName: 'Budi Santoso',
    });

    assert.equal(String(first._id), String(second._id));
    assert.equal(second.occurrences, 2);
    assert.equal(await ResolutionReview.countDocuments({}), 1);
});

test('a pair already decided as separate is counted, not reopened', async () => {
    // Otherwise the reviewer is told their decision means "this pair is not
    // raised again" and is asked the same question by the next donation.
    const a = await makeEntity('Budi Santosa');
    const b = await makeEntity('Budi Santoso');
    const review = await openReview(a, b);

    const res = reply();
    await controller.keepSeparate(
        request({ params: { id: String(review._id) }, body: { reason: 'different NIK' } }),
        res,
    );
    assert.equal(res.sent.status, 200);

    await controller.raise({
        resolution: {
            requiresReview: true,
            entity: a,
            candidate: b,
            confidence: 0.91,
            basis: 'fuzzy-below-threshold',
        },
        observedName: 'Budi Santosa',
    });

    assert.equal(await ResolutionReview.countDocuments({}), 1);
    const reread = await ResolutionReview.findById(review._id);
    assert.equal(reread.state, 'kept-separate');
    assert.equal(reread.occurrences, 2);
});

test('one submitter past the cap is set aside, not dropped', async () => {
    // Ingestion is open to any authenticated account, and a caller inventing a
    // spelling per submission raises a new pair every time. The pair may be
    // genuine, so it is recorded; it just stops setting the queue's order.
    const submitter = 'noisy@example.test';
    for (let index = 0; index < MAX_OPEN_PER_ACTOR; index += 1) {
        const a = await makeEntity(`Budi Santosa ${index}`);
        const b = await makeEntity(`Budi Santoso ${index}`);
        await controller.raise({
            resolution: {
                requiresReview: true,
                entity: a,
                candidate: b,
                confidence: 0.91,
                basis: 'fuzzy-below-threshold',
            },
            observedName: a.canonicalName,
            actor: submitter,
        });
    }

    const a = await makeEntity('Budi Santosa last');
    const b = await makeEntity('Budi Santoso last');
    const capped = await controller.raise({
        resolution: {
            requiresReview: true,
            entity: a,
            candidate: b,
            confidence: 0.91,
            basis: 'fuzzy-below-threshold',
        },
        observedName: a.canonicalName,
        actor: submitter,
    });

    assert.ok(capped, 'a capped review was dropped rather than set aside');
    assert.equal(capped.deprioritised, true);
    assert.equal(await ResolutionReview.countDocuments({}), MAX_OPEN_PER_ACTOR + 1);
});

test('the headline overdue count excludes what one submitter queued past the cap', async () => {
    // It is read as "how wrong the limit evaluation is right now". A figure
    // any caller can inflate does not support that reading.
    const past = new Date('2020-01-01T00:00:00Z');
    const a = await makeEntity('Budi Santosa');
    const b = await makeEntity('Budi Santoso');
    await ResolutionReview.create({
        entityId: a._id,
        candidateId: b._id,
        observedName: a.canonicalName,
        candidateName: b.canonicalName,
        similarity: 0.91,
        basis: 'fuzzy-below-threshold',
        raisedAt: past,
    });
    const c = await makeEntity('Ani Wijaya');
    const d = await makeEntity('Ani Widjaja');
    await ResolutionReview.create({
        entityId: c._id,
        candidateId: d._id,
        observedName: c.canonicalName,
        candidateName: d.canonicalName,
        similarity: 0.91,
        basis: 'fuzzy-below-threshold',
        raisedAt: past,
        deprioritised: true,
    });

    const res = reply();
    await controller.list(request(), res);
    assert.equal(res.sent.body.data.open_and_overdue, 1);
    assert.equal(res.sent.body.data.set_aside_from_one_submitter, 1);
});

test('a review naming an entity that no longer exists is refused', async () => {
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const review = await openReview(observed, candidate);
    await Entity.deleteOne({ _id: observed._id });

    const sent = await merge(review);
    assert.equal(sent.status, 404);
});

test('the review records what the merge cost', async () => {
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const party = await makeEntity('Partai Maju');
    const donation = await makeDonation(observed, party);
    await makeScoringEvent(donation);

    const review = await openReview(observed, candidate);
    await merge(review, 'confirmed against the filed return');

    const reread = await ResolutionReview.findById(review._id).lean();
    assert.equal(reread.state, 'merged');
    assert.equal(reread.decidedBy, ACTOR);
    assert.equal(reread.decisionReason, 'confirmed against the filed return');
    assert.equal(reread.donationsRepointed, 1);
    assert.equal(reread.scoringEventsNeedingRescore, 1);
});

test('an unauthenticated merge writes nothing', async () => {
    // The actor comes from the token and nowhere else, so a request without
    // one has no permanent record to write.
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const review = await openReview(observed, candidate);

    const res = reply();
    await controller.merge(
        {
            params: { id: String(review._id) },
            body: { reason: 'because' },
            user: null,
        },
        res,
    );

    assert.equal(res.sent.status, 400);
    const reread = await Entity.findById(observed._id).lean();
    assert.equal(reread.mergedInto, null);
});

test('the detail view reads both histories from the donations, not the review', async () => {
    const observed = await makeEntity('Budi Santosa');
    const candidate = await makeEntity('Budi Santoso');
    const party = await makeEntity('Partai Maju');
    await makeDonation(observed, party, { amountIdr: 5_000_000 });
    await makeDonation(candidate, party, { amountIdr: 7_000_000 });

    const review = await openReview(observed, candidate);
    const res = reply();
    await controller.detail(request({ params: { id: String(review._id) } }), res);

    const { observed: left, candidate: right } = res.sent.body.data;
    assert.equal(left.history.donation_count, 1);
    assert.equal(left.history.total_idr, 5_000_000);
    assert.equal(right.history.donation_count, 1);
    assert.equal(right.history.total_idr, 7_000_000);
});

test('a review id that is not an object id is refused rather than thrown', async () => {
    const res = reply();
    await controller.detail(request({ params: { id: 'not-an-id' } }), res);
    assert.ok(
        res.sent.status === 404 || res.sent.status === 500,
        'an unparseable id produced neither a refusal nor an error',
    );
    assert.ok(mongoose.connection.readyState === 1, 'the connection did not survive');
});
