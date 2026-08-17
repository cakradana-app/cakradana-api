/**
 * Admitting a batch, against a database.
 *
 * `ingest.test.js` covers what a candidate must carry, what gets quarantined,
 * and how a record is shaped — all reachable without a store. What is not
 * reachable that way is everything that depends on what is already held:
 * whether this donation has been seen before, whether the party resolves to an
 * existing entity or a new one, and whether a second report of the same
 * donation counts as corroboration or as the same document arriving twice.
 *
 * That last question is where the second of the two defects found in review
 * lived. `isIndependentSource` returned as soon as the caller-supplied source
 * reference was unfamiliar, so one submitter could confirm their own filing by
 * uploading it again under a new reference — through the same channel, in the
 * same session. The docstring said counting a re-upload would let a single
 * source manufacture its own confirmation, and the function did exactly that.
 *
 * A corroboration count is read as independent reports of the same donation.
 * Inflating it makes a record look better evidenced than it is, which is the
 * direction that matters: an over-corroborated record is one an analyst is less
 * likely to question.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const {
    Donation,
    Entity,
    Quarantine,
} = require('../app/domains/canonical/canonical.model');
const { ingestBatch } = require('../app/domains/canonical/ingest');
const {
    ResolutionReview,
} = require('../app/domains/services/entities/resolution-review.model');

useDatabase();

function candidate(overrides = {}) {
    return {
        senderName: 'Budi Santoso',
        senderType: 'individual',
        receiverName: 'Partai Maju',
        receiverType: 'political-party',
        amountIdr: 10_000_000,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'digital-form',
        ...overrides,
    };
}

async function ingest(candidates, options = {}) {
    return ingestBatch(candidates, options);
}

test('the same donation reported twice through one channel is not corroboration', async () => {
    // The defect. A new source reference through a channel already heard from
    // was enough, so re-uploading the same filing under a fresh reference
    // manufactured a second independent report of it.
    const first = await ingest([candidate({ sourceReference: 'filing-a' })]);
    assert.equal(first.results[0].status, 'ingested');

    const again = await ingest([candidate({ sourceReference: 'filing-a-resent' })]);
    assert.equal(again.results[0].status, 'duplicate');
    assert.equal(
        again.results[0].corroborating,
        false,
        'a second upload through the same channel was counted as corroboration',
    );
    assert.equal(again.results[0].sources, 1);

    const stored = await Donation.findOne({}).lean();
    assert.equal(stored.corroboration.length, 0);
});

test('the same document arriving twice is not corroboration either', async () => {
    await ingest([candidate({ sourceReference: 'filing-a' })]);
    const again = await ingest([
        candidate({ channel: 'web-scrape', sourceReference: 'filing-a' }),
    ]);
    assert.equal(again.results[0].corroborating, false);
});

test('a genuinely independent report is recorded as corroboration', async () => {
    // Both halves have to be new: a channel not heard from, carrying a
    // document identifier not seen. A filed return and a scraped page
    // describing the same donation is better evidence than either alone.
    await ingest([candidate({ sourceReference: 'filing-a' })]);
    const scraped = await ingest([
        candidate({ channel: 'web-scrape', sourceReference: 'kpu-page-1' }),
    ]);

    assert.equal(scraped.results[0].status, 'duplicate');
    assert.equal(scraped.results[0].corroborating, true);
    // The count includes the original observation, so a record only one source
    // has mentioned reads as 1 rather than 0.
    assert.equal(scraped.results[0].sources, 2);

    const stored = await Donation.findOne({}).lean();
    assert.equal(stored.corroboration.length, 1);
    assert.equal(stored.corroboration[0].channel, 'web-scrape');
    assert.equal(stored.corroboration[0].sourceReference, 'kpu-page-1');
});

test('a third channel corroborates once more, and a repeat of it does not', async () => {
    await ingest([candidate({ sourceReference: 'filing-a' })]);
    await ingest([candidate({ channel: 'web-scrape', sourceReference: 'kpu-page-1' })]);
    const paper = await ingest([
        candidate({ channel: 'paper-form', sourceReference: 'scan-77' }),
    ]);
    assert.equal(paper.results[0].sources, 3);

    const repeat = await ingest([
        candidate({ channel: 'paper-form', sourceReference: 'scan-78' }),
    ]);
    assert.equal(repeat.results[0].corroborating, false);
    assert.equal(repeat.results[0].sources, 3);
});

test('a donation is admitted once however many times it is submitted', async () => {
    // Double-counting inflates cumulative totals and can manufacture a
    // statutory finding that did not occur.
    await ingest([
        candidate({ sourceReference: 'a' }),
        candidate({ sourceReference: 'b' }),
        candidate({ sourceReference: 'c' }),
    ]);
    assert.equal(await Donation.countDocuments({}), 1);
});

test('both parties are resolved to entities, and reused on the next donation', async () => {
    await ingest([candidate()]);
    await ingest([candidate({ amountIdr: 20_000_000 })]);

    assert.equal(await Donation.countDocuments({}), 2);
    assert.equal(await Entity.countDocuments({}), 2);

    const donations = await Donation.find({}).lean();
    const senders = new Set(donations.map((d) => String(d.senderRef.entityId)));
    assert.equal(senders.size, 1, 'the same donor resolved to two entities');
});

test('a near match creates a separate entity and queues the question', async () => {
    // Merging on a string similarity attributes one person's giving to
    // another. The donation survives as its own donor and a person decides.
    //
    // The names are chosen to land between the two thresholds: similarity is
    // weighted token overlap, so one extra name part scores 0.88 — close
    // enough to be worth a person's judgement, not close enough to merge
    // unattended.
    await ingest([candidate({ senderName: 'Budi Santoso Wijaya Kusuma' })]);
    const near = await ingest([
        candidate({
            senderName: 'Budi Santoso Wijaya Kusuma Adi',
            amountIdr: 12_000_000,
        }),
    ]);

    assert.equal(near.results[0].status, 'ingested');
    assert.equal(
        await Entity.countDocuments({ entityType: 'individual' }),
        2,
        'a near match was merged unattended',
    );

    const queued = await ResolutionReview.find({}).lean();
    assert.equal(queued.length, 1, 'a near match was set aside with nowhere to decide it');
    assert.equal(queued[0].state, 'open');
    assert.equal(queued[0].basis, 'fuzzy-below-threshold');
    assert.ok(queued[0].reviewBy instanceof Date);
});

test('an exact repeat of a name resolves to the same entity, raising nothing', async () => {
    // The counterweight to the test above: a queue that fills with pairs
    // nobody needs to decide is a queue nobody works.
    await ingest([candidate({ senderName: 'Budi Santoso Wijaya Kusuma' })]);
    await ingest([
        candidate({ senderName: 'Budi Santoso Wijaya Kusuma', amountIdr: 12_000_000 }),
    ]);
    assert.equal(await Entity.countDocuments({ entityType: 'individual' }), 1);
    assert.equal(await ResolutionReview.countDocuments({}), 0);
});

test('a record that cannot be admitted is quarantined without failing the batch', async () => {
    // Per record, never the batch: one unreadable row in an upload of two
    // hundred must not discard the other hundred and ninety-nine.
    const summary = await ingest([
        candidate(),
        candidate({ amountIdr: null, sourceReference: 'broken' }),
        candidate({ amountIdr: 30_000_000 }),
    ]);

    const statuses = summary.results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 'ingested').length, 2);
    assert.equal(statuses.filter((s) => s === 'quarantined').length, 1);
    assert.equal(await Donation.countDocuments({}), 2);
    assert.equal(await Quarantine.countDocuments({}), 1);
});

test('a quarantined record carries a deadline it can be found by', async () => {
    // A record set aside with a reason and never looked at again is data loss
    // with better bookkeeping.
    await ingest([candidate({ amountIdr: null })]);
    const held = await Quarantine.findOne({}).lean();
    assert.ok(held.reviewBy instanceof Date);
    assert.ok(held.reviewBy > held.createdAt);
});

test('the donation records when it happened and when the system learned of it', async () => {
    // Point-in-time feature computation depends on knowing what was knowable
    // when, and one date cannot express both.
    const occurredAt = new Date('2026-06-05T00:00:00Z');
    await ingest([candidate({ occurredAt })]);
    const stored = await Donation.findOne({}).lean();
    assert.equal(stored.occurredAt.getTime(), occurredAt.getTime());
    assert.ok(stored.recordedAt instanceof Date);
    assert.ok(stored.recordedAt >= occurredAt);
});

test('a name too ambiguous to resolve is admitted and reported, not dropped', async () => {
    // The donation is the record; an unresolved party is a question about it,
    // not a reason to lose it.
    const summary = await ingest([candidate({ senderName: 'A' })]);
    assert.equal(summary.results[0].status, 'ingested');
    const stored = await Donation.findOne({}).lean();
    assert.equal(stored.senderRef.rawText, 'A');
});
