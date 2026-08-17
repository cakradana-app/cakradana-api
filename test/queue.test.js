/**
 * Queue filters and the review budget.
 *
 * The budget matters more than the filters. Precision@B is a statement about
 * the top B items a team can actually process, so a queue that does not know
 * its own B produces a figure describing an operating point nobody works at.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    queueFilters,
    queueBudget,
} = require('../app/domains/services/donations/labels.controller');

test('the queue defaults to the configured review budget', () => {
    const original = process.env.REVIEW_BUDGET;
    process.env.REVIEW_BUDGET = '120';
    const { budget, limit } = queueBudget({});
    assert.equal(budget, 120);
    assert.equal(limit, 120);
    if (original === undefined) delete process.env.REVIEW_BUDGET;
    else process.env.REVIEW_BUDGET = original;
});

test('the budget is reported even when a caller asks for fewer', () => {
    // Otherwise a short page reads as a short queue, and the difference is the
    // whole basis of a precision-at-budget figure.
    const original = process.env.REVIEW_BUDGET;
    process.env.REVIEW_BUDGET = '120';
    const { budget, limit } = queueBudget({ limit: '10' });
    assert.equal(budget, 120);
    assert.equal(limit, 10);
    if (original === undefined) delete process.env.REVIEW_BUDGET;
    else process.env.REVIEW_BUDGET = original;
});

test('tier 1 selects donations carrying a statutory finding', () => {
    const { event, applied } = queueFilters({ tier: '1' });
    assert.equal(event.hasFinding, true);
    assert.match(applied.tier, /statutory/);
});

test('tier 2 selects donations with no statutory finding', () => {
    // Not "donations with a behavioural score": one that also breaches a limit
    // is a legal matter first, and mixing it into the behavioural queue buries
    // the fact under the estimate.
    const { event } = queueFilters({ tier: '2' });
    assert.equal(event.hasFinding, false);
});

test('a lane filter matches lanes that ran and contributed', () => {
    const { event } = queueFilters({ lane: 'graph' });
    assert.deepEqual(event['behavioural.lanes'].$elemMatch, {
        lane: 'graph',
        available: true,
        contribution: { $gt: 0 },
    });
});

test('district filters through the electoral context', () => {
    // Which is where the data model puts it. A separate district column would
    // give the filter something to match and the rest of the system nothing to
    // populate.
    const { donation, applied } = queueFilters({ district: 'pemilu-2029/jakarta-2' });
    assert.equal(donation.electoralContext, 'pemilu-2029/jakarta-2');
    assert.equal(applied.electoral_context, 'pemilu-2029/jakarta-2');
});

test('a period filter bounds on when the donation occurred', () => {
    const { donation } = queueFilters({ from: '2026-06-01', to: '2026-06-30' });
    assert.equal(donation.occurredAt.$gte.toISOString().slice(0, 10), '2026-06-01');
    assert.equal(donation.occurredAt.$lte.toISOString().slice(0, 10), '2026-06-30');
});

test('an open period bounds on one side only', () => {
    const { donation } = queueFilters({ from: '2026-06-01' });
    assert.ok(donation.occurredAt.$gte);
    assert.ok(!('$lte' in donation.occurredAt));
});

test('no filters constrain nothing', () => {
    const { event, donation, applied } = queueFilters({});
    assert.deepEqual(event, {});
    assert.deepEqual(donation, {});
    assert.deepEqual(applied, {});
});

test('applied filters are echoed back', () => {
    // A caller cannot otherwise tell a filter that matched nothing from one
    // the server ignored.
    const { applied } = queueFilters({ tier: '1', lane: 'anomaly', band: 'high' });
    assert.ok(applied.tier);
    assert.equal(applied.lane, 'anomaly');
    assert.equal(applied.band, 'high');
});
