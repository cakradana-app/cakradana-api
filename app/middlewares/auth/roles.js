/**
 * Role-based access.
 *
 * The frontend is a static export and enforces nothing, so every restriction
 * that matters has to hold here. What each role may reach follows from what the
 * role is for: a recipient sees attributions naming them and nothing else; an
 * analyst sees the queue but not the rule sets; an administrator configures the
 * system but has no business reading donation content.
 *
 * Enforcement is off by default and is switched on with `ENFORCE_ROLES=true`.
 * Not because the restrictions are optional, but because turning them on
 * against a deployment whose users predate roles would lock out everyone whose
 * account was created before the field existed. While off, a request that would
 * have been refused is logged as such and allowed — so an operator can see the
 * exact blast radius before switching it on, rather than discovering it from
 * support tickets.
 */

const { log } = require('../../utils/observability/logging');
const metrics = require('../../utils/observability/metrics');

/**
 * Roles, and what each is for.
 *
 * `recipient` is the default for a self-registered account. Most people who
 * sign up are subjects of the data, not reviewers of it, and defaulting the
 * other way would hand the review queue to anyone who registered.
 */
const ROLES = Object.freeze([
    'recipient',
    'kpu_officer',
    'ppatk_analyst',
    'adjudicator',
    'ml_engineer',
    'administrator',
]);

const DEFAULT_ROLE = 'recipient';

/** Who may review donations others are party to. */
const REVIEWERS = Object.freeze(['kpu_officer', 'ppatk_analyst', 'adjudicator']);

function enforcing() {
    return process.env.ENFORCE_ROLES === 'true';
}

function roleOf(req) {
    return req.user?.role || DEFAULT_ROLE;
}

/**
 * Require one of the given roles.
 *
 * The refusal names the role held and the roles accepted. An opaque 403 sends
 * an operator to the logs to discover something the response could have told
 * them.
 */
function requireRole(...allowed) {
    const permitted = allowed.flat();
    return (req, res, next) => {
        const role = roleOf(req);
        if (permitted.includes(role)) return next();

        metrics.increment('cakradana_role_denials_total', {
            role,
            enforced: enforcing(),
        });

        if (!enforcing()) {
            // Recorded and allowed. The point of the unenforced mode is that
            // the log shows precisely what enforcement would break.
            log.warn('role check would have denied this request', {
                role,
                permitted,
                path: req.path,
                enforcement: 'disabled',
            });
            return next();
        }

        return res.status(403).json({
            status: 'error',
            message: `This action needs one of: ${permitted.join(', ')}. This account is ${role}.`,
            data: {},
        });
    };
}

/**
 * Require a role, whatever the enforcement flag says.
 *
 * Shadow mode exists so an operator can read the blast radius of enforcement
 * before switching it on, and for a read that is a sound trade: the cost of
 * being wrong is a log line. For an action that cannot be undone it is not.
 *
 * Merging two entities attributes one person's donations to another and can
 * produce a statutory finding against somebody who did nothing. Dispositioning
 * a cluster writes the training signal for every donation in it. Neither has a
 * shadow-mode version — the write either happens or it does not — so neither
 * waits for the flag.
 *
 * The denial is still counted, and counted as enforced, so the difference
 * between the two modes stays visible in the metrics rather than looking like
 * traffic that never arrived.
 */
function requireRoleStrict(...allowed) {
    const permitted = allowed.flat();
    return (req, res, next) => {
        const role = roleOf(req);
        if (permitted.includes(role)) return next();

        metrics.increment('cakradana_role_denials_total', {
            role,
            enforced: true,
        });
        log.warn('irreversible action refused', {
            role,
            permitted,
            path: req.path,
            enforcement: enforcing() ? 'enabled' : 'disabled-but-not-waivable',
        });

        return res.status(403).json({
            status: 'error',
            message:
                `This action needs one of: ${permitted.join(', ')}. This account is ${role}. ` +
                'It cannot be undone, so it is refused whether or not role enforcement is on.',
            data: {},
        });
    };
}

module.exports = {
    ROLES,
    DEFAULT_ROLE,
    REVIEWERS,
    requireRole,
    requireRoleStrict,
    roleOf,
    enforcing,
};
