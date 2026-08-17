/**
 * Rebuilding the published dataset on a schedule.
 *
 * Separate from serving it, so that publishing is an act with a time and an
 * outcome rather than a side effect of somebody loading a page. It also means
 * a bad build is visible as a failed job instead of as wrong numbers on a
 * public endpoint.
 */

const { materialise } = require('./public.controller');
const { log } = require('../../utils/observability/logging');
const metrics = require('../../utils/observability/metrics');

/** Daily. The published figures are quarterly aggregates; hourly would publish noise. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer = null;

async function runOnce() {
    try {
        const report = await materialise();
        metrics.increment('cakradana_public_materialisations_total', { outcome: 'ok' });
        return report;
    } catch (error) {
        // The previous dataset stays in place. Serving yesterday's aggregates
        // is better than serving none, and far better than serving a partial
        // rebuild that reads as a collapse in donations.
        log.error('public dataset build failed', { error: error.message });
        metrics.increment('cakradana_public_materialisations_total', { outcome: 'failed' });
        return null;
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

module.exports = { start, stop, runOnce, DEFAULT_INTERVAL_MS };
