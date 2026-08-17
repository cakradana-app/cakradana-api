/**
 * Case assembly.
 *
 * The constraint under test is that a report cannot be produced from a
 * selection of donations alone. Requiring a narrative first is what keeps a
 * formal document from being a rendering of a score.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Case, CASE_STATES } = require('../app/domains/services/cases/case.model');

const DONATION_ID = '507f1f77bcf86cd799439011';

function file(overrides = {}) {
    return new Case({
        title: 'Converging donations to one recipient',
        openedBy: 'analyst@example.org',
        donationIds: [DONATION_ID],
        ...overrides,
    });
}

test('a case can be opened before it is explained', async () => {
    // Assembly is work in progress; requiring the account up front would mean
    // writing it before reading the records.
    await assert.doesNotReject(() => file().validate());
});

test('a case cannot be assembled without an account of what connects it', async () => {
    await assert.rejects(
        () => file({ state: 'assembled' }).validate(),
        /a selection, not a case/,
    );
});

test('a case cannot be reported without one either', async () => {
    await assert.rejects(() => file({ state: 'reported' }).validate(), /narrative/);
});

test('an explained case with no donations describes nothing', async () => {
    await assert.rejects(
        () =>
            file({
                state: 'assembled',
                narrative: 'Twenty-three donors in nine days.',
                donationIds: [],
            }).validate(),
        /describes nothing/,
    );
});

test('an explained case with donations advances', async () => {
    await assert.doesNotReject(() =>
        file({
            state: 'assembled',
            narrative: 'Twenty-three donors in nine days, none with prior history.',
        }).validate(),
    );
});

test('the cluster a case came from is recorded', async () => {
    // So the reasoning traces back to what surfaced it rather than starting at
    // the analyst's conclusion.
    const assembled = file({ alertIds: ['cluster:9f2a1b'] });
    await assembled.validate();
    assert.deepEqual([...assembled.alertIds], ['cluster:9f2a1b']);
});

test('a case has somewhere to end', () => {
    assert.ok(CASE_STATES.includes('closed'));
});
