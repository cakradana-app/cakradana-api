/**
 * Restore an archive, and prove that it landed.
 *
 * A restore that reports success without checking is the failure mode this
 * script exists to remove. Insert calls that returned no error still leave a
 * short collection when a file was truncated, when a batch hit a duplicate key,
 * or when the archive was copied while it was still being written — and the
 * difference between a complete recovery and one missing four hundred donations
 * is invisible at the console. So the manifest is checked twice: the files are
 * verified against it before anything is written, and what actually landed in
 * the database is verified against it afterwards. Any mismatch is a failure,
 * not a warning.
 *
 * The archive carries documents, not indexes. Indexes are declared in the
 * schemas and built by the application when it starts against the restored
 * store, so the first minutes after a restore are slower rather than wrong.
 *
 * Retention runs against the live store, not against archives. Restoring an
 * archive taken before a retention sweep reinstates the records that sweep
 * deleted, so the procedure ends by re-running retention — this script says so
 * on completion rather than assuming whoever is recovering at 3am remembers.
 *
 * Usage:
 *   node scripts/restore.js --from <archive-dir> [--uri <mongodb-uri>] [--force]
 *
 * `--force` permits restoring into collections that already hold documents.
 * Without it a non-empty target is refused, because merging an archive into a
 * live store produces something that is neither the archive nor the store.
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const { BACKUP_RUN_COLLECTION, SCHEMA_VERSION, schemaFingerprint } = require('../app/domains/canonical/resilience');
const {
    MANIFEST_FORMAT,
    collectionDigest,
    decodeDocument,
    sha256,
} = require('./archive-format');

/** Bounded so one insert call is not the size of the whole collection. */
const BATCH = 500;

class RestoreIncomplete extends Error {
    constructor(message, mismatches) {
        super(message);
        this.name = 'RestoreIncomplete';
        this.mismatches = mismatches;
    }
}

/**
 * Read the manifest and check every file against it.
 *
 * Done before a connection is opened. An archive that fails this check must not
 * reach the database at all: a half-written file inserted into an empty store
 * is harder to recognise as a bad archive than one that was never inserted.
 */
function verifyArchive(from) {
    const manifestPath = path.join(from, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(
            `${from} has no manifest.json. An archive that cannot identify itself cannot ` +
            'be trusted to restore; if this is a `.partial` directory, the backup that ' +
            'produced it did not finish',
        );
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.manifestFormat !== MANIFEST_FORMAT) {
        throw new Error(
            `manifest format ${manifest.manifestFormat}, expected ${MANIFEST_FORMAT}`,
        );
    }

    const mismatches = [];
    const contents = new Map();

    for (const entry of manifest.collections) {
        const file = path.join(from, entry.file);
        if (!fs.existsSync(file)) {
            mismatches.push(`${entry.collection}: ${entry.file} is missing from the archive`);
            continue;
        }
        const bytes = fs.readFileSync(file);
        if (sha256(bytes) !== entry.fileSha256) {
            mismatches.push(
                `${entry.collection}: ${entry.file} does not match its recorded checksum`,
            );
            continue;
        }
        const lines = bytes.toString('utf8').split('\n').filter((line) => line.length > 0);
        if (lines.length !== entry.documents) {
            mismatches.push(
                `${entry.collection}: ${lines.length} lines, manifest says ${entry.documents}`,
            );
            continue;
        }
        contents.set(entry.collection, lines.map(decodeDocument));
    }

    if (mismatches.length > 0) {
        throw new RestoreIncomplete(
            `the archive at ${from} does not match its manifest`,
            mismatches,
        );
    }

    return { manifest, contents };
}

/**
 * Compare what a store actually holds against what an archive says it should.
 *
 * Counts and content, because they fail differently. A short collection is a
 * restore that dropped documents; a full collection with a different digest is
 * a restore that wrote different ones — most likely from a different archive
 * than the one being checked against.
 */
async function checkStore(connection, manifest) {
    const verified = [];
    const mismatches = [];

    for (const entry of manifest.collections) {
        const landed = await connection.db.collection(entry.collection).find({}).toArray();
        const digest = collectionDigest(landed);
        if (landed.length !== entry.documents) {
            mismatches.push(
                `${entry.collection}: ${landed.length} documents present, manifest says ${entry.documents}`,
            );
        } else if (digest !== entry.digest) {
            mismatches.push(
                `${entry.collection}: ${landed.length} documents present but their content ` +
                'does not match the archive',
            );
        } else {
            verified.push({ collection: entry.collection, documents: landed.length, digest });
        }
    }

    return { verified, mismatches };
}

/**
 * Check a store against an archive without writing to either.
 *
 * The drill uses it, and so does anyone asking the question a restore is
 * supposed to answer some time after the restore ran: is this store still the
 * recovery it claimed to be.
 */
