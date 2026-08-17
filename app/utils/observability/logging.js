/**
 * Structured logging and request correlation.
 *
 * A donation entering through a paper form passes through OCR, extraction,
 * validation, entity resolution, ingestion, and scoring — five components and
 * two services. When one of them drops a record, the only way to find out where
 * is to follow that record's own path, and `console.log` lines with no shared
 * identifier cannot be followed.
 *
 * So every request carries a correlation id, it goes out on the response and
 * downstream to the scoring service, and every log line is JSON with the id on
 * it. Lines a person reads casually are worth less than lines a query can
 * group.
 */

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Per-request context, carried without threading it through every signature.
 *
 * The alternative is a correlation id parameter on every function in the call
 * chain, which is how correlation ids get dropped: one function that forgets to
 * pass it silently breaks the trail from that point down.
 */
const context = new AsyncLocalStorage();

const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

function currentLevel() {
    const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
    return LEVELS.includes(configured) ? configured : 'info';
}

function emit(level, message, fields = {}) {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(currentLevel())) return;

    const store = context.getStore() || {};
    const line = {
        at: new Date().toISOString(),
        level,
        message,
        correlation_id: store.correlationId || null,
        actor: store.actor || null,
        route: store.route || null,
        ...fields,
    };

    // Errors go to stderr so that a container's log routing can separate them
    // without parsing. Everything is JSON either way.
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
}

const log = {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
};

/** The id for the request currently being handled, if any. */
function correlationId() {
    return context.getStore()?.correlationId || null;
}

/**
 * Record who the request is for, once authentication has run.
 *
 * Set separately from the id because the actor is not known when the request
 * arrives, and a log line written before authentication should say so rather
 * than carry a name that had not been established yet.
 */
function setActor(actor) {
    const store = context.getStore();
    if (store) store.actor = actor;
}

/**
 * Express middleware: assign a correlation id and log the outcome.
 *
 * An inbound `x-correlation-id` is honoured, so a trace started by the web app
 * or by a batch job continues through this service instead of restarting here.
 */
function requestLogging() {
    return (req, res, next) => {
        const correlation =
            req.headers['x-correlation-id'] || crypto.randomUUID();
        const started = process.hrtime.bigint();

        context.run({ correlationId: correlation, route: req.path }, () => {
            res.setHeader('x-correlation-id', correlation);

            res.on('finish', () => {
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                const store = context.getStore() || {};
                store.actor = store.actor || req.user?.email || null;
                emit(res.statusCode >= 500 ? 'error' : 'info', 'request', {
                    method: req.method,
                    path: req.path,
                    status: res.statusCode,
                    duration_ms: Math.round(ms * 100) / 100,
                });
            });

            next();
        });
    };
}

module.exports = { log, requestLogging, correlationId, setActor, context };
