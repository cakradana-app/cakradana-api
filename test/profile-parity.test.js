/**
 * Deployment-profile parity.
 *
 * Two profiles exist. The reference architecture is fully on-premise, with a
 * self-hosted model, and is what gets proposed to an operating authority. The
 * prototype calls a hosted API for the same model. The claim the split rests on
 * is that they detect the same things — that a donation judged in one would be
 * judged identically in the other, and the only difference is where the
 * inference runs.
 *
 * That claim was asserted in prose and nowhere tested, which is the state in
 * which it stops being true without anybody noticing: a header added to one
 * adapter, a temperature nudged in the other, and the two deployments quietly
 * disagree about the same document.
 *
 * So what is checked here is that the two adapters differ in exactly one
 * respect — whether the document leaves the premises — and agree on everything
 * that could change an outcome.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OpenRouterProvider,
    SelfHostedProvider,
    ProviderError,
    createProvider,
} = require('../app/utils/llm/provider');
const {
    extractDonations,
    buildSystemPrompt,
    buildUserPrompt,
} = require('../app/utils/llm/extraction');

const PROMPT = {
    system: 'you extract donations',
    user: 'a document',
    temperature: 0.1,
    maxTokens: 2000,
};

/** Run a provider against a scripted HTTP layer, returning what it sent. */
async function capture(provider, respond) {
    const originalFetch = global.fetch;
    const sent = [];
    global.fetch = async (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body) });
        return respond();
    };
    try {
        const content = await provider.complete(PROMPT);
        return { sent, content };
    } finally {
        global.fetch = originalFetch;
    }
}

function ok(content) {
    return () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
    });
}

function failing(status, statusText = 'Error') {
    return () => ({
        ok: false,
        status,
        statusText,
        text: async () => 'upstream said no',
    });
}

function providers(env) {
    Object.assign(process.env, env);
    return {
        hosted: new OpenRouterProvider(),
        selfHosted: new SelfHostedProvider(),
    };
}

const ENV = {
    OPENROUTER_API_URL: 'https://openrouter.example/api/v1/chat/completions',
    OPENROUTER_API_KEY: 'test-key',
    LLM_BASE_URL: 'https://inference.internal/v1',
};

test('both profiles send the same conversation to the model', async () => {
    // A prompt that differs between deployments is a different model input,
    // and the two would extract different values from the same document.
    const { hosted, selfHosted } = providers(ENV);
    const a = await capture(hosted, ok('[]'));
    const b = await capture(selfHosted, ok('[]'));
    assert.deepEqual(a.sent[0].body.messages, b.sent[0].body.messages);
});

test('both profiles use the same sampling parameters', async () => {
    // Temperature and top_p decide how much the model invents. A deployment
    // sampling more freely produces values with no source in the document.
    const { hosted, selfHosted } = providers(ENV);
    const a = (await capture(hosted, ok('[]'))).sent[0].body;
    const b = (await capture(selfHosted, ok('[]'))).sent[0].body;
    assert.equal(a.temperature, b.temperature);
    assert.equal(a.top_p, b.top_p);
    assert.equal(a.max_tokens, b.max_tokens);
});

test('both profiles read the response the same way', async () => {
    const { hosted, selfHosted } = providers(ENV);
    const a = await capture(hosted, ok('  extracted  '));
    const b = await capture(selfHosted, ok('  extracted  '));
    assert.equal(a.content, 'extracted');
    assert.equal(b.content, a.content);
});

test('both profiles refuse a response carrying no content', async () => {
    const empty = () => ({ ok: true, json: async () => ({ choices: [] }) });
    const { hosted, selfHosted } = providers(ENV);
    for (const provider of [hosted, selfHosted]) {
        await assert.rejects(
            () => capture(provider, empty),
            /returned no message content/,
        );
    }
});

test('both profiles agree on which failures are worth retrying', async () => {
    // A deployment that retries a rejected request and one that gives up on a
    // rate limit end up with different sets of documents extracted.
    const { hosted, selfHosted } = providers(ENV);
    for (const [status, retryable] of [[429, true], [503, true], [400, false]]) {
        for (const provider of [hosted, selfHosted]) {
            const error = await capture(provider, failing(status)).catch((e) => e);
            assert.ok(error instanceof ProviderError, `${provider.name} ${status}`);
            assert.equal(
                error.retryable,
                retryable,
                `${provider.name} treated ${status} as retryable=${error.retryable}`,
            );
        }
    }
});

test('the one difference between the profiles is where the document goes', async () => {
    // This is the whole reason two adapters exist. If it were not true, the
    // on-premise profile would not be on-premise.
    const { hosted, selfHosted } = providers(ENV);
    assert.equal(hosted.sendsDataOffPremise, true);
    assert.equal(selfHosted.sendsDataOffPremise, false);

    const a = await capture(hosted, ok('[]'));
    const b = await capture(selfHosted, ok('[]'));
    assert.match(a.sent[0].url, /openrouter\.example/);
    assert.match(b.sent[0].url, /inference\.internal/);
});

