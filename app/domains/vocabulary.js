/**
 * Controlled vocabularies shared by extraction, storage, rules, and features.
 *
 * One list, used everywhere. Extraction prompts are generated from these
 * values rather than restating them, because a prompt that offers a value the
 * store rejects produces records that fail validation after the expensive step
 * has already run. That is exactly what happened here: the prompt asked the
 * model for "company", which the schema never accepted, so every corporate
 * donor the extractor identified correctly was thrown away on write.
 *
 * `unknown` is a first-class value. Nothing is coerced into a known category
 * to make a record fit.
 */

const ENTITY_TYPES = Object.freeze([
    'individual',
    'corporation',
    'organization',
    'political-party',
    'government',
    'state-enterprise',
    'village-government',
    'foreign-entity',
    'unknown',
]);

const TRANSACTION_KINDS = Object.freeze(['cash', 'transfer', 'in_kind', 'unknown']);

const CHANNELS = Object.freeze(['digital-form', 'paper-form', 'web-scrape', 'import']);

const TEMPORAL_PRECISIONS = Object.freeze(['day', 'hour', 'minute', 'second']);

const PROVENANCE = Object.freeze([
    'extracted',
    'submitted',
    'scraped',
    'human-corrected',
    'derived',
    // Recovered from the store this service began with, which held every
    // donation in one document and recorded nothing about where a value came
    // from. Its own category because it is none of the others: nobody
    // extracted it here, nobody submitted it here, and it was not computed. A
    // record whose origin is unknown should say so rather than borrow the
    // nearest word, because these are exactly the records an analyst should
    // weigh differently.
    'migrated',
]);

/**
 * Why a donor's identity is absent.
 *
 * A form submitted anonymously and a scan nobody could read produce the same
 * empty field and are legally different: the first is an offence by the
 * recipient, the second is a data-quality problem. Merging them manufactures
 * accusations out of poor scans.
 */
const IDENTITY_ABSENCE = Object.freeze([
    'declared_anonymous',
    'extraction_failed',
    'not_provided',
]);

const LABEL_SOURCES = Object.freeze([
    'rule_tier2',
    'analyst_disposition',
    'recipient_confirmation',
    'dispute_outcome',
    'synthetic',
]);

const LABEL_VALUES = Object.freeze(['risky', 'not_risky', 'indeterminate']);

/**
 * Why a subject says an attribution is wrong.
 *
 * A controlled list rather than free text, because the reason determines what
 * correcting the record means: "not mine" removes an attribution, "wrong
 * amount" changes a figure every cumulative total depends on. `other` carries
 * free text, and exists so that a subject with a reason nobody anticipated is
 * not forced to pick the nearest wrong one.
 */
const DISPUTE_REASONS = Object.freeze([
    'not_mine',
    'wrong_amount',
    'wrong_date',
    'wrong_counterparty',
    'duplicate',
    'other',
]);

/**
 * Where a dispute sits.
 *
 * `acknowledged` is separate from `open` because acknowledgement carries its
 * own deadline. A subject who is told nothing for three weeks has no way to
 * tell a queue from a void.
 */
const DISPUTE_STATES = Object.freeze([
    'open',
    'acknowledged',
    'resolved',
    'withdrawn',
]);

/**
 * How a dispute ended.
 *
 * `partially_upheld` is a real outcome, not a hedge: a subject may be right
 * that the amount is wrong and wrong that the donation is not theirs, and
 * flattening that to a binary loses the half that was correct.
 */
const DISPUTE_OUTCOMES = Object.freeze([
    'upheld',
    'partially_upheld',
    'rejected',
]);

/**
 * How the model should describe each entity type it is asked to classify.
 * Generated into the prompt so the vocabulary cannot drift from the schema.
 */
const ENTITY_TYPE_GUIDANCE = Object.freeze({
    individual: 'a natural person, such as "Budi Santoso" or "Dr. Ani Kusuma"',
    corporation: 'a business entity, typically prefixed PT, CV, UD, or Tbk',
    organization: 'an association, foundation, cooperative, or other non-business body',
    'political-party': 'a political party, such as "Partai Maju"',
    government: 'a government body, ministry, agency, or regional administration',
    'state-enterprise': 'a state or regionally owned enterprise, often marked (Persero) or Perumda',
    'village-government': 'a village administration, such as "Pemerintah Desa Sukamaju"',
    'foreign-entity': 'a person or body identified in the text as foreign',
    unknown: 'use when the text does not make the type clear',
});

module.exports = {
    ENTITY_TYPES,
    ENTITY_TYPE_GUIDANCE,
    TRANSACTION_KINDS,
    CHANNELS,
    TEMPORAL_PRECISIONS,
    PROVENANCE,
    IDENTITY_ABSENCE,
    LABEL_SOURCES,
    LABEL_VALUES,
    DISPUTE_REASONS,
    DISPUTE_STATES,
    DISPUTE_OUTCOMES,
};
