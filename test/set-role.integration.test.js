/**
 * Assigning a role, which nothing could do until now.
 *
 * `ENFORCE_ROLES=true` refuses every reviewer route to every account that does
 * not hold a reviewer role, and every account defaults to `recipient` because
 * most people who register are subjects of the data rather than reviewers of
 * it. With no way to change that field, switching the flag on locked out the
 * review queue permanently and there was no in-band remedy — the endpoint that
 * would grant a role would itself need a role to guard it.
 *
 * That gap is invisible from either side on its own. The middleware is correct
 * and tested; the model has the field with the right enum. What was missing was
 * the only path between them, and the failure it produces looks like a
 * deployment problem rather than a missing feature.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const { User } = require('../app/domains/users/user.model');
const { AuditEntry } = require('../app/domains/canonical/retention');
const { DEFAULT_ROLE } = require('../app/middlewares/auth/roles');
const { assign } = require('../scripts/set-role');

useDatabase();

const ADMIN = 'operator@cakradana.faizath.com';

async function makeUser(email, name) {
    return User.create({ email, name, password: 'x'.repeat(20), type: 'individual' });
}

test('a new account holds the default role and nothing else', async () => {
    const user = await makeUser('subject@example.org', 'Subject One');
    assert.equal(user.role, DEFAULT_ROLE);
    assert.equal(DEFAULT_ROLE, 'recipient');
});

test('a role can be assigned, and the assignment is recorded', async () => {
    await makeUser('analyst@example.org', 'Analyst One');
    await assign('analyst@example.org', 'ppatk_analyst', ADMIN);

    const reread = await User.findOne({ email: 'analyst@example.org' }).lean();
    assert.equal(reread.role, 'ppatk_analyst');

    // A role change decides what somebody may read about other people's
    // donations, so it has to be answerable afterwards — and by whom, not only
    // that it happened.
    const logged = await AuditEntry.findOne({ action: 'set-role' }).lean();
    assert.ok(logged, 'a privilege change wrote no audit entry');
    assert.equal(logged.actor, ADMIN);
    assert.match(logged.reason, /recipient to ppatk_analyst/);
});

test('an unknown role is refused rather than stored', async () => {
    await makeUser('someone@example.org', 'Someone Else');
    await assert.rejects(
        () => assign('someone@example.org', 'superuser', ADMIN),
        /is not a role/,
    );
    const reread = await User.findOne({ email: 'someone@example.org' }).lean();
    assert.equal(reread.role, DEFAULT_ROLE);
});

test('an unknown account is refused', async () => {
    await assert.rejects(
        () => assign('nobody@example.org', 'ppatk_analyst', ADMIN),
        /No account for/,
    );
});

test('assigning the role somebody already holds writes no audit entry', async () => {
    // A no-op recorded as a privilege change makes the log describe activity
    // that did not happen, which is the log this file is arguing matters.
    await makeUser('steady@example.org', 'Steady State');
    await assign('steady@example.org', 'kpu_officer', ADMIN);
    await AuditEntry.deleteMany({});
    await assign('steady@example.org', 'kpu_officer', ADMIN);
    assert.equal(await AuditEntry.countDocuments({ action: 'set-role' }), 0);
});

test('a role can be taken away as well as given', async () => {
    // The direction that matters when somebody leaves the role rather than the
    // organisation. Nothing here is one-way.
    await makeUser('former@example.org', 'Former Analyst');
    await assign('former@example.org', 'ppatk_analyst', ADMIN);
    await assign('former@example.org', 'recipient', ADMIN);

    const reread = await User.findOne({ email: 'former@example.org' }).lean();
    assert.equal(reread.role, 'recipient');
    assert.equal(await AuditEntry.countDocuments({ action: 'set-role' }), 2);
});
