/**
 * The only way in or out of the identifier store.
 *
 * Every read of an identifier value is a disclosure of the most identifying
 * thing this system holds about a person, so every read is recorded with who
 * made it and why. A reason is required and cannot be defaulted: an access log
 * full of entries nobody had to justify answers "who looked" and not "why",
 * and only the second is any use when the question is whether a disclosure
 * should have happened.
 *
 * Matching is separated from reading on purpose. Deciding whether two records
 * describe one person is the common operation and does not need the value;
 * reading the value is rare, and is the one that has to be justified. Keeping
 * them the same call would make every match a disclosure.
 */

const { Entity } = require('../canonical/canonical.model');
const { record } = require('../canonical/retention');
const {
    EntityIdentifier,
    IDENTIFIER_SCHEMES,
    IdentifierSecretsMissing,
    IdentifierRejected,
    lookupHash,
    encrypt,
    decrypt,
    configured,
    newSurrogate,
    validateValue,
} = require('./identifier.model');

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

/**
 * Refuse rather than degrade when the store is not configured.
 *
 * 503 and not 500: nothing is broken, the deployment has not been given the
 * secrets. An operator reading this needs to know which.
 */
function unconfigured(res, err) {
    return res.status(503).json({
        status: 'error',
        message: err.message,
        data: {
            missing: err.missing,
            // Said plainly, because the tempting workaround is the one thing
            // that must not happen.
            not_a_fallback:
                'identifiers are not stored unencrypted when the key is absent; ' +
                'the value is refused',
        },
    });
}

/**
 * Record an identifier for an entity.
 *
 * The value never reaches the entity document. What goes there is the
 * surrogate this returns, and the entity schema refuses anything that is not
 * one — so a later caller cannot quietly put a number in its place.
 */
const mint = async (req, res) => {
    try {
        const { entity_id: entityId, scheme, value, validated_against: against } =
            req.body || {};
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'recording an identifier must name who did it');
        if (!entityId) return fail(res, 400, 'entity_id is required');
        if (!IDENTIFIER_SCHEMES.includes(scheme)) {
            return fail(res, 400, `scheme must be one of: ${IDENTIFIER_SCHEMES.join(', ')}`);
        }
        if (!value || String(value).trim() === '') {
            return fail(res, 400, 'value is required');
        }
        try {
            // Before anything is derived from it. A placeholder recorded as an
            // identifier collides with every other placeholder, and a collision
            // is reported below as the strongest evidence two records are one
            // party — which would put two unrelated people in the merge queue.
            validateValue(scheme, value);
        } catch (err) {
            if (err instanceof IdentifierRejected) return fail(res, 400, err.message);
            throw err;
        }

        const entity = await Entity.findById(entityId);
        if (!entity) return fail(res, 404, 'No such entity');
        if (entity.mergedInto) {
            return fail(
                res,
                409,
                'This entity was merged into another record; the identifier belongs ' +
                    'on the surviving one',
                { merged_into: entity.mergedInto },
            );
        }

        const hash = lookupHash(scheme, value);

        // The same identifier already recorded against a different entity is
        // the strongest evidence this system can have that two records are one
        // person — and recording it twice would destroy that evidence by
        // making both look separately identified.
        const elsewhere = await EntityIdentifier.findOne({
            scheme,
            lookupHash: hash,
            entityId: { $ne: entity._id },
        }).lean();
        if (elsewhere) {
            await record({
                actor,
                action: 'identifier-collision',
                subjectType: 'Entity',
                subjectId: String(entity._id),
                reason: `already recorded against ${elsewhere.entityId}`,
            });
            return fail(
                res,
                409,
                'This identifier is already recorded against another entity. That is ' +
                    'evidence the two are the same party, and is a resolution decision ' +
                    'rather than something to record twice.',
                { other_entity_id: elsewhere.entityId, resolve_at: '/service/entities/reviews' },
            );
        }

        const existing = await EntityIdentifier.findOne({
            scheme,
            lookupHash: hash,
            entityId: entity._id,
        }).lean();
        if (existing) {
            return res.status(200).json({
                status: 'success',
                message: 'This identifier is already recorded for this entity',
                data: { value_ref: existing.valueRef, scheme, created: false },
            });
        }

        // The surrogate is issued first so the ciphertext can be bound to it.
        // Without that binding, the encrypted fields copied from one record onto
        // another decrypt cleanly and the wrong number is returned under the
        // wrong entity's disclosure record.
        const valueRef = newSurrogate();
        const sealed = encrypt(value, { valueRef, scheme });
        let stored;
        try {
            stored = await EntityIdentifier.create({
                valueRef,
                entityId: entity._id,
                scheme,
                lookupHash: hash,
                ...sealed,
                validated: Boolean(against),
                validatedAgainst: against || null,
                recordedBy: actor,
            });
        } catch (err) {
            // The check above is a read followed by a write, so two mints of one
            // number arriving together both saw nothing and both proceeded. The
            // unique index is what actually decides; this turns losing that race
            // into the same answer the check gives.
            if (err?.code === 11000) {
                const other = await EntityIdentifier.findOne({ scheme, lookupHash: hash }).lean();
                // The race can be lost to this same entity — an operator
                // double-submitting, a client retrying a request whose response
                // was lost. That is the case the non-racing path above answers
                // with 200 and `created: false`, and answering it with 409
                // instead told the operator to resolve the entity against
                // itself: a decision with no second party to make it about.
                if (other && String(other.entityId) === String(entity._id)) {
                    return res.status(200).json({
                        status: 'success',
                        message: 'This identifier is already recorded for this entity',
                        data: { value_ref: other.valueRef, scheme, created: false },
                    });
                }
                return fail(
                    res,
                    409,
                    'This identifier is already recorded. Two records holding one ' +
                        'identifier is a resolution decision rather than something to ' +
                        'record twice.',
                    { other_entity_id: other?.entityId || null },
                );
            }
            throw err;
        }

        // The entity gets the surrogate and nothing else.
        await Entity.updateOne(
            { _id: entity._id },
            { $addToSet: { identifiers: { scheme, valueRef: stored.valueRef, validated: stored.validated } } },
        );

        await record({
            actor,
            action: 'record-identifier',
            subjectType: 'Entity',
            subjectId: String(entity._id),
            reason: `${scheme} recorded`,
        });

        return res.status(201).json({
            status: 'success',
            message: 'Identifier recorded',
            data: {
                value_ref: stored.valueRef,
                scheme,
                created: true,
                validated: stored.validated,
                // Named so a caller does not go looking for the value on the
                // entity and conclude the record failed.
                where_the_value_is:
                    'held encrypted in a separate collection; the entity holds only ' +
                    'this reference',
            },
        });
    } catch (err) {
        if (err instanceof IdentifierSecretsMissing) return unconfigured(res, err);
        return serverError(res, err, 'recording an identifier');
    }
};

