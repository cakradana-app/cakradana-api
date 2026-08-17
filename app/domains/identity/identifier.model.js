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

//: The shortest pepper worth having. `openssl rand -hex 32` gives 64; this is
//: low enough not to reject a reasonable passphrase and high enough to refuse
//: a word.
const MIN_PEPPER_LENGTH = 32;

//: What each scheme's value has to look like. A scheme with no pattern is
//: accepted on length alone; a NIK is sixteen digits and saying so stops a
//: placeholder being recorded as one.
const SCHEME_PATTERNS = Object.freeze({
    nik: /^[0-9]{16}$/,
    npwp: /^[0-9]{15,16}$/,
});

//: Below this, a normalised value is not an identifier. `"-"` normalises to the
//: empty string and `"N/A"` to `"NA"`, and both were accepted — so two
//: unrelated people recorded with the same placeholder collided, and the
//: collision is reported as the strongest evidence that two records are one
//: party.
const MIN_VALUE_LENGTH = 6;

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

class IdentifierRejected extends Error {
    constructor(message) {
        super(message);
        this.name = 'IdentifierRejected';
    }
}

/**
 * Check a value is an identifier before anything is derived from it.
 *
 * Run against the normalised form, because that is what gets hashed and stored:
 * checking the raw value would accept `"-"`, which normalises to nothing.
 */
function validateValue(scheme, value) {
    const normalised = normaliseValue(value);
    if (normalised.length < MIN_VALUE_LENGTH) {
        throw new IdentifierRejected(
            `this is not a ${scheme}: it carries fewer than ${MIN_VALUE_LENGTH} ` +
                'identifying characters. A placeholder recorded as an identifier ' +
                'collides with every other placeholder, and a collision is reported ' +
                'as evidence that two records are the same party.',
        );
    }
    const pattern = SCHEME_PATTERNS[scheme];
    if (pattern && !pattern.test(normalised)) {
        throw new IdentifierRejected(
            `this does not have the form of a ${scheme}`,
        );
    }
    return normalised;
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
    // Checked for length, not merely presence. The key protects the plaintext;
    // the pepper is the only thing standing between a dumped collection and the
    // enumeration this module exists to prevent — a NIK encodes a region and a
    // date of birth, so a guessable pepper leaves roughly ten thousand
    // candidates per target. `IDENTIFIER_PEPPER=cakradana` was accepted.
    if (pepper.length < MIN_PEPPER_LENGTH) {
        missing.push(`IDENTIFIER_PEPPER (at least ${MIN_PEPPER_LENGTH} characters)`);
    }
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

/**
 * What a ciphertext is bound to.
 *
 * GCM authenticates the ciphertext and not the document it sits in, so without
 * this, `iv`, `ciphertext` and `tag` copied from one record onto another
 * decrypt cleanly: reading Bob's surrogate returns Alice's number, and the
 * disclosure is recorded against Bob. Binding the surrogate makes that
 * substitution fail closed, because the surrogate is unique per record and a
 * copy therefore lands under a different one.
 *
 * The entity is deliberately NOT bound, though it was at first. Binding it made
 * the ciphertext unreadable the moment the record moved between entities — and
 * a merge moves it, which is a routine supported operation on exactly the
 * near-duplicate names this data produces. The key stayed intact and the
 * plaintext became unrecoverable, in the collection whose entire purpose is the
 * values that make an attribution certain. It also failed silently in the worst
 * way: `lookupHash` does not involve the entity, so `/match` and
 * `/entity/:id` went on reporting the party as identified.
 *
 * Binding an attribute that legitimately changes turns every legitimate change
 * into data loss. The surrogate never changes, which is what makes it the right
 * thing to bind.
 */
function context({ valueRef, scheme }) {
    return Buffer.from(`${valueRef}|${scheme}`, 'utf8');
}

function encrypt(value, binding) {
    const { key } = secrets();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context(binding));
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
    decipher.setAAD(context(record));
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
// Unique, and enforced by the database rather than by a read followed by a
// write. The controller checks for a collision first so it can explain one, but
// two mints of the same number arriving together both saw no existing record
// and both succeeded — leaving two entities separately identified by one
// identifier, which is the opposite of what holding it establishes.
identifierSchema.index({ scheme: 1, lookupHash: 1 }, { unique: true });
identifierSchema.index({ entityId: 1 });

const EntityIdentifier = mongoose.model('EntityIdentifier', identifierSchema);

module.exports = {
    EntityIdentifier,
    IDENTIFIER_SCHEMES,
    IdentifierSecretsMissing,
    IdentifierRejected,
    MIN_PEPPER_LENGTH,
    MIN_VALUE_LENGTH,
    validateValue,
    context,
    SURROGATE_PATTERN,
    newSurrogate,
    normaliseValue,
    lookupHash,
    encrypt,
    decrypt,
    configured,
    secrets,
};
