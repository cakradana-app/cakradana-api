/**
 * The published dataset, against a database.
 *
 * `public.test.js` covers the schema's refusals and the arithmetic. What it
 * cannot cover without a store is the materialiser — which is where the
 * decisions about what may be published actually happen — or the two endpoints,
 * which are the only routes in this service with no token in front of them.
 *
 * Two defects were found here by reading the code after it became tracked, and
 * both are guarded below. The endpoint passed query values straight into a
 * mongoose filter, and Express parses `?period[$ne]=x` into an object, so an
 * unauthenticated caller could put an operator where a value goes. And a
 * suppressed cell stored its true donation count under `sourceRecords` — no
 * endpoint served it, so nothing leaked, but the design rests on this
 * collection holding only what may be published, so that nobody writing the
 * next endpoint has to remember which fields are safe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const { Donation, Entity } = require('../app/domains/canonical/canonical.model');
const {
    PublicAggregate,
    PublicOperations,
    MIN_DONORS_PER_CELL,
} = require('../app/domains/public/public.model');
const controller = require('../app/domains/public/public.controller');
const { normaliseName } = require('../app/domains/canonical/resolution');

useDatabase();

function reply() {
    const sent = {};
    return {
        sent,
        status(code) {
            sent.status = code;
            return this;
        },
        json(body) {
            sent.body = body;
            return this;
        },
    };
}

async function makeEntity(name, type = 'individual') {
    return Entity.create({
        canonicalName: name,
        normalisedName: normaliseName(name),
        entityType: type,
    });
}

//: A build date at which 2026-Q2 has both closed and settled. A quarter is not
//: published until the settling period has elapsed since it ended, because
//: ingestion is asynchronous and the first build after a quarter closes would
//: otherwise freeze whatever had happened to arrive by then. Every case below
//: is about what gets published, not about when, so each one builds from a date
//: at which its fixtures are publishable.
const AFTER_SETTLING = new Date('2026-10-01T00:00:00Z');

async function donate(sender, receiver, amountIdr, index) {
    return Donation.create({
        senderRef: { entityId: sender._id, rawText: sender.canonicalName },
        receiverRef: { entityId: receiver._id, rawText: receiver.canonicalName },
        amountIdr,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'digital-form',
        dedupKey: `pub-${index}`,
    });
}

/** A recipient with `donors` distinct donors, each giving once. */
async function cellWith(donorCount, amountEach = 10_000_000) {
    const party = await makeEntity('Partai Maju', 'political-party');
    for (let index = 0; index < donorCount; index += 1) {
        const donor = await makeEntity(`Donor ${index}`);
        await donate(donor, party, amountEach, `${donorCount}-${index}`);
    }
    return party;
}

async function serve(query = {}) {
    const res = reply();
    await controller.dataset({ query }, res);
    return res.sent;
}

test('a cell above the threshold is published', async () => {
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: AFTER_SETTLING });

    const sent = await serve();
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.cells.length, 1);
    const cell = sent.body.data.cells[0];
    assert.equal(cell.suppressed, false);
    assert.equal(cell.donors, MIN_DONORS_PER_CELL);
});

test('a cell below the threshold publishes no figures at all', async () => {
    // An aggregate over two donors is two donors. Publishing "Rp1.2 billion
    // from 2 donors" alongside a known large donation identifies the second by
    // arithmetic, which is the ordinary way aggregate releases leak.
    await cellWith(MIN_DONORS_PER_CELL - 1, 600_000_000);
    await controller.materialise({ now: AFTER_SETTLING });

    const sent = await serve();
    const cell = sent.body.data.cells[0];
    assert.equal(cell.suppressed, true);
    assert.equal(cell.donors, 0);
    assert.equal(cell.donations, 0);
    assert.equal(cell.total_idr, 0);
    assert.match(cell.suppression_reason, /fewer than/);
});

test('a suppressed cell holds no true count anywhere in the collection', async () => {
    // The count was stored under `sourceRecords` while every other field was
    // suppressed. Nothing served it, so nothing leaked — but the collection is
    // the published dataset, and the design only works if everything in it is
    // publishable without somebody having to remember which fields are not.
    await cellWith(MIN_DONORS_PER_CELL - 1, 600_000_000);
    await controller.materialise({ now: AFTER_SETTLING });

    const stored = await PublicAggregate.findOne({ suppressed: true }).lean();
    assert.ok(stored, 'the suppressed cell was omitted rather than published as suppressed');
    for (const [field, value] of Object.entries(stored)) {
        if (typeof value !== 'number') continue;
        if (['__v'].includes(field)) continue;
        assert.equal(
            value,
            0,
            `${field} carries ${value} on a suppressed cell, which is a figure suppression withheld`,
        );
    }
});

