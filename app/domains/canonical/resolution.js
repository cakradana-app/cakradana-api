/**
 * Entity resolution.
 *
 * The accuracy ceiling of every cumulative limit rule is set here. A donor
 * split across three spellings looks like three donors, each comfortably under
 * the cap, which is precisely the behaviour the cap exists to prevent. So
 * resolution quality is a detection requirement rather than data hygiene.
 *
 * Resolution stops at the first confident match. Anything below the automatic
 * threshold but above the review threshold is queued for a person rather than
 * guessed, because a wrong merge attributes one person's donations to another
 * and that is not a mistake this system can make quietly.
 */

const { Entity } = require('./canonical.model');
const { ENTITY_TYPES } = require('../vocabulary');

/** Above this, a fuzzy match is accepted without review. */
const AUTO_THRESHOLD = 0.94;
/** Below this, a candidate is not worth a reviewer's time. */
const REVIEW_THRESHOLD = 0.82;

/** Legal-form tokens that carry no identifying information on their own. */
const LEGAL_FORMS = new Set([
    'pt', 'cv', 'ud', 'tbk', 'persero', 'perumda', 'perum', 'koperasi',
    'yayasan', 'partai', 'firma', 'nv',
]);

const HONORIFICS = new Set([
    'dr', 'drs', 'ir', 'h', 'hj', 'prof', 'se', 'sh', 'mm', 'msi', 'st', 'spd',
]);

/**
 * Fold a name for comparison.
 *
 * Case, punctuation, honorifics, and legal-form tokens are removed, because
 * none of them distinguish one party from another and all of them vary between
 * a scanned form and a filed report. What is left is the part that identifies.
 */
function normaliseName(value) {
    if (typeof value !== 'string') return '';
    return value
        .toLowerCase()
        .replace(/[.,()\-_/\\'"]/g, ' ')
        .split(/\s+/)
        // Single characters are dropped: they are the residue of punctuated
        // qualifications such as "S.E." and identify nobody, but left in place
        // they make two records of the same person compare as different.
        .filter(
            (token) =>
                token.length > 1 && !LEGAL_FORMS.has(token) && !HONORIFICS.has(token),
        )
        .join(' ')
        .trim();
}

/**
 * Similarity between two normalised names, from 0 to 1.
 *
 * Token overlap weighted towards rarer, longer tokens: two people sharing a
 * common given name are not the same person, while sharing an unusual surname
 * is far more telling.
 */
function similarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;

    const a = new Set(left.split(' '));
    const b = new Set(right.split(' '));
    let shared = 0;
    let weight = 0;

    for (const token of a) {
        const tokenWeight = Math.min(token.length, 8);
        weight += tokenWeight;
        if (b.has(token)) shared += tokenWeight;
    }
    for (const token of b) {
        if (!a.has(token)) weight += Math.min(token.length, 8);
    }

    return weight === 0 ? 0 : shared / weight;
}

/**
 * Resolve a name to an entity, creating one when nothing matches.
 *
 * Returns the entity together with how it was reached and whether a person
 * should look at it. Callers persist the confidence on the donation, so a
 * downstream reader can see how firmly the attribution is held.
 */
async function resolveEntity(rawName, entityType = 'unknown', options = {}) {
    const { createIfMissing = true, session = null, observedAt = null } = options;

    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
        return { entity: null, confidence: 0, basis: 'absent', requiresReview: false };
    }

    const type = ENTITY_TYPES.includes(entityType) ? entityType : 'unknown';
    const normalised = normaliseName(name);
    if (!normalised) {
        return { entity: null, confidence: 0, basis: 'no-identifying-tokens', requiresReview: true };
    }

    const ofType = { $in: type === 'unknown' ? ENTITY_TYPES : [type, 'unknown'] };
    // Entities merged away are excluded from every match below. Without that
    // filter a merge lasted exactly until the next donation: the absorbed
    // record kept its normalised name, matched exactly, short-circuited before
    // the fuzzy path that would have raised a review, and the split identity
    // came back — permanently, and now invisibly.
    const live = { mergedInto: null };

    // Exact match on the canonical form or a folded alias, scoped by type. An
    // individual and a company sharing a name are different parties.
    const exact = await Entity.findOne({
        ...live,
        entityType: ofType,
        $or: [{ normalisedName: normalised }, { normalisedAliases: normalised }],
    }).session(session);

    if (exact) {
        await noteSighting(exact, name, observedAt, session);
        return {
            entity: exact,
            confidence: 1,
            // Distinguished so a reader can tell a donor matched under their
            // own recorded name from one matched through a name an analyst
            // decided was the same person.
            basis:
                exact.normalisedName === normalised ? 'normalised-name' : 'merged-alias',
            requiresReview: false,
        };
    }

    // Fuzzy candidates, restricted to entities sharing at least one token so
    // the comparison set stays bounded as the store grows.
    const tokens = normalised.split(' ').filter((t) => t.length > 2);
    const candidates = tokens.length
        ? await Entity.find({
              ...live,
              entityType: ofType,
              normalisedName: { $regex: tokens.map(escapeRegex).join('|') },
          })
              .limit(50)
              .session(session)
        : [];

    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
        const score = similarity(normalised, candidate.normalisedName);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }

    if (best && bestScore >= AUTO_THRESHOLD) {
        await noteSighting(best, name, observedAt, session);
        return { entity: best, confidence: bestScore, basis: 'fuzzy', requiresReview: false };
    }

    if (best && bestScore >= REVIEW_THRESHOLD) {
        // Close enough to be worth a person's judgement, not close enough to
        // merge unattended. A new entity is created so the donation is not
        // lost, and the near match travels with it for review.
        const created = createIfMissing
            ? await createEntity(name, normalised, type, observedAt, session)
            : null;
        return {
            entity: created,
            confidence: bestScore,
            basis: 'fuzzy-below-threshold',
            requiresReview: true,
            candidate: best,
        };
    }

    if (!createIfMissing) {
        return { entity: null, confidence: 0, basis: 'no-match', requiresReview: false };
    }

    const created = await createEntity(name, normalised, type, observedAt, session);
    return { entity: created, confidence: 1, basis: 'created', requiresReview: false };
}

