/**
 * Continuity of the published dataset across a rebuild.
 *
 * The dataset used to be rebuilt in place: every cell deleted, then the new
 * ones inserted. Between those two calls there was no published dataset at all,
 * and `/public/aggregates` answered with an empty list of cells — which, by this
 * module's own reasoning about suppression, reads as an absence of donations
 * rather than an absence of a build. A failure or a restart in that window left
 * it that way until the next day's run, and the scheduler's comment said the
 * previous dataset stayed in place, which was not true.
 *
 * What is tested here is that it is true now. The rebuild is assembled in a
 * separate collection and swapped in with a rename, so a build that dies at any
 * point leaves the previous dataset exactly as it was, and a reader sees one
 * complete dataset or the other and never a half-written one.
 *
 * The failures are induced rather than waited for. A window that is only
 * reachable when something goes wrong is a window nobody tests, which is how it
 * survived being written down as a comment claiming the opposite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { useDatabase } = require('./helpers/database');
const { Donation, Entity } = require('../app/domains/canonical/canonical.model');
const {
    PublicAggregate,
    PublicAggregateStaging,
    PublicDatasetBuild,
    BUILDING_COLLECTION,
    MIN_DONORS_PER_CELL,
    SETTLING_PERIOD_DAYS,
} = require('../app/domains/public/public.model');
const controller = require('../app/domains/public/public.controller');
const scheduler = require('../app/domains/public/public.scheduler');
const { normaliseName } = require('../app/domains/canonical/resolution');

useDatabase();

/**
 * A day inside a quarter that has both closed and settled.
 *
 * Only settled quarters are published, so a fixture dated in the quarter in
 * progress — or in one that closed recently — produces no cells and would test
 * nothing while passing.
 *
 * Computed rather than written down, because these cases build with the real
 * clock. A fixed date works until the settling period changes or enough time
 * passes, and the way it stops working is that the tests keep passing against
 * an empty dataset. That is the failure this whole file exists to catch, so it
 * is the one it must not have.
 */
function settledQuarterDay(now = new Date()) {
    const quarterStart = new Date(
        Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1),
    );
    for (;;) {
        quarterStart.setUTCMonth(quarterStart.getUTCMonth() - 3);
        const endsAt = Date.UTC(
            quarterStart.getUTCFullYear(),
            quarterStart.getUTCMonth() + 3,
            1,
        );
        if (now.getTime() - endsAt >= SETTLING_PERIOD_DAYS * 24 * 60 * 60 * 1000) {
            return new Date(
                Date.UTC(quarterStart.getUTCFullYear(), quarterStart.getUTCMonth(), 15),
            );
        }
    }
}

const CLOSED_QUARTER_DAY = settledQuarterDay();

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

/** A recipient with enough distinct donors that its cell is published rather than suppressed. */
async function publishableCell(recipient = 'Partai Maju', donors = MIN_DONORS_PER_CELL) {
    const party = await makeEntity(recipient, 'political-party');
    for (let index = 0; index < donors; index += 1) {
        const donor = await makeEntity(`${recipient} donor ${index}`);
        await Donation.create({
            senderRef: { entityId: donor._id, rawText: donor.canonicalName },
            receiverRef: { entityId: party._id, rawText: party.canonicalName },
            amountIdr: 10_000_000,
            occurredAt: CLOSED_QUARTER_DAY,
            recordedAt: CLOSED_QUARTER_DAY,
            channel: 'digital-form',
            dedupKey: `continuity-${recipient}-${index}`,
        });
    }
    return party;
}

async function serve(query = {}) {
    const res = reply();
    await controller.dataset({ query }, res);
    return res.sent;
}

async function operations() {
    const res = reply();
    await controller.operations({}, res);
    return res.sent;
}

/**
 * Replace the staging write for one build.
 *
 * The staging insert is where a real build spends its time and is the step most
 * likely to fail on a full disk or a restart, so it is the honest place to
 * interrupt one.
 */
function interceptStagingWrite(replacement) {
    const original = PublicAggregateStaging.insertMany.bind(PublicAggregateStaging);
    PublicAggregateStaging.insertMany = (...args) => replacement(original, ...args);
    return () => {
        PublicAggregateStaging.insertMany = original;
    };
}

async function stagingExists() {
    const names = await mongoose.connection.db
        .listCollections({ name: BUILDING_COLLECTION })
        .toArray();
    return names.length > 0;
}

