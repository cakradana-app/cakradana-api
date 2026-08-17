/**
 * The restore drill.
 *
 * A recovery objective is a claim about something that has never happened yet,
 * and the usual way it turns out to be false is that the backups were running
 * fine and nobody had ever restored one. So this does the restore: it seeds a
 * store, backs it up, restores the archive into a clean database, and compares
 * what came out against what went in. Everything else here — the objectives,
 * the manifest, the metrics — describes a recovery. This is the only test that
 * performs one.
 *
 * It needs a real MongoDB, because the failures worth catching are the ones a
 * fake does not have: BSON types that survive a round trip, an insert that
 * silently drops a document, a collection that restores empty. When no database
 * can be reached the drill fails and says so. It is never skipped — a skipped
 * drill is a recovery plan nobody has tested, reported as a passing suite,
 * which is the exact state this work exists to end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');

const {
    OBJECTIVES,
    BACKUP_POLICY,
    BACKUP_SET,
    NOT_BACKED_UP,
    BACKUP_RUN_COLLECTION,
    schemaFingerprint,
    rpoStatus,
    resilienceReport,
} = require('../app/domains/canonical/resilience');
const { Donation, Entity, Label } = require('../app/domains/canonical/canonical.model');
const { AuditEntry } = require('../app/domains/canonical/retention');
const { Dispute } = require('../app/domains/services/disputes/dispute.model');
const { User } = require('../app/domains/users/user.model');
const health = require('../app/domains/health/health.controller');
const monitoring = require('../app/domains/services/monitoring/monitoring.controller');
const metrics = require('../app/utils/observability/metrics');
const { backup, pruneArchives } = require('../scripts/backup');
const { restore, verifyStore, RestoreIncomplete } = require('../scripts/restore');

const quiet = () => {};
const workspaces = [];

let server = null;
let databases = 0;

/**
 * The mongod every case here runs against.
 *
 * `mongodb-memory-server` when it is installed, and whatever
 * `RESILIENCE_TEST_URI` points at otherwise — the `mongodb` service in
 * compose.yml, typically. Both give a real mongod, and the failures worth
 * catching here are the ones a fake does not have. When neither is reachable
 * this throws and names both options, because an unreachable database is an
 * environment problem and must not read as a broken restore.
 */
async function mongod() {
    if (server) return server;

    if (process.env.RESILIENCE_TEST_URI) {
        server = { uri: process.env.RESILIENCE_TEST_URI, stop: async () => {} };
        return server;
    }

    let MongoMemoryServer;
    try {
        ({ MongoMemoryServer } = require('mongodb-memory-server'));
    } catch (error) {
        throw new Error(
            'the restore drill needs a MongoDB and found none. Install the dev ' +
            'dependencies (`npm ci`), or start the compose service and set ' +
            'RESILIENCE_TEST_URI=mongodb://admin:password@localhost:27017/?authSource=admin. ' +
            `Underlying error: ${error.message}`,
        );
    }

    let instance;
    try {
        instance = await MongoMemoryServer.create();
    } catch (error) {
        throw new Error(
            'mongodb-memory-server could not start a mongod. Set RESILIENCE_TEST_URI to a ' +
            `reachable MongoDB to run the drill against instead. Underlying error: ${error.message}`,
        );
    }
    server = { uri: instance.getUri(), stop: () => instance.stop() };
    return server;
}

/** An empty database of its own. A restore target has to be clean, and reusing one is how a "restored" collection turns out to be the previous case's. */
async function newStore() {
    const running = await mongod();
    const url = new URL(running.uri);
    databases += 1;
    url.pathname = `/drill_${process.pid}_${databases}`;
    return url.toString();
}

/** Enough of an Express response to read what a handler decided. */
function fakeResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function newWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakradana-drill-'));
    workspaces.push(dir);
    return dir;
}

test.after(async () => {
    if (server) await server.stop();
    for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
    await mongoose.disconnect();
});

/**
 * Documents built through the real schemas, then written as plain documents.
 *
 * Through the schemas so the drill moves the shapes the application actually
 * stores, including the nested provenance entries and the object ids that a
 * lossy encoding would flatten into strings. Written raw so the seed is a
 * database state rather than a sequence of model calls, which is what a backup
 * reads.
 */