async function createEntity(name, normalised, type, observedAt, session) {
    const now = observedAt || new Date();
    const [entity] = await Entity.create(
        [
            {
                canonicalName: name,
                normalisedName: normalised,
                aliases: [name],
                entityType: type,
                firstSeen: now,
                lastSeen: now,
            },
        ],
        session ? { session } : {},
    );
    return entity;
}

/**
 * Record that an entity was seen, widening its alias set and its date range.
 *
 * First and last sighting drive the thin-donor signal, where a donor's very
 * first appearance being a large donation is itself notable.
 */
async function noteSighting(entity, observedName, observedAt, session) {
    const updates = {};
    if (observedName && !entity.aliases.includes(observedName)) {
        updates.$addToSet = { aliases: observedName };
    }
    const when = observedAt || new Date();
    if (!entity.firstSeen || when < entity.firstSeen) {
        updates.$min = { firstSeen: when };
    }
    if (!entity.lastSeen || when > entity.lastSeen) {
        updates.$max = { lastSeen: when };
    }
    if (Object.keys(updates).length) {
        await Entity.updateOne({ _id: entity._id }, updates).session(session);
    }
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The entity a record now belongs to, following merges to the end.
 *
 * One hop was not enough. A second merge of an already-absorbed entity — which
 * `merge` permits, since it only refuses when the entity being merged is itself
 * a tombstone — leaves a chain, and an account linked to the first link
 * resolved to the middle of it and matched nothing. The subject was then shown
 * an empty list under this system's strongest scope claim, reported as
 * complete, with nothing saying resolution had run out of hops.
 *
 * The guard is on a cycle rather than on a depth. A cycle should not be
 * constructible, and if one ever is, looping forever is a worse answer than
 * stopping and saying where.
 */
async function survivorOf(entityId, { Entity: model = null } = {}) {
    const collection = model || require('./canonical.model').Entity;
    const seen = new Set();
    let current = entityId ? String(entityId) : null;

    while (current) {
        if (seen.has(current)) {
            // Reported rather than silently truncated: an unresolvable link is
            // not the same as an account with no donations.
            return { entityId: null, reason: 'the merge chain loops' };
        }
        seen.add(current);
        const entity = await collection.findById(current).select('mergedInto').lean();
        if (!entity) return { entityId: null, reason: 'the linked entity no longer exists' };
        if (!entity.mergedInto) return { entityId: current, reason: null };
        current = String(entity.mergedInto);
    }
    return { entityId: null, reason: 'no entity is linked to this account' };
}

module.exports = {
    survivorOf,
    resolveEntity,
    normaliseName,
    similarity,
    AUTO_THRESHOLD,
    REVIEW_THRESHOLD,
    LEGAL_FORMS,
};
