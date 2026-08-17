/**
 * The swap itself: what reaches the published collection, and what does not.
 *
 * `swapIn` builds the next dataset in a staging collection and renames it over
 * the live one, so the rename is the only moment the published figures change.
 * Two guards stand in front of that rename — one refusing an empty replacement,
 * one refusing a short one — and the second had no test.
 *
 * That mattered more than the usual missing-test case. A mutation sweep over
 * this module caught six of seven changes; removing the short-staging check was
 * the one that left the suite green, which means the check was carrying a claim
 * nothing had ever made it demonstrate. A guard nobody has watched fail is
 * indistinguishable from a guard that does not work, and this one stands
 * between a partial build and the published record of who funded whom.
 *
 * The short insert is induced rather than waited for. `insertMany` is ordered,
 * so a failure part-way through throws and never reaches the count — which is
 * why no natural input reproduces this, and why leaving the guard untested was
 * easy to justify. What the guard actually defends against is that stopping
 * being true: a retry, a batching change, an `ordered: false`. The test states
 * the guard's claim directly — a staging collection holding fewer cells than
 * were handed over is not published — rather than the route by which it might
 * one day be reached.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const {
    PublicAggregate,
    PublicAggregateStaging,
    BUILDING_COLLECTION,
} = require('../app/domains/public/public.model');
const controller = require('../app/domains/public/public.controller');

useDatabase();

function cell(recipientName, totalIdr) {
    return {
        recipientKey: recipientName.toLowerCase().replace(/\s+/g, '-'),
        recipientName,
        recipientType: 'party',
        electoralContext: null,
        period: '2026-Q1',
        donorCount: 12,
        donationCount: 12,
        totalIdr,
        materialisedAt: new Date(),
        sourceRecords: 12,
    };
}

/** Replace `insertMany` for one call, and put it back however that call ends. */
async function whileInsertingOnly(count, run) {
    const original = PublicAggregateStaging.insertMany;
    PublicAggregateStaging.insertMany = function short(documents, options) {
        return original.call(this, documents.slice(0, count), options);
    };
    try {
        return await run();
    } finally {
        PublicAggregateStaging.insertMany = original;
    }
}

test('a short staging collection is refused rather than published', async () => {
    const previous = [cell('Partai Merah', 5_000_000), cell('Partai Biru', 9_000_000)];
    await controller.swapIn(previous);
    assert.equal(await PublicAggregate.countDocuments({}), 2);

    const next = [
        cell('Partai Merah', 6_000_000),
        cell('Partai Biru', 11_000_000),
        cell('Partai Hijau', 3_000_000),
    ];

    await whileInsertingOnly(1, async () => {
        await assert.rejects(
            () => controller.swapIn(next),
            (error) => {
                // The message carries both figures, because "the build was
                // short" is not actionable and "1 of 3" is.
                assert.match(error.message, /staged 1 cells of 3/);
                assert.match(error.message, /previous dataset is left in place/);
                return true;
            },
        );
    });

    // The claim the guard exists to make: the published dataset is the one that
    // was there before, unchanged, rather than a partial replacement. A short
    // collection published is a set of aggregates that silently omits
    // recipients, and nothing downstream can tell that from a period in which
    // those recipients received nothing.
    const live = await PublicAggregate.find({}).sort({ recipientName: 1 }).lean();
    assert.equal(live.length, 2);
    assert.deepEqual(
        live.map((item) => [item.recipientName, item.totalIdr]),
        [
            ['Partai Biru', 9_000_000],
            ['Partai Merah', 5_000_000],
        ],
    );
});

test('a refused swap leaves no staging collection behind', async () => {
    await controller.swapIn([cell('Partai Merah', 5_000_000)]);

    await whileInsertingOnly(0, async () => {
        await assert.rejects(() => controller.swapIn([
            cell('Partai Merah', 6_000_000),
            cell('Partai Biru', 2_000_000),
        ]));
    });

    // Dropped on the way out, so the next build starts from nothing rather than
    // from the wreckage of this one. Left in place, its documents would be
    // counted by the following build's own guard and pass it.
    const collections = await PublicAggregate.db.db
        .listCollections({ name: BUILDING_COLLECTION })
        .toArray();
    assert.equal(collections.length, 0);
});

test('a swap that stages everything handed to it replaces the dataset', async () => {
    // The other side of the guard, without which the two tests above pass
    // equally well against a `swapIn` that refuses every build.
    await controller.swapIn([cell('Partai Merah', 5_000_000)]);
    await controller.swapIn([
        cell('Partai Merah', 6_000_000),
        cell('Partai Biru', 2_000_000),
    ]);

    const live = await PublicAggregate.find({}).sort({ recipientName: 1 }).lean();
    assert.deepEqual(
        live.map((item) => [item.recipientName, item.totalIdr]),
        [
            ['Partai Biru', 2_000_000],
            ['Partai Merah', 6_000_000],
        ],
    );
});