async function seed(uri) {
    const connection = await mongoose.createConnection(uri).asPromise();

    const senderId = new mongoose.Types.ObjectId();
    const receiverId = new mongoose.Types.ObjectId();

    const entities = [
        new Entity({
            _id: senderId,
            canonicalName: 'Budi Santoso',
            entityType: 'individual',
            aliases: ['Budi Santoso', 'B. Santoso'],
        }),
        new Entity({
            _id: receiverId,
            canonicalName: 'Partai Maju',
            entityType: 'political-party',
        }),
    ].map((doc) => doc.toObject());

    const donations = [1, 2, 3].map((n) =>
        new Donation({
            senderRef: { entityId: senderId, rawText: 'Budi Santoso', entityType: 'individual' },
            receiverRef: { entityId: receiverId, rawText: 'Partai Maju', entityType: 'political-party' },
            // Deliberately large: rupiah figures exceed what a lossy encoding
            // round-trips as the same number, and a donation that returns from
            // a restore as a different value is compared against the statutory
            // limit as a different donation.
            amountIdr: 2_500_000_000 + n,
            occurredAt: new Date(`2026-05-0${n}T00:00:00.000Z`),
            recordedAt: new Date(`2026-05-1${n}T09:30:00.000Z`),
            channel: 'digital-form',
            dedupKey: `seed-${n}`,
            provenance: [
                { field: 'amountIdr', provenance: 'submitted', actor: 'submitter@example.org', at: new Date('2026-05-11T09:30:00.000Z') },
            ],
        }).toObject(),
    );

    const labels = [
        new Label({
            donationId: donations[0]._id,
            donationVersion: 1,
            source: 'analyst_disposition',
            value: 'risky',
            weight: 1,
            actor: 'analyst@example.org',
        }).toObject(),
    ];

    const auditEntries = [
        new AuditEntry({ actor: 'analyst@example.org', action: 'view-case', subjectType: 'Donation', subjectId: String(donations[0]._id) }).toObject(),
        new AuditEntry({ actor: 'someone@example.org', action: 'view-case', subjectType: 'Donation', subjectId: String(donations[1]._id), outcome: 'denied', reason: 'not assigned to this case' }).toObject(),
    ];

    const disputes = [
        new Dispute({
            donationId: donations[2]._id,
            donationVersion: 1,
            raisedBy: 'budi@example.org',
            party: 'sender',
            reason: 'not_mine',
            acknowledgeBy: new Date('2026-06-05T00:00:00.000Z'),
            resolveBy: new Date('2026-07-01T00:00:00.000Z'),
        }).toObject(),
    ];

    const users = [
        new User({ name: 'Analyst', email: 'analyst@example.org', type: 'individual' }).toObject(),
    ];

    await connection.db.collection('entities').insertMany(entities);
    await connection.db.collection('donations').insertMany(donations);
    await connection.db.collection('labels').insertMany(labels);
    await connection.db.collection('auditentries').insertMany(auditEntries);
    await connection.db.collection('disputes').insertMany(disputes);
    await connection.db.collection('users').insertMany(users);
    await connection.close();

    return { donations, entities, senderId, receiverId };
}

async function countIn(uri, collection) {
    const connection = await mongoose.createConnection(uri).asPromise();
    const count = await connection.db.collection(collection).countDocuments();
    await connection.close();
    return count;
}

test('every objective states a number and what makes it defensible', () => {
    // A target with no reasoning attached is a number somebody will change
    // under pressure without knowing what it was standing on.
    for (const [name, objective] of Object.entries(OBJECTIVES)) {
        assert.ok(objective.because.length > 80, `${name} has no reasoning`);
        assert.ok(objective.toTighten.length > 40, `${name} does not say what would improve it`);
    }
    assert.ok(OBJECTIVES.availability.target > 0.9 && OBJECTIVES.availability.target < 1);
    assert.ok(OBJECTIVES.rpo.hours > 0);
    assert.ok(OBJECTIVES.rto.hours > 0);
});

