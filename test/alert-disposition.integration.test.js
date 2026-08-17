/**
 * Dispositioning a cluster, against a database.
 *
 * `alert-disposition.test.js` covers the refusals: no reason, no actor, an
 * exception naming a donation outside the cluster, an exception with no reason
 * of its own, a detector that could not be read. Every one of those returns
 * before the first write, which is why they could be tested without a database
 * and why testing them established nothing about what happens after.
 *
 * What happens after is the part that matters. One judgement about a cluster
 * becomes one label per member — the training signal for every donation in it —
 * and each carve-out has to become a label saying the opposite of the one
 * around it. The labels supersede whatever an analyst decided before, and a
 * superseding chain that breaks silently leaves two live dispositions for the
 * same donation with no way to tell which the model should believe.
 *
 * None of that is reachable without a database. It is also, along with the
 * merge, one of the two paths where review found a defect that its own
 * docstring claimed to prevent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const { Donation, Label } = require('../app/domains/canonical/canonical.model');
const { AuditEntry } = require('../app/domains/canonical/retention');
const scoring = require('../app/utils/scoring/client');
const controller = require('../app/domains/services/donations/labels.controller');

useDatabase();

const ACTOR = 'analyst@cakradana.faizath.com';

function reply() {
    const sent = {};
    return {
        sent,
        status(code) {
            sent.status = code;
            return this;
        },
        json(body) {
            sent.body = body;
            return this;
        },
    };
}

async function makeDonation(index) {
    return Donation.create({
        senderRef: { entityId: null, rawText: `Donor ${index}` },
        receiverRef: { entityId: null, rawText: 'Partai Maju' },
        amountIdr: 5_000_000,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'digital-form',
        dedupKey: `alert-${index}`,
    });
}

/**
 * Stand the detector up with a cluster over the given donations.
 *
 * Replaced on the module rather than over the network: what is under test is
 * what the controller writes once it has an alert, and a real detector would
 * make the test describe the scoring service instead.
 */
function withAlert(alert, run) {
    const original = scoring.groupAlerts;
    scoring.groupAlerts = async () => ({
        has_run: true,
        detected_at: '2026-06-06T00:00:00Z',
        alerts: alert ? [alert] : [],
    });
    return run().finally(() => {
        scoring.groupAlerts = original;
    });
}

function alertOver(donations, overrides = {}) {
    return {
        alert_id: 'fan-in-001',
        kind: 'fan-in',
        typology: 'smurfing',
        provisional_node_ratio: 0.25,
        subject: { donations: donations.map((d) => String(d._id)) },
        ...overrides,
    };
}

async function disposition(body) {
    const res = reply();
    await controller.dispositionAlert({ body, user: { email: ACTOR } }, res);
    return res.sent;
}

test('one judgement about a cluster becomes one label per member', async () => {
    // The whole point of the endpoint. Forty separate dispositions over the
    // members of one cluster is forty claims where the analyst made one.
    const donations = await Promise.all([0, 1, 2].map(makeDonation));
    const sent = await withAlert(alertOver(donations), () =>
        disposition({
            alert_id: 'fan-in-001',
            reason: 'a family paying together, confirmed against the filed return',
        }),
    );

    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.members, 3);
    assert.equal(sent.body.data.labelled, 3);

    const labels = await Label.find({}).lean();
    assert.equal(labels.length, 3);
    for (const label of labels) {
        assert.equal(label.value, 'not_risky');
        assert.equal(label.source, 'analyst_disposition');
        assert.equal(label.actor, ACTOR);
        assert.equal(label.alertId, 'fan-in-001');
        assert.equal(label.alertException, false);
    }
});

test('the members of one judgement share a bulk id', async () => {
    // Without it the cluster cannot be reconstructed later, and an analyst
    // reviewing the decision sees three unrelated labels rather than one call.
    const donations = await Promise.all([0, 1, 2].map(makeDonation));
    const sent = await withAlert(alertOver(donations), () =>
        disposition({ alert_id: 'fan-in-001', reason: 'one household' }),
    );

    const labels = await Label.find({}).lean();
    const bulkIds = new Set(labels.map((l) => String(l.bulkId)));
    assert.equal(bulkIds.size, 1);
    assert.equal([...bulkIds][0], sent.body.data.bulk_id);
});

