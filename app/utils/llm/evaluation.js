/**
 * Measuring extraction against a labelled corpus.
 *
 * Four numbers, and the third is the one that matters.
 *
 * Field accuracy and record exact-match say how much of what a document
 * contains is recovered. The **hallucination rate** says how much of what is
 * recorded was never in the document, and it is measured against a subset of
 * pages containing no donations at all — because a model that scores well on
 * pages with donations may still invent them on pages without, and only the
 * null case detects that. The quarantine rate says how much was set aside;
 * a low hallucination rate bought with a quarantine rate of 60% is not a good
 * trade, and reporting them separately makes that visible.
 *
 * What this measures depends on the model it is given. Against a scripted
 * model it measures the pipeline: parsing, span grounding, vocabulary, date
 * precision. Against a real provider it measures the model as well. The report
 * says which, because quoting a pipeline figure as a model figure is the kind
 * of claim this project exists not to make.
 */

const { extractDonations } = require('./extraction');

/**
 * Thresholds a change must not cross.
 *
 * Hallucination is the tightest because it is the failure that attributes a
 * donation to a person the document never named.
 */
const THRESHOLDS = Object.freeze({
    fieldAccuracy: 0.9,
    recordExactMatch: 0.8,
    hallucinationRate: 0.01,
    quarantineRate: 0.2,
});

const COMPARED_FIELDS = ['sender', 'receiver', 'amount', 'date', 'sender_type', 'receiver_type'];

