/**
 * Model health, proxied.
 *
 * The scoring service holds these figures and must not be reachable from a
 * browser: it accepts donation records and returns judgements about named
 * people, and putting it on a public network so a dashboard can read one
 * endpoint would be a poor trade.
 *
 * So this proxies. It also degrades honestly — when the scoring service cannot
 * be reached, the response says the figures are unavailable rather than
 * returning zeros. A dashboard showing zero lanes running looks identical to a
 * system where nothing is running, and only one of those is an emergency.
 */

const scoring = require('../../../utils/scoring/client');
const { record } = require('../../canonical/retention');
const { resilienceReport } = require('../../canonical/resilience');

const health = async (req, res) => {
    try {
        const windowDays = Number.parseInt(req.query.window_days, 10) || 30;
        const reviewBudget =
            Number.parseInt(req.query.review_budget, 10) ||
            Number.parseInt(process.env.REVIEW_BUDGET, 10) ||
            null;

        const report = await scoring.modelHealth({ windowDays, reviewBudget });

        await record({
            actor: req.user?.email || null,
            action: 'read-model-health',
            subjectType: 'Model',
        });

        return res.status(200).json({
            status: 'success',
            message: 'Model health',
            data: { available: true, ...report },
        });
    } catch (err) {
        if (err.name === 'ScoringUnavailable') {
            // 200 with `available: false` rather than an error status: the
            // request succeeded and the answer is that the figures cannot be
            // obtained. A 5xx here would make a dashboard show a failure of
            // itself rather than of the thing it monitors.
            return res.status(200).json({
                status: 'success',
                message: 'Model health is unavailable',
                data: {
                    available: false,
                    reason: err.message,
                    note:
                        'the scoring service could not be reached; these figures are ' +
                        'unknown rather than zero',
                },
            });
        }
        console.error('Error reading model health:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

/**
 * Structural clusters, as the last detection pass left them.
 *
 * Group alerts are not published and are not part of the public dataset: a
 * cluster is a hypothesis about a set of people, and one that has not been
 * looked at by anybody should not leave the review surface.
 */
const alerts = async (req, res) => {
    try {
        const report = await scoring.groupAlerts();
        return res.status(200).json({
            status: 'success',
            message: 'Structural alerts',
            data: { available: true, ...report },
        });
    } catch (err) {
        if (err.name === 'ScoringUnavailable') {
            return res.status(200).json({
                status: 'success',
                message: 'Structural alerts are unavailable',
                data: { available: false, reason: err.message, alerts: [] },
            });
        }
        console.error('Error reading structural alerts:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

/**
 * Which reference lists the rules are actually usable against.
 *
 * A register that quietly stopped being refreshed raises nothing. The rules
 * that depend on it return indeterminate, the queue simply stops containing
 * that kind of finding, and from the outside it looks exactly like a population
 * in which nobody is a prohibited source. Nothing else in this system would
 * show the difference.
 *
 * Reported as unavailable with a reason when the scoring service cannot be
 * reached, never as an empty list of healthy registers.
 */
const registers = async (req, res) => {
    try {
        const report = await scoring.registerStatus();
        return res.status(200).json({
            status: 'success',
            message: 'Register freshness',
            data: { available: true, ...report },
        });
    } catch (err) {
        if (err.name === 'ScoringUnavailable') {
            return res.status(200).json({
                status: 'success',
                message: 'Register freshness is unavailable',
                data: {
                    available: false,
                    reason: err.message,
                    registers: [],
                    // Said explicitly: an empty list here is the absence of an
                    // answer, not a clean bill of health.
                    note:
                        'this is not a report that every register is healthy; it ' +
                        'is the absence of a report',
                },
            });
        }
        console.error('Error reading register freshness:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

/**
 * What this deployment promises about surviving an incident, and where it
 * currently stands against that.
 *
 * The objectives and the position are served together on purpose. A dashboard
 * showing "RPO 6h" and a green tick, with nothing saying what makes six the
 * number, invites somebody to tighten it to one on the grounds that one sounds
 * better — and the figure would then be breached by design, since the interval
 * between full dumps is the only thing bounding it.
 *
 * The reply also states what is not covered. The gap between "there are
 * backups" and "we can recover" is where recovery plans usually fail, and it is
 * not closed by leaving the gap unmentioned.
 */
const resilience = async (req, res) => {
    try {
        const report = await resilienceReport();
        return res.status(200).json({
            status: 'success',
            message: 'Recovery objectives and current position',
            data: report,
        });
    } catch (err) {
        console.error('Error reading resilience objectives:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

module.exports = { health, alerts, registers, resilience };
