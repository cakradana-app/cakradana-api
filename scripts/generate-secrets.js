/**
 * Generate the two identifier secrets, correctly shaped, in one command.
 *
 * The store refuses to hold a value without them, which is the right default
 * and also the reason a deployment ships without identifiers: two variables
 * nobody generated, and the system goes on working on a weaker basis without
 * an error anywhere. `.env.sample` names `openssl rand -hex 32` for the key,
 * which is correct and covers half of it — the pepper has a different
 * requirement, and the failure mode there is not an empty value but a plausible
 * one. `IDENTIFIER_PEPPER=cakradana` was accepted once. A NIK is sixteen digits
 * encoding a region and a date of birth, so its real space is small enough to
 * enumerate, and a guessable pepper leaves roughly ten thousand candidates per
 * target against a dumped collection.
 *
 * So this generates both, at the lengths the module requires, and prints them
 * in the form the environment file wants. It writes nothing: a script that
 * edits `.env` would eventually be run against one that already had a key, and
 * rotating the key without re-encrypting makes every stored identifier
 * unreadable — the same loss the AAD binding once caused, arrived at from the
 * other direction. What to do with the output is the operator's decision and
 * the consequences of getting it wrong are stated below it.
 */

const crypto = require('node:crypto');

const {
    MIN_PEPPER_LENGTH,
    configured,
} = require('../app/domains/identity/identifier.model');

// A 256-bit AES key, hex-encoded: 64 characters, which is what the module
// checks for.
const key = crypto.randomBytes(32).toString('hex');

// Comfortably past the minimum. The pepper is not a key in a cipher — it keys
// the HMAC that makes two records matchable without anybody reading a number —
// so length is the only property that matters and there is no cost to more.
const pepper = crypto.randomBytes(48).toString('base64url');

if (pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error('generated pepper is shorter than the module requires');
}

const already = configured();

process.stdout.write(`IDENTIFIER_KEY=${key}\nIDENTIFIER_PEPPER=${pepper}\n`);
process.stderr.write(
    '\n' +
        (already
            ? 'This environment already has both secrets set.\n\n' +
              'Replacing them is not a rotation. The key decrypts what is stored and\n' +
              'the pepper derives the hashes that match records to one person, so\n' +
              'changing either leaves every existing identifier unreadable and every\n' +
              'stored hash unmatchable — while the entity documents go on reporting\n' +
              'those parties as identified, because the surrogate does not change.\n' +
              'Re-encrypting the collection has to happen in the same operation.\n'
            : 'Put these in the environment this service reads, and nowhere a\n' +
              'backup of the database would also reach: holding the key beside the\n' +
              'ciphertext it opens is the same as not encrypting.\n\n' +
              'Until they are set, identifiers are refused and entity resolution\n' +
              'rests on names alone. GET /ready and the metrics endpoint both\n' +
              'report which state this deployment is in.\n'),
);
