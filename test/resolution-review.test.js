/**
 * The entity-resolution review loop.
 *
 * Ingestion has always refused to merge a near match unattended and counted
 * how many it set aside. The count reached every upload response and the
 * candidates reached nothing, so the number described work that had nowhere to
 * happen.
 *
 * What is tested here is that a queued near match carries a deadline, that
 * neither decision can be made by nobody or without a reason, and that a merge
 * is required to say what it cost — because entity resolution sets the accuracy
 * ceiling of every cumulative rule, and a merge changes every total either
 * entity took part in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ResolutionReview,
    SLA,
} = require('../app/domains/services/entities/resolution-review.model');
const {
    SLA: DISPUTE_SLA,
} = require('../app/domains/services/disputes/dispute.model');
const { addWorkingDays } = require('../app/utils/time/working-days');

const ENTITY_A = '507f1f77bcf86cd799439011';
const ENTITY_B = '507f1f77bcf86cd799439012';

function review(overrides = {}) {
    return new ResolutionReview({
        entityId: ENTITY_A,
        candidateId: ENTITY_B,
        observedName: 'Budi Santosa',
        candidateName: 'Budi Santoso',
        similarity: 0.91,
        basis: 'fuzzy-below-threshold',
        ...overrides,
    });
}

test('a queued near match carries its deadline on the record', async () => {
    // A deadline held only in a policy document cannot be queried, so nothing
    // can find what is overdue.
    const queued = review();
    await queued.validate();
    assert.ok(queued.reviewBy instanceof Date);
});

test('the deadline is counted in working days', async () => {
    // A Thursday. Five working days lands the following Thursday, not Tuesday.
    const raisedAt = new Date('2026-08-13T09:00:00Z');
    const queued = review({ raisedAt });
    await queued.validate();
    assert.equal(
        queued.reviewBy.getTime(),
        addWorkingDays(raisedAt, SLA.reviewWithinWorkingDays).getTime(),
    );
});

test('resolution is given less time than a dispute', () => {
    // A dispute concerns a record already attributed. An open resolution
    // review means the limit rules are miscounting right now, and the error
    // grows with every donation ingested under either spelling.
    assert.ok(SLA.reviewWithinWorkingDays < DISPUTE_SLA.resolveWithinWorkingDays);
});

test('an open review past its date is overdue, and says what that costs', async () => {
    const queued = review({ raisedAt: new Date('2026-01-01T00:00:00Z') });
    await queued.validate();
    const status = queued.slaStatus(new Date('2026-03-01T00:00:00Z'));
    assert.equal(status.overdue, true);
    assert.match(status.consequence_while_open, /split identity/);
});

test('a decided review is not overdue and carries no standing consequence', async () => {
    const queued = review({
        raisedAt: new Date('2026-01-01T00:00:00Z'),
        state: 'kept-separate',
        decidedBy: 'analyst@example.org',
        decisionReason: 'different NIK on the filed returns',
    });
    await queued.validate();
    const status = queued.slaStatus(new Date('2026-03-01T00:00:00Z'));
    assert.equal(status.overdue, false);
    assert.equal(status.consequence_while_open, null);
});

test('nothing merges two people without a name on it', async () => {
    // A wrong merge attributes one person's donations to another and can
    // produce a statutory finding against somebody who did nothing.
    const queued = review({ state: 'merged', decisionReason: 'same NIK' });
    await assert.rejects(() => queued.validate(), /name the person/);
});

test('keeping two entities separate also requires a reason', async () => {
    // Without one the outcome is indistinguishable from an untouched review,
    // and the next donation under either name raises the same pair again.
    const queued = review({
        state: 'kept-separate',
        decidedBy: 'analyst@example.org',
    });
    await assert.rejects(() => queued.validate(), /requires a reason/);
});

test('a decision with an actor and a reason validates', async () => {
    const queued = review({
        state: 'merged',
        decidedBy: 'analyst@example.org',
        decisionReason: 'same NIK on both filed returns',
    });
    await queued.validate();
    assert.equal(queued.state, 'merged');
});

test('an open review needs neither an actor nor a reason', async () => {
    const queued = review();
    await queued.validate();
    assert.equal(queued.decidedBy, null);
    assert.equal(queued.decisionReason, null);
});

test('a review records what the merge cost downstream', async () => {
    // A merge changes every cumulative total either entity took part in. The
    // figures are stored so a finding that moves afterwards can be explained.
    const queued = review({
        state: 'merged',
        decidedBy: 'analyst@example.org',
        decisionReason: 'same NIK',
        donationsRepointed: 14,
        scoringEventsNeedingRescore: 22,
    });
    await queued.validate();
    assert.equal(queued.donationsRepointed, 14);
    assert.equal(queued.scoringEventsNeedingRescore, 22);
});

test('the observed names travel with the review, not only the references', async () => {
    // An entity merged away by a later decision would otherwise leave a review
    // nobody can read.
    const queued = review();
    await queued.validate();
    assert.equal(queued.observedName, 'Budi Santosa');
    assert.equal(queued.candidateName, 'Budi Santoso');
});

test('one pair is one question, however many donations ask it', async () => {
    // Occurrences accumulate on a single review rather than producing forty
    // copies of the same decision.
    const queued = review({ occurrences: 12 });
    await queued.validate();
    assert.equal(queued.occurrences, 12);
});

test('a review cannot be filed in a state the vocabulary does not define', async () => {
    const queued = review({
        state: 'probably-fine',
        decidedBy: 'analyst@example.org',
        decisionReason: 'looked alright',
    });
    await assert.rejects(() => queued.validate());
});

test('a similarity outside the unit interval is refused', async () => {
    await assert.rejects(() => review({ similarity: 1.4 }).validate());
});

/**
 * What one submitter can do to the queue.
 *
 * Ingestion is open to any authenticated account by design — submitters are the
 * point — and every ingested near match now raises a review. A caller inventing
 * a new spelling on each submission therefore raises a new pair every time, and
 * the queue is ordered by deadline, so those rows land ahead of the ones the
 * system found on its own.
 *
 * The queue's whole value is that its order says which donors are currently
 * being miscounted. A caller who can set that order has taken it away.
 */

