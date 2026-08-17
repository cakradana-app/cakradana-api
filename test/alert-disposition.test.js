/**
 * Dispositioning a cluster as one finding.
 *
 * A fan-in of forty donations is one thing the system noticed. Clearing it as
 * forty separate decisions loses that a group was examined as a group, and
 * makes the retraining signal count one conclusion forty times.
 *
 * What is checked here is everything that happens before any write: that the
 * cluster's membership comes from the detector rather than the caller, that an
 * unreadable detector refuses the request instead of degrading it into a bulk
 * clear, and that a carve-out can only carve out a member and must say why.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Label } = require('../app/domains/canonical/canonical.model');
const {
    dispositionAlert,
} = require('../app/domains/services/donations/labels.controller');
const scoring = require('../app/utils/scoring/client');

const ALERT_ID = 'a1b2c3d4e5f6';
const MEMBERS = [
    '507f1f77bcf86cd799439011',
    '507f1f77bcf86cd799439012',
    '507f1f77bcf86cd799439013',
];

function response() {
    const captured = { status: null, body: null };
    return {
        captured,
        status(code) {
            captured.status = code;
            return this;
        },
        json(body) {
            captured.body = body;
            return this;
        },
    };
}

function request(body = {}, actor = 'analyst@example.org') {
    return { body, user: actor ? { email: actor } : undefined };
}

/** Run the handler with the detector stubbed, restoring it afterwards. */
async function withAlerts(report, run) {
    const original = scoring.groupAlerts;
    scoring.groupAlerts =
        typeof report === 'function' ? report : async () => report;
    try {
        return await run();
    } finally {
        scoring.groupAlerts = original;
    }
}

const CLUSTER = {
    has_run: true,
    detected_at: '2026-08-01T00:00:00+07:00',
    alerts: [
        {
            alert_id: ALERT_ID,
            kind: 'fan-in-burst',
            typology: 'T-01',
            subject: { donations: MEMBERS },
            provisional_node_ratio: 0.25,
        },
    ],
};

test('a cluster disposition needs an alert to be about', async () => {
    const res = response();
    await dispositionAlert(request({ reason: 'grassroots campaign' }), res);
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /alert_id is required/);
});

test('a cluster dismissed without a reason is refused', async () => {
    // Otherwise it is indistinguishable from a cluster nobody examined.
    const res = response();
    await dispositionAlert(request({ alert_id: ALERT_ID }), res);
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /nobody examined/);
});

test('a disposition must name the person making it', async () => {
    const res = response();
    await dispositionAlert(
        request({ alert_id: ALERT_ID, reason: 'grassroots' }, null),
        res,
    );
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /name the person/);
});

test('a value outside the vocabulary is refused', async () => {
    const res = response();
    await dispositionAlert(
        request({ alert_id: ALERT_ID, reason: 'grassroots', value: 'probably_fine' }),
        res,
    );
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /value must be one of/);
});

test('an unreadable detector refuses rather than degrading to a bulk clear', async () => {
    // A disposition recorded against an alert nobody could read is a claim
    // about a cluster whose membership is unknown.
    const res = response();
    await withAlerts(
        async () => {
            throw new Error('scoring service unreachable');
        },
        () =>
            dispositionAlert(
                request({ alert_id: ALERT_ID, reason: 'grassroots' }),
                res,
            ),
    );
    assert.equal(res.captured.status, 503);
    assert.match(res.captured.body.message, /cannot be established/);
});

test('an alert absent from the last pass is a not-found, with when it ran', async () => {
    // A stale empty list and a genuinely clean population look identical
    // otherwise, and only one of them means nothing was found.
    const res = response();
    await withAlerts({ has_run: true, detected_at: '2026-08-01T00:00:00+07:00', alerts: [] }, () =>
        dispositionAlert(request({ alert_id: ALERT_ID, reason: 'grassroots' }), res),
    );
    assert.equal(res.captured.status, 404);
    assert.equal(res.captured.body.data.detected_at, '2026-08-01T00:00:00+07:00');
    assert.equal(res.captured.body.data.has_run, true);
});

test('an exception can only carve out a member of the cluster', async () => {
    // A caller-supplied member list would let a disposition claim to cover a
    // cluster while covering something else.
    const res = response();
    await withAlerts(CLUSTER, () =>
        dispositionAlert(
            request({
                alert_id: ALERT_ID,
                reason: 'grassroots',
                except: [
                    { donation_id: '507f1f77bcf86cd799439099', reason: 'unrelated' },
                ],
            }),
            res,
        ),
    );
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /not part of this cluster/);
});

test('an exception carries its own reason', async () => {
    // It is a separate judgement from the one made about the cluster.
    const res = response();
    await withAlerts(CLUSTER, () =>
        dispositionAlert(
            request({
                alert_id: ALERT_ID,
                reason: 'grassroots',
                except: [{ donation_id: MEMBERS[0] }],
            }),
            res,
        ),
    );
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /its own reason/);
});

test('an exception without a donation is refused', async () => {
    const res = response();
    await withAlerts(CLUSTER, () =>
        dispositionAlert(
            request({ alert_id: ALERT_ID, reason: 'grassroots', except: [{ reason: 'x' }] }),
            res,
        ),
    );
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /donation_id/);
});

test('except must be a list, not a single object', async () => {
    const res = response();
    await withAlerts(CLUSTER, () =>
        dispositionAlert(
            request({
                alert_id: ALERT_ID,
                reason: 'grassroots',
                except: { donation_id: MEMBERS[0], reason: 'x' },
            }),
            res,
        ),
    );
    assert.equal(res.captured.status, 400);
    assert.match(res.captured.body.message, /array of exceptions/);
});

test('an alert covering nothing cannot be dispositioned', async () => {
    const res = response();
    await withAlerts(
        {
            has_run: true,
            alerts: [{ alert_id: ALERT_ID, kind: 'fan-in-burst', subject: { donations: [] } }],
        },
        () => dispositionAlert(request({ alert_id: ALERT_ID, reason: 'grassroots' }), res),
    );
    assert.equal(res.captured.status, 409);
});

test('a label can record the cluster its judgement was about', async () => {
    // Without it, clearing a forty-donation fan-in records forty unrelated
    // decisions and the finding actually dismissed leaves no trace.
    const label = new Label({
        donationId: MEMBERS[0],
        donationVersion: 1,
        value: 'not_risky',
        source: 'analyst_disposition',
        weight: 0.9,
        alertId: ALERT_ID,
    });
    await label.validate();
    assert.equal(label.alertId, ALERT_ID);
    assert.equal(label.alertException, false);
});

test('a carve-out is marked as one rather than looking like a stray label', async () => {
    const label = new Label({
        donationId: MEMBERS[0],
        donationVersion: 1,
        value: 'risky',
        source: 'analyst_disposition',
        weight: 0.9,
        alertId: ALERT_ID,
        alertException: true,
    });
    await label.validate();
    assert.equal(label.alertException, true);
});
