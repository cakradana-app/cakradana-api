/**
 * Operational metrics, in the Prometheus text format.
 *
 * The figures chosen are the ones whose silent drift is dangerous rather than
 * the ones that are easy to collect. A quarantine rate climbing from 2% to 40%
 * means an upstream form changed and most of a filing period is being set
 * aside; alert volume above the review budget means the tail of the queue is
 * never read, so the precision figure quoted for the system describes an
 * operating point nobody works at. Neither shows up as an error.
 *
 * Counters are process-local and reset on restart, which is what a scraper
 * expects. Gauges derived from the database are computed on scrape, so they
 * describe the store rather than this process's view of it.
 */

const mongoose = require('mongoose');

const counters = new Map();
const histograms = new Map();

function key(name, labels = {}) {
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
}

function increment(name, labels = {}, by = 1) {
    const id = key(name, labels);
    counters.set(id, (counters.get(id) || 0) + by);
}

function observe(name, value, labels = {}) {
    const id = key(name, labels);
    const current = histograms.get(id) || { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += value;
    current.max = Math.max(current.max, value);
    histograms.set(id, current);
}

//: How long the store figures get before the scrape gives up on them. A
//: metrics endpoint that hangs is a metrics endpoint that is down, as far as
//: anything scraping it on a timeout is concerned — so waiting longer than a
//: scrape will wait produces the outcome the tolerance below exists to prevent.
//:
//: The previous behaviour was tolerant but not timely: an unreachable database
//: was caught, after mongoose spent ten seconds holding the commands in its
//: buffer first. Ten seconds is at or past a default scrape timeout, so the
//: visibility disappeared exactly when the store was down.
const STORE_GAUGE_BUDGET_MS = 2_000;

/**
 * Figures that describe the store rather than this process.
 *
 * Read on scrape and tolerant of the database being unreachable: a metrics
 * endpoint that fails when the database is down removes the visibility exactly
 * when it is needed. Tolerant means both that it does not throw and that it
 * does not wait — see the budget above.
 */
async function storeGauges() {
    // No connection at all is answerable without waiting for one. Mongoose
    // buffers commands issued while disconnected and resolves them if a
    // connection arrives, which is right for application code and wrong here:
    // a scrape wants the current answer, and the current answer is that the
    // store cannot be read.
    if (mongoose.connection.readyState !== 1) {
        return { cakradana_store_metrics_available: 0 };
    }

    let timer;
    try {
        return await Promise.race([
            collectStoreGauges(),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('store gauges exceeded their budget')),
                    STORE_GAUGE_BUDGET_MS,
                );
                // The process must not be held open by a scrape's timer.
                if (timer.unref) timer.unref();
            }),
        ]);
    } catch (error) {
        // Nothing is fabricated here. A gauge omitted is a gauge nobody
        // measured, and emitting zeroes would say the store holds nothing —
        // which is the one reading that must never be produced by a failure to
        // read it.
        return { cakradana_store_metrics_available: 0 };
    } finally {
        clearTimeout(timer);
    }
}

async function collectStoreGauges() {
    const gauges = {};
    try {
        const {
            Donation,
            Quarantine,
            ScoringEvent,
        } = require('../../domains/canonical/canonical.model');
        const { Dispute } = require('../../domains/services/disputes/dispute.model');

        const [donations, quarantined, unresolvedQuarantine, scored, openDisputes] =
            await Promise.all([
                Donation.countDocuments({ supersededBy: null }),
                Quarantine.countDocuments({}),
                Quarantine.countDocuments({ resolvedAt: null }),
                ScoringEvent.countDocuments({}),
                Dispute.countDocuments({ state: { $in: ['open', 'acknowledged'] } }),
            ]);

        gauges.cakradana_donations_total = donations;
        gauges.cakradana_quarantine_total = quarantined;
        gauges.cakradana_quarantine_unresolved = unresolvedQuarantine;
        gauges.cakradana_scoring_events_total = scored;
        gauges.cakradana_disputes_open = openDisputes;

        // The rate that matters more than the count: a rising share means the
        // upstream shape changed, and it does not present as an error anywhere.
        const admitted = donations + quarantined;
        gauges.cakradana_quarantine_share = admitted ? quarantined / admitted : 0;

        const overdue = await Dispute.countDocuments({
            state: { $in: ['open', 'acknowledged'] },
            resolveBy: { $lt: new Date() },
        });
        gauges.cakradana_disputes_overdue = overdue;

        // The recovery position. Without it the RPO is a number in a file: an
        // objective that cannot be measured against cannot be breached, which
        // is not the same as being met. The age is what an alert should watch;
        // `ever_completed` separates a schedule that slipped from one that was
        // never created, and those are different failures.
        const {
            rpoStatus,
            legacySingletonStatus,
        } = require('../../domains/canonical/resilience');
        const rpo = await rpoStatus();
        gauges.cakradana_backup_ever_completed = rpo.lastBackupAt ? 1 : 0;
        if (rpo.lastBackupAt) {
            const completed = new Date(rpo.lastBackupAt).getTime();
            gauges.cakradana_backup_last_success_timestamp_seconds = Math.floor(completed / 1000);
            gauges.cakradana_backup_age_seconds = Math.max(
                0,
                Math.floor((Date.now() - completed) / 1000),
            );
        }

        // How much of the legacy document still exists nowhere else. It falls
        // to zero when the backfill has run, and while it is above zero a
        // backup that omitted that collection would lose those donations
        // without anything reporting it. Cached inside, because the document
        // it reads can approach sixteen megabytes.
        const legacy = await legacySingletonStatus();
        if (legacy.legacyOnly !== null) {
            gauges.cakradana_legacy_donations_total = legacy.held;
            gauges.cakradana_legacy_only_donations = legacy.legacyOnly;
        }

        // A published dataset that stopped being rebuilt keeps answering, with
        // figures that get quoted as current. The build failures are counted
        // elsewhere; what nothing showed until now is how old the dataset
        // actually is, which is the figure an alert can act on.
        const { datasetState } = require('../../domains/public/public.controller');
        const published = await datasetState();
        gauges.cakradana_public_dataset_cells = published.cells;
        if (published.built_at) {
            gauges.cakradana_public_dataset_age_seconds = Math.max(
                0,
                Math.floor((Date.now() - new Date(published.built_at).getTime()) / 1000),
            );
        }
    } catch (error) {
        // Reported as its own metric rather than as an empty response, so a
        // scrape that returns nothing is distinguishable from a store that
        // holds nothing.
        gauges.cakradana_store_metrics_available = 0;
        return gauges;
    }
    gauges.cakradana_store_metrics_available = 1;
    return gauges;
}

