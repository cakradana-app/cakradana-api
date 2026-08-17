/**
 * Quarantine's review clock.
 *
 * The list endpoint reported days until deletion, which is a retention period,
 * not a deadline. Knowing a record has eighty days left before it is removed
 * says nothing about whether anybody was supposed to have read it by now, and
 * a record deleted unread is data loss with better bookkeeping: the donation is
 * as absent from every cumulative total as if it had been dropped, and the
 * reason nobody read makes no difference to the figures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    Quarantine,
    QUARANTINE_SLA,
} = require('../app/domains/canonical/canonical.model');
const { RETENTION } = require('../app/domains/canonical/retention');
const { addWorkingDays } = require('../app/utils/time/working-days');

function quarantined(overrides = {}) {
    return new Quarantine({
        channel: 'paper-form',
        reason: 'failed validation before persistence',
        ...overrides,
    });
}

test('a quarantined record carries a review deadline, not only a deletion date', async () => {
    const held = quarantined();
    await held.validate();
    assert.ok(held.reviewBy instanceof Date);
});

test('the review deadline falls well inside the retention period', async () => {
    // A record deleted unread is data loss with better bookkeeping: the
    // donation is as absent from every total as if it had been dropped.
    const held = quarantined({ createdAt: new Date('2026-01-05T00:00:00Z') });
    await held.validate();
    const daysToReview =
        (held.reviewBy - new Date('2026-01-05T00:00:00Z')) / 86_400_000;
    assert.ok(daysToReview < RETENTION.quarantine.days);
    assert.equal(QUARANTINE_SLA.reviewWithinWorkingDays, 10);
});

test('the deadline is counted in working days', async () => {
    const held = quarantined({ createdAt: new Date('2026-08-13T09:00:00Z') });
    await held.validate();
    assert.equal(
        held.reviewBy.getTime(),
        addWorkingDays(
            new Date('2026-08-13T09:00:00Z'),
            QUARANTINE_SLA.reviewWithinWorkingDays,
        ).getTime(),
    );
});

test('an unresolved record past its date is overdue, and says what that costs', async () => {
    const held = quarantined({ createdAt: new Date('2026-01-01T00:00:00Z') });
    await held.validate();
    const status = held.slaStatus(new Date('2026-06-01T00:00:00Z'));
    assert.equal(status.overdue, true);
    assert.match(status.consequence_while_open, /no cumulative total/);
});

test('a resolved record is not overdue however long it sat', async () => {
    const held = quarantined({
        createdAt: new Date('2026-01-01T00:00:00Z'),
        resolvedAt: new Date('2026-05-01T00:00:00Z'),
        resolvedBy: 'analyst@example.org',
    });
    await held.validate();
    const status = held.slaStatus(new Date('2026-06-01T00:00:00Z'));
    assert.equal(status.overdue, false);
    assert.equal(status.consequence_while_open, null);
});

test('an explicitly supplied deadline is not overwritten', async () => {
    // A record re-raised under an agreed timetable keeps that timetable.
    const agreed = new Date('2026-03-01T00:00:00Z');
    const held = quarantined({ reviewBy: agreed });
    await held.validate();
    assert.equal(held.reviewBy.getTime(), agreed.getTime());
});

test('the deadline is set once and does not move when the record is touched', async () => {
    // Otherwise every re-validation would push the deadline out, and a record
    // that is looked at repeatedly without being resolved would never be late.
    const held = quarantined();
    await held.validate();
    const first = held.reviewBy.getTime();
    held.detail = ['a note added later'];
    await held.validate();
    assert.equal(held.reviewBy.getTime(), first);
});

test('a new record starts its clock at creation', async () => {
    // createdAt is set by the timestamps plugin after validation, so the hook
    // falls through to now — which for a record being created is the same
    // instant. Asserted so the fallback is not mistaken for a defect.
    const before = Date.now();
    const held = quarantined();
    await held.validate();
    const after = Date.now();

    assert.equal(held.createdAt, undefined);
    // Bracketed rather than compared to a single sampled instant: the clock
    // moves between the two readings, and an exact comparison would be a test
    // that fails whenever it happens to straddle a millisecond.
    const earliest = addWorkingDays(
        new Date(before),
        QUARANTINE_SLA.reviewWithinWorkingDays,
    ).getTime();
    const latest = addWorkingDays(
        new Date(after),
        QUARANTINE_SLA.reviewWithinWorkingDays,
    ).getTime();
    assert.ok(
        held.reviewBy.getTime() >= earliest && held.reviewBy.getTime() <= latest,
        `expected the deadline between ${earliest} and ${latest}, got ${held.reviewBy.getTime()}`,
    );
});