async function verifyStore({ from, uri = process.env.MONGODB_URI } = {}) {
    const { manifest } = verifyArchive(from);
    const connection = await mongoose.createConnection(uri).asPromise();
    try {
        const { verified, mismatches } = await checkStore(connection, manifest);
        if (mismatches.length > 0) {
            throw new RestoreIncomplete(
                `the store does not match the archive at ${from}`,
                mismatches,
            );
        }
        return { manifest, verified };
    } finally {
        await connection.close();
    }
}

/**
 * Restore, then verify against the manifest.
 *
 * Returns a report naming every collection and the count and digest that were
 * confirmed. Throws `RestoreIncomplete` rather than returning a partial result:
 * a caller that has to remember to inspect a field to learn the restore did not
 * work will eventually forget.
 */
async function restore({
    from,
    uri = process.env.MONGODB_URI,
    force = false,
    actor = 'operator',
    log = console.log,
} = {}) {
    if (!from) throw new Error('no archive: pass --from <archive-dir>');
    if (!uri) throw new Error('no MongoDB URI: pass --uri or set MONGODB_URI');

    const { manifest, contents } = verifyArchive(from);
    log(`archive verified: ${manifest.documents} documents taken at ${manifest.takenAt}`);

    // Reported, never fatal. An archive from an older schema is exactly what a
    // recovery from an old backup restores, and refusing it would leave the
    // operator with a verified archive and no way to use it.
    const currentFingerprint = schemaFingerprint();
    const schemaDrifted =
        manifest.schemaVersion !== SCHEMA_VERSION ||
        manifest.schemaFingerprint !== currentFingerprint;
    if (schemaDrifted) {
        log(
            `warning: the archive was taken under schema ${manifest.schemaVersion}/` +
            `${manifest.schemaFingerprint} and this code declares ${SCHEMA_VERSION}/` +
            `${currentFingerprint}. The documents will restore; whether every field still ` +
            'means what it did is a question for whoever changed the schema',
        );
    }

    const connection = await mongoose.createConnection(uri).asPromise();

    try {
        const occupied = [];
        for (const entry of manifest.collections) {
            const existing = await connection.db.collection(entry.collection).countDocuments();
            if (existing > 0) occupied.push(`${entry.collection} (${existing} documents)`);
        }
        if (occupied.length > 0 && !force) {
            throw new Error(
                `refusing to restore into a store that already holds data: ${occupied.join(', ')}. ` +
                'Merging an archive into a live store produces something that is neither ' +
                'the archive nor the store; pass --force if that is genuinely what is wanted',
            );
        }

        for (const entry of manifest.collections) {
            const documents = contents.get(entry.collection);
            const target = connection.db.collection(entry.collection);
            for (let i = 0; i < documents.length; i += BATCH) {
                await target.insertMany(documents.slice(i, i + BATCH), { ordered: true });
            }
            log(`  ${entry.collection}: ${documents.length} documents inserted`);
        }

        // What is checked here is the database, not the archive: the archive was
        // already checked, and re-checking it would prove nothing about the
        // restore.
        const { verified, mismatches } = await checkStore(connection, manifest);

        if (mismatches.length > 0) {
            throw new RestoreIncomplete(
                'the restore is incomplete and must not be treated as a recovery',
                mismatches,
            );
        }

        await connection.db.collection('auditentries').insertOne({
            actor,
            action: 'restore-database',
            subjectType: 'Backup',
            subjectId: manifest.takenAt,
            outcome: 'allowed',
            reason: `restored ${manifest.documents} documents from ${from}`,
            at: new Date(),
        });

        // The run history describes the store that was backed up, not this one.
        // Left empty so the next reading of the RPO reports `never` — which is
        // true of the restored store until it has been backed up itself.
        await connection.db.collection(BACKUP_RUN_COLLECTION).deleteMany({});

        log(`restore verified: ${manifest.documents} documents across ${verified.length} collections`);
        log(
            'next: start the application so it builds the declared indexes, and run the ' +
            'retention pass. This archive may predate a retention sweep, in which case the ' +
            'restore has reinstated records that sweep deleted.',
        );

        return { manifest, verified, schemaDrifted };
    } finally {
        await connection.close();
    }
}

function parseArgs(argv) {
    const args = { force: false, verifyOnly: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--from') args.from = path.resolve(argv[++i]);
        else if (arg === '--uri') args.uri = argv[++i];
        else if (arg === '--force') args.force = true;
        else if (arg === '--verify-only') args.verifyOnly = true;
        else if (arg === '--actor') args.actor = argv[++i];
        else throw new Error(`unrecognised argument: ${arg}`);
    }
    return args;
}

if (require.main === module) {
    const args = parseArgs(process.argv.slice(2));
    (args.verifyOnly ? verifyStore(args) : restore(args))
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(`restore failed: ${error.message}`);
            for (const mismatch of error.mismatches || []) console.error(`  ${mismatch}`);
            console.error(
                'The store is not a recovery of this archive. Do not put it into service.',
            );
            process.exit(1);
        });
}

module.exports = { restore, verifyArchive, verifyStore, RestoreIncomplete };
