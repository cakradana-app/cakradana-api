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

/**
 * Cross-source corroboration.
 *
 * A donation described by both a filed return and a scraped page stands on
 * better evidence than one only a scrape has ever mentioned, and a reviewer
 * about to put a finding to the person it names should be able to see which
 * they are looking at.
 *
 * The discipline that makes the count mean anything is what is refused: the
 * same document arriving twice is not corroboration. Counting it would let a
 * single source manufacture its own confirmation, and the confidence that
 * followed would rest on one observation counted repeatedly.
 */

const { isIndependentSource } = require('../app/domains/canonical/ingest');

function held(overrides = {}) {
    return {
        channel: 'web-scrape',
        sourceDocument: { reference: 'https://kpu.go.id/ladk/123' },
        corroboration: [],
        ...overrides,
    };
}

test('the same document arriving twice is not corroboration', () => {
    assert.equal(
        isIndependentSource(held(), {
            channel: 'web-scrape',
            sourceReference: 'https://kpu.go.id/ladk/123',
        }),
        false,
    );
});

test('a new document on a channel already counted does not corroborate', () => {
    // The defect this replaces: the check returned on the reference alone
    // whenever one was present, and the digital-form channel takes
    // `sourceReference` verbatim from the request body. One caller resubmitting
    // the same donation with a fresh reference string each time was judged
    // independent every time, and the case bundle told the reviewer the
    // donation had four sources.
    //
    // The cost is stated rather than hidden: two genuinely different filed
    // returns scraped from the same site now count once. Under-counting real
    // corroboration weakens a signal; over-counting it manufactures evidence.
    assert.equal(
        isIndependentSource(held(), {
            channel: 'web-scrape',
            sourceReference: 'https://kpu.go.id/lppdk/456',
        }),
        false,
    );
});

test('a caller cannot manufacture sources by varying the reference', () => {
    let record = held({ channel: 'digital-form', sourceDocument: { reference: 'r1' } });
    for (const reference of ['r2', 'r3', 'r4']) {
        assert.equal(
            isIndependentSource(record, { channel: 'digital-form', sourceReference: reference }),
            false,
            `reference ${reference} should not count as a second source`,
        );
    }
});

test('one upload does not corroborate itself across its own pages', () => {
    // Every page of a scan carries its own filename but arrives through one
    // channel in one act of reporting. A summary page repeating a line item
    // would otherwise be reported as a second independent source.
    const record = held({ channel: 'paper-form', sourceDocument: { reference: 'page1.jpg' } });
    assert.equal(
        isIndependentSource(record, { channel: 'paper-form', sourceReference: 'page2.jpg' }),
        false,
    );
});

test('a different channel with no document reference counts once', () => {
    // A digital submission and a paper scan are not the same act of reporting,
    // even when neither carries a document identifier.
    assert.equal(isIndependentSource(held(), { channel: 'digital-form' }), true);
});

test('the same channel with no reference does not corroborate', () => {
    assert.equal(isIndependentSource(held(), { channel: 'web-scrape' }), false);
});

test('a source already counted does not corroborate a second time', () => {
    const record = held({
        corroboration: [{ channel: 'paper-form', sourceReference: 'scan-77' }],
    });
    assert.equal(
        isIndependentSource(record, { channel: 'paper-form', sourceReference: 'scan-77' }),
        false,
    );
});

test('a channel already counted through corroboration does not count again', () => {
    const record = held({
        corroboration: [{ channel: 'digital-form', sourceReference: null }],
    });
    assert.equal(isIndependentSource(record, { channel: 'digital-form' }), false);
});

test('a record with no source document is still bounded by its channel', () => {
    const record = held({ sourceDocument: null, channel: 'import' });
    assert.equal(
        isIndependentSource(record, { channel: 'import', sourceReference: 'batch-1' }),
        false,
    );
    assert.equal(
        isIndependentSource(record, { channel: 'paper-form', sourceReference: 'scan-1' }),
        true,
    );
});

test('a channel claimed without a reference is not reopened by one with a reference', () => {
    // The reverse of the case that was covered. Both orders have to hold, or
    // the same channel is counted twice depending on which arrived first.
    const record = held({
        channel: 'web-scrape',
        sourceDocument: null,
        corroboration: [{ channel: 'paper-form', sourceReference: null }],
    });
    assert.equal(
        isIndependentSource(record, { channel: 'paper-form', sourceReference: 'scan-9' }),
        false,
    );
});