test('a suppressed cell is published as suppressed, not omitted', async () => {
    // A cell that vanishes reads as an absence of donations rather than an
    // absence of publishable detail.
    await cellWith(MIN_DONORS_PER_CELL - 1);
    const summary = await controller.materialise({ now: AFTER_SETTLING });
    assert.equal(summary.cells, 1);
    assert.equal(summary.suppressed, 1);
    assert.equal(summary.published, 0);

    const sent = await serve();
    assert.equal(sent.body.data.cells.length, 1);
});

test('an operator in a query parameter is refused rather than run', async () => {
    // The one route with no token in front of it. Express parses
    // `?period[$ne]=x` into an object, which reaches mongoose as an operator.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: AFTER_SETTLING });

    for (const period of [{ $ne: null }, { $regex: '(a+)+$' }, ['2026-Q2'], 5]) {
        const sent = await serve({ period });
        assert.equal(sent.status, 400, `an operator got through as ${JSON.stringify(period)}`);
        assert.match(sent.body.message, /quarter/);
    }
});

test('an operator in the electoral context is refused too', async () => {
    const sent = await serve({ electoral_context: { $ne: null } });
    assert.equal(sent.status, 400);
    assert.match(sent.body.message, /single label/);
});

test('a well-formed period still filters', async () => {
    // The refusal above is only correct if the legitimate form still works.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: AFTER_SETTLING });

    const matching = await serve({ period: '2026-Q2' });
    assert.equal(matching.status, 200);
    assert.equal(matching.body.data.cells.length, 1);

    const other = await serve({ period: '2025-Q1' });
    assert.equal(other.status, 200);
    assert.equal(other.body.data.cells.length, 0);
});

test('an unresolved recipient is not published under whatever a scanner read', async () => {
    const donor = await makeEntity('Budi Santoso');
    await Donation.create({
        senderRef: { entityId: donor._id, rawText: 'Budi Santoso' },
        receiverRef: { entityId: null, rawText: 'Partai Ma ju  (smudged)' },
        amountIdr: 10_000_000,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'paper-form',
        dedupKey: 'unresolved-1',
    });
    await controller.materialise({ now: AFTER_SETTLING });

    assert.equal(await PublicAggregate.countDocuments({}), 0);
});

test('a corrected record is not published beside its correction', async () => {
    const party = await cellWith(MIN_DONORS_PER_CELL);
    const superseding = await Donation.findOne({ 'senderRef.rawText': 'Donor 0' });
    await Donation.create({
        senderRef: { entityId: superseding.senderRef.entityId, rawText: 'Donor 0' },
        receiverRef: { entityId: party._id, rawText: 'Partai Maju' },
        amountIdr: 99_000_000,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'digital-form',
        dedupKey: 'superseded-1',
        supersededBy: superseding._id,
    });

    await controller.materialise({ now: AFTER_SETTLING });
    const cell = await PublicAggregate.findOne({ suppressed: false }).lean();
    assert.equal(cell.donationCount, MIN_DONORS_PER_CELL);
});

test('the build replaces rather than accumulates', async () => {
    // An incremental build that misses a deletion leaves a published figure for
    // a record that has since been corrected or withdrawn.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: AFTER_SETTLING });
    await controller.materialise({ now: AFTER_SETTLING });
    assert.equal(await PublicAggregate.countDocuments({}), 1);
});

test('the response says what it excludes and when it was built', async () => {
    // An aggregate with no date attached gets quoted years later as though it
    // were current, and a reader has no other way to know what is missing.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: AFTER_SETTLING });

    const sent = await serve();
    assert.ok(sent.body.data.materialised_at);
    assert.match(sent.body.data.excludes, /risk scores/);
    assert.match(sent.body.data.excludes, /fewer than 5 distinct donors/);
    assert.ok(sent.body.data.rounding_idr > 0);
});

