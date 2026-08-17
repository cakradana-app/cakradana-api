/**
 * Correlation, logging, and metrics.
 *
 * A donation entering through a paper form passes through OCR, extraction,
 * validation, resolution, ingestion, and scoring. When one of those drops a
 * record, following it is the only way to find out where — which requires the
 * record's path to carry one identifier the whole way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    log,
    context,
    correlationId,
    setActor,
} = require('../app/utils/observability/logging');
const metrics = require('../app/utils/observability/metrics');

function captureStdout(run) {
    const written = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => {
        written.push(String(chunk));
        return true;
    };
    try {
        run();
    } finally {
        process.stdout.write = original;
    }
    return written.map((line) => JSON.parse(line));
}

test('log lines are JSON', () => {
    // Lines a person reads casually are worth less than lines a query can
    // group.
    const [line] = captureStdout(() => log.info('ingested', { records: 4 }));
    assert.equal(line.message, 'ingested');
    assert.equal(line.records, 4);
    assert.ok(line.at);
});

test('a line carries the correlation id of the request it belongs to', () => {
    const lines = captureStdout(() => {
        context.run({ correlationId: 'abc-123' }, () => {
            log.info('extracted');
        });
    });
    assert.equal(lines[0].correlation_id, 'abc-123');
});

test('a line written outside a request says so rather than inventing an id', () => {
    const [line] = captureStdout(() => log.info('startup'));
    assert.equal(line.correlation_id, null);
});

test('the actor is attached once authentication has established one', () => {
    // Set separately from the id because a line written before authentication
    // should not carry a name that had not been established yet.
    const lines = captureStdout(() => {
        context.run({ correlationId: 'abc' }, () => {
            log.info('before');
            setActor('analyst@example.org');
            log.info('after');
        });
    });
    assert.equal(lines[0].actor, null);
    assert.equal(lines[1].actor, 'analyst@example.org');
});

test('the level filters what is emitted', () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    const lines = captureStdout(() => {
        log.info('quiet');
        log.warn('loud');
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].message, 'loud');
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
});

test('correlationId is null outside a request', () => {
    assert.equal(correlationId(), null);
});

test('counters accumulate under their labels', async () => {
    metrics.reset();
    metrics.increment('cakradana_requests_total', { method: 'GET', route: '/x', status: 200 });
    metrics.increment('cakradana_requests_total', { method: 'GET', route: '/x', status: 200 });
    metrics.increment('cakradana_requests_total', { method: 'GET', route: '/x', status: 500 });

    const rendered = await metrics.render();
    assert.match(rendered, /cakradana_requests_total\{method="GET",route="\/x",status="200"\} 2/);
    assert.match(rendered, /cakradana_requests_total\{method="GET",route="\/x",status="500"\} 1/);
});

test('labels are ordered so one series does not become two', async () => {
    metrics.reset();
    metrics.increment('cakradana_extraction_records_total', { outcome: 'kept', channel: 'paper-form' });
    metrics.increment('cakradana_extraction_records_total', { channel: 'paper-form', outcome: 'kept' });
    const rendered = await metrics.render();
    assert.match(rendered, /cakradana_extraction_records_total\{channel="paper-form",outcome="kept"\} 2/);
});

test('observations report count, sum, and maximum', async () => {
    metrics.reset();
    metrics.observe('cakradana_request_duration_ms', 10, { route: '/x' });
    metrics.observe('cakradana_request_duration_ms', 30, { route: '/x' });
    const rendered = await metrics.render();
    assert.match(rendered, /cakradana_request_duration_ms_count\{route="\/x"\} 2/);
    assert.match(rendered, /cakradana_request_duration_ms_sum\{route="\/x"\} 40/);
    assert.match(rendered, /cakradana_request_duration_ms_max\{route="\/x"\} 30/);
});

test('an unreachable store reports that, rather than reporting zero', async () => {
    // A scrape returning nothing must be distinguishable from a store holding
    // nothing; the second would read as a system with no donations in it.
    metrics.reset();
    const rendered = await metrics.render();
    assert.match(rendered, /cakradana_store_metrics_available 0/);
});

test('every rendered metric carries its help text once', async () => {
    metrics.reset();
    metrics.increment('cakradana_requests_total', { method: 'GET', route: '/a', status: 200 });
    metrics.increment('cakradana_requests_total', { method: 'GET', route: '/b', status: 200 });
    const rendered = await metrics.render();
    const helps = rendered.split('\n').filter((l) => l.startsWith('# HELP cakradana_requests_total'));
    assert.equal(helps.length, 1);
});
