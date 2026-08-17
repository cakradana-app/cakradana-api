/**
 * The published dataset.
 *
 * Publishing is the one place where a mistake cannot be undone by fixing the
 * code: a risk score about a named person, once served publicly, has been
 * served. The tests are about what the dataset refuses to carry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PublicAggregate,
    MIN_DONORS_PER_CELL,
    AMOUNT_ROUNDING_IDR,
} = require('../app/domains/public/public.model');
const { periodOf, round } = require('../app/domains/public/public.controller');

function cell(overrides = {}) {
    return new PublicAggregate({
        recipientName: 'Partai Maju',
        recipientType: 'political-party',
        period: '2026-Q2',
        donorCount: 40,
        donationCount: 120,
        totalIdr: 4_000_000_000,
        materialisedAt: new Date(),
        sourceRecords: 120,
        ...overrides,
    });
}

test('an aggregate cell validates', async () => {
    await assert.doesNotReject(() => cell().validate());
});

test('the schema refuses a score', async () => {
    // Enforced here rather than trusted to the materialiser, which is the part
    // most likely to be extended by somebody who does not know this rule.
    const withScore = cell();
    withScore.set('score', 72, { strict: false });
    await assert.rejects(() => withScore.validate(), /never published/);
});

test('the schema refuses flags and alerts too', async () => {
    for (const field of ['band', 'risk', 'findings', 'flags', 'alerts']) {
        const carrying = cell();
        carrying.set(field, 'anything', { strict: false });
        await assert.rejects(
            () => carrying.validate(),
            new RegExp(field),
            `${field} should be refused`,
        );
    }
});

test('a thin cell is published as suppressed rather than omitted', async () => {
    // A cell that vanishes reads as an absence of donations. One marked
    // suppressed reads as what it is: an absence of publishable detail.
    const thin = cell({
        donorCount: 0,
        donationCount: 0,
        totalIdr: 0,
        suppressed: true,
        suppressionReason: 'too few donors',
    });
    await assert.doesNotReject(() => thin.validate());
    assert.equal(thin.suppressed, true);
});

test('the suppression threshold is more than a couple of donors', () => {
    // An aggregate over two donors is two donors, and publishing it beside a
    // known large donation identifies the other by arithmetic.
    assert.ok(MIN_DONORS_PER_CELL >= 5);
});

test('totals are rounded, blunting differencing between releases', () => {
    assert.equal(round(4_123_456_789), 4_123_000_000);
    assert.equal(AMOUNT_ROUNDING_IDR, 1_000_000);
});

test('periods are quarters', () => {
    // The coarsest useful grouping. Finer periods narrow cells until they
    // identify donors.
    assert.equal(periodOf('2026-01-15'), '2026-Q1');
    assert.equal(periodOf('2026-06-30'), '2026-Q2');
    assert.equal(periodOf('2026-12-31'), '2026-Q4');
});
