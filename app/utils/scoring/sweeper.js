/**
 * Scoring the records that were left outstanding.
 *
 * Ingestion never blocks on scoring: a donation that has been received and
 * validated is worth keeping whether or not anything has judged it yet. That
 * design is only honest if something later picks up what was left behind.
 * Without this, "the score is outstanding" meant "the donation is never scored"
 * — and a donation nothing evaluated is indistinguishable, in every queue and
 * every total, from one evaluated and found clean.
 *
 * Two things are swept: donations with no scoring event at all, and events
 * marked for re-scoring because the record they described was corrected.
 */

const { Donation, ScoringEvent } = require('../../domains/canonical/canonical.model');
const scoring = require('./client');
const { log } = require('../observability/logging');
const metrics = require('../observability/metrics');

/** Bounded so a sweep cannot monopolise the scoring service. */
const BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;

/**
 * Donations in force that no scoring event covers.
 *
 * Expressed as a lookup rather than a per-donation existence check, which at
 * the volumes in the scale requirements is the difference between one query and
 * ten million.
 */
async function unscored(limit = BATCH_SIZE) {
    return Donation.aggregate([
        { $match: { supersededBy: null } },
        {
            $lookup: {
                from: ScoringEvent.collection.name,
                localField: '_id',
                foreignField: 'donationId',
                as: 'events',
            },
        },
        { $match: { events: { $size: 0 } } },
        { $limit: limit },
        { $project: { events: 0 } },
    ]);
}

/** Records whose score was invalidated by a correction. */
async function stale(limit = BATCH_SIZE) {
    const events = await ScoringEvent.find({ rescoreReason: { $ne: null } })
        .sort({ scoredAt: 1 })
        .limit(limit)
        .lean();
    if (!events.length) return [];
    return Donation.find({
        _id: { $in: events.map((e) => e.donationId) },
        supersededBy: null,
    });
}

async function sweepOnce({ limit = BATCH_SIZE } = {}) {
    const pending = await unscored(limit);
    const invalidated = await stale(limit);
    const donations = [...pending, ...invalidated];

    if (!donations.length) {
        return { attempted: 0, scored: 0, stillPending: 0, available: true };
    }

    const result = await scoring.scoreMany(donations, {
        requestId: `sweep-${donations.length}`,
    });

    metrics.increment('cakradana_scoring_sweep_total', {
        outcome: result.available ? 'ok' : 'unavailable',
    });
    metrics.increment(
        'cakradana_scoring_sweep_scored_total',
        {},
        result.scored.length,
    );

    log.info('scoring sweep', {
        attempted: donations.length,
        scored: result.scored.length,
        still_pending: result.pending.length,
        available: result.available,
        reason: result.reason || null,
    });

    return {
        attempted: donations.length,
        scored: result.scored.length,
        stillPending: result.pending.length,
        available: result.available,
        reason: result.reason || null,
    };
}

/**
 * Start sweeping.
 *
 * Runs whether or not the scoring service is configured. An unconfigured
 * service produces a sweep that reports everything as still pending, which is
 * the true state and is worth logging — the alternative is a queue of unscored
 * donations that nothing mentions.
 */
function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (timer) return timer;
    log.info('scoring sweep started', { interval_ms: intervalMs });
    const tick = () => sweepOnce().catch((error) =>
        log.error('scoring sweep failed', { error: error.message }),
    );
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
    return timer;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, sweepOnce, unscored, stale, BATCH_SIZE, DEFAULT_INTERVAL_MS };