test('a carve-out is labelled against the cluster, with its own reason', async () => {
    // A cluster dismissed as a family paying together can still contain one
    // donation that is not, and recording it as clean because the group was
    // would teach the model the opposite of what the analyst decided.
    const donations = await Promise.all([0, 1, 2].map(makeDonation));
    const excepted = donations[1];

    const sent = await withAlert(alertOver(donations), () =>
        disposition({
            alert_id: 'fan-in-001',
            reason: 'a family paying together',
            except: [
                {
                    donation_id: String(excepted._id),
                    value: 'risky',
                    reason: 'this donor is not a relative and gave the day of the filing',
                },
            ],
        }),
    );

    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.data.exceptions, [String(excepted._id)]);

    const carveOut = await Label.findOne({ donationId: excepted._id }).lean();
    assert.equal(carveOut.value, 'risky');
    assert.equal(carveOut.alertException, true);
    assert.match(carveOut.note, /not a relative/);
    // The note carries both judgements: the one made about this donation and
    // the one it was carved out of.
    assert.match(carveOut.note, /excepted from fan-in fan-in-001/);
    assert.match(carveOut.note, /a family paying together/);

    const others = await Label.find({ donationId: { $ne: excepted._id } }).lean();
    assert.equal(others.length, 2);
    for (const label of others) {
        assert.equal(label.value, 'not_risky');
        assert.equal(label.alertException, false);
    }
});

test('a new disposition supersedes the analyst’s previous one', async () => {
    // Two live analyst dispositions for the same donation is a training signal
    // with no defined value: whichever the pipeline reads first wins, and
    // which that is depends on insertion order.
    const donations = await Promise.all([0].map(makeDonation));

    await withAlert(alertOver(donations), () =>
        disposition({ alert_id: 'fan-in-001', reason: 'first look: a family' }),
    );
    await withAlert(alertOver(donations), () =>
        disposition({
            alert_id: 'fan-in-001',
            value: 'risky',
            reason: 'second look: the filing contradicts it',
        }),
    );

    const labels = await Label.find({ donationId: donations[0]._id })
        .sort({ createdAt: 1 })
        .lean();
    assert.equal(labels.length, 2);
    assert.equal(String(labels[0].supersededBy), String(labels[1]._id));
    assert.equal(labels[1].supersededBy, null);

    const live = await Label.find({
        donationId: donations[0]._id,
        source: 'analyst_disposition',
        supersededBy: null,
    }).lean();
    assert.equal(live.length, 1, 'more than one live disposition for one donation');
    assert.equal(live[0].value, 'risky');
});

test('a member the cluster names but the store does not have is reported, not invented', async () => {
    // The detector runs over a point-in-time view. A donation superseded by a
    // correction since the last pass is named by the alert and absent here,
    // and labelling something that is not there would be a claim about a
    // record nobody can read.
    const donations = await Promise.all([0, 1].map(makeDonation));
    const ghost = '507f1f77bcf86cd799439099';
    const alert = alertOver(donations);
    alert.subject.donations.push(ghost);

    const sent = await withAlert(alert, () =>
        disposition({ alert_id: 'fan-in-001', reason: 'one household' }),
    );

    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.members, 3);
    assert.equal(sent.body.data.labelled, 2);
    assert.deepEqual(sent.body.data.not_found, [ghost]);
    assert.equal(await Label.countDocuments({}), 2);
});

test('how much of the cluster rested on unresolved parties is carried onto the record', async () => {
    // A pattern assembled from parties nobody has resolved is a weaker claim
    // than the same pattern over identified donors, and the record of what was
    // dismissed has to say which it was.
    const donations = await Promise.all([0, 1].map(makeDonation));
    const sent = await withAlert(alertOver(donations, { provisional_node_ratio: 0.5 }), () =>
        disposition({ alert_id: 'fan-in-001', reason: 'one household' }),
    );
    assert.equal(sent.body.data.provisional_node_ratio, 0.5);
});

