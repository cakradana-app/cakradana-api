/**
 * Liveness and readiness.
 *
 * They answer different questions and conflating them is how a deployment
 * rolls a healthy process into service that cannot do anything. Liveness asks
 * whether the process is running; readiness asks whether it can serve a
 * request, which here means the database is connected.
 *
 * The scoring service is checked and reported, but its absence does not make
 * this service unready. Ingestion is designed to continue while scoring is
 * down, with the donations stored and their scores outstanding — refusing
 * traffic because a downstream is unavailable would turn a degraded system into
 * an offline one, and lose the records that were arriving.
 *
 * Readiness also reports whether identifiers can be held at all. That one is
 * here because its absence is invisible: the store refuses every value, entity
 * resolution falls back to names, and everything downstream goes on working on
 * a weaker basis without a single error. A deployment learns it at deploy or
 * not at all.
 *
 * Readiness also reports the recovery position: the declared RPO and RTO, and
 * how old the last recoverable copy is. Reported for the same reason and with
 * the same limit as the scoring service — an objective nobody can measure
 * against is not an objective, and a stale backup is a serious problem that is
 * not made better by taking the service out of rotation, which would stop the
 * ingestion whose records are the thing at risk.
 */

const mongoose = require('mongoose');

const metrics = require('../../utils/observability/metrics');
const { OBJECTIVES, rpoStatus } = require('../canonical/resilience');
const { configured: identifierStorageConfigured } = require('../identity/identifier.model');

/** Alive. Deliberately touches nothing: a liveness probe that queries the database restarts the process when the database is slow. */
const live = (req, res) =>
    res.status(200).json({ status: 'success', message: 'alive', data: { alive: true } });

const READY_STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

const ready = async (req, res) => {
    const state = mongoose.connection.readyState;
    const database = READY_STATES[state] || 'unknown';
    const scoringConfigured = Boolean(process.env.SCORING_SERVICE_URL);
    const identifiersConfigured = identifierStorageConfigured();

    const isReady = state === 1;

    // Only asked when the database is there to ask. A readiness probe that
    // waits on a query it already knows will fail turns a disconnection into a
    // timeout, which is a slower and less legible version of the same answer.
    const rpo = isReady
        ? await rpoStatus()
        : { state: 'unknown', reason: 'the database is not connected', objectiveHours: OBJECTIVES.rpo.hours };

    return res.status(isReady ? 200 : 503).json({
        status: isReady ? 'success' : 'error',
        message: isReady ? 'ready' : 'not ready',
        data: {
            ready: isReady,
            database,
            // Reported rather than required. Its absence degrades scoring, not
            // ingestion, and the difference is what keeps arriving records
            // from being refused.
            scoring_service: scoringConfigured ? 'configured' : 'not configured',
            scoring_affects_readiness: false,
            subject_notification: process.env.NOTIFY_SUBJECTS === 'true' ? 'enabled' : 'disabled',
            // Reported here because this is the endpoint a deployment reads,
            // and the consequence is a silent one. Without the two secrets the
            // store refuses every identifier, entity resolution falls back to
            // matching names, and nothing says so: donations resolve, the
            // graph builds, the queue fills. The system goes on working while
            // the basis of every cumulative rule quietly weakens, and the
            // first sign is somebody noticing two people merged who share a
            // name. An operator learns this at deploy or not at all.
            identifier_storage: identifiersConfigured ? 'usable' : 'not configured',
            // Not a readiness failure, for the same reason as the two above:
            // refusing traffic would stop the ingestion whose records are what
            // is at stake, and a deployment that has decided not to hold
            // identifiers is a legitimate deployment.
            identifier_storage_affects_readiness: false,
            ...(identifiersConfigured
                ? {}
                : {
                      identifier_storage_consequence:
                          'identifiers are refused and entity resolution rests on ' +
                          'names alone, which is a materially weaker basis for every ' +
                          'cumulative rule',
                  }),
            recovery: {
                availability_target: OBJECTIVES.availability.target,
                rpo_hours: OBJECTIVES.rpo.hours,
                rto_hours: OBJECTIVES.rto.hours,
                last_backup_at: rpo.lastBackupAt ?? null,
                backup_age_hours: rpo.ageHours ?? null,
                rpo_state: rpo.state,
                rpo_reason: rpo.reason ?? null,
                // Same rule as the scoring service above, for a stronger
                // reason: withdrawing from rotation over a stale backup stops
                // the ingestion whose records are what the backup protects.
                rpo_affects_readiness: false,
            },
        },
    });
};

/** Prometheus text format. */
const metricsEndpoint = async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.status(200).send(await metrics.render());
};

module.exports = { live, ready, metrics: metricsEndpoint };
