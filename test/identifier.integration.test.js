/**
 * Strong identifiers, and the boundary around them.
 *
 * The entity document has always carried a `valueRef` described as "a
 * surrogate reference, never the identifier itself". Nothing was on the other
 * end of it: no collection held a value, so the system could not confirm an
 * identity it claimed to resolve, and the first person who needed to would
 * have added a `value` field beside the surrogate and been finished in a
 * minute. The comment was the whole of the protection.
 *
 * What is tested here is that the boundary is now structural. The entity
 * schema refuses anything that is not a surrogate, so putting a NIK where the
 * reference goes fails rather than succeeds quietly. The values live in their
 * own collection, encrypted, reachable through one service that records every
 * read. And matching two records to one person happens on a keyed hash, so the
 * common operation is not a disclosure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const { Entity } = require('../app/domains/canonical/canonical.model');
const { AuditEntry } = require('../app/domains/canonical/retention');
const {
    EntityIdentifier,
    lookupHash,
    normaliseValue,
    encrypt,
    decrypt,
    configured,
} = require('../app/domains/identity/identifier.model');
const controller = require('../app/domains/identity/identifier.controller');
const { normaliseName } = require('../app/domains/canonical/resolution');

useDatabase();

const ACTOR = 'analyst@cakradana.faizath.com';
const NIK = '3174012509900001';
const BINDING = { valueRef: `idref_${'1'.repeat(32)}`, entityId: '507f1f77bcf86cd799439011', scheme: 'nik' };

//: A key and pepper for the tests. Set per test rather than globally so the
//: unconfigured behaviour is reachable, which is the branch that matters most.
const KEY = 'a'.repeat(64);
//: Long enough to satisfy the minimum, which exists because the pepper is
//: the only thing standing between a dumped collection and enumeration.
const PEPPER = 'test-pepper-'.repeat(4);

function withSecrets(run) {
    const key = process.env.IDENTIFIER_KEY;
    const pepper = process.env.IDENTIFIER_PEPPER;
    process.env.IDENTIFIER_KEY = KEY;
    process.env.IDENTIFIER_PEPPER = PEPPER;
    const restore = () => {
        if (key === undefined) delete process.env.IDENTIFIER_KEY;
        else process.env.IDENTIFIER_KEY = key;
        if (pepper === undefined) delete process.env.IDENTIFIER_PEPPER;
        else process.env.IDENTIFIER_PEPPER = pepper;
    };
    return Promise.resolve()
        .then(run)
        .finally(restore);
}

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

async function makeEntity(name = 'Budi Santoso', extra = {}) {
    return Entity.create({
        canonicalName: name,
        normalisedName: normaliseName(name),
        ...extra,
    });
}

async function mint(body) {
    const res = reply();
    await controller.mint({ body, user: { email: ACTOR } }, res);
    return res.sent;
}

test('the entity document refuses an identifier value where the reference goes', async () => {
    // The defect this collection exists to prevent, made unreachable. The
    // field took any string, so "never the identifier itself" was a paragraph
    // somebody with a deadline reads past.
    const entity = await makeEntity();
    entity.identifiers.push({ scheme: 'nik', valueRef: NIK });
    await assert.rejects(() => entity.save(), /must be a surrogate/);

    const reread = await Entity.findById(entity._id).lean();
    assert.equal(reread.identifiers.length, 0);
});

test('the entity document accepts a surrogate', async () => {
    const entity = await makeEntity();
    entity.identifiers.push({ scheme: 'nik', valueRef: `idref_${'0'.repeat(32)}` });
    await entity.save();
    const reread = await Entity.findById(entity._id).lean();
    assert.equal(reread.identifiers.length, 1);
});

test('a recorded identifier puts only its surrogate on the entity', async () =>
    withSecrets(async () => {
        const entity = await makeEntity();
        const sent = await mint({ entity_id: String(entity._id), scheme: 'nik', value: NIK });

        assert.equal(sent.status, 201);
        assert.match(sent.body.data.value_ref, /^idref_[0-9a-f]{32}$/);

        const reread = await Entity.findById(entity._id).lean();
        assert.equal(reread.identifiers.length, 1);
        assert.equal(reread.identifiers[0].valueRef, sent.body.data.value_ref);

        // The number appears nowhere in the entity document, under any key.
        assert.equal(
            JSON.stringify(reread).includes(NIK),
            false,
            'the identifier value reached the entity document',
        );
    }));

test('the value is not readable from the identifier collection either', async () =>
    withSecrets(async () => {
        // A dump of this collection — a backup copied somewhere it should not
        // be, a restore into a less careful environment — has to yield
        // nothing without the key, which is not in it.
        const entity = await makeEntity();
        await mint({ entity_id: String(entity._id), scheme: 'nik', value: NIK });

        const stored = await EntityIdentifier.findOne({}).lean();
        assert.equal(
            JSON.stringify(stored).includes(NIK),
            false,
            'the identifier value is stored in the clear',
        );
        assert.ok(stored.ciphertext && stored.iv && stored.tag);
    }));

test('the lookup hash does not contain the value and is keyed', async () =>
    withSecrets(async () => {
        // An unkeyed hash would not do. A NIK is sixteen digits encoding a
        // region and a date of birth, so its real space is small enough to
        // enumerate against a hash somebody has.
        const withPepper = lookupHash('nik', NIK);
        process.env.IDENTIFIER_PEPPER = 'a-different-pepper-'.repeat(3);
        const withAnother = lookupHash('nik', NIK);
        process.env.IDENTIFIER_PEPPER = PEPPER;

        assert.notEqual(withPepper, withAnother);
        assert.equal(withPepper.includes(NIK), false);
    }));

test('the same number under two schemes does not collide', async () =>
    withSecrets(() => {
        assert.notEqual(lookupHash('nik', NIK), lookupHash('npwp', NIK));
    }));

test('presentational punctuation does not make one identifier into two', async () =>
    withSecrets(() => {
        // An NPWP is usually written with dots and dashes and a NIK is
        // sometimes spaced. Two records of one number that hash differently
        // are two identities, which is the opposite of what these are for.
        assert.equal(normaliseValue('01.234.567.8-901.000'), '012345678901000');
        assert.equal(
            lookupHash('npwp', '01.234.567.8-901.000'),
            lookupHash('npwp', '012345678901000'),
        );
    }));

test('a value survives the round trip exactly', async () =>
    withSecrets(() => {
        assert.equal(decrypt({ ...BINDING, ...encrypt(NIK, BINDING) }), NIK);
    }));

test('a tampered record is refused rather than decrypted to something else', async () =>
    withSecrets(() => {
        // The point of the authenticated mode. An identifier silently changed
        // underneath is an attribution moved to somebody else.
        const sealed = { ...BINDING, ...encrypt(NIK, BINDING) };
        const flipped = { ...sealed };
        flipped.ciphertext =
            (flipped.ciphertext[0] === 'a' ? 'b' : 'a') + flipped.ciphertext.slice(1);
        assert.throws(() => decrypt(flipped));
    }));

test('reading a value requires a reason and records the disclosure', async () =>
    withSecrets(async () => {
        const entity = await makeEntity();
        const minted = await mint({
            entity_id: String(entity._id),
            scheme: 'nik',
            value: NIK,
        });

        const refused = reply();
        await controller.reveal(
            { params: { ref: minted.body.data.value_ref }, body: {}, user: { email: ACTOR } },
            refused,
        );
        assert.equal(refused.sent.status, 400);
        assert.match(refused.sent.body.message, /reason is required/);

        const allowed = reply();
        await controller.reveal(
            {
                params: { ref: minted.body.data.value_ref },
                body: { reason: 'confirming an over-limit finding before it is served' },
                user: { email: ACTOR },
            },
            allowed,
        );
        assert.equal(allowed.sent.status, 200);
        assert.equal(allowed.sent.body.data.value, NIK);

        const disclosure = await AuditEntry.findOne({ action: 'read-identifier' }).lean();
        assert.ok(disclosure, 'a value was read and nothing recorded it');
        assert.equal(disclosure.actor, ACTOR);
        assert.equal(String(disclosure.subjectId), String(entity._id));
        assert.match(disclosure.reason, /over-limit finding/);
    }));

test('a read of an identifier that does not exist is recorded too', async () =>
    withSecrets(async () => {
        // Otherwise the log answers "which reads succeeded" rather than "who
        // went looking", and somebody probing surrogates leaves no trace.
        const res = reply();
        await controller.reveal(
            {
                params: { ref: `idref_${'f'.repeat(32)}` },
                body: { reason: 'checking' },
                user: { email: ACTOR },
            },
            res,
        );
        assert.equal(res.sent.status, 404);
        const attempt = await AuditEntry.findOne({ action: 'read-identifier' }).lean();
        assert.equal(attempt.outcome, 'denied');
    }));

test('matching answers the question without returning the value', async () =>
    withSecrets(async () => {
        // Deciding whether two records describe one person is the common
        // operation. Keeping it in the same call as reading would make every
        // match a disclosure.
        const entity = await makeEntity();
        await mint({ entity_id: String(entity._id), scheme: 'nik', value: NIK });

        const res = reply();
        await controller.match(
            { body: { scheme: 'nik', value: NIK }, user: { email: ACTOR } },
            res,
        );

        assert.equal(res.sent.data, undefined);
        assert.equal(res.sent.body.data.known, true);
        assert.equal(String(res.sent.body.data.entity_id), String(entity._id));
        assert.equal(res.sent.body.data.value_returned, false);
        assert.equal(JSON.stringify(res.sent.body).includes(NIK), false);
    }));

test('an unknown identifier is reported as unknown, not as an error', async () =>
    withSecrets(async () => {
        const res = reply();
        await controller.match(
            { body: { scheme: 'nik', value: '9999999999999999' }, user: { email: ACTOR } },
            res,
        );
        assert.equal(res.sent.status, 200);
        assert.equal(res.sent.body.data.known, false);
        assert.equal(res.sent.body.data.entity_id, null);
    }));

test('the same identifier on a second entity is a resolution decision, not a second record', async () =>
    withSecrets(async () => {
        // The strongest evidence this system can have that two records are one
        // person. Recording it twice would destroy that evidence by making
        // both look separately identified.
        const first = await makeEntity('Budi Santoso');
        const second = await makeEntity('Budi Santosa');
        await mint({ entity_id: String(first._id), scheme: 'nik', value: NIK });

        const sent = await mint({
            entity_id: String(second._id),
            scheme: 'nik',
            value: NIK,
        });
        assert.equal(sent.status, 409);
        assert.equal(String(sent.body.data.other_entity_id), String(first._id));
        assert.equal(await EntityIdentifier.countDocuments({}), 1);

        const flagged = await AuditEntry.findOne({ action: 'identifier-collision' }).lean();
        assert.ok(flagged, 'a collision was refused and nothing recorded it');
    }));

test('recording the same identifier twice for one entity is idempotent', async () =>
    withSecrets(async () => {
        const entity = await makeEntity();
        const first = await mint({
            entity_id: String(entity._id),
            scheme: 'nik',
            value: NIK,
        });
        const again = await mint({
            entity_id: String(entity._id),
            scheme: 'nik',
            value: '3174 0125 0990 0001',
        });

        assert.equal(again.status, 200);
        assert.equal(again.body.data.created, false);
        assert.equal(again.body.data.value_ref, first.body.data.value_ref);
        assert.equal(await EntityIdentifier.countDocuments({}), 1);
    }));

test('an identifier is refused for an entity that was merged away', async () =>
    withSecrets(async () => {
        const survivor = await makeEntity('Budi Santoso');
        const absorbed = await makeEntity('Budi Santosa', { mergedInto: survivor._id });

        const sent = await mint({
            entity_id: String(absorbed._id),
            scheme: 'nik',
            value: NIK,
        });
        assert.equal(sent.status, 409);
        assert.equal(await EntityIdentifier.countDocuments({}), 0);
    }));

test('without the secrets a value is refused, not stored unprotected', async () => {
    // The branch that matters most. A failure to protect something must not
    // present as having stored it safely.
    const key = process.env.IDENTIFIER_KEY;
    const pepper = process.env.IDENTIFIER_PEPPER;
    delete process.env.IDENTIFIER_KEY;
    delete process.env.IDENTIFIER_PEPPER;
    try {
        assert.equal(configured(), false);
        const entity = await makeEntity();
        const sent = await mint({ entity_id: String(entity._id), scheme: 'nik', value: NIK });

        assert.equal(sent.status, 503);
        assert.deepEqual(sent.body.data.missing.sort(), [
            'IDENTIFIER_KEY (64 hex characters)',
            'IDENTIFIER_PEPPER (at least 32 characters)',
        ]);
        assert.match(sent.body.data.not_a_fallback, /refused/);
        assert.equal(await EntityIdentifier.countDocuments({}), 0);

        const reread = await Entity.findById(entity._id).lean();
        assert.equal(reread.identifiers.length, 0);
    } finally {
        if (key !== undefined) process.env.IDENTIFIER_KEY = key;
        if (pepper !== undefined) process.env.IDENTIFIER_PEPPER = pepper;
    }
});

test('a key of the wrong length is treated as absent rather than used', async () => {
    const key = process.env.IDENTIFIER_KEY;
    process.env.IDENTIFIER_KEY = 'tooshort';
    process.env.IDENTIFIER_PEPPER = PEPPER;
    try {
        assert.equal(configured(), false);
    } finally {
        if (key === undefined) delete process.env.IDENTIFIER_KEY;
        else process.env.IDENTIFIER_KEY = key;
        delete process.env.IDENTIFIER_PEPPER;
    }
});

test('the safe view lists what an entity is identified by and no values', async () =>
    withSecrets(async () => {
        // The question the network view, the case bundle, and the report draft
        // all ask, none of which needs a number to answer it.
        const entity = await makeEntity();
        await mint({
            entity_id: String(entity._id),
            scheme: 'nik',
            value: NIK,
            validated_against: 'dukcapil',
        });

        const res = reply();
        await controller.forEntity(
            { params: { id: String(entity._id) }, user: { email: ACTOR } },
            res,
        );

        assert.equal(res.sent.body.data.count, 1);
        assert.equal(res.sent.body.data.values_included, false);
        assert.equal(res.sent.body.data.identifiers[0].scheme, 'nik');
        // An unvalidated identifier is somebody's claim about themselves,
        // which is different evidence from one checked against the register.
        assert.equal(res.sent.body.data.identifiers[0].validated, true);
        assert.equal(res.sent.body.data.identifiers[0].validated_against, 'dukcapil');
        assert.equal(JSON.stringify(res.sent.body).includes(NIK), false);
    }));

test('an unrecognised scheme is refused', async () =>
    withSecrets(async () => {
        // An unrecognised scheme is a value nobody has decided the handling
        // rules for, and the handling rules are the entire point.
        const entity = await makeEntity();
        const sent = await mint({
            entity_id: String(entity._id),
            scheme: 'whatever',
            value: NIK,
        });
        assert.equal(sent.status, 400);
    }));

test('recording an identifier must name who did it', async () =>
    withSecrets(async () => {
        const entity = await makeEntity();
        const res = reply();
        await controller.mint(
            { body: { entity_id: String(entity._id), scheme: 'nik', value: NIK }, user: null },
            res,
        );
        assert.equal(res.sent.status, 400);
        assert.equal(await EntityIdentifier.countDocuments({}), 0);
    }));

test('the status view says what an unusable store costs', async () => {
    // A deployment that cannot store identifiers resolves entities on names
    // alone, which is materially weaker and something an operator should learn
    // before it matters rather than from an error on first use.
    const res = reply();
    await controller.status({ user: { email: ACTOR } }, res);
    assert.equal(res.sent.status, 200);
    assert.match(res.sent.body.data.consequence_when_unusable, /names alone/);
});

test('a ciphertext moved onto another record does not decrypt', async () =>
    withSecrets(async () => {
        // GCM authenticates the ciphertext, not the document holding it. Without
        // binding, the encrypted fields copied from Alice's record onto Bob's
        // decrypt cleanly: reading Bob's surrogate returns Alice's number, and
        // the disclosure is recorded against Bob — so the access log the design
        // rests on names the wrong subject.
        const alice = await makeEntity('Alice');
        const bob = await makeEntity('Bob');
        const hers = await mint({ entity_id: String(alice._id), scheme: 'nik', value: NIK });
        const his = await mint({
            entity_id: String(bob._id),
            scheme: 'nik',
            value: '3174012509900002',
        });

        const stolen = await EntityIdentifier.findOne({ valueRef: hers.body.data.value_ref }).lean();
        await EntityIdentifier.updateOne(
            { valueRef: his.body.data.value_ref },
            { $set: { iv: stolen.iv, ciphertext: stolen.ciphertext, tag: stolen.tag } },
        );

        const res = reply();
        await controller.reveal(
            {
                params: { ref: his.body.data.value_ref },
                body: { reason: 'reading a substituted record' },
                user: { email: ACTOR },
            },
            res,
        );
        assert.equal(res.sent.status, 500, 'a substituted ciphertext decrypted');
        assert.equal(JSON.stringify(res.sent.body).includes(NIK), false);
    }));

test('two entities cannot hold one identifier even without the read check', async () =>
    withSecrets(async () => {
        // The controller checks for a collision so it can explain one, but the
        // check is a read followed by a write: two mints arriving together both
        // saw nothing. The database is what actually decides.
        const first = await makeEntity('Budi Santoso');
        const second = await makeEntity('Budi Santosa');
        const minted = await mint({ entity_id: String(first._id), scheme: 'nik', value: NIK });
        const held = await EntityIdentifier.findOne({
            valueRef: minted.body.data.value_ref,
        }).lean();

        await assert.rejects(
            () =>
                EntityIdentifier.create({
                    entityId: second._id,
                    scheme: 'nik',
                    lookupHash: held.lookupHash,
                    iv: held.iv,
                    ciphertext: held.ciphertext,
                    tag: held.tag,
                    recordedBy: ACTOR,
                }),
            /E11000|duplicate key/,
        );
    }));

test('a placeholder is refused rather than recorded as an identifier', async () =>
    withSecrets(async () => {
        // Two unrelated people recorded with the same placeholder collide, and
        // the collision is reported as the strongest evidence they are one
        // party — which puts them in the merge queue, and a merge on that basis
        // attributes one person's donations to the other.
        const entity = await makeEntity();
        for (const placeholder of ['-', 'N/A', 'n/a', '...', '0']) {
            const sent = await mint({
                entity_id: String(entity._id),
                scheme: 'nik',
                value: placeholder,
            });
            assert.equal(sent.status, 400, `"${placeholder}" was accepted as a NIK`);
        }
        assert.equal(await EntityIdentifier.countDocuments({}), 0);
    }));

test('a value that is not the shape of its scheme is refused', async () =>
    withSecrets(async () => {
        const entity = await makeEntity();
        const short = await mint({
            entity_id: String(entity._id),
            scheme: 'nik',
            value: '317401250990',
        });
        assert.equal(short.status, 400);
        assert.match(short.body.message, /form of a nik/);

        // A scheme with no declared pattern is accepted on length alone; a
        // passport number's format varies by issuing country and guessing at it
        // would refuse valid ones.
        const passport = await mint({
            entity_id: String(entity._id),
            scheme: 'passport',
            value: 'X1234567',
        });
        assert.equal(passport.status, 201);
    }));

test('a guessable pepper is treated as no pepper at all', async () => {
    // The key protects the plaintext. The pepper is the only thing between a
    // dumped collection and the enumeration this module exists to prevent, and
    // only the key was being checked.
    const key = process.env.IDENTIFIER_KEY;
    const pepper = process.env.IDENTIFIER_PEPPER;
    process.env.IDENTIFIER_KEY = KEY;
    process.env.IDENTIFIER_PEPPER = 'cakradana';
    try {
        assert.equal(configured(), false);
        const entity = await makeEntity();
        const sent = await mint({ entity_id: String(entity._id), scheme: 'nik', value: NIK });
        assert.equal(sent.status, 503);
        assert.ok(sent.body.data.missing.some((m) => m.startsWith('IDENTIFIER_PEPPER')));
        assert.equal(await EntityIdentifier.countDocuments({}), 0);
    } finally {
        if (key === undefined) delete process.env.IDENTIFIER_KEY;
        else process.env.IDENTIFIER_KEY = key;
        if (pepper === undefined) delete process.env.IDENTIFIER_PEPPER;
        else process.env.IDENTIFIER_PEPPER = pepper;
    }
});

test('the identifier views do not wait for the enforcement flag', async () => {
    // With ENFORCE_ROLES=false any account could walk the entity list and learn
    // which named people have a NIK or a passport on file in a
    // political-donation risk system. A disclosure cannot be un-made by turning
    // the flag on later.
    const router = require('../app/domains/identity/identifier.router');
    const source = require('node:fs').readFileSync(
        require.resolve('../app/domains/identity/identifier.router'),
        'utf8',
    );
    assert.equal(
        /requireRole\(/.test(source),
        false,
        'an identifier route is gated by the waivable check',
    );
    assert.ok(router);
});

test('a merge does not destroy the identifiers it moves', async () =>
    withSecrets(async () => {
        // The ciphertext was bound to the entity, and a merge moves the record
        // between entities — so a routine merge made every identifier the
        // absorbed party held permanently unreadable. The key stayed intact and
        // the plaintext did not, in the collection whose whole purpose is the
        // values that make an attribution certain.
        //
        // It failed silently in the worst direction too: the lookup hash does
        // not involve the entity, so the surrounding views went on reporting
        // the party as identified while the value behind that claim was gone.
        const absorbed = await makeEntity('Budi Santosa');
        const survivor = await makeEntity('Budi Santoso');
        const minted = await mint({
            entity_id: String(absorbed._id),
            scheme: 'nik',
            value: NIK,
        });
        assert.equal(minted.status, 201);

        // Exactly what the merge does.
        await EntityIdentifier.updateMany(
            { entityId: absorbed._id },
            { $set: { entityId: survivor._id } },
        );

        const res = reply();
        await controller.reveal(
            {
                params: { ref: minted.body.data.value_ref },
                body: { reason: 'reading it after the two records were joined' },
                user: { email: ACTOR },
            },
            res,
        );
        assert.equal(res.sent.status, 200, 'a merge made the identifier unreadable');
        assert.equal(res.sent.body.data.value, NIK);
        assert.equal(String(res.sent.body.data.entity_id), String(survivor._id));
    }));

test('a read that cannot be completed is still recorded', async () =>
    withSecrets(async () => {
        // The audit entry was written after decryption, so a read that failed
        // left no trace — against a module header that says every read is
        // recorded with who made it and why. A read that could not be completed
        // is still a read somebody asked for, and is the more interesting one.
        const entity = await makeEntity();
        const minted = await mint({
            entity_id: String(entity._id),
            scheme: 'nik',
            value: NIK,
        });
        await EntityIdentifier.updateOne(
            { valueRef: minted.body.data.value_ref },
            { $set: { ciphertext: 'deadbeef' } },
        );

        const res = reply();
        await controller.reveal(
            {
                params: { ref: minted.body.data.value_ref },
                body: { reason: 'checking a record that will not authenticate' },
                user: { email: ACTOR },
            },
            res,
        );

        assert.equal(res.sent.status, 500);
        assert.equal(JSON.stringify(res.sent.body).includes(NIK), false);
        // And it says the surrounding views are now making a claim they cannot
        // support, which is the part an operator has to act on.
        assert.match(res.sent.body.data.warning, /still report this entity as identified/);

        const attempt = await AuditEntry.findOne({ action: 'read-identifier' }).lean();
        assert.ok(attempt, 'a failed read wrote no audit entry at all');
        assert.equal(attempt.outcome, 'denied');
        assert.equal(attempt.actor, ACTOR);
        assert.match(attempt.reason, /could not be authenticated/);
    }));