/**
 * Which entity, if any, holds this identifier.
 *
 * Answers the question resolution actually asks without disclosing anything:
 * the caller supplies a value they already have and learns whether the system
 * knows it, never the other way round. The value is not returned and the
 * request is not a disclosure, so it needs no justification — but it is still
 * recorded, because a caller enumerating identifiers to find which exist is
 * doing so one request at a time and that pattern is only visible in a log.
 */
const match = async (req, res) => {
    try {
        const { scheme, value } = req.body || {};
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a lookup must name who made it');
        if (!IDENTIFIER_SCHEMES.includes(scheme)) {
            return fail(res, 400, `scheme must be one of: ${IDENTIFIER_SCHEMES.join(', ')}`);
        }
        if (!value) return fail(res, 400, 'value is required');
        try {
            // The same check `mint` applies, for the same reason and against a
            // population `mint` cannot reach. Every placeholder normalises to
            // the same short string and therefore to the same lookup hash, so
            // `{scheme: 'nik', value: '-'}` is a query for "whoever else was
            // recorded with a dash" — and any record predating that check on
            // the write path is exactly what it would find. A migration leaves
            // precisely that population behind, so the read path cannot assume
            // the write path already cleaned it.
            validateValue(scheme, value);
        } catch (err) {
            if (err instanceof IdentifierRejected) {
                // Recorded, not merely refused. A caller working through
                // placeholders to see which the system accepts is doing so one
                // request at a time, and a 400 that leaves no trace makes that
                // sequence invisible — which is the pattern this log exists to
                // show.
                await record({
                    actor,
                    action: 'match-identifier',
                    subjectType: 'EntityIdentifier',
                    subjectId: null,
                    outcome: 'denied',
                    reason: `${scheme} lookup refused: not an identifier`,
                });
                return fail(res, 400, err.message);
            }
            throw err;
        }

        const found = await EntityIdentifier.findOne({
            scheme,
            lookupHash: lookupHash(scheme, value),
        }).lean();

        await record({
            actor,
            action: 'match-identifier',
            subjectType: 'EntityIdentifier',
            subjectId: found ? String(found.entityId) : null,
            outcome: found ? 'allowed' : 'denied',
            reason: `${scheme} lookup`,
        });

        return res.status(200).json({
            status: 'success',
            message: found ? 'Known identifier' : 'No entity holds this identifier',
            data: {
                known: Boolean(found),
                entity_id: found?.entityId || null,
                validated: found?.validated ?? null,
                // The value is not echoed. A caller that supplied it has it
                // already, and echoing it would put it in this response, this
                // log, and whatever holds either.
                value_returned: false,
            },
        });
    } catch (err) {
        if (err instanceof IdentifierSecretsMissing) return unconfigured(res, err);
        return serverError(res, err, 'matching an identifier');
    }
};

/**
 * Read an identifier value.
 *
 * The rare operation, and the one that is a disclosure. A reason is required
 * and recorded against the entity, so the subject of a disclosure can be told
 * who read their identifier and what for.
 */
