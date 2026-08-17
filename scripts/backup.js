/**
 * Take a backup of everything that cannot be rebuilt.
 *
 * Written in Node against the driver rather than shelling out to `mongodump`,
 * so that a recovery does not depend on the database tools happening to be
 * installed on whichever host is available at the time. The same code is what
 * the restore drill exercises on every commit, which means the mechanism being
 * proven is the mechanism that will be used.
 *
 * Two rules shape the failure behaviour.
 *
 * It fails loudly rather than producing an empty archive. A dump that runs
 * cleanly against the wrong database, or against the right one with the wrong
 * `authSource`, produces zero documents and exits zero — and it keeps doing so
 * every six hours until somebody needs it. An empty archive is refused unless
 * the operator says the emptiness is expected.
 *
 * Nothing is left behind that looks complete but is not. The archive is written
 * to a `.partial` directory and renamed only after every collection has been
 * written and the manifest committed, so an interrupted run leaves something
 * obviously unfinished instead of something quietly short.
 *
 * Usage:
 *   node scripts/backup.js [--uri <mongodb-uri>] [--out <dir>] [--allow-empty]
 *
 * `--out` names the parent directory; each run creates a timestamped archive
 * inside it. Defaults to `backups/` and to `MONGODB_URI` from the environment.
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const {
    BACKUP_SET,
    BACKUP_RUN_COLLECTION,
    SCHEMA_VERSION,
    schemaFingerprint,
} = require('../app/domains/canonical/resilience');
const {
    MANIFEST_FORMAT,
    collectionDigest,
    encodeDocument,
    sha256,
    redactUri,
    archiveStamp,
} = require('./archive-format');

const DEFAULT_OUT = path.resolve(__dirname, '..', 'backups');

/**
 * Dump the backup set into a new archive directory.
 *
 * Returns the manifest it wrote, so a caller — the drill, or an operator's
 * script — can assert on what was captured rather than re-reading the disk to
 * find out.
 */
async function backup({
    uri = process.env.MONGODB_URI,
    out = DEFAULT_OUT,
    allowEmpty = false,
    now = new Date(),
    log = console.log,
} = {}) {
    if (!uri) {
        throw new Error(
            'no MongoDB URI: pass --uri or set MONGODB_URI. Refusing to guess, because ' +
            'a backup of the wrong database is worse than no backup',
        );
    }

    const startedAt = new Date();
    const archive = path.join(out, archiveStamp(now));
    const partial = `${archive}.partial`;

    const connection = await mongoose.createConnection(uri).asPromise();

    try {
        fs.mkdirSync(partial, { recursive: true });

        const collections = [];
        let total = 0;

        for (const entry of BACKUP_SET) {
            const documents = await connection.db
                .collection(entry.collection)
                .find({})
                .toArray();

            const file = `${entry.collection}.jsonl`;
            const body = documents.map(encodeDocument).join('\n');
            // A trailing newline on a non-empty file and an empty file for an
            // empty collection, so line count and document count agree without
            // a special case.
            const bytes = Buffer.from(documents.length ? `${body}\n` : '', 'utf8');
            fs.writeFileSync(path.join(partial, file), bytes);

            collections.push({
                collection: entry.collection,
                file,
                documents: documents.length,
                bytes: bytes.length,
                fileSha256: sha256(bytes),
                // Order-independent, so the restore can verify what landed
                // rather than only how much of it did.
                digest: collectionDigest(documents),
                because: entry.because,
            });
            total += documents.length;
            log(`  ${entry.collection}: ${documents.length} documents`);
        }

        if (total === 0 && !allowEmpty) {
            fs.rmSync(partial, { recursive: true, force: true });
            throw new Error(
                `every collection in the backup set is empty at ${redactUri(uri)}. This is ` +
                'almost always the wrong database or the wrong authSource rather than an ' +
                'empty system; pass --allow-empty if it really is empty',
            );
        }

        const manifest = {
            manifestFormat: MANIFEST_FORMAT,
            takenAt: now.toISOString(),
            source: redactUri(uri),
            schemaVersion: SCHEMA_VERSION,
            // Recorded alongside the declared version because a version somebody
            // has to remember to bump will be wrong at least once, and a restore
            // that can see the shape changed can say so.
            schemaFingerprint: schemaFingerprint(),
            documents: total,
            collections,
        };

        fs.writeFileSync(
            path.join(partial, 'manifest.json'),
            `${JSON.stringify(manifest, null, 4)}\n`,
        );

        // The archive becomes an archive here and not before.
        fs.renameSync(partial, archive);

        const completedAt = new Date();
        await recordRun(connection, {
            startedAt,
            completedAt,
            outcome: 'success',
            archive,
            documents: total,
            collections: collections.length,
            schemaVersion: SCHEMA_VERSION,
            schemaFingerprint: manifest.schemaFingerprint,
            durationMs: completedAt - startedAt,
            error: null,
        });

        log(`backup complete: ${total} documents in ${archive}`);
        return { archive, manifest };
    } catch (error) {
        fs.rmSync(partial, { recursive: true, force: true });
        // Recorded so that a run which failed is distinguishable from a run
        // that was never scheduled. Best-effort: if the database is what
        // failed, this cannot be written either, and the thrown error is then
        // the only report.
        await recordRun(connection, {
            startedAt,
            completedAt: null,
            outcome: 'failed',
            archive: null,
            documents: 0,
            collections: 0,
            schemaVersion: SCHEMA_VERSION,
            schemaFingerprint: null,
            durationMs: Date.now() - startedAt.getTime(),
            error: error.message,
        }).catch(() => {});
        throw error;
    } finally {
        await connection.close();
    }
}

/**
 * Write the run record through the raw collection.
 *
 * Deliberately not through the model: the script owns its own connection, and
 * binding a model registered on the default connection to it would work only
 * for as long as nothing else in the process had connected.
 */
async function recordRun(connection, run) {
    await connection.db.collection(BACKUP_RUN_COLLECTION).insertOne(run);
}

function parseArgs(argv) {
    const args = { allowEmpty: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--uri') args.uri = argv[++i];
        else if (arg === '--out') args.out = path.resolve(argv[++i]);
        else if (arg === '--allow-empty') args.allowEmpty = true;
        else throw new Error(`unrecognised argument: ${arg}`);
    }
    return args;
}

if (require.main === module) {
    backup(parseArgs(process.argv.slice(2)))
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(`backup failed: ${error.message}`);
            process.exit(1);
        });
}

module.exports = { backup, DEFAULT_OUT };
