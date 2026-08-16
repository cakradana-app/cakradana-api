/**
 * Suspicious activity report drafts.
 *
 * A formal-looking document is exactly the kind of thing people assume has been
 * checked, so what is tested here is mostly what a draft refuses to imply.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    approve,
    buildLimitations,
    STRUCTURE_REVIEWED,
    UNREVIEWED_NOTICE,
    STANDING_CAVEAT,
} = require('../app/domains/services/reports/sar');

function draft(overrides = {}) {
    return {
        draftId: 'draft-1',
        status: 'draft',
        limitations: [],
        notices: [STANDING_CAVEAT],
        ...overrides,
    };
}

test('the draft structure is not claimed to be conformant', () => {
    // It has not been checked against the receiving authority's requirements,
    // and a document that looks official invites the assumption that it has.
    assert.equal(STRUCTURE_REVIEWED, false);
    assert.match(UNREVIEWED_NOTICE, /has not been reviewed/);
});

test('the standing caveat separates findings from determinations', () => {
    assert.match(STANDING_CAVEAT, /not determinations that an offence occurred/);
    assert.match(STANDING_CAVEAT, /for the competent authority/);
});

test('unevaluated checks are reported as a limitation', () => {
    // Their absence from the findings is not evidence of compliance, and a
    // reader will not infer that from an empty list.
    const limitations = buildLimitations({
        donations: [{ senderRef: { entityId: 'a' }, receiverRef: { entityId: 'b' } }],
        events: [
            {
                indeterminateRules: [
                    { rule_id: 'RULE-T1-09', reason: 'register unavailable' },
                ],
            },
        ],
        dispositions: [{ value: 'risky' }],
        anyDemonstration: false,
    });
    const incomplete = limitations.find((l) => l.kind === 'incomplete-evaluation');
    assert.ok(incomplete);
    assert.match(incomplete.detail, /not evidence of compliance/);
});

test('a draft nobody has reviewed says so', () => {
    const limitations = buildLimitations({
        donations: [{ senderRef: { entityId: 'a' }, receiverRef: { entityId: 'b' } }],
        events: [{}],
        dispositions: [],
        anyDemonstration: false,
    });
    assert.ok(limitations.some((l) => l.kind === 'no-human-assessment'));
});

test('unresolved parties are declared, with the count', () => {
    // Any total computed across them may be attributing transactions to the
    // wrong person, which matters most in exactly this document.
    const limitations = buildLimitations({
        donations: [
            { senderRef: { entityId: 'a' }, receiverRef: { entityId: 'b' } },
            { senderRef: {}, receiverRef: { entityId: 'b' } },
        ],
        events: [{}],
        dispositions: [{ value: 'risky' }],
        anyDemonstration: false,
    });
    const unresolved = limitations.find((l) => l.kind === 'unresolved-parties');
    assert.ok(unresolved);
    assert.match(unresolved.detail, /1 of 2/);
});

test('fixture-backed findings block the draft entirely', () => {
    const limitations = buildLimitations({
        donations: [{ senderRef: { entityId: 'a' }, receiverRef: { entityId: 'b' } }],
        events: [{}],
        dispositions: [{ value: 'risky' }],
        anyDemonstration: true,
    });
    const blocking = limitations.find((l) => l.kind === 'non-authoritative-evidence');
    assert.ok(blocking);
    assert.equal(blocking.blocking, true);
});

test('a blocked draft cannot be approved', async () => {
    // Demonstration evidence establishes nothing about any party, and a report
    // built on it must not reach a receiving authority.
    await assert.rejects(
        () =>
            approve(
                draft({
                    limitations: [
                        { kind: 'non-authoritative-evidence', blocking: true, detail: 'fixture data' },
                    ],
                }),
                { actor: 'analyst@example.org', audit: async () => {} },
            ),
        /cannot be approved/,
    );
});

test('an approval must name the person giving it', async () => {
    await assert.rejects(
        () => approve(draft(), { actor: null, audit: async () => {} }),
        /name the person/,
    );
});

test('approval does not transmit anything', async () => {
    // The decision to accuse a named person of financial crime should leave the
    // building by a deliberate human act, not as a side effect of a score.
    const logged = [];
    const approved = await approve(draft(), {
        actor: 'analyst@example.org',
        audit: async (entry) => logged.push(entry),
    });

    assert.equal(approved.status, 'approved-for-manual-submission');
    assert.equal(approved.transmission.automatic, false);
    assert.match(approved.transmission.detail, /does not transmit/);
    assert.equal(logged.length, 1, 'the approval must be recorded');
    assert.equal(logged[0].actor, 'analyst@example.org');
});