test('no served cell carries a score, band, or flag under any name', async () => {
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: AFTER_SETTLING });

    const sent = await serve();
    // Matched on the cells rather than on the whole envelope, and on words
    // rather than five exact keys. The envelope legitimately names what it
    // excludes — "risk scores, flags, structural alerts" — so scanning the
    // whole body could only ever be a check on five literal spellings, and
    // `behavioural_score` would have passed it. The cells are what the test is
    // named for and what must carry no verdict under any name.
    const served = JSON.stringify(sent.body.data.cells).toLowerCase();
    for (const forbidden of ['score', 'band', 'risk', 'finding', 'flag', 'alert', 'verdict']) {
        assert.equal(
            served.includes(forbidden),
            false,
            `a served cell carries the word "${forbidden}"`,
        );
    }
    // And the envelope still declares the exclusion, which is a different
    // claim and worth keeping.
    assert.match(sent.body.data.excludes, /risk scores/);
});

test('the operations view counts without naming anybody', async () => {
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    const res = reply();
    await controller.operations({ query: {} }, res);

    assert.equal(res.sent.status, 200);
    assert.equal(res.sent.body.data.donations_held, MIN_DONORS_PER_CELL);
    assert.equal(JSON.stringify(res.sent.body).includes('Donor 0'), false);
});

test('the quarter in progress is not published', async () => {
    // Its figures change with every donation admitted, and publishing the
    // sequence is publishing the donations. An observer polling across releases
    // of an open quarter watches a cell gain one donor and one amount, which
    // discloses that donation to the rupiah against a named recipient — the
    // leak the threshold exists to prevent, arrived at by subtraction.
    const party = await makeEntity('Partai Maju', 'political-party');
    for (let index = 0; index < MIN_DONORS_PER_CELL; index += 1) {
        const donor = await makeEntity(`Donor ${index}`);
        await donate(donor, party, 10_000_000, `open-${index}`);
    }

    // `donate` files everything in 2026-Q2, so a clock inside that quarter
    // makes it the quarter in progress.
    await controller.materialise({ now: new Date('2026-05-01T00:00:00Z'), allowEmpty: true });
    assert.equal(await PublicAggregate.countDocuments({}), 0);

    // And a clock past it makes the same quarter publishable.
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });
    assert.equal(await PublicAggregate.countDocuments({}), 1);
});

test('a published figure is not revised in place', async () => {
    // Republishing a revised figure is a second observation of one cell, and
    // the difference between the two is exactly what an observer differences.
    const party = await cellWith(MIN_DONORS_PER_CELL);
    const later = new Date('2026-10-01T00:00:00Z');
    await controller.materialise({ now: later });

    const first = await PublicAggregate.findOne({}).lean();
    assert.equal(first.donorCount, MIN_DONORS_PER_CELL);
    assert.ok(first.firstPublishedAt);
    assert.equal(first.revisionPending, false);

    // A sixth donor arrives for the same closed quarter.
    const extra = await makeEntity('Donor extra');
    await donate(extra, party, 250_000_000, 'extra-1');
    await controller.materialise({ now: new Date('2026-10-02T00:00:00Z') });

    const again = await PublicAggregate.findOne({}).lean();
    assert.equal(
        again.donorCount,
        MIN_DONORS_PER_CELL,
        'the published donor count moved, which discloses the new donor',
    );
    assert.equal(again.totalIdr, first.totalIdr, 'the published total moved');
    assert.equal(again.revisionPending, true);
    assert.match(again.revisionNote, /published figures are unchanged/);
    assert.equal(
        again.firstPublishedAt.getTime(),
        first.firstPublishedAt.getTime(),
    );
});

test('the response says the current quarter is absent by design', async () => {
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });
    const sent = await serve();
    assert.match(sent.body.data.covers, /closed quarters only/);
});

test('the operations figures come from the build, not from a live count', async () => {
    // The endpoint has no token in front of it and no cache behind it, so
    // counting on demand meant three collection scans for anybody who asked, as
    // often as they asked. A live count of donations held at single-record
    // granularity is also a feed: polling it says when records were ingested
    // and how many.
    await cellWith(MIN_DONORS_PER_CELL);

    const before = reply();
    await controller.operations({ query: {} }, before);
    assert.equal(before.sent.body.data.published, false);
    // Distinguished from a system holding nothing, which zeroes would claim.
    assert.match(before.sent.body.data.reason, /has not been built/);

    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    const after = reply();
    await controller.operations({ query: {} }, after);
    assert.equal(after.sent.body.data.published, true);
    assert.equal(after.sent.body.data.donations_held, MIN_DONORS_PER_CELL);
    assert.ok(after.sent.body.data.materialised_at);

    // A donation admitted after the build does not move the published figure
    // until the next one.
    const party = await makeEntity('Partai Baru', 'political-party');
    const donor = await makeEntity('Donor late');
    await donate(donor, party, 10_000_000, 'late-1');

    const stale = reply();
    await controller.operations({ query: {} }, stale);
    assert.equal(
        stale.sent.body.data.donations_held,
        MIN_DONORS_PER_CELL,
        'the published count tracked a live ingestion',
    );
});

