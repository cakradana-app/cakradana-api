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
const { PublicAggregate, MIN_DONORS_PER_CELL } = require('../app/domains/public/public.model');
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
    await controller.materialise();

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
    await controller.materialise();

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
    await controller.materialise();

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
    const summary = await controller.materialise();
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
    await controller.materialise();

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
    await controller.materialise();

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
    await controller.materialise();

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

    await controller.materialise();
    const cell = await PublicAggregate.findOne({ suppressed: false }).lean();
    assert.equal(cell.donationCount, MIN_DONORS_PER_CELL);
});

test('the build replaces rather than accumulates', async () => {
    // An incremental build that misses a deletion leaves a published figure for
    // a record that has since been corrected or withdrawn.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise();
    await controller.materialise();
    assert.equal(await PublicAggregate.countDocuments({}), 1);
});

test('the response says what it excludes and when it was built', async () => {
    // An aggregate with no date attached gets quoted years later as though it
    // were current, and a reader has no other way to know what is missing.
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise();

    const sent = await serve();
    assert.ok(sent.body.data.materialised_at);
    assert.match(sent.body.data.excludes, /risk scores/);
    assert.match(sent.body.data.excludes, /fewer than 5 distinct donors/);
    assert.ok(sent.body.data.rounding_idr > 0);
});

test('no served cell carries a score, band, or flag under any name', async () => {
    await cellWith(MIN_DONORS_PER_CELL);
    await controller.materialise();

    const sent = await serve();
    const body = JSON.stringify(sent.body).toLowerCase();
    for (const forbidden of ['"score"', '"band"', '"risk_score"', '"flags"', '"alerts"']) {
        assert.equal(body.includes(forbidden), false, `the response carries ${forbidden}`);
    }
});

test('the operations view counts without naming anybody', async () => {
    await cellWith(MIN_DONORS_PER_CELL);
    const res = reply();
    await controller.operations({ query: {} }, res);

    assert.equal(res.sent.status, 200);
    assert.equal(res.sent.body.data.donations_held, MIN_DONORS_PER_CELL);
    // No donation with no disputes should report a rate, because a rate over
    // zero disputes is not zero — it is unmeasured.
    assert.equal(res.sent.body.data.dispute_upheld_rate, null);
    assert.equal(JSON.stringify(res.sent.body).includes('Donor 0'), false);
});
