/**
 * A scrape after the database has gone away underneath the process.
 *
 * `observability.test.js` covers a process that was never connected. This
 * covers the likelier production case: one that was connected, kept serving,
 * and lost the store — which is when the metrics endpoint is the first thing an
 * operator turns to.
 *
 * What is checked is the outcome, which is what matters and is what regressed
 * before: the scrape returns rather than hanging, it reports the store gauges
 * as unavailable rather than as zero, and the figures that never needed the
 * store survive.
 *
 * What is NOT checked here is the timeout budget in `storeGauges`. This test
 * passes with the budget set to sixty seconds, because closing the client makes
 * the driver reject immediately rather than wait — so the fast return comes
 * from the error path, not the budget. The budget's own trigger is a socket
 * that stays open and never answers, which nothing here reproduces. It is a
 * backstop, and it is untested; saying so is better than a test named after it
 * that would pass however long it were set to.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { useDatabase } = require('./helpers/database');
const metrics = require('../app/utils/observability/metrics');

useDatabase();

test('a scrape after the store disappears reports unavailable, not zero', async () => {
    // Connected, and the gauges read normally.
    assert.equal(mongoose.connection.readyState, 1);
    const healthy = await metrics.render();
    assert.match(healthy, /^cakradana_store_metrics_available 1$/m);

    // Now take the server away without telling mongoose. `readyState` stays at
    // 1, so the short-circuit does not fire and every command waits — which is
    // precisely the state the budget is for.
    const { client } = mongoose.connection.getClient().topology
        ? { client: mongoose.connection.getClient() }
        : { client: null };
    assert.ok(client, 'could not reach the driver client to interrupt it');
    await client.close(true);

    const started = Date.now();
    const rendered = await metrics.render();
    const took = Date.now() - started;

    assert.ok(
        took < 5_000,
        `a scrape against a dead connection took ${took}ms, past a scrape timeout`,
    );
    void took;
    // Unavailable, not zero. A gauge omitted is one nobody measured; zeroes
    // would say the store holds nothing, which is the reading a failure to read
    // must never produce.
    assert.match(rendered, /^cakradana_store_metrics_available 0$/m);
    assert.equal(rendered.includes('cakradana_donations_total'), false);
    // The figures that do not depend on the store survive, which is most of
    // what a scrape is for when the store is the broken thing.
    assert.match(rendered, /^cakradana_rpo_objective_seconds /m);
});