function normalise(value) {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Pair extracted records with expected ones.
 *
 * Matched on amount and date rather than position: extraction order is not
 * guaranteed, and scoring by index would report a correct extraction of a
 * reordered table as entirely wrong.
 */
function pair(expected, extracted) {
    const remaining = [...extracted];
    const pairs = [];

    for (const truth of expected) {
        const index = remaining.findIndex(
            (record) =>
                record.fields?.amount === truth.amount &&
                normalise(record.fields?.date) === normalise(truth.date),
        );
        pairs.push({ truth, found: index >= 0 ? remaining.splice(index, 1)[0] : null });
    }

    // Whatever is left matched no expected record. On a document that contains
    // donations these are usually duplicates; on one that contains none they
    // are fabrications.
    return { pairs, unmatched: remaining };
}

/**
 * Run the corpus.
 *
 * `provider` is passed straight through to extraction, so the same harness
 * serves the scripted run in CI and a live run against a real model.
 */
async function evaluate(corpus, { provider = null } = {}) {
    let fieldsCompared = 0;
    let fieldsCorrect = 0;
    let recordsExpected = 0;
    let recordsExact = 0;
    let recordsQuarantined = 0;

    let emptyDocuments = 0;
    let adversarialDocuments = 0;
    let fabricatedOnEmpty = 0;
    let fabricatedOnAdversarial = 0;
    let suppressedByInjection = 0;
    let fabricatedOverall = 0;

    const failures = [];

    for (const document of corpus) {
        const result = await extractDonations(document.text, { provider });
        const { pairs, unmatched } = pair(document.expected, result.donations);

        recordsQuarantined += result.rejected.length;

        if (document.kind === 'adversarial') {
            adversarialDocuments += 1;
            fabricatedOnAdversarial += unmatched.length;
            // Suppression is the other half of injection and is easy to miss:
            // a page carrying a real donation and an instruction to ignore it
            // scores clean on any measure that only counts fabrications.
            const recovered = pairs.filter((p) => p.found).length;
            suppressedByInjection += document.expected.length - recovered;
        } else if (document.expected.length === 0) {
            emptyDocuments += 1;
            fabricatedOnEmpty += result.donations.length;
            if (result.donations.length) {
                failures.push({
                    document: document.id,
                    kind: 'fabrication',
                    detail: `${result.donations.length} record(s) extracted from a document containing none`,
                });
            }
        }
        if (document.kind !== 'adversarial') fabricatedOverall += unmatched.length;

        for (const { truth, found } of pairs) {
            recordsExpected += 1;
            let allMatched = Boolean(found);
            for (const field of COMPARED_FIELDS) {
                if (truth[field] === undefined) continue;
                fieldsCompared += 1;
                const actual = found ? found.fields?.[field] : undefined;
                if (normalise(actual) === normalise(truth[field])) {
                    fieldsCorrect += 1;
                } else {
                    allMatched = false;
                }
            }
            if (allMatched) recordsExact += 1;
        }
    }

    const totalRecordsSeen = recordsExpected + fabricatedOverall;

    const report = {
        documents: corpus.length,
        emptyDocuments,
        adversarialDocuments,
        fieldAccuracy: fieldsCompared ? fieldsCorrect / fieldsCompared : 0,
        recordExactMatch: recordsExpected ? recordsExact / recordsExpected : 0,
        // Measured over everything recorded, so a single fabrication in a large
        // corpus registers rather than being averaged away per document.
        hallucinationRate: totalRecordsSeen ? fabricatedOverall / totalRecordsSeen : 0,
        // The empty subset reported separately: it is the direct measurement,
        // and the aggregate can hide it.
        fabricatedOnEmptyDocuments: fabricatedOnEmpty,
        // Injection is measured but not gated, because the defence that
        // applies to it lives outside extraction. Span grounding stops a model
        // inventing a value; it cannot stop a page that supplies the value it
        // wants recorded, and pretending a threshold covers that would be a
        // false assurance. The source allowlist and volume monitoring are what
        // apply here.
        injection: {
            documents: adversarialDocuments,
            fabricatedRecords: fabricatedOnAdversarial,
            suppressedRecords: suppressedByInjection,
            note:
                'reported, not gated: grounding cannot refute injected text that ' +
                'contains the values it asks to have recorded',
        },
        quarantineRate: totalRecordsSeen
            ? recordsQuarantined / (totalRecordsSeen + recordsQuarantined)
            : 0,
        failures: failures.slice(0, 20),
        // What was actually exercised. A pipeline figure quoted as a model
        // figure is exactly the misattribution this project exists not to
        // repeat.
        measures: provider
            ? 'the extraction pipeline against a scripted model'
            : 'the extraction pipeline and the configured language model',
    };

    report.passed =
        Object.entries(THRESHOLDS).every(([metric, threshold]) =>
            metric === 'hallucinationRate' || metric === 'quarantineRate'
                ? report[metric] <= threshold
                : report[metric] >= threshold,
        ) &&
        // Nothing invented on a page that contained nothing. Not a rate: one
        // fabricated donation attributed to a named person is one too many,
        // and a rate would let it round away.
        report.fabricatedOnEmptyDocuments === 0;

    return report;
}

function describe(report) {
    return [
        `documents: ${report.documents} (${report.emptyDocuments} empty, ${report.adversarialDocuments} adversarial)`,
        `field accuracy: ${report.fieldAccuracy.toFixed(4)} (>= ${THRESHOLDS.fieldAccuracy})`,
        `record exact match: ${report.recordExactMatch.toFixed(4)} (>= ${THRESHOLDS.recordExactMatch})`,
        `hallucination rate: ${report.hallucinationRate.toFixed(4)} (<= ${THRESHOLDS.hallucinationRate})`,
        `fabricated on empty documents: ${report.fabricatedOnEmptyDocuments}`,
        `injection: ${report.injection.fabricatedRecords} fabricated, ` +
            `${report.injection.suppressedRecords} suppressed (reported, not gated)`,
        `quarantine rate: ${report.quarantineRate.toFixed(4)} (<= ${THRESHOLDS.quarantineRate})`,
        `measures ${report.measures}`,
        report.passed ? 'PASS' : 'FAIL',
    ].join('\n');
}

module.exports = { evaluate, describe, pair, THRESHOLDS, COMPARED_FIELDS };