const {
    MAX_OPEN_PER_ACTOR,
} = require('../app/domains/services/entities/resolution-review.model');

test('a review records which account submitted the donation behind it', async () => {
    const queued = review({ raisedByActor: 'submitter@example.org' });
    await queued.validate();
    assert.equal(queued.raisedByActor, 'submitter@example.org');
});

test('a review is not set aside by default', async () => {
    const queued = review();
    await queued.validate();
    assert.equal(queued.deprioritised, false);
});

test('a review past one submitter’s cap is set aside, not discarded', async () => {
    // Dropping it would lose a real near match: the pair may be genuine, and
    // the same donor really may be being counted twice.
    const queued = review({
        raisedByActor: 'submitter@example.org',
        deprioritised: true,
    });
    await queued.validate();
    assert.equal(queued.deprioritised, true);
    assert.equal(queued.state, 'open');
    assert.ok(queued.reviewBy instanceof Date);
});

test('the cap is a bound on queue position, not a fraud threshold', () => {
    // A genuine bulk uploader legitimately produces many near matches, so the
    // cap is set where one caller stops being able to reorder the queue rather
    // than where their behaviour becomes suspicious.
    assert.ok(MAX_OPEN_PER_ACTOR >= 20);
});

/**
 * Defects found in review, each reproduced before being fixed.
 *
 * The first is the one that mattered: a merge that lasted until the next
 * donation. `resolveEntity` matched on `normalisedName` with no filter for
 * entities merged away, so the absorbed record kept matching exactly, short-
 * circuited before the fuzzy path that would have raised a review, and the
 * split identity came back — permanently, and now invisibly.
 */

const { Entity } = require('../app/domains/canonical/canonical.model');
const { normaliseName } = require('../app/domains/canonical/resolution');

test('an entity carries the folded names it answers to, not only observed ones', async () => {
    // `aliases` holds names as written, for a person reading the record.
    // Matching on those would fail on exactly the punctuation and honorifics
    // that folding exists to remove, which is why resolution queries the
    // folded forms and a merge has to write them.
    const survivor = new Entity({
        canonicalName: 'Budi Santoso',
        normalisedName: normaliseName('Budi Santoso'),
        aliases: ['Dr. Budi Santosa, S.E.'],
        normalisedAliases: [normaliseName('Dr. Budi Santosa, S.E.')],
    });
    await survivor.validate();
    assert.equal(survivor.normalisedAliases[0], 'budi santosa');
    assert.notEqual(survivor.normalisedAliases[0], survivor.aliases[0]);
});

test('an entity merged away is marked, and the marker is a reference', async () => {
    const merged = new Entity({
        canonicalName: 'Budi Santosa',
        normalisedName: 'budi santosa',
        mergedInto: ENTITY_B,
    });
    await merged.validate();
    assert.equal(String(merged.mergedInto), ENTITY_B);
});

test('a live entity has no merge marker', async () => {
    const live = new Entity({ canonicalName: 'X', normalisedName: 'x' });
    await live.validate();
    assert.equal(live.mergedInto, null);
});