test('the backup interval cannot promise less than the RPO', () => {
    // With full dumps and no continuous capture, the worst-case loss is exactly
    // the interval between them. An interval longer than the objective is an
    // objective that is breached by design rather than by incident.
    assert.ok(BACKUP_POLICY.intervalHours <= OBJECTIVES.rpo.hours);
});

test('every backed-up collection says why it cannot be rebuilt', () => {
    for (const entry of BACKUP_SET) {
        assert.ok(entry.because.length > 40, `${entry.collection} has no stated reason`);
        assert.ok(typeof entry.model().schema === 'object');
    }
    // An exclusion nobody wrote down is indistinguishable from an oversight.
    for (const entry of NOT_BACKED_UP) {
        assert.ok(entry.because.length > 40, `${entry.collection} is excluded with no reason`);
    }
});

test('the schema fingerprint changes when a backed-up schema changes', () => {
    const before = schemaFingerprint();
    Donation.schema.path('amountIdr');
    Donation.schema.add({ drillOnlyField: { type: String, default: null } });
    const after = schemaFingerprint();
    Donation.schema.remove('drillOnlyField');
    delete Donation.schema.paths.drillOnlyField;

    assert.notEqual(before, after);
    assert.equal(schemaFingerprint(), before);
});

test('a backup of an empty store fails rather than producing an empty archive', async () => {
    // The dangerous version of this is not an error: it is a clean exit against
    // the wrong database or the wrong authSource, repeated every six hours
    // until somebody needs the archive.
    const uri = await newStore();
    const out = newWorkspace();

    await assert.rejects(
        () => backup({ uri, out, log: quiet }),
        /every collection in the backup set is empty/,
    );
    // And it leaves nothing behind that could be mistaken for an archive.
    assert.deepEqual(fs.readdirSync(out), []);
});

test('an empty store can be backed up when the operator says the emptiness is expected', async () => {
    const uri = await newStore();
    const out = newWorkspace();
    const { manifest } = await backup({ uri, out, allowEmpty: true, log: quiet });
    assert.equal(manifest.documents, 0);
    assert.equal(manifest.collections.length, BACKUP_SET.length);
});

test('the drill: seeded data survives a backup and a restore into a clean database', async () => {
    const source = await newStore();
    const target = await newStore();
    const out = newWorkspace();

    const seeded = await seed(source);

    const { archive, manifest } = await backup({ uri: source, out, log: quiet });

    // The manifest identifies what it holds. A backup nobody can identify is a
    // backup nobody can trust to restore.
    assert.equal(manifest.documents, 3 + 2 + 1 + 2 + 1 + 1);
    assert.ok(manifest.takenAt);
    assert.equal(manifest.schemaFingerprint, schemaFingerprint());
    assert.ok(!manifest.source.includes('password'), 'the manifest must not carry credentials');

    const report = await restore({ from: archive, uri: target, log: quiet });
    assert.equal(report.verified.length, BACKUP_SET.length);
    assert.equal(report.schemaDrifted, false);

    // Verified independently of the restore's own report, because a restore
    // that checks itself and a restore that is checked are different claims.
    const connection = await mongoose.createConnection(target).asPromise();
    const restored = await connection.db
        .collection('donations')
        .find({})
        .sort({ dedupKey: 1 })
        .toArray();
    const emptyOnBothSides = await connection.db.collection('scoringevents').countDocuments();
    await connection.close();

    assert.equal(restored.length, 3);
    // Types, not just counts. A date that returns as a string and an amount
    // that returns as a different number are both restores that "worked".
    assert.ok(restored[0].occurredAt instanceof Date);
    assert.equal(restored[0].amountIdr, seeded.donations[0].amountIdr);
    assert.equal(String(restored[0].senderRef.entityId), String(seeded.senderId));
    assert.equal(restored[0].provenance.length, 1);
    assert.ok(restored[0].provenance[0].at instanceof Date);
    // A collection that was empty is restored empty rather than skipped.
    assert.equal(emptyOnBothSides, 0);
});