test('an upheld rate over no disputes is unmeasured, not zero', async () => {
    // Reporting zero would claim nothing has ever been contested successfully,
    // which is a different and more flattering statement.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    const res = reply();
    await controller.operations({ query: {} }, res);
    assert.equal(res.sent.body.data.disputes_raised, 0);
    assert.equal(res.sent.body.data.dispute_upheld_rate, null);
});

test('a rebuild never leaves the operations figures reporting unbuilt', async () => {
    // The window a delete-then-insert opens. Between the two writes there was
    // no record, so the endpoint answered `published: false` with the reason
    // "the dataset has not been built" — false at that moment, because it had
    // been built and was being rebuilt. One atomic write closes it.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });
    assert.equal(await PublicOperations.countDocuments({}), 1);

    // Rebuild repeatedly; there must never be a moment with no record, and
    // never more than one.
    for (let round = 0; round < 5; round += 1) {
        await controller.materialise({ now: new Date(`2026-10-0${round + 2}T00:00:00Z`) });
        assert.equal(
            await PublicOperations.countDocuments({}),
            1,
            'a rebuild left either no operations record or more than one',
        );
    }

    const res = reply();
    await controller.operations({ query: {} }, res);
    assert.equal(res.sent.body.data.published, true);
});

test('the collection cannot hold two operations records', async () => {
    // The replace targets a constant key. The index is what makes "at most one"
    // a guarantee rather than something the writer is trusted to maintain.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    await assert.rejects(
        () =>
            PublicOperations.create({
                donationsHeld: 999,
                disputesRaised: 0,
                disputesUpheld: 0,
                materialisedAt: new Date(),
            }),
        /E11000|duplicate key/,
    );
});

test('an empty answer says which of the four causes it is', async () => {
    // A reader on this route has no second endpoint to consult and no token to
    // consult one with, so the answer has to say.
    const nothingBuilt = await serve();
    assert.equal(nothingBuilt.body.data.cells.length, 0);
    assert.equal(nothingBuilt.body.data.published_dataset.state, 'never-built');
    assert.equal(nothingBuilt.body.data.filtered, false);
    assert.match(
        nothingBuilt.body.data.published_dataset.note,
        /not the same as no donations/,
    );

    // A healthy dataset whose filter matched nothing is a different answer, and
    // the state alone cannot express it.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    const filteredOut = await serve({ period: '2020-Q1' });
    assert.equal(filteredOut.body.data.cells.length, 0);
    assert.equal(filteredOut.body.data.published_dataset.state, 'published');
    assert.equal(filteredOut.body.data.filtered, true);
});

test('the build date survives a filter that matches nothing', async () => {
    // Taken from the first cell it was null whenever the list was empty,
    // including for a healthy dataset, which reads as never built.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    const empty = await serve({ period: '2020-Q1' });
    assert.ok(
        empty.body.data.materialised_at,
        'an empty filtered answer reported no build date',
    );
});

