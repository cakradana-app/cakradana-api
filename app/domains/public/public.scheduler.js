/**
 * Rebuilding the published dataset on a schedule.
 *
 * Separate from serving it, so that publishing is an act with a time and an
 * outcome rather than a side effect of somebody loading a page. It also means
 * a bad build is visible as a failed job instead of as wrong numbers on a
 * public endpoint.
 */

const { materialise } = require('./public.controller');
const { PublicDatasetBuild } = require('./public.model');
const { log } = require('../../utils/observability/logging');
const metrics = require('../../utils/observability/metrics');

/** Daily. The published figures are quarterly aggregates; hourly would publish noise. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer = null;

async function runOnce() {
    const startedAt = new Date();
    try {
        const report = await materialise();
        metrics.increment('cakradana_public_materialisations_total', { outcome: 'ok' });
        await recordBuild({
            startedAt,
            completedAt: new Date(),
            outcome: 'success',
            cells: report.cells,
            published: report.published,
            suppressed: report.suppressed,
            sourceRecords: report.sourceRecords,
            durationMs: Date.now() - startedAt.getTime(),
        });
        return report;
    } catch (error) {
        // The previous dataset stays in place — which the materialiser now makes
        // true rather than merely intended. It assembles the rebuild in a
        // separate collection and swaps it in with a rename, so a failure
        // anywhere in the build leaves the published dataset exactly as it was.
        // Before that, the build deleted every cell and then inserted the new
        // ones, and a failure between the two left the dataset empty until the
        // next day's run: serving no cells at all, which reads as an absence of
        // donations rather than an absence of a build.
        //
        // Serving yesterday's aggregates is better than serving none. It is not
        // free either — nothing about the endpoint says the figures stopped
        // being refreshed — so the failure is recorded where /public/operations
        // and the metrics can report it.
        log.error('public dataset build failed', { error: error.message });
        metrics.increment('cakradana_public_materialisations_total', { outcome: 'failed' });
        await recordBuild({
            startedAt,
            completedAt: null,
            outcome: 'failed',
            durationMs: Date.now() - startedAt.getTime(),
            error: error.message,
        });
        return null;
    }
}

/**
 * Write down what the build did.
 *
 * Best-effort, and deliberately so: a store that cannot be written to is
 * usually why the build failed in the first place, and a scheduler that threw
 * while recording a failure would replace a legible failed job with an
 * unhandled rejection.
 */
async function recordBuild(fields) {
    try {
        await PublicDatasetBuild.create(fields);
    } catch (error) {
        log.error('could not record the public dataset build', { error: error.message });
    }
}

function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (timer) return timer;
    if (process.env.PUBLISH_AGGREGATES !== 'true') {
        // Publishing is a governance decision with a review attached, not a
        // default. Nothing is built until somebody enables it.
        log.info('public dataset publishing is disabled');
        return null;
    }
    log.info('public dataset schedule started', { interval_ms: intervalMs });
    runOnce();
    timer = setInterval(runOnce, intervalMs);
    if (timer.unref) timer.unref();
    return timer;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, runOnce, recordBuild, DEFAULT_INTERVAL_MS };
