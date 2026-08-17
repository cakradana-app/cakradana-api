/**
 * Run the extraction evaluation against the configured language model.
 *
 * The suite in `test/` runs the same corpus against a scripted model, which
 * measures the pipeline. This measures the model too, and needs credentials, so
 * it is a deliberate act rather than part of the test run.
 *
 * Required whenever the provider, model, model version, or prompt changes. A
 * change that degrades the hallucination rate is a change that starts
 * attributing donations to people the document never named, and the only way to
 * find out is to measure it.
 */

require('dotenv').config();

const { buildCorpus } = require('../test/fixtures/extraction-corpus');
const { evaluate, describe } = require('../app/utils/llm/evaluation');
const { createProvider } = require('../app/utils/llm/provider');

async function main() {
    const documents = Number.parseInt(process.argv[2], 10) || 200;
    const corpus = buildCorpus({ documents });

    let provider;
    try {
        provider = createProvider();
    } catch (error) {
        console.error(
            `No language model is configured: ${error.message}\n` +
            'This run measures the model, so it cannot proceed without one.',
        );
        process.exit(2);
    }

    console.error(
        `Running ${corpus.length} documents against ${provider.name}` +
        (provider.sendsDataOffPremise
            ? ' — note: this provider sends document text off premise'
            : ''),
    );

    const report = await evaluate(corpus, { provider: null });
    console.log(describe(report));
    console.log(JSON.stringify(report, null, 2));

    // Non-zero on failure so a pipeline can gate on it.
    process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(3);
});