test('a restore into a store that already holds data is refused', async () => {
    const source = await newStore();
    const target = await newStore();
    const out = newWorkspace();

    await seed(source);
    const { archive } = await backup({ uri: source, out, log: quiet });
    await restore({ from: archive, uri: target, log: quiet });

    // Merging an archive into a live store produces something that is neither.
    await assert.rejects(
        () => restore({ from: archive, uri: target, log: quiet }),
        /refusing to restore into a store that already holds data/,
    );
});

test('a forced merge is reported as a merge, not as a short restore', async () => {
    const target = await newStore();
    const out = newWorkspace();

    const first = await newStore();
    await seed(first);
    const { archive: firstArchive } = await backup({ uri: first, out, log: quiet });
    await restore({ from: firstArchive, uri: target, log: quiet });

    // A different store's archive, so the documents do not collide and the
    // merge actually happens.
    const second = await newStore();
    await seed(second);
    const { archive: secondArchive } = await backup({ uri: second, out, log: quiet });

    // The counts differ for a reason that has nothing to do with the archive
    // being short, and calling it an incomplete restore would send somebody
    // looking at the wrong thing.
    await assert.rejects(
        () => restore({ from: secondArchive, uri: target, force: true, log: quiet }),
        /--force merged into collections that already held documents/,
    );
});

test('a tampered archive is refused before anything reaches the database', async () => {
    const source = await newStore();
    const target = await newStore();
    const out = newWorkspace();

    await seed(source);
    const { archive } = await backup({ uri: source, out, log: quiet });

    const donationsFile = path.join(archive, 'donations.jsonl');
    const lines = fs.readFileSync(donationsFile, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(donationsFile, `${lines.slice(0, 2).join('\n')}\n`);

    await assert.rejects(
        () => restore({ from: archive, uri: target, log: quiet }),
        (error) => {
            assert.ok(error instanceof RestoreIncomplete);
            assert.match(error.mismatches.join(' '), /donations.*checksum/);
            return true;
        },
    );

    // Nothing was written. A bad archive inserted into an empty store is harder
    // to recognise as a bad archive than one that never reached it.
    assert.equal(await countIn(target, 'donations'), 0);
});

test('a directory that is not an archive is refused by name', async () => {
    const target = await newStore();
    await assert.rejects(
        () => restore({ from: newWorkspace(), uri: target, log: quiet }),
        /has no manifest.json/,
    );
});

test('a partial restore is not reported as a recovery', async () => {
    const source = await newStore();
    const target = await newStore();
    const out = newWorkspace();

    await seed(source);
    const { archive } = await backup({ uri: source, out, log: quiet });
    await restore({ from: archive, uri: target, log: quiet });

    // One document lost after the fact, which is what a restore that dropped a
    // batch looks like from the outside.
    const connection = await mongoose.createConnection(target).asPromise();
    await connection.db.collection('donations').deleteOne({ dedupKey: 'seed-2' });
    await connection.close();

    await assert.rejects(
        () => verifyStore({ from: archive, uri: target }),
        (error) => {
            assert.ok(error instanceof RestoreIncomplete);
            assert.match(error.mismatches[0], /donations: 2 documents present, manifest says 3/);
            return true;
        },
    );
});

test('a store holding the right number of the wrong documents is not a recovery either', async () => {
    const source = await newStore();
    const target = await newStore();
    const out = newWorkspace();

    await seed(source);
    const { archive } = await backup({ uri: source, out, log: quiet });
    await restore({ from: archive, uri: target, log: quiet });

    // A count check alone passes this. The content digest is what does not.
    const connection = await mongoose.createConnection(target).asPromise();
    await connection.db
        .collection('donations')
        .updateOne({ dedupKey: 'seed-1' }, { $set: { amountIdr: 1 } });
    await connection.close();

    await assert.rejects(
        () => verifyStore({ from: archive, uri: target }),
        /content\s+does not match the archive|does not match the archive/,
    );
});

test('the backup records that it ran, so the RPO can be measured against it', async () => {
    const uri = await newStore();
    const out = newWorkspace();
    await seed(uri);
    await backup({ uri, out, log: quiet });

    // Read through the application's own connection, which is how the health
    // and metrics surfaces read it.
    await mongoose.connect(uri);
    try {
        const status = await rpoStatus();
        assert.equal(status.state, 'meeting');
        assert.equal(status.objectiveHours, OBJECTIVES.rpo.hours);
        assert.ok(status.ageHours < 1);

        // An RPO nobody can measure against is not an RPO: the age is reported
        // as a breach once it exceeds the objective, without anything else
        // having to change.
        const later = new Date(Date.now() + (OBJECTIVES.rpo.hours + 1) * 3_600_000);
        const breaching = await rpoStatus({ now: later });
        assert.equal(breaching.state, 'breaching');
        assert.match(breaching.reason, /objective/);

        const report = await resilienceReport();
        assert.equal(report.rpo.state, 'meeting');
        assert.ok(report.notCovered.length > 0);
    } finally {
        await mongoose.disconnect();
    }
});

test('a store that has never been backed up says so rather than reporting a breach', async () => {
    const uri = await newStore();
    await mongoose.connect(uri);
    try {
        const status = await rpoStatus();
        // Separated from `breaching` deliberately. A deployment that has never
        // taken a backup is a configuration that was never finished, not a
        // schedule that slipped, and the two call for different responses.
        assert.equal(status.state, 'never');
        assert.equal(status.lastBackupAt, null);
        assert.match(status.reason, /no backup has ever completed/);
    } finally {
        await mongoose.disconnect();
    }
});

test('a failed backup is recorded, so it is distinguishable from one never scheduled', async () => {
    const uri = await newStore();
    const out = newWorkspace();

    await assert.rejects(() => backup({ uri, out, log: quiet }));

    const connection = await mongoose.createConnection(uri).asPromise();
    const runs = await connection.db.collection(BACKUP_RUN_COLLECTION).find({}).toArray();
    await connection.close();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, 'failed');
    assert.match(runs[0].error, /empty/);
});

