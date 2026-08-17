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
