/**
 * Retention policy and the access log.
 *
 * Donation records attach a name to a political preference, which puts them in
 * the category with the highest handling standard. What is tested here is that
 * the practical consequences of that are in code rather than in a policy
 * document nobody executes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AuditEntry, RETENTION } = require('../app/domains/canonical/retention');

test('every retained category states why it is retained', () => {
    // A period with no stated purpose is data held on no basis, and "we might
    // want it later" is not a basis.
    for (const [category, policy] of Object.entries(RETENTION)) {
        assert.ok(policy.days > 0, `${category} has no retention period`);
        assert.ok(policy.because && policy.because.length > 20, `${category} has no stated purpose`);
    }
});

test('quarantined records are not held indefinitely', () => {
    // They hold the personal data of whoever appeared in the source document,
    // and a record nobody corrected in a quarter will not be corrected.
    assert.ok(RETENTION.quarantine.days <= 180);
});

test('scoring events outlive the processes that consumed them', () => {
    // A score that fed a regulatory process has to remain explicable for as
    // long as that process can be reopened.
    assert.ok(RETENTION.scoringEvents.days >= 365 * 5);
});

test('the access log outlives the access it records', () => {
    assert.ok(RETENTION.auditLog.days >= RETENTION.quarantine.days);
});

test('an audit entry names who did what to which record', async () => {
    const entry = new AuditEntry({
        actor: 'analyst@example.org',
        action: 'view-case',
        subjectType: 'Donation',
        subjectId: '507f1f77bcf86cd799439011',
    });
    await assert.doesNotReject(() => entry.validate());
    assert.equal(entry.outcome, 'allowed');
});

test('a refused attempt is recordable', async () => {
    // A log holding only what succeeded cannot show that someone tried
    // repeatedly to reach records they had no business reading.
    const entry = new AuditEntry({
        actor: 'someone@example.org',
        action: 'view-case',
        subjectType: 'Donation',
        subjectId: '507f1f77bcf86cd799439011',
        outcome: 'denied',
        reason: 'not assigned to this case',
    });
    await assert.doesNotReject(() => entry.validate());
});

test('an entry without an actor is refused', async () => {
    const entry = new AuditEntry({ action: 'view-case', subjectType: 'Donation' });
    await assert.rejects(() => entry.validate());
});

test('the log references records rather than copying them', () => {
    // Otherwise it becomes a second uncontrolled store of the data it exists
    // to protect.
    const paths = Object.keys(AuditEntry.schema.paths);
    assert.ok(paths.includes('subjectId'));
    assert.ok(!paths.includes('payload'));
    assert.ok(!paths.some((p) => p.startsWith('donation.')));
});