test('a rebuild that fails partway leaves the published dataset exactly as it was', async () => {
    await publishableCell();
    await controller.materialise();

    const before = await serve();
    assert.equal(before.body.data.cells.length, 1);
    const builtAt = before.body.data.materialised_at;

    const restore = interceptStagingWrite(async () => {
        throw new Error('simulated crash mid-build');
    });
    try {
        await assert.rejects(() => controller.materialise(), /simulated crash mid-build/);
    } finally {
        restore();
    }

    // Not empty, and not partial: the same dataset, down to the build it came
    // from. This is the assertion the old implementation could not pass.
    assert.equal(await PublicAggregate.countDocuments({}), 1);
    const after = await serve();
    assert.equal(after.body.data.cells.length, 1);
    assert.deepEqual(after.body.data.cells, before.body.data.cells);
    assert.deepEqual(after.body.data.materialised_at, builtAt);
});

test('the published dataset is never empty while a rebuild is being written', async () => {
    // The window itself, observed. Under the old implementation the count taken
    // at this moment was zero on every build, successful ones included.
    await publishableCell();
    await controller.materialise();

    const observed = [];
    const restore = interceptStagingWrite(async (original, ...args) => {
        observed.push(await PublicAggregate.countDocuments({}));
        return original(...args);
    });
    try {
        await controller.materialise();
    } finally {
        restore();
    }

    assert.equal(observed.length, 1);
    assert.equal(observed[0], 1, 'the live dataset was emptied before the new one was written');
});

test('debris from a build that died before its swap does not become the dataset', async () => {
    await publishableCell();

    // What a crashed build leaves behind. It is not the dataset and never was.
    await mongoose.connection.db
        .collection(BUILDING_COLLECTION)
        .insertMany([{ recipientName: 'half a build', period: '1999-Q1' }]);

    await controller.materialise();

    const sent = await serve();
    assert.equal(sent.body.data.cells.length, 1);
    assert.equal(sent.body.data.cells[0].recipient, 'Partai Maju');
    assert.equal(await stagingExists(), false, 'the staging collection outlived the build');
});

test('a rebuild that comes out empty is refused rather than published', async () => {
    // Every publishable cell disappearing at once is more likely to be an
    // upstream failure than a collapse in political donations, and publishing
    // it is not reversible in the way that matters.
    await publishableCell();
    await controller.materialise();
    assert.equal(await PublicAggregate.countDocuments({}), 1);

    // Resolution having stopped: the donations are still there, the entities
    // they resolve to are not, so nothing is publishable.
    await Entity.deleteMany({});

    await assert.rejects(() => controller.materialise(), /refusing to replace/);
    assert.equal(await PublicAggregate.countDocuments({}), 1);

    // And the operator can still say it deliberately.
    const report = await controller.materialise({ allowEmpty: true });
    assert.equal(report.cells, 0);
    assert.equal(await PublicAggregate.countDocuments({}), 0);
});

test('an empty dataset on a store that never had one is not refused', async () => {
    // The first build of a deployment with nothing publishable yet. There is no
    // previous dataset to protect, so there is nothing to refuse.
    const report = await controller.materialise();
    assert.equal(report.cells, 0);
    assert.equal(await PublicAggregate.countDocuments({}), 0);
});

test('the dataset keeps the indexes it is queried through across a rebuild', async () => {
    // A rename carries a collection's indexes with it, which means the indexes
    // have to be built on the staging collection before the swap. Without this
    // the published dataset would lose them on every rebuild, and nothing would
    // report it: the queries would still return the right answers, slowly.
    await publishableCell();
    await controller.materialise();

    const indexes = await mongoose.connection.db
        .collection(PublicAggregate.collection.collectionName)
        .indexes();
    const keys = indexes.map((index) => JSON.stringify(index.key));

    for (const [declared] of PublicAggregate.schema.indexes()) {
        assert.ok(
            keys.includes(JSON.stringify(declared)),
            `${JSON.stringify(declared)} did not survive the rebuild`,
        );
    }
});

test('a cell carrying a verdict does not reach the published collection', async () => {
    // The rebuild is written through the model rather than the driver, so the
    // schema still sees every cell. Writing staging with the driver would have
    // put this straight into the collection that becomes the published dataset
    // one line later.
    await controller.swapIn([
        {
            recipientName: 'Partai Maju',
            recipientType: 'political-party',
            electoralContext: null,
            period: '2026-Q2',
            donorCount: 9,
            donationCount: 12,
            totalIdr: 120_000_000,
            suppressed: false,
            suppressionReason: null,
            materialisedAt: new Date(),
            sourceRecords: 12,
            score: 72,
            band: 'high',
        },
    ]);

    const stored = await mongoose.connection.db
        .collection(PublicAggregate.collection.collectionName)
        .findOne({});
    assert.ok(stored, 'the cell was not published at all');
    assert.equal(stored.score, undefined, 'a score reached the published collection');
    assert.equal(stored.band, undefined, 'a band reached the published collection');
});

