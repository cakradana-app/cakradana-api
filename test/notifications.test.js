/**
 * Telling a subject they have been flagged.
 *
 * The tests are mostly about what cannot happen: nothing sent automatically,
 * nothing withheld without a recorded reason, and no risk score in anything the
 * subject receives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    Notification,
    WITHHOLDING_REASONS,
} = require('../app/domains/services/notifications/notification.model');
const {
    deliveryEnabled,
} = require('../app/domains/services/notifications/notification.controller');

const DONATION_ID = '507f1f77bcf86cd799439011';

function notice(overrides = {}) {
    return new Notification({
        donationId: DONATION_ID,
        party: 'sender',
        trigger: { kind: 'legal_finding', ruleIds: ['RULE-T1-01'] },
        ...overrides,
    });
}

test('delivery is off unless the deployment turns it on', () => {
    // Notifying a real person is not reversible, and a backfill or a rescore
    // of historical data would otherwise reach them.
    const original = process.env.NOTIFY_SUBJECTS;
    delete process.env.NOTIFY_SUBJECTS;
    assert.equal(deliveryEnabled(), false);
    process.env.NOTIFY_SUBJECTS = 'yes';
    assert.equal(deliveryEnabled(), false, 'only an exact opt-in counts');
    process.env.NOTIFY_SUBJECTS = 'true';
    assert.equal(deliveryEnabled(), true);
    if (original === undefined) delete process.env.NOTIFY_SUBJECTS;
    else process.env.NOTIFY_SUBJECTS = original;
});

test('a candidate starts undecided', async () => {
    const candidate = notice();
    await candidate.validate();
    assert.equal(candidate.state, 'pending_decision');
});

test('withholding without a reason is refused', async () => {
    // A notice never sent leaves no trace of its own absence, so the reason is
    // the only thing that distinguishes a decision from an oversight.
    await assert.rejects(
        () => notice({ state: 'withheld', decidedBy: 'a@example.org' }).validate(),
        /must record why/,
    );
});

test('"other" must say what it was', async () => {
    await assert.rejects(
        () =>
            notice({
                state: 'withheld',
                decidedBy: 'a@example.org',
                withholdingReason: 'other',
            }).validate(),
        /must say what it was/,
    );
});

test('an active investigation is a recordable reason', async () => {
    // The exemption is real and is recorded as such rather than left as a
    // silent absence.
    assert.ok(WITHHOLDING_REASONS.includes('active_investigation'));
    await assert.doesNotReject(() =>
        notice({
            state: 'withheld',
            decidedBy: 'a@example.org',
            withholdingReason: 'active_investigation',
        }).validate(),
    );
});

test('no decision is anonymous, in either direction', async () => {
    await assert.rejects(
        () => notice({ state: 'approved' }).validate(),
        /must name the person who made it/,
    );
});

test('an unresolved subject can still be the subject of a candidate', async () => {
    // Otherwise the case never appears, and is then withheld for want of
    // anyone to send it to — which is a decision somebody should make rather
    // than a gap nobody sees.
    const candidate = notice({ subjectEntityId: null, subjectRawText: 'Budi Santoso' });
    await assert.doesNotReject(() => candidate.validate());
});

test('the trigger distinguishes a finding from a score', async () => {
    // A statutory finding is a fact with an article behind it; a behavioural
    // band is an estimate. Telling someone the second is a different act.
    const legal = notice();
    await legal.validate();
    assert.equal(legal.trigger.kind, 'legal_finding');

    const behavioural = notice({
        trigger: { kind: 'behavioural_band', band: 'high' },
    });
    await behavioural.validate();
    assert.equal(behavioural.trigger.band, 'high');
});