test('a merge does not release the difference as a new cell', async () => {
    // The cell was keyed on the recipient's current name, so a merge moved it
    // to a new key: the rebuild found no previously published figures to carry
    // forward and published the current ones as new, with a fresh publication
    // date and nothing saying a figure had moved. The delta across those two
    // releases is one donor and one amount against a named recipient — the leak
    // the freeze exists to prevent, reached through a routine merge of exactly
    // the near-duplicate party names this data produces.
    const party = await makeEntity('Partai Maju', 'political-party');
    for (let index = 0; index < MIN_DONORS_PER_CELL; index += 1) {
        const donor = await makeEntity(`Donor ${index}`);
        await donate(donor, party, 10_000_000, `merge-${index}`);
    }
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });

    const first = await PublicAggregate.findOne({}).lean();
    assert.equal(first.donorCount, MIN_DONORS_PER_CELL);
    assert.equal(first.totalIdr, 50_000_000);

    // A late donation for the same closed quarter, and then the party's two
    // spellings merged, exactly as the resolution review does it.
    const late = await makeEntity('Donor late');
    await donate(late, party, 250_000_000, 'merge-late');
    const survivor = await makeEntity('Partai Maju Bersatu', 'political-party');
    // A real merge repoints the donations as well as tombstoning the absorbed
    // record. Setting `mergedInto` alone leaves every donation still resolving
    // to the old name, so the cell key never moves and the test passes without
    // reproducing anything — which is what it did before this line was added.
    await Donation.updateMany(
        { 'receiverRef.entityId': party._id },
        { $set: { 'receiverRef.entityId': survivor._id } },
    );
    await Entity.updateOne({ _id: party._id }, { $set: { mergedInto: survivor._id } });

    await controller.materialise({ now: new Date('2026-10-02T00:00:00Z') });

    const cells = await PublicAggregate.find({}).lean();
    assert.equal(cells.length, 1, 'the merge produced a second cell');
    assert.equal(
        cells[0].donorCount,
        MIN_DONORS_PER_CELL,
        'the merge released the new donor',
    );
    assert.equal(cells[0].totalIdr, first.totalIdr, 'the merge released the new amount');
    assert.equal(cells[0].revisionPending, true);
    assert.equal(
        cells[0].firstPublishedAt.getTime(),
        first.firstPublishedAt.getTime(),
        'the merge reset the publication date, hiding that a figure moved',
    );
});

test('a published cell whose donations all vanish is frozen, not deleted', async () => {
    // `documents` is built from live donations, so a cell whose every donation
    // was superseded simply did not appear and the wholesale replace removed
    // it. By this module's own reasoning a cell that vanishes reads as an
    // absence of donations, and a published cell disappearing between two
    // releases is itself a differencing observation. Reachable through an
    // upheld dispute, which marks records for exactly this.
    const going = await cellWith(MIN_DONORS_PER_CELL);
    const staying = await makeEntity('Partai Lain', 'political-party');
    for (let index = 0; index < MIN_DONORS_PER_CELL; index += 1) {
        const donor = await makeEntity(`Other donor ${index}`);
        await donate(donor, staying, 10_000_000, `stay-${index}`);
    }
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });
    assert.equal(await PublicAggregate.countDocuments({}), 2);

    // Every donation to one recipient corrected away.
    const superseding = await Donation.findOne({ 'receiverRef.entityId': staying._id });
    await Donation.updateMany(
        { 'receiverRef.entityId': going._id },
        { $set: { supersededBy: superseding._id } },
    );
    await controller.materialise({ now: new Date('2026-10-02T00:00:00Z') });

    const names = (await PublicAggregate.find({}).lean()).map((c) => c.recipientName);
    assert.ok(
        names.includes('Partai Maju'),
        'a published cell was deleted when its donations were superseded',
    );
    const frozen = await PublicAggregate.findOne({ recipientName: 'Partai Maju' }).lean();
    assert.equal(frozen.donorCount, MIN_DONORS_PER_CELL);
    assert.equal(frozen.revisionPending, true);
    assert.match(frozen.revisionNote, /no live donation now resolves/);
});

test('the endpoint says how many published figures no longer match the records', async () => {
    // The count that says how often freezing on the first build after a
    // quarter closes is costing accuracy. In a system where paper forms are
    // OCR'd and admitted well after the fact, a cell can be published as
    // suppressed and stay suppressed while the donations behind it keep
    // arriving — marked, but never resolved. Per-cell that is easy to miss;
    // as a count it is the figure worth watching.
    const party = await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise({ now: new Date('2026-10-01T00:00:00Z') });
    const before = await serve();
    assert.equal(before.body.data.cells_pending_revision, 0);

    const late = await makeEntity('Donor late');
    await donate(late, party, 250_000_000, 'pending-1');
    await controller.materialise({ now: new Date('2026-10-02T00:00:00Z') });

    const after = await serve();
    assert.equal(after.body.data.cells_pending_revision, 1);
    // And the figure itself did not move, which is the point.
    assert.equal(after.body.data.cells[0].donors, MIN_DONORS_PER_CELL);
    assert.equal(after.body.data.cells[0].revision_pending, true);
});

