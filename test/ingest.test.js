/**
 * Entity resolution and the ingestion guards.
 *
 * These cover the pure parts — name folding, similarity, deduplication, and
 * validation — which is where the correctness of every cumulative limit
 * ultimately rests. A donor split across spellings looks like several donors,
 * each comfortably under the cap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseName, similarity, AUTO_THRESHOLD, REVIEW_THRESHOLD } = require('../app/domains/canonical/resolution');
const { buildDedupKey, truncateToPrecision, validate } = require('../app/domains/canonical/ingest');
const { toCandidate } = require('../app/domains/services/digital-form/digital.controller');

test('legal-form tokens are not part of an identity', () => {
    assert.equal(normaliseName('PT. Sumber Sejahtera (Persero)'), 'sumber sejahtera');
    assert.equal(normaliseName('CV Karya Mandiri'), 'karya mandiri');
});

test('honorifics and punctuated qualifications are not part of an identity', () => {
    // The same person appears with and without these between a scanned form
    // and a filed report.
    assert.equal(normaliseName('Dr. Budi Santoso, S.E.'), 'budi santoso');
    assert.equal(normaliseName('H. Budi Santoso'), 'budi santoso');
});

test('the same person written two ways resolves to one identity', () => {
    const score = similarity(normaliseName('Dr. Budi Santoso'), normaliseName('budi  santoso'));
    assert.equal(score, 1);
});

test('two people sharing a given name are not the same person', () => {
    const score = similarity(normaliseName('Budi Santoso'), normaliseName('Budi Wijaya'));
    assert.ok(score < REVIEW_THRESHOLD, `expected a low score, got ${score}`);
});

test('a near match sits below the automatic threshold', () => {
    // Close enough to deserve a person's judgement, not close enough to merge
    // unattended. A wrong merge attributes one person's donations to another.
    const score = similarity(normaliseName('Budi Santoso'), normaliseName('Budi Santosa'));
    assert.ok(score < AUTO_THRESHOLD);
});

test('an empty or unidentifying name yields nothing to resolve against', () => {
    assert.equal(normaliseName(''), '');
    assert.equal(normaliseName('PT'), '');
    assert.equal(normaliseName(null), '');
});

test('a timestamp is truncated to the precision the source stated', () => {
    // Treating a date-only record as midnight invents a time of day, and
    // enough of them create a spike that looks like coordinated timing.
    const stamp = new Date('2026-06-05T14:32:11.500Z');
    assert.equal(truncateToPrecision(stamp, 'day').toISOString(), '2026-06-05T00:00:00.000Z');
    assert.equal(truncateToPrecision(stamp, 'hour').toISOString(), '2026-06-05T14:00:00.000Z');
    assert.equal(truncateToPrecision(stamp, 'minute').toISOString(), '2026-06-05T14:32:00.000Z');
});

test('the same donation seen twice at day precision collides', () => {
    // Counting it twice inflates a donor's running total and can manufacture a
    // limit breach that never happened.
    const shared = { senderId: 'a', receiverId: 'b', amountIdr: 100, precision: 'day', electoralContext: 'x' };
    const morning = buildDedupKey({ ...shared, occurredAt: new Date('2026-06-05T09:00:00Z') });
    const evening = buildDedupKey({ ...shared, occurredAt: new Date('2026-06-05T21:00:00Z') });
    assert.equal(morning, evening);
});

test('different amounts do not collide', () => {
    const shared = { senderId: 'a', receiverId: 'b', occurredAt: new Date('2026-06-05T00:00:00Z'), precision: 'day', electoralContext: 'x' };
    assert.notEqual(
        buildDedupKey({ ...shared, amountIdr: 100 }),
        buildDedupKey({ ...shared, amountIdr: 200 }),
    );
});

test('an unresolved donor does not collide with a resolved one', () => {
    const shared = { receiverId: 'b', amountIdr: 100, occurredAt: new Date('2026-06-05T00:00:00Z'), precision: 'day', electoralContext: 'x' };
    assert.notEqual(
        buildDedupKey({ ...shared, senderId: 'a' }),
        buildDedupKey({ ...shared, senderId: null }),
    );
});

test('validation reports every problem rather than the first', () => {
    // A quarantined record should be correctable in one pass.
    const problems = validate({ amountIdr: 0, channel: 'nope' });
    assert.ok(problems.length >= 3);
    assert.match(problems.join(' '), /amount/);
    assert.match(problems.join(' '), /channel/);
    assert.match(problems.join(' '), /recipient/);
});

test('a donation cannot be recorded as known before it happened', () => {
    const problems = validate({
        amountIdr: 100,
        channel: 'digital-form',
        receiverName: 'Partai Maju',
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-01-01T00:00:00Z'),
    });
    assert.match(problems.join(' '), /before it happened/);
});

test('a sound record produces no problems', () => {
    const problems = validate({
        amountIdr: 100,
        channel: 'digital-form',
        receiverName: 'Partai Maju',
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-06T00:00:00Z'),
        occurredAtPrecision: 'day',
    });
    assert.deepEqual(problems, []);
});

test('a submitted entity type outside the vocabulary becomes unknown', () => {
    // Never coerced into a neighbouring category, which would assert something
    // about the donor that nobody stated.
    const candidate = toCandidate({
        sender: 'Budi',
        sender_type: 'company',
        receiver: 'Partai Maju',
        amount: '100000',
        date: '2026-06-05',
    });
    assert.equal(candidate.senderType, 'unknown');
    assert.equal(candidate.amountIdr, 100000);
    assert.equal(candidate.occurredAtPrecision, 'day');
});

test('a submitted timestamp with a time keeps its precision', () => {
    const candidate = toCandidate({
        receiver: 'Partai Maju',
        amount: 100000,
        date: '2026-06-05 14:30',
    });
    assert.equal(candidate.occurredAtPrecision, 'minute');
});

test('submitted fields are recorded as submitted, not extracted', () => {
    // How a value arrived determines how far it can be trusted and by whom it
    // can be contested.
    const candidate = toCandidate({ receiver: 'Partai Maju', amount: 100000, date: '2026-06-05' });
    assert.ok(candidate.provenance.every((p) => p.provenance === 'submitted'));
});
