/**
 * Running the retention policy on a schedule.
 *
 * A retention period that nothing enforces is not a retention period. The
 * policy existed and was correct; nothing invoked it, which means the system
 * held personal data past the purpose that justified collecting it for as long
 * as it had been running. Political-affiliation data, at that.
 *
 * The job reports what it removed. A retention job whose effect nobody sees is
 * indistinguishable from one that has stopped working, and the failure mode is
 * silent: data accumulates and nothing goes wrong until somebody asks.
 */

const { enforceRetention } = require('./retention');
const { log } = require('../../utils/observability/logging');
const metrics = require('../../utils/observability/metrics');

/** Once a day is frequent enough for periods measured in months. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer = null;

async function runOnce({ dryRun = false } = {}) {
    const started = Date.now();
    try {
        const report = await enforceRetention({ dryRun });
        for (const [category, outcome] of Object.entries(report)) {
            metrics.increment(
                'cakradana_retention_deleted_total',
                { category },
                outcome.deleted,
            );
        }
        log.info('retention enforced', {
            dry_run: dryRun,
            duration_ms: Date.now() - started,
            deleted: Object.fromEntries(
                Object.entries(report).map(([k, v]) => [k, v.deleted]),
            ),
        });
        return report;
    } catch (error) {
        // Logged rather than thrown. A failing retention pass must not take
        // the process down — but it must be visible, because the consequence
        // of it failing quietly is holding data with no basis.
        log.error('retention pass failed', { error: error.message });
        metrics.increment('cakradana_retention_failures_total');
        return null;
    }
}

/**
 * Start the schedule.
 *
 * Off unless `ENFORCE_RETENTION=true`. Deletion is irreversible and the periods
 * are provisional pending legal review, so the operator turns it on knowingly.
 * While off, a dry run is still performed on the same schedule and logged, so
 * the volume that *would* be deleted is visible before anything is.
 */
function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (timer) return timer;

    const enforcing = process.env.ENFORCE_RETENTION === 'true';
    log.info('retention schedule started', {
        interval_ms: intervalMs,
        mode: enforcing ? 'enforcing' : 'dry run',
    });

    const tick = () => runOnce({ dryRun: !enforcing });
    // Run once at startup so a deployment does not wait a full day to find out
    // the pass errors.
    tick();

    timer = setInterval(tick, intervalMs);
    // Does not hold the process open by itself.
    if (timer.unref) timer.unref();
    return timer;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, runOnce, DEFAULT_INTERVAL_MS };
