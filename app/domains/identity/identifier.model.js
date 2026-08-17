/**
 * Strong identifiers, held apart from everything that reads an entity.
 *
 * A NIK, an NPWP, a passport number: the values that make an attribution
 * certain, and the values whose disclosure is worst. They sat nowhere until
 * now — the entity carried a `valueRef` described as a surrogate with nothing
 * on the other end of it — which meant the system could not confirm an identity
 * it claimed to resolve, and meant the first person to need that capability
 * would have added a `value` field to the entity document and been done.
 *
 * That is the outcome this collection exists to make harder rather than
 * merely discouraged. Three things separate it from the rest of the store:
 *
 *   - It is its own collection, reached through one service that requires a
 *     role and records every read. Nothing joins it to an entity query.
 *   - The value is encrypted at rest, so a dump of this collection — a backup
 *     copied somewhere it should not be, a restore into a less careful
 *     environment — yields nothing without the key, which is not in it.
 *   - Matching happens on a keyed hash rather than the value, so "is this the
 *     same person" can be answered without anybody reading a number. An
 *     unkeyed hash would not do: a NIK is sixteen digits encoding a region and
 *     a date of birth, so its real space is small enough to enumerate.
 *
 * Both secrets are required. Absent, the store refuses to admit a value rather
 * than falling back to holding it in the clear — a failure to protect
 * something must not present as having stored it safely.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * The identifier schemes this system recognises.
 *
 * Closed, because an unrecognised scheme is a value nobody has decided the
 * handling rules for, and the handling rules are the entire point here.
 */
const IDENTIFIER_SCHEMES = Object.freeze([
    'nik',
    'npwp',
    'passport',
    'company-registration',
    'party-registration',
]);

//: The shape of a surrogate. Fixed so the entity document can refuse anything
//: that is not one — a raw identifier stuffed into `valueRef` would otherwise
//: be indistinguishable from a reference to this collection, and would sit in
//: the entity store being read by everything.
const SURROGATE_PATTERN = /^idref_[0-9a-f]{32}$/;

function newSurrogate() {
    return `idref_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Normalise before hashing, so two spellings of one number match.
 *
 * Punctuation in an NPWP is presentational and a NIK is sometimes spaced. Two
 * records of the same identifier that hash differently are two identities, and
 * the whole purpose of holding these is that they are not.
 */
function normaliseValue(value) {
    return String(value ?? '')
        .replace(/[^0-9a-zA-Z]/g, '')
        .toUpperCase();
}

class IdentifierSecretsMissing extends Error {
    constructor(missing) {
        super(
            `Identifier storage is not configured: ${missing.join(' and ')} must be ` +
                'set. Values are refused rather than stored unprotected.',
        );
        this.name = 'IdentifierSecretsMissing';
        this.missing = missing;
    }
}

/**
 * The two secrets, or a refusal naming what is absent.
 *
 * Read per call rather than at import, so a process can be started, told what
 * it is missing, and given it — rather than crashing at load with a stack
 * trace in place of an explanation.
 */
function secrets() {
    const pepper = process.env.IDENTIFIER_PEPPER || '';
    const key = process.env.IDENTIFIER_KEY || '';
    const missing = [];
    if (!pepper) missing.push('IDENTIFIER_PEPPER');
    // A 256-bit key, hex-encoded. Checked for length here rather than left to
    // fail inside the cipher, where the message names a buffer size.
    if (!/^[0-9a-fA-F]{64}$/.test(key)) missing.push('IDENTIFIER_KEY (64 hex characters)');
    if (missing.length) throw new IdentifierSecretsMissing(missing);
    return { pepper, key: Buffer.from(key, 'hex') };
}

/** Whether a value could be stored, without throwing to find out. */
function configured() {
    try {
        secrets();
        return true;
    } catch {
        return false;
    }
}

/**
 * The lookup hash for a value.
 *
 * Keyed, and scoped by scheme so a number that is valid under two schemes does
 * not collide across them.
 */
function lookupHash(scheme, value) {
    const { pepper } = secrets();
    return crypto
        .createHmac('sha256', pepper)
        .update(`${scheme}:${normaliseValue(value)}`)
        .digest('hex');
}

function encrypt(value) {
    const { key } = secrets();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(normaliseValue(value), 'utf8'),
        cipher.final(),
    ]);
    return {
        iv: iv.toString('hex'),
        ciphertext: ciphertext.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
    };
}

function decrypt(record) {
    const { key } = secrets();
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(record.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
    // Throws on a tampered record rather than returning altered plaintext,
    // which is the point of the authenticated mode: an identifier silently
    // changed underneath is an attribution moved to somebody else.
    return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'hex')),
        decipher.final(),
    ]).toString('utf8');
}

const identifierSchema = new mongoose.Schema(
    {
        // What the entity document holds. The only thing that crosses the
        // boundary.
        valueRef: {
            type: String,
            required: true,
            unique: true,
            default: newSurrogate,
            match: SURROGATE_PATTERN,
        },
        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Entity',
            required: true,
        },
        scheme: { type: String, enum: IDENTIFIER_SCHEMES, required: true },

        // Equality without disclosure.
        lookupHash: { type: String, required: true },

        iv: { type: String, required: true },
        ciphertext: { type: String, required: true },
        tag: { type: String, required: true },

        // Whether the value was checked against the issuing register, as
        // opposed to merely recorded. An unvalidated identifier is somebody's
        // claim about themselves.
        validated: { type: Boolean, default: false },
        validatedAgainst: { type: String, default: null },

        recordedBy: { type: String, required: true },
    },
    { timestamps: true },
);

// Scoped by scheme, because the same digits under two schemes are two
// identifiers.
identifierSchema.index({ scheme: 1, lookupHash: 1 });
identifierSchema.index({ entityId: 1 });

const EntityIdentifier = mongoose.model('EntityIdentifier', identifierSchema);

module.exports = {
    EntityIdentifier,
    IDENTIFIER_SCHEMES,
    IdentifierSecretsMissing,
    SURROGATE_PATTERN,
    newSurrogate,
    normaliseValue,
    lookupHash,
    encrypt,
    decrypt,
    configured,
    secrets,
};
