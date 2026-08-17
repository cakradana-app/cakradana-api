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
 *                          [--keep-days <n>] [--no-prune]
 *
 * `--out` names the parent directory; each run creates a timestamped archive
 * inside it. Defaults to `backups/` and to `MONGODB_URI` from the environment.
 * Archives past the retention period are removed after a successful run, since
 * an unbounded pile of copies of political-affiliation data is the problem the
 * retention policy exists to prevent, relocated to a disk nobody watches.
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const {
    BACKUP_POLICY,
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
    prune = true,
    keepDays = BACKUP_POLICY.archiveRetentionDays,
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
    const archive = freeArchivePath(out, archiveStamp(now));
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

        // Only after a good archive exists. Pruning first would, on a run that
        // then failed, leave fewer copies than before it started.
        const pruned = prune ? pruneArchives({ out, now, keepDays, log }) : [];

        log(`backup complete: ${total} documents in ${archive}`);
        return { archive, manifest, pruned };
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
 * An archive path nothing is using yet.
 *
 * The stamp is second-precision because a person reads it, and two runs within
 * the same second would otherwise land on the same directory: the second one
 * failed at the rename with ENOTEMPTY, after doing all its work. A scheduled
 * backup never hits this, which is precisely why it would have been discovered
 * by whoever ran a second one by hand during an incident.
 */
function freeArchivePath(out, stamp) {
    let candidate = path.join(out, stamp);
    for (let n = 2; fs.existsSync(candidate) || fs.existsSync(`${candidate}.partial`); n += 1) {
        candidate = path.join(out, `${stamp}-${n}`);
    }
    return candidate;
}

/**
 * Delete archives past the period they are kept for.
 *
 * An archive holds the same personal data the live store does and inherits the
 * same handling standard. Without this, a schedule running every six hours
 * accumulates an unbounded second copy of political-affiliation data on a disk
 * nobody is looking at, which is the failure the retention policy exists to
 * prevent, relocated.
 *
 * Two safeguards, because this deletes. Only directories inside the output
 * directory that carry a manifest this format wrote are considered, so pointing
 * `--out` at the wrong place removes nothing; and the age is taken from the
 * manifest rather than from the filesystem, since copying an archive resets
 * every timestamp on it. Interrupted runs are cleared on their directory name,
 * which is the one case with no manifest to read.
 */
function pruneArchives({ out, now, keepDays, log }) {
    const cutoff = now.getTime() - keepDays * 86_400_000;
    const removed = [];

    for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(out, entry.name);

        if (entry.name.endsWith('.partial')) {
            // A backup that did not finish. It is not an archive and never
            // becomes one, and leaving it invites somebody to restore it.
            fs.rmSync(directory, { recursive: true, force: true });
            removed.push(entry.name);
            continue;
        }

        const manifestPath = path.join(directory, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;

        let takenAt;
        try {
            takenAt = new Date(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).takenAt).getTime();
        } catch {
            // Unreadable rather than old. Left alone and reported: deleting
            // what cannot be identified is how a good archive goes missing.
            log(`  leaving ${entry.name}: its manifest could not be read`);
            continue;
        }
        if (Number.isFinite(takenAt) && takenAt < cutoff) {
            fs.rmSync(directory, { recursive: true, force: true });
            removed.push(entry.name);
        }
    }

    if (removed.length > 0) {
        log(`pruned ${removed.length} archive(s) older than ${keepDays} days`);
    }
    return removed;
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
        else if (arg === '--no-prune') args.prune = false;
        else if (arg === '--keep-days') args.keepDays = Number.parseInt(argv[++i], 10);
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

module.exports = { backup, pruneArchives, DEFAULT_OUT };
