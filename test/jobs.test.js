/**
 * Background jobs.
 *
 * The property being protected is that the uploader's connection no longer
 * decides whether the work survives. A ten-page scan outlives most proxy idle
 * timeouts, and the old synchronous path reported failure for work that had
 * actually completed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Job, JOB_STATES } = require('../app/domains/services/jobs/job.model');

function job(overrides = {}) {
    return new Job({ kind: 'paper-extraction', ...overrides });
}

test('a job starts queued and reports a denominator', async () => {
    // Both numbers, because a percentage alone hides whether the total was
    // what the uploader expected to be processed.
    const queued = job({ progress: { done: 0, total: 20, stage: 'queued' } });
    await queued.validate();
    assert.equal(queued.state, 'queued');
    assert.equal(queued.progress.total, 20);
});

test('partial success is a state of its own', () => {
    // A batch where two of ten pages were unreadable succeeded at eight and
    // failed at two. Collapsing that to success or failure loses one half.
    assert.ok(JOB_STATES.includes('partially_succeeded'));
});

test('failures do not use the reserved field name', async () => {
    // `errors` is mongoose's own validation state. Shadowing it would make a
    // job's failures and a document's validation errors the same field.
    const failed = job({ state: 'failed', failures: ['page 3 unreadable'] });
    await failed.validate();
    assert.deepEqual([...failed.failures], ['page 3 unreadable']);
    assert.notEqual(typeof failed.errors, 'object');
});

test('duration is unavailable until the job starts', async () => {
    const queued = job();
    await queued.validate();
    assert.equal(queued.durationMs, null);
});

test('a running job reports elapsed time without a finish', async () => {
    // So a caller can tell slow from stuck while it is still going.
    const running = job({
        state: 'running',
        startedAt: new Date(Date.now() - 5_000),
    });
    await running.validate();
    assert.ok(running.durationMs >= 5_000);
});
