/**
 * Role-based access and subject scoping.
 *
 * A donation record is a political preference attached to a name. Showing one
 * to the wrong person discloses somebody's politics to a stranger, which makes
 * scoping errors worse here than the usual authorisation bug.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ROLES,
    DEFAULT_ROLE,
    REVIEWERS,
    requireRole,
    roleOf,
} = require('../app/middlewares/auth/roles');

function call(middleware, { role } = {}) {
    const req = { user: role ? { role } : {}, path: '/service/donations/queue' };
    const captured = { status: null, body: null, passed: false };
    const res = {
        status(code) {
            captured.status = code;
            return this;
        },
        json(body) {
            captured.body = body;
            return this;
        },
    };
    middleware(req, res, () => {
        captured.passed = true;
    });
    return captured;
}

function withEnforcement(on, run) {
    const original = process.env.ENFORCE_ROLES;
    process.env.ENFORCE_ROLES = on ? 'true' : 'false';
    try {
        return run();
    } finally {
        if (original === undefined) delete process.env.ENFORCE_ROLES;
        else process.env.ENFORCE_ROLES = original;
    }
}

test('a self-registered account is a recipient, not a reviewer', () => {
    // Most people who sign up are subjects of this data. Defaulting the other
    // way would hand the review queue to anyone who registered.
    assert.equal(DEFAULT_ROLE, 'recipient');
    assert.ok(!REVIEWERS.includes(DEFAULT_ROLE));
});

test('an account with no role is treated as the default', () => {
    assert.equal(roleOf({ user: {} }), DEFAULT_ROLE);
    assert.equal(roleOf({}), DEFAULT_ROLE);
});

test('a permitted role passes', () => {
    withEnforcement(true, () => {
        const result = call(requireRole(REVIEWERS), { role: 'ppatk_analyst' });
        assert.equal(result.passed, true);
    });
});

test('a refusal names the role held and the roles accepted', () => {
    // An opaque 403 sends an operator to the logs to discover something the
    // response could have said.
    withEnforcement(true, () => {
        const result = call(requireRole(REVIEWERS), { role: 'recipient' });
        assert.equal(result.status, 403);
        assert.match(result.body.message, /recipient/);
        assert.match(result.body.message, /ppatk_analyst/);
    });
});

test('with enforcement off the request proceeds and is recorded', () => {
    // The point of the unenforced mode: the log shows exactly what enforcement
    // would break, before it breaks it.
    withEnforcement(false, () => {
        const result = call(requireRole(REVIEWERS), { role: 'recipient' });
        assert.equal(result.passed, true);
        assert.equal(result.status, null);
    });
});

test('adjudication is narrower than review', () => {
    // Resolving a dispute decides whether an attribution about a named person
    // stands. It is not the same authority as reading a queue.
    withEnforcement(true, () => {
        const analyst = call(requireRole('adjudicator', 'kpu_officer'), {
            role: 'ppatk_analyst',
        });
        assert.equal(analyst.passed, false);
        const adjudicator = call(requireRole('adjudicator', 'kpu_officer'), {
            role: 'adjudicator',
        });
        assert.equal(adjudicator.passed, true);
    });
});

test('an ml engineer is not a reviewer', () => {
    // Analytical access is not access to the personal records behind it.
    assert.ok(ROLES.includes('ml_engineer'));
    assert.ok(!REVIEWERS.includes('ml_engineer'));
});

test('an administrator is not a reviewer either', () => {
    // Configuration and rule sets, not donation content.
    assert.ok(!REVIEWERS.includes('administrator'));
});

test('every role is a known role', () => {
    for (const role of REVIEWERS) assert.ok(ROLES.includes(role));
});
