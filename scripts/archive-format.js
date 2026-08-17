/**
 * The archive format, defined once.
 *
 * Backup and restore have to agree exactly on how a document is turned into
 * bytes and how those bytes are digested, because the whole verification story
 * rests on the two sides computing the same number for the same data. Two
 * implementations that agree today drift the first time one of them is
 * optimised, and the failure presents as "the restore is corrupt" rather than
 * as "the digest changed".
 *
 * Documents are written as extended JSON in canonical mode. Relaxed mode is
 * lossy in ways that matter here: a date becomes a string, and an integer and a
 * double become the same token. A donation amount that returns from a restore
 * as a different BSON type than it went in with is a donation whose comparison
 * against a statutory threshold may now behave differently.
 */

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;

/** The manifest layout. Bumped if a reader would misread an older manifest. */
const MANIFEST_FORMAT = 1;

/**
 * Sort object keys, recursively, without touching BSON values.
 *
 * Only plain objects are rewritten. An ObjectId, Date, Long, or Binary is
 * passed through as it is: they are values, not maps, and rebuilding them as
 * plain objects would lose the type the canonical encoding exists to preserve.
 */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== 'object') return value;
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;

    const sorted = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = canonicalize(value[key]);
    }
    return sorted;
}

/** One document's identity, independent of the order its fields were stored in. */
function documentDigest(doc) {
    return crypto
        .createHash('sha256')
        .update(EJSON.stringify(canonicalize(doc), { relaxed: false }))
        .digest('hex');
}

/**
 * A collection's identity, independent of the order its documents came back in.
 *
 * Order-independent on purpose. A restore inserts in batches and a later read
 * may return documents in a different order than the dump did; a digest that
 * depended on order would report corruption for a restore that is correct.
 */
function collectionDigest(documents) {
    const perDocument = documents.map(documentDigest).sort();
    return crypto.createHash('sha256').update(perDocument.join('\n')).digest('hex');
}

/** One document, as one line. */
function encodeDocument(doc) {
    return EJSON.stringify(doc, { relaxed: false });
}

function decodeDocument(line) {
    return EJSON.parse(line, { relaxed: false });
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * A connection string with its credentials removed.
 *
 * The manifest is written next to the data and is meant to be read by whoever
 * is recovering. It records which host and database the archive came from,
 * because an archive that cannot be identified cannot be trusted to restore —
 * and it records nothing that would put a password into an artefact that gets
 * copied around.
 */
function redactUri(uri) {
    try {
        const parsed = new URL(uri);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return 'unparseable-uri';
    }
}

/** `20260817T131200Z`, sortable and safe in a path. */
function archiveStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
    MANIFEST_FORMAT,
    canonicalize,
    documentDigest,
    collectionDigest,
    encodeDocument,
    decodeDocument,
    sha256,
    redactUri,
    archiveStamp,
};
