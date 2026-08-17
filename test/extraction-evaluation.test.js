/**
 * The extraction evaluation set.
 *
 * Two scripted models are run against the same corpus. A faithful one, which
 * should pass; and one that invents records, which should be caught by span
 * grounding rather than by anything the model was asked to do.
 *
 * This measures the pipeline, not a language model. A live run against a real
 * provider is a separate, opt-in exercise — CI has no model and pretending
 * otherwise would produce a number that describes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCorpus } = require('./fixtures/extraction-corpus');
const { evaluate, describe, THRESHOLDS } = require('../app/utils/llm/evaluation');

const CORPUS = buildCorpus({ documents: 200 });

/** A model that reads the document correctly and quotes what it read. */
function faithfulModel(corpus) {
    const byText = new Map(corpus.map((doc) => [doc.text, doc]));
    return {
        name: 'scripted-faithful',
        sendsDataOffPremise: false,
        async complete({ user }) {
            const document = [...byText.values()].find((doc) => user.includes(doc.text));
            if (!document) return '[]';
            return JSON.stringify(
                document.expected.map((truth, index) => ({
                    sender: truth.sender,
                    sender_span: document.spans[index].sender,
                    sender_type: truth.sender_type,
                    receiver: truth.receiver,
                    receiver_span: document.spans[index].receiver,
                    receiver_type: truth.receiver_type,
                    amount: truth.amount,
                    amount_span: document.spans[index].amount,
                    date: truth.date,
                    date_span: document.spans[index].date,
                })),
            );
        },
    };
}

/** A model that invents a donation on every document, quoting nothing. */
function fabricatingModel() {
    return {
        name: 'scripted-fabricating',
        sendsDataOffPremise: false,
        async complete() {
            return JSON.stringify([
                {
                    sender: 'Ahmad Fauzi',
                    sender_span: 'Ahmad Fauzi',
                    sender_type: 'individual',
                    receiver: 'Partai Maju',
                    receiver_span: 'Partai Maju',
                    receiver_type: 'political-party',
                    amount: 999_000_000,
                    amount_span: 'Rp999.000.000',
                    date: '2026-06-01',
                    date_span: '2026-06-01',
                },
            ]);
        },
    };
}

test('the corpus meets its size and composition requirements', () => {
    assert.ok(CORPUS.length >= 200, 'at least 200 documents');
    // The empty subset is what measures fabrication directly.
    const empty = CORPUS.filter((doc) => doc.kind === 'empty');
    assert.ok(empty.length >= 40, 'a substantial subset containing no donations');
    assert.ok(
        CORPUS.some((doc) => doc.kind === 'adversarial'),
        'pages carrying instructions aimed at the extractor',
    );

    const layouts = new Set(CORPUS.map((doc) => doc.layout));
    for (const shape of ['form', 'table', 'scraped', 'empty', 'adversarial']) {
        assert.ok(layouts.has(shape), `missing ${shape} documents`);
    }
    assert.ok(CORPUS.some((doc) => doc.degraded), 'poor scans are represented');
});

test('the corpus is identical on every build', () => {
    // A metric that moves because the fixture moved tells you nothing about the
    // change you made.
    const again = buildCorpus({ documents: 200 });
    assert.equal(CORPUS.length, again.length);
    assert.equal(CORPUS[0].text, again[0].text);
    assert.equal(CORPUS.at(-1).text, again.at(-1).text);
});

test('a faithful model passes every threshold', async () => {
    const report = await evaluate(CORPUS, { provider: faithfulModel(CORPUS) });
    assert.ok(
        report.fieldAccuracy >= THRESHOLDS.fieldAccuracy,
        `field accuracy ${report.fieldAccuracy}\n${describe(report)}`,
    );
    assert.ok(report.recordExactMatch >= THRESHOLDS.recordExactMatch, describe(report));
    assert.ok(report.hallucinationRate <= THRESHOLDS.hallucinationRate, describe(report));
    assert.equal(report.fabricatedOnEmptyDocuments, 0);
    assert.equal(report.passed, true, describe(report));
});

test('a fabricating model is caught, and by grounding rather than by luck', async () => {
    // The record it emits quotes text the document does not contain, so span
    // verification drops it. Nothing about the model changed; the pipeline
    // refuses to record a value it cannot find on the page.
    const report = await evaluate(CORPUS, { provider: fabricatingModel() });
    assert.equal(report.fabricatedOnEmptyDocuments, 0, describe(report));
    assert.ok(report.hallucinationRate <= THRESHOLDS.hallucinationRate, describe(report));
    // It still fails, because it recovered none of the real records.
    assert.equal(report.passed, false);
});

test('the report says what it measured', async () => {
    // A pipeline figure quoted as a model figure is the misattribution this
    // project exists not to repeat.
    const report = await evaluate(CORPUS.slice(0, 5), { provider: faithfulModel(CORPUS) });
    assert.match(report.measures, /scripted model/);
});

test('the empty subset is reported separately from the aggregate', async () => {
    // The aggregate can hide it: a handful of fabrications across a large
    // corpus rounds to nothing.
    const report = await evaluate(CORPUS, { provider: faithfulModel(CORPUS) });
    assert.equal(typeof report.fabricatedOnEmptyDocuments, 'number');
    assert.ok(report.emptyDocuments >= 40);
});

test('injection is measured but not gated, and says why', async () => {
    // Span grounding stops a model inventing a value. It cannot stop a page
    // that supplies the value it wants recorded — the page really does say
    // "Rp999.000.000" — so a threshold here would be a false assurance. The
    // defences that apply are the source allowlist and volume monitoring.
    const report = await evaluate(CORPUS, { provider: faithfulModel(CORPUS) });
    assert.ok(report.injection.documents > 0);
    assert.match(report.injection.note, /not gated/);
    assert.equal(typeof report.injection.suppressedRecords, 'number');
});

test('the hallucination threshold is the tightest of them', () => {
    // It is the failure that attributes a donation to somebody the document
    // never named.
    assert.ok(THRESHOLDS.hallucinationRate <= 0.01);
    assert.ok(THRESHOLDS.hallucinationRate < 1 - THRESHOLDS.fieldAccuracy);
});