test('the typology of the alert is carried onto every label', async () => {
    const donations = await Promise.all([0, 1].map(makeDonation));
    await withAlert(alertOver(donations), () =>
        disposition({ alert_id: 'fan-in-001', reason: 'one household' }),
    );
    const labels = await Label.find({}).lean();
    for (const label of labels) assert.equal(label.typology, 'smurfing');
});

test('an unreadable detector writes nothing at all', async () => {
    // Refused rather than degraded into a bulk clear over whatever the caller
    // sent: a disposition recorded against an alert nobody could read is a
    // claim about a cluster whose membership is unknown.
    const donations = await Promise.all([0, 1].map(makeDonation));
    const original = scoring.groupAlerts;
    scoring.groupAlerts = async () => {
        throw new Error('the scoring service is unreachable');
    };
    try {
        const sent = await disposition({
            alert_id: 'fan-in-001',
            reason: 'looks like a family',
        });
        assert.equal(sent.status, 503);
    } finally {
        scoring.groupAlerts = original;
    }

    assert.equal(await Label.countDocuments({}), 0);
    void donations;
});

test('an exception naming a donation outside the cluster writes nothing', async () => {
    // The refusal was already covered. What was not is that it happens before
    // the loop, so a request that is refused halfway does not leave the first
    // members labelled and the rest not.
    const donations = await Promise.all([0, 1, 2].map(makeDonation));
    const outside = await makeDonation(99);

    const sent = await withAlert(alertOver(donations), () =>
        disposition({
            alert_id: 'fan-in-001',
            reason: 'one household',
            except: [{ donation_id: String(outside._id), reason: 'not a relative' }],
        }),
    );

    assert.equal(sent.status, 400);
    assert.equal(await Label.countDocuments({}), 0);
});

test('an alert covering no donations is refused before any write', async () => {
    const sent = await withAlert(alertOver([]), () =>
        disposition({ alert_id: 'fan-in-001', reason: 'one household' }),
    );
    assert.equal(sent.status, 409);
    assert.equal(await Label.countDocuments({}), 0);
});

test('an alert the last pass did not produce is refused', async () => {
    const donations = await Promise.all([0].map(makeDonation));
    const sent = await withAlert(alertOver(donations), () =>
        disposition({ alert_id: 'fan-out-404', reason: 'one household' }),
    );
    assert.equal(sent.status, 404);
    assert.equal(sent.body.data.has_run, true);
    assert.equal(await Label.countDocuments({}), 0);
});

test('the decision is written to the audit record with its reason', async () => {
    // A disposition is the training signal for every donation in the cluster.
    // Who made it and why has to be readable afterwards without reconstructing
    // it from the labels.
    const donations = await Promise.all([0, 1].map(makeDonation));
    await withAlert(alertOver(donations), () =>
        disposition({
            alert_id: 'fan-in-001',
            reason: 'a family paying together, confirmed against the filed return',
        }),
    );

    const audit = await AuditEntry.findOne({ action: 'disposition-alert' }).lean();
    assert.ok(audit, 'the disposition wrote no audit record');
    assert.equal(audit.actor, ACTOR);
    assert.equal(audit.subjectType, 'Alert');
    assert.equal(audit.subjectId, 'fan-in-001');
    assert.match(audit.reason, /confirmed against the filed return/);
});

test('the disposition of an alert can be read back, carve-outs included', async () => {
    const donations = await Promise.all([0, 1, 2].map(makeDonation));
    const excepted = donations[2];
    await withAlert(alertOver(donations), () =>
        disposition({
            alert_id: 'fan-in-001',
            reason: 'a family paying together',
            except: [
                {
                    donation_id: String(excepted._id),
                    value: 'risky',
                    reason: 'gave the day of the filing',
                },
            ],
        }),
    );

    const res = reply();
    await controller.alertDisposition(
        { params: { id: 'fan-in-001' }, query: {}, user: { email: ACTOR } },
        res,
    );

    assert.equal(res.sent.status, 200);
    const body = JSON.stringify(res.sent.body);
    assert.match(body, /fan-in-001/);
    assert.match(body, new RegExp(String(excepted._id)));
});
