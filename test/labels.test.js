/**
 * The label loop.
 *
 * The constraint under test is the difference between confirming a donation
 * and clearing it. Getting that wrong inverts the training signal on the
 * typology this system exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Label } = require('../app/domains/canonical/canonical.model');
const { SOURCE_WEIGHTS } = require('../app/domains/services/donations/labels.controller');

const DONATION_ID = '507f1f77bcf86cd799439011';

function label(overrides = {}) {
    return new Label({
        donationId: DONATION_ID,
        donationVersion: 1,
        value: 'indeterminate',
        source: 'recipient_confirmation',
        weight: 0.7,
        ...overrides,
    });
}

test('a recipient confirmation cannot assert that a donation is clean', async () => {
    // A donation split across many nominal donors is genuinely received, and
    // its recipient confirms it truthfully. Recording that as a clean label
    // would teach a model that verified splitting is fine.
    await assert.rejects(
        () => label({ value: 'not_risky' }).validate(),
        /records that a donation occurred/,
    );
});

test('a recipient confirmation cannot assert that a donation is risky either', async () => {
    // Confirmation says the transaction happened. It is not a judgement in
    // either direction.
    await assert.rejects(() => label({ value: 'risky' }).validate(), /occurred/);
});

test('a confirmation is stored as carrying no risk verdict', async () => {
    await assert.doesNotReject(() => label({ value: 'indeterminate' }).validate());
});

test('an analyst may record either verdict', async () => {
    await assert.doesNotReject(() =>
        label({ source: 'analyst_disposition', value: 'not_risky', weight: 0.9 }).validate(),
    );
    await assert.doesNotReject(() =>
        label({ source: 'analyst_disposition', value: 'risky', weight: 0.9 }).validate(),
    );
});

test('an adjudicated dispute may record either verdict', async () => {
    await assert.doesNotReject(() =>
        label({ source: 'dispute_outcome', value: 'not_risky', weight: 1 }).validate(),
    );
});

test('a label must name where it came from', async () => {
    await assert.rejects(() => label({ source: 'guesswork' }).validate());
});

test('adjudicated outcomes outweigh expert judgement, which outweighs heuristics', () => {
    // An adjudicated outcome was investigated; a heuristic is a hypothesis
    // about intent inferred from structure.
    assert.ok(SOURCE_WEIGHTS.dispute_outcome > SOURCE_WEIGHTS.analyst_disposition);
    assert.ok(SOURCE_WEIGHTS.analyst_disposition > SOURCE_WEIGHTS.recipient_confirmation);
    assert.ok(SOURCE_WEIGHTS.recipient_confirmation > SOURCE_WEIGHTS.rule_tier2);
    assert.ok(SOURCE_WEIGHTS.rule_tier2 > SOURCE_WEIGHTS.synthetic);
});

test('every weight is a share rather than an arbitrary scale', () => {
    for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
        assert.ok(weight > 0 && weight <= 1, `${source} weight ${weight} is out of range`);
    }
});
