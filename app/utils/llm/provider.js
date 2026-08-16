/**
 * Language model provider interface.
 *
 * One interface with two adapters. The prototype calls a hosted API; a
 * government deployment runs the same model on its own hardware. Neither the
 * extraction logic nor anything above it changes between them, so the choice
 * of where the model runs is a configuration decision rather than a rewrite.
 *
 * This matters beyond convenience. Sending donation documents to a hosted
 * endpoint means the text leaves the perimeter, which is a decision about
 * personal data rather than about latency. Keeping the boundary at one
 * interface makes it a thing an operator can see and move.
 */

const DEFAULT_MODEL = 'deepseek/deepseek-r1-distill-qwen-7b';
const DEFAULT_TIMEOUT_MS = 60_000;

class ProviderError extends Error {
    constructor(message, { retryable = false, status = null } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.retryable = retryable;
        this.status = status;
    }
}

/**
 * Send a chat completion request and return the raw text.
 *
 * Adapters differ only in endpoint, headers, and how they report failure.
 * Neither adapter interprets the response: understanding what the model said
 * belongs to the extraction layer, which is where it can be validated.
 */
class LlmProvider {
    constructor({ model, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        this.model = model || process.env.LLM_MODEL || DEFAULT_MODEL;
        this.timeoutMs = timeoutMs;
    }

    get name() {
        return 'abstract';
    }

    /** Whether document text leaves the deployment perimeter to reach this provider. */
    get sendsDataOffPremise() {
        return true;
    }

    async complete() {
        throw new Error('not implemented');
    }

    async _post(url, headers, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new ProviderError(
                    `${this.name} returned ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
                    // Rate limits and upstream faults are worth retrying; a
                    // rejected request will be rejected again.
                    { retryable: response.status === 429 || response.status >= 500, status: response.status },
                );
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                throw new ProviderError(`${this.name} returned no message content`);
            }
            return content.trim();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new ProviderError(
                    `${this.name} did not respond within ${this.timeoutMs}ms`,
                    { retryable: true },
                );
            }
            throw error instanceof ProviderError
                ? error
                : new ProviderError(`${this.name} request failed: ${error.message}`, { retryable: true });
        }
    }
}

/**
 * Hosted provider used by the prototype deployment.
 */
class OpenRouterProvider extends LlmProvider {
    get name() {
        return 'openrouter';
    }

    get sendsDataOffPremise() {
        return true;
    }

    async complete({ system, user, temperature = 0.1, maxTokens = 2000 }) {
        const url = process.env.OPENROUTER_API_URL;
        const key = process.env.OPENROUTER_API_KEY;
        if (!url || !key) {
            throw new ProviderError(
                'OPENROUTER_API_URL and OPENROUTER_API_KEY must both be set',
            );
        }

        return this._post(
            url,
            {
                Authorization: `Bearer ${key}`,
                'HTTP-Referer': 'https://cakradana-api.faizath.com',
                'X-Title': 'Cakradana',
            },
            {
                model: process.env.OPENROUTER_API_MODEL || this.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                temperature,
                max_tokens: maxTokens,
                top_p: 0.9,
            },
        );
    }
}

/**
 * Self-hosted provider, for deployments that must keep documents inside their
 * own perimeter. Speaks the OpenAI-compatible chat completions shape that
 * vLLM, Ollama, and TGI all expose.
 */
class SelfHostedProvider extends LlmProvider {
    get name() {
        return 'self-hosted';
    }

    get sendsDataOffPremise() {
        return false;
    }

    async complete({ system, user, temperature = 0.1, maxTokens = 2000 }) {
        const url = process.env.LLM_BASE_URL;
        if (!url) {
            throw new ProviderError('LLM_BASE_URL must be set for the self-hosted provider');
        }
        const headers = {};
        if (process.env.LLM_API_KEY) {
            headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;
        }

        return this._post(`${url.replace(/\/$/, '')}/chat/completions`, headers, {
            model: this.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            temperature,
            max_tokens: maxTokens,
            top_p: 0.9,
        });
    }
}

/**
 * Build the configured provider.
 *
 * Defaults to the hosted adapter, which is what the prototype runs on. A
 * deployment that must not send documents off-premise sets LLM_PROVIDER to
 * `self-hosted` and points LLM_BASE_URL at its own inference server.
 */
function createProvider(options = {}) {
    const configured = (process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    switch (configured) {
        case 'self-hosted':
        case 'selfhosted':
        case 'local':
            return new SelfHostedProvider(options);
        case 'openrouter':
            return new OpenRouterProvider(options);
        default:
            throw new ProviderError(
                `unknown LLM_PROVIDER '${configured}'; expected 'openrouter' or 'self-hosted'`,
            );
    }
}

module.exports = {
    LlmProvider,
    OpenRouterProvider,
    SelfHostedProvider,
    ProviderError,
    createProvider,
    DEFAULT_MODEL,
};