test('the self-hosted profile refuses to run without somewhere to run', async () => {
    // Falling back to the hosted API would send documents off-premise from a
    // deployment configured precisely to prevent that.
    delete process.env.LLM_BASE_URL;
    await assert.rejects(
        () => new SelfHostedProvider().complete(PROMPT),
        /LLM_BASE_URL must be set/,
    );
    process.env.LLM_BASE_URL = ENV.LLM_BASE_URL;
});

test('an unrecognised profile is refused rather than defaulted', async () => {
    // Silently choosing the hosted adapter for a misspelled 'self-hsoted'
    // would send documents off-premise and report success.
    const previous = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'self-hsoted';
    assert.throws(() => createProvider(), /unknown LLM_PROVIDER/);
    if (previous === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous;
});

test('the prompt does not depend on which profile is configured', () => {
    // The prompt is generated from the shared vocabulary, so this holds by
    // construction — and is asserted so that it keeps holding.
    const previous = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'openrouter';
    const hostedSystem = buildSystemPrompt();
    const hostedUser = buildUserPrompt('Budi Santoso menyumbang Rp10.000.000');
    process.env.LLM_PROVIDER = 'self-hosted';
    assert.equal(buildSystemPrompt(), hostedSystem);
    assert.equal(buildUserPrompt('Budi Santoso menyumbang Rp10.000.000'), hostedUser);
    if (previous === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous;
});

test('the same document extracts identically through either adapter', async () => {
    // The claim that matters, and the earlier version of this test did not
    // check it: `extractDonations` skips `createProvider()` entirely when a
    // provider is passed in, so stubbing the provider and flipping
    // LLM_PROVIDER around it asserted f(x) === f(x). It could not fail however
    // far the two adapters diverged — the one thing this file exists to catch.
    //
    // Each side now goes through the real adapter, built by createProvider()
    // under its own profile, with only the HTTP layer scripted.
    const document =
        'Budi Santoso menyumbang Rp10.000.000 kepada Partai Maju pada 5 Juni 2026.';
    const modelReply = JSON.stringify([
        {
            sender: 'Budi Santoso',
            sender_span: 'Budi Santoso',
            receiver: 'Partai Maju',
            receiver_span: 'Partai Maju',
            amount: 'Rp10.000.000',
            amount_span: 'Rp10.000.000',
            date: '2026-06-05',
            date_span: '5 Juni 2026',
        },
    ]);

    const previous = process.env.LLM_PROVIDER;
    const originalFetch = global.fetch;
    const sent = [];
    global.fetch = async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: modelReply } }] }),
        };
    };

    try {
        providers(ENV);
        process.env.LLM_PROVIDER = 'openrouter';
        const hosted = await extractDonations(document, { provider: createProvider() });

        process.env.LLM_PROVIDER = 'self-hosted';
        const selfHosted = await extractDonations(document, { provider: createProvider() });

        // Both adapters were genuinely exercised, and against different hosts.
        assert.equal(sent.length, 2);
        assert.match(sent[0].url, /openrouter\.example/);
        assert.match(sent[1].url, /inference\.internal/);

        // The detection output is identical. `provider` and `sentOffPremise`
        // are the one permitted difference — they record which adapter ran and
        // whether the document left the premises, which is the whole reason
        // two adapters exist, and are provenance rather than findings.
        const { provider: _a, sentOffPremise: offPremise, ...hostedFindings } = hosted;
        const {
            provider: _b,
            sentOffPremise: onPremise,
            ...selfHostedFindings
        } = selfHosted;
        assert.deepEqual(selfHostedFindings, hostedFindings);
        assert.equal(offPremise, true);
        assert.equal(onPremise, false);

        assert.equal(hosted.donations.length, 1);
        assert.equal(hosted.donations[0].fields.amount, 10_000_000);
        assert.equal(hosted.donations[0].fields.sender, 'Budi Santoso');
    } finally {
        global.fetch = originalFetch;
        if (previous === undefined) delete process.env.LLM_PROVIDER;
        else process.env.LLM_PROVIDER = previous;
    }
});

test('a divergence between the adapters would fail this file', async () => {
    // A guard on the guard: if the two adapters sent different conversations,
    // the parity tests above compare those bodies directly and would fail. This
    // asserts the comparison has something to compare — that both adapters
    // actually issued a request rather than one silently short-circuiting.
    const { hosted, selfHosted } = providers(ENV);
    const a = await capture(hosted, ok('[]'));
    const b = await capture(selfHosted, ok('[]'));
    assert.equal(a.sent.length, 1);
    assert.equal(b.sent.length, 1);
    assert.notEqual(a.sent[0].url, b.sent[0].url);
});