test('archives are not kept forever, and an unfinished one is not left to be restored', async () => {
    // An archive holds the same personal data the live store does. A schedule
    // running every six hours with nothing removing anything is the retention
    // problem relocated to a disk nobody watches.
    const uri = await newStore();
    const out = newWorkspace();
    await seed(uri);

    const old = new Date(Date.now() - (BACKUP_POLICY.archiveRetentionDays + 1) * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    await backup({ uri, out, now: old, log: quiet });
    await backup({ uri, out, now: recent, log: quiet });
    fs.mkdirSync(path.join(out, '20260101T000000Z.partial'));
    // Not ours, and not identifiable. Deleting what cannot be identified is how
    // a good archive goes missing.
    fs.mkdirSync(path.join(out, 'something-else'));

    const { pruned } = await backup({ uri, out, log: quiet });

    const left = fs.readdirSync(out).sort();
    assert.equal(pruned.length, 2);
    assert.ok(!left.some((name) => name.endsWith('.partial')));
    assert.ok(left.includes('something-else'));
    assert.ok(left.includes('20260101T000000Z.partial') === false);
    // The recent one and the run just taken.
    assert.equal(left.filter((name) => /^\d{8}T\d{6}Z$/.test(name)).length, 2);
});

test('pruning removes nothing when pointed at a directory of things it did not write', () => {
    const out = newWorkspace();
    fs.mkdirSync(path.join(out, 'holiday-photos'));
    fs.writeFileSync(path.join(out, 'notes.txt'), 'not an archive');

    const removed = pruneArchives({
        out,
        now: new Date('2099-01-01T00:00:00.000Z'),
        keepDays: 1,
        log: quiet,
    });

    assert.deepEqual(removed, []);
    assert.deepEqual(fs.readdirSync(out).sort(), ['holiday-photos', 'notes.txt']);
});

test('the declared objectives are scrapeable without reading the store', () => {
    // The scrape most worth having is the one taken during an incident, which
    // is when the database is the thing that is down. An alert comparing the
    // backup age against the objective needs both numbers to be present.
    const gauges = metrics.objectiveGauges();
    assert.equal(gauges.cakradana_rpo_objective_seconds, OBJECTIVES.rpo.hours * 3600);
    assert.equal(gauges.cakradana_rto_objective_seconds, OBJECTIVES.rto.hours * 3600);
    assert.equal(gauges.cakradana_availability_objective_ratio, OBJECTIVES.availability.target);
});

test('the age of the last backup is exposed as a metric', async () => {
    const uri = await newStore();
    const out = newWorkspace();
    await seed(uri);
    await backup({ uri, out, log: quiet });

    await mongoose.connect(uri);
    try {
        const scraped = await metrics.render();
        // The figure an alert watches. Without it the RPO is a number in a
        // file: an objective nothing measures cannot be breached, which is not
        // the same as being met.
        assert.match(scraped, /cakradana_backup_age_seconds \d+/);
        assert.match(scraped, /cakradana_backup_ever_completed 1/);
        assert.match(scraped, /cakradana_backup_last_success_timestamp_seconds \d+/);
        assert.match(scraped, /# HELP cakradana_backup_age_seconds /);
    } finally {
        await mongoose.disconnect();
    }
});

test('a store with no backup reports zero rather than omitting the series', async () => {
    // An absent series reads as a scrape that did not run. Zero reads as what
    // it is, and can be alerted on.
    const uri = await newStore();
    await mongoose.connect(uri);
    try {
        const scraped = await metrics.render();
        assert.match(scraped, /cakradana_backup_ever_completed 0/);
        assert.ok(!scraped.includes('cakradana_backup_age_seconds '));
    } finally {
        await mongoose.disconnect();
    }
});

test('readiness reports the recovery position and does not depend on it', async () => {
    const uri = await newStore();
    await mongoose.connect(uri);
    try {
        const response = fakeResponse();
        await health.ready({}, response);

        // Ready, with a store that has never been backed up. Withdrawing from
        // rotation over a stale backup would stop the ingestion whose records
        // are the thing at risk.
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.data.recovery.rpo_state, 'never');
        assert.equal(response.body.data.recovery.rpo_affects_readiness, false);
        assert.equal(response.body.data.recovery.rpo_hours, OBJECTIVES.rpo.hours);
        assert.equal(response.body.data.recovery.rto_hours, OBJECTIVES.rto.hours);
        assert.equal(
            response.body.data.recovery.availability_target,
            OBJECTIVES.availability.target,
        );
    } finally {
        await mongoose.disconnect();
    }
});

test('the monitoring endpoint serves the objectives with their reasoning and their limits', async () => {
    const uri = await newStore();
    const out = newWorkspace();
    await seed(uri);
    await backup({ uri, out, log: quiet });

    await mongoose.connect(uri);
    try {
        const response = fakeResponse();
        await monitoring.resilience({ query: {} }, response);

        assert.equal(response.statusCode, 200);
        const { data } = response.body;
        assert.equal(data.rpo.state, 'meeting');
        // The reasoning travels with the number. A dashboard showing "RPO 6h"
        // and nothing about what makes six defensible invites somebody to set
        // it to one.
        assert.ok(data.objectives.rpo.because.length > 80);
        assert.ok(data.notCovered.some((line) => /failover/.test(line)));
        assert.equal(data.backupSet.length, BACKUP_SET.length);
    } finally {
        await mongoose.disconnect();
    }
});

test('the run history is not carried into the store it was restored onto', async () => {
    const source = await newStore();
    const target = await newStore();
    const out = newWorkspace();

    await seed(source);
    const { archive } = await backup({ uri: source, out, log: quiet });
    await restore({ from: archive, uri: target, log: quiet });

    // Otherwise the restored store would report a recent successful backup of
    // itself, which is the one claim a recovery must not inherit.
    assert.equal(await countIn(target, BACKUP_RUN_COLLECTION), 0);

    // The restore is itself an access to personal data and is logged as one.
    const connection = await mongoose.createConnection(target).asPromise();
    const entries = await connection.db
        .collection('auditentries')
        .find({ action: 'restore-database' })
        .toArray();
    await connection.close();
    assert.equal(entries.length, 1);
});