/**
 * The declared objectives themselves, as gauges.
 *
 * Emitted whether or not the database can be read, because an alert comparing
 * the backup age against the objective needs both numbers, and the scrape most
 * worth having is the one taken during an incident. They change only when
 * somebody changes them in code, which is exactly the change worth seeing in a
 * dashboard's history.
 */
function objectiveGauges() {
    const { OBJECTIVES } = require('../../domains/canonical/resilience');
    return {
        cakradana_availability_objective_ratio: OBJECTIVES.availability.target,
        cakradana_rpo_objective_seconds: OBJECTIVES.rpo.hours * 3600,
        cakradana_rto_objective_seconds: OBJECTIVES.rto.hours * 3600,
    };
}

const HELP = Object.freeze({
    cakradana_donations_total: 'Donations currently in force, excluding superseded versions',
    cakradana_quarantine_total: 'Records set aside because they could not be admitted',
    cakradana_quarantine_unresolved: 'Quarantined records nobody has reviewed',
    cakradana_quarantine_share: 'Share of submitted records that were quarantined',
    cakradana_scoring_events_total: 'Scoring events recorded, including re-scores',
    cakradana_disputes_open: 'Disputes awaiting acknowledgement or resolution',
    cakradana_disputes_overdue: 'Disputes past their resolution deadline',
    cakradana_store_metrics_available: 'Whether the store-derived gauges could be read',
    cakradana_backup_ever_completed: 'Whether any backup has ever completed against this store',
    cakradana_backup_last_success_timestamp_seconds: 'Unix time of the last verified backup',
    cakradana_backup_age_seconds: 'Age of the last verified backup; the figure to alert on against the RPO',
    cakradana_availability_objective_ratio: 'Declared availability target for the ingestion write path',
    cakradana_rpo_objective_seconds: 'Declared recovery point objective',
    cakradana_rto_objective_seconds: 'Declared recovery time objective',
    cakradana_public_dataset_cells: 'Cells in the published dataset, suppressed ones included',
    cakradana_public_dataset_age_seconds: 'Age of the last successful publication build',
    cakradana_public_materialisations_total: 'Publication builds by outcome',
    cakradana_legacy_donations_total: 'Donation rows held in the legacy document',
    cakradana_legacy_only_donations:
        'Legacy rows with no canonical counterpart; above zero the legacy collection is the only copy',
    cakradana_requests_total: 'HTTP requests by method, route, and status',
    cakradana_scoring_requests_total: 'Calls to the scoring service by outcome',
    cakradana_extraction_records_total: 'Extracted records by outcome',
    cakradana_request_duration_ms: 'Request duration in milliseconds',
});

async function render() {
    const lines = [];
    const seen = new Set();

    const helpFor = (id) => {
        const name = id.split('{')[0];
        if (seen.has(name)) return;
        seen.add(name);
        if (HELP[name]) lines.push(`# HELP ${name} ${HELP[name]}`);
    };

    for (const [id, value] of counters) {
        helpFor(id);
        lines.push(`${id} ${value}`);
    }

    for (const [id, stats] of histograms) {
        helpFor(id);
        const name = id.split('{')[0];
        const labels = id.slice(name.length);
        lines.push(`${name}_count${labels} ${stats.count}`);
        lines.push(`${name}_sum${labels} ${stats.sum}`);
        lines.push(`${name}_max${labels} ${stats.max}`);
    }

    for (const [name, value] of Object.entries(objectiveGauges())) {
        helpFor(name);
        lines.push(`${name} ${value}`);
    }

    for (const [name, value] of Object.entries(await storeGauges())) {
        helpFor(name);
        lines.push(`${name} ${value}`);
    }

    return `${lines.join('\n')}\n`;
}

/** Express middleware counting requests and their durations. */
function requestMetrics() {
    return (req, res, next) => {
        const started = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            // Labelled by the matched route rather than the path, so that ids
            // in the URL do not produce one time series per donation.
            const route = req.route?.path
                ? `${req.baseUrl}${req.route.path}`
                : req.baseUrl || 'unmatched';
            increment('cakradana_requests_total', {
                method: req.method,
                route,
                status: res.statusCode,
            });
            observe('cakradana_request_duration_ms', ms, { route });
        });
        next();
    };
}

function reset() {
    counters.clear();
    histograms.clear();
}

module.exports = {
    increment,
    observe,
    render,
    requestMetrics,
    reset,
    storeGauges,
    objectiveGauges,
};