test('a failed build is recorded, not only logged', async () => {
    // A failed build now leaves the previous dataset serving, which is right and
    // silent: the endpoint keeps answering and nothing about it says the figures
    // stopped being refreshed.
    await publishableCell();
    await scheduler.runOnce();

    const restore = interceptStagingWrite(async () => {
        throw new Error('simulated crash mid-build');
    });
    try {
        const result = await scheduler.runOnce();
        assert.equal(result, null, 'a failed build was reported as a build');
    } finally {
        restore();
    }

    const builds = await PublicDatasetBuild.find({}).sort({ startedAt: 1 }).lean();
    assert.equal(builds.length, 2);
    assert.equal(builds[0].outcome, 'success');
    assert.equal(builds[0].cells, 1);
    assert.equal(builds[1].outcome, 'failed');
    assert.match(builds[1].error, /simulated crash mid-build/);
});

test('the aggregates endpoint says why its own list is empty', async () => {
    // The route with no token in front of it, and therefore the one where a
    // reader has no second endpoint to consult. An empty `cells` has four
    // causes and the list cannot tell them apart.
    //
    // Driven through the scheduler rather than through `materialise` directly,
    // which is what reaches the two causes a direct build cannot produce: a
    // build that ran and found nothing, and a dataset still being served while
    // its rebuilds fail. Both need the build journal, and only the scheduler
    // writes it.
    const never = await serve();
    assert.equal(never.body.data.cells.length, 0);
    assert.equal(never.body.data.published_dataset.state, 'never-built');
    assert.equal(never.body.data.filtered, false);

    // A build ran and found nothing publishable, which is not the same thing.
    await scheduler.runOnce();
    const empty = await serve();
    assert.equal(empty.body.data.published_dataset.state, 'built-and-empty');
    assert.ok(empty.body.data.published_dataset.built_at);

    // A dataset that is fine, and a filter that matched nothing. This is the
    // cause the state alone cannot express.
    await publishableCell();
    await scheduler.runOnce();
    const unmatched = await serve({ period: '2020-Q1' });
    assert.equal(unmatched.body.data.cells.length, 0);
    assert.equal(unmatched.body.data.published_dataset.state, 'published');
    assert.equal(unmatched.body.data.filtered, true);

    // And figures still being served while the rebuilds fail say so.
    const restore = interceptStagingWrite(async () => {
        throw new Error('simulated crash mid-build');
    });
    try {
        await scheduler.runOnce();
    } finally {
        restore();
    }
    const stale = await serve();
    assert.equal(stale.body.data.cells.length, 1);
    assert.equal(stale.body.data.published_dataset.last_build_outcome, 'failed');
    assert.match(stale.body.data.published_dataset.note, /are not current/);
});

test('the published state distinguishes never built, built and empty, and stale', async () => {
    // `/public/aggregates` answers with a list of cells, and an empty list has
    // three quite different causes. The endpoint cannot tell them apart from the
    // cells alone, so this is where it is said.
    const never = await operations();
    assert.equal(never.body.data.published_dataset.state, 'never-built');
    assert.match(never.body.data.published_dataset.note, /not the same as no donations/);

    // A build that ran and found nothing publishable.
    await scheduler.runOnce();
    const empty = await operations();
    assert.equal(empty.body.data.published_dataset.state, 'built-and-empty');
    assert.equal(empty.body.data.published_dataset.cells, 0);
    assert.ok(empty.body.data.published_dataset.built_at);

    // A dataset that is being served while its rebuilds are failing.
    await publishableCell();
    await scheduler.runOnce();
    const restore = interceptStagingWrite(async () => {
        throw new Error('simulated crash mid-build');
    });
    try {
        await scheduler.runOnce();
    } finally {
        restore();
    }

    const stale = await operations();
    assert.equal(stale.body.data.published_dataset.state, 'published');
    assert.equal(stale.body.data.published_dataset.cells, 1);
    assert.equal(stale.body.data.published_dataset.last_build_outcome, 'failed');
    assert.match(stale.body.data.published_dataset.note, /are not current/);
});