/**
 * The settling period, which is the reason a closed quarter is not enough.
 *
 * A published figure is frozen: republishing a revised one lets an observer
 * difference the two and recover what changed, which for a cell that gains a
 * donor is that donor's donation, to the rupiah, against a named recipient. The
 * freeze rested on a claim that a closed quarter does not move, and that claim
 * is false here by design — ingestion is asynchronous, paper forms are admitted
 * well after the fact, and the scoring sweeper exists because records arrive
 * late.
 *
 * So the first build after a quarter closed used to freeze whatever had arrived
 * by then. A recipient whose donors' forms were still in the queue was
 * published as suppressed and stayed suppressed, reporting no donors for a
 * quarter in which it received a great deal. Waiting does not resolve the
 * conflict, but it makes the frozen figure much likelier to be the complete
 * one.
 */
test('a quarter that has closed but not settled is not published', async () => {
    await cellWith(MIN_DONORS_PER_CELL);

    // 2026-Q2 ended on the first of July. This is a month after that: closed by
    // the old rule, and the date at which every case above used to build.
    await controller.materialise({ now: new Date('2026-08-01T00:00:00Z'), allowEmpty: true });
    assert.equal((await serve()).body.data.cells.length, 0);

    // The day before it settles, and the day it does.
    await controller.materialise({ now: new Date('2026-09-28T00:00:00Z'), allowEmpty: true });
    assert.equal((await serve()).body.data.cells.length, 0);

    await controller.materialise({ now: new Date('2026-09-29T12:00:00Z') });
    const settled = await serve();
    assert.equal(settled.body.data.cells.length, 1);
    assert.equal(settled.body.data.cells[0].period, '2026-Q2');
});

test('the settling period is counted from the end of the quarter, not the donation', async () => {
    // Two donations in the same quarter, seven weeks apart. They settle
    // together, because what settles is the period. Counting from each
    // donation would publish the earlier half of a quarter while the later
    // half was still arriving — which is the same disclosure as publishing an
    // open quarter, reached by a different route.
    const party = await makeEntity('Partai Maju', 'political-party');
    for (let index = 0; index < MIN_DONORS_PER_CELL; index += 1) {
        const donor = await makeEntity(`Donor ${index}`);
        await Donation.create({
            senderRef: { entityId: donor._id, rawText: donor.canonicalName },
            receiverRef: { entityId: party._id, rawText: party.canonicalName },
            amountIdr: 10_000_000,
            occurredAt: new Date(index === 0 ? '2026-04-10T00:00:00Z' : '2026-06-05T00:00:00Z'),
            recordedAt: new Date('2026-06-05T00:00:00Z'),
            channel: 'digital-form',
            dedupKey: `settle-${index}`,
        });
    }

    // Ninety days after the earliest donation, and still inside the period's
    // own settling window.
    await controller.materialise({ now: new Date('2026-07-10T00:00:00Z'), allowEmpty: true });
    assert.equal((await serve()).body.data.cells.length, 0);

    await controller.materialise({ now: new Date('2026-09-29T12:00:00Z') });
    const cells = (await serve()).body.data.cells;
    assert.equal(cells.length, 1);
    assert.equal(cells[0].donors, MIN_DONORS_PER_CELL);
});

test('a quarter that ends the year settles into the next one', async () => {
    // The rollover, which is the arithmetic most likely to be wrong: Q4 ends on
    // the first of January of the following year, not the first of October.
    const party = await makeEntity('Partai Akhir', 'political-party');
    for (let index = 0; index < MIN_DONORS_PER_CELL; index += 1) {
        const donor = await makeEntity(`Penyumbang ${index}`);
        await Donation.create({
            senderRef: { entityId: donor._id, rawText: donor.canonicalName },
            receiverRef: { entityId: party._id, rawText: party.canonicalName },
            amountIdr: 10_000_000,
            occurredAt: new Date('2026-11-20T00:00:00Z'),
            recordedAt: new Date('2026-11-20T00:00:00Z'),
            channel: 'digital-form',
            dedupKey: `year-end-${index}`,
        });
    }

    await controller.materialise({ now: new Date('2027-03-01T00:00:00Z'), allowEmpty: true });
    assert.equal((await serve()).body.data.cells.length, 0);

    await controller.materialise({ now: new Date('2027-04-01T00:00:00Z') });
    const cells = (await serve()).body.data.cells;
    assert.equal(cells.length, 1);
    assert.equal(cells[0].period, '2026-Q4');
});
