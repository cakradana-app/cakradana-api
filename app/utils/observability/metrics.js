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

/**
 * Figures that describe the store rather than this process.
 *
 * Read on scrape and tolerant of the database being unreachable: a metrics
 * endpoint that fails when the database is down removes the visibility exactly
 * when it is needed.
 */
async function storeGauges() {
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

const HELP = Object.freeze({
    cakradana_donations_total: 'Donations currently in force, excluding superseded versions',
    cakradana_quarantine_total: 'Records set aside because they could not be admitted',
    cakradana_quarantine_unresolved: 'Quarantined records nobody has reviewed',
    cakradana_quarantine_share: 'Share of submitted records that were quarantined',
    cakradana_scoring_events_total: 'Scoring events recorded, including re-scores',
    cakradana_disputes_open: 'Disputes awaiting acknowledgement or resolution',
    cakradana_disputes_overdue: 'Disputes past their resolution deadline',
    cakradana_store_metrics_available: 'Whether the store-derived gauges could be read',
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

module.exports = { increment, observe, render, requestMetrics, reset, storeGauges };