const reveal = async (req, res) => {
    try {
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'reading an identifier must name who did it');
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return fail(
                res,
                400,
                'a reason is required to read an identifier value; a log of reads ' +
                    'nobody had to justify records who looked and not why',
            );
        }

        const stored = await EntityIdentifier.findOne({
            valueRef: req.params.ref,
        }).lean();
        if (!stored) {
            await record({
                actor,
                action: 'read-identifier',
                subjectType: 'EntityIdentifier',
                subjectId: req.params.ref,
                outcome: 'denied',
                reason,
            });
            return fail(res, 404, 'No such identifier');
        }

        // Decryption is attempted inside its own guard, and the attempt is
        // recorded either way. It used to sit before the only `record` call on
        // this path, so a read that failed to decrypt left no trace at all —
        // and the module header says every read is recorded with who made it
        // and why. A read that could not be completed is still a read somebody
        // asked for, and is the more interesting of the two.
        let value;
        try {
            value = decrypt(stored);
        } catch (error) {
            await record({
                actor,
                action: 'read-identifier',
                subjectType: 'Entity',
                subjectId: String(stored.entityId),
                outcome: 'denied',
                reason: `${reason} — the stored value could not be authenticated`,
            });
            return res.status(500).json({
                status: 'error',
                message:
                    'This identifier is stored but could not be read back. The record ' +
                    'is intact and the value is not recoverable from it.',
                data: {
                    value_ref: stored.valueRef,
                    scheme: stored.scheme,
                    // Said outright, because the surrounding views will go on
                    // reporting this party as identified: the lookup hash does
                    // not depend on anything that could have broken here.
                    warning:
                        'other views still report this entity as identified; that ' +
                        'claim now rests on a value nobody can read',
                },
            });
        }

        await record({
            actor,
            action: 'read-identifier',
            subjectType: 'Entity',
            subjectId: String(stored.entityId),
            outcome: 'allowed',
            reason,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Identifier value',
            data: {
                value_ref: stored.valueRef,
                scheme: stored.scheme,
                value,
                entity_id: stored.entityId,
                validated: stored.validated,
                validated_against: stored.validatedAgainst,
                // Stated in the response because it is the consequence the
                // reader should be aware of at the moment they read it.
                disclosure_recorded:
                    'this read is on the entity’s access record and is disclosable ' +
                    'to the subject',
            },
        });
    } catch (err) {
        if (err instanceof IdentifierSecretsMissing) return unconfigured(res, err);
        return serverError(res, err, 'reading an identifier');
    }
};

/**
 * What an entity is identified by, without any of the values.
 *
 * The safe view, and the one nearly everything wants: whether a party is
 * identified at all, by what, and whether anybody checked. `identityBasis` on
 * the network view, the case bundle, and the report draft are all this
 * question, and none of them needs a number to answer it.
 */
const forEntity = async (req, res) => {
    try {
        // Recorded, which it was not. This is the one identifier operation that
        // wrote no trace, and what it discloses — which named people have a NIK
        // or a passport on file in a political-donation risk system, and whether
        // anybody checked it — is worth knowing somebody asked for.
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a lookup must name who made it');
        await record({
            actor,
            action: 'list-identifiers',
            subjectType: 'Entity',
            subjectId: String(req.params.id),
        });

        const held = await EntityIdentifier.find({ entityId: req.params.id })
            .select('valueRef scheme validated validatedAgainst createdAt')
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Identifiers held for this entity',
            data: {
                entity_id: req.params.id,
                count: held.length,
                identifiers: held.map((item) => ({
                    value_ref: item.valueRef,
                    scheme: item.scheme,
                    // An unvalidated identifier is somebody's claim about
                    // themselves, which is a different kind of evidence from
                    // one checked against the issuing register.
                    validated: item.validated,
                    validated_against: item.validatedAgainst,
                    recorded_at: item.createdAt,
                })),
                values_included: false,
            },
        });
    } catch (err) {
        return serverError(res, err, 'listing identifiers for an entity');
    }
};

/** Whether this deployment can hold identifiers at all. */
const status = async (req, res) => {
    try {
        const usable = configured();
        return res.status(200).json({
        status: 'success',
        message: 'Identifier storage',
        data: {
            usable,
            held: usable ? await EntityIdentifier.countDocuments({}) : null,
            // Reported rather than inferred from an error on first use. A
            // deployment that cannot store identifiers resolves entities on
            // names alone, which is a materially weaker basis and one an
            // operator should know about before it matters.
                consequence_when_unusable:
                    'identifiers are refused, so entity resolution rests on names alone',
            },
        });
    } catch (err) {
        // Express 4 does not forward a rejected promise, so without this an
        // unreachable database takes the process down — from the one endpoint
        // whose job is to say the store is degraded.
        return serverError(res, err, 'reading identifier storage status');
    }
};

module.exports = { mint, match, reveal, forEntity, status };
