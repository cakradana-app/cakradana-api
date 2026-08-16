/**
 * Client for the scoring service.
 *
 * Sends canonical donation records. It does not send engineered features and
 * cannot: the code that computes them lives with the model, which is what
 * keeps training and serving on one implementation. The previous scoring
 * service demanded fourteen pre-computed inputs that nothing here could
 * produce, so the two services were never connectable at all.
 *
 * Ingestion never blocks on scoring. A donation that has been received and
 * validated is a fact worth keeping whether or not anything has judged it yet,
 * so a scoring failure leaves the record in place and the score outstanding.
 */

const { ScoringEvent } = require('../../domains/canonical/canonical.model');

const DEFAULT_TIMEOUT_MS = 15_000;

class ScoringUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScoringUnavailable';
    }
}

function baseUrl() {
    return (process.env.SCORING_SERVICE_URL || '').replace(/\/$/, '');
}

function isConfigured() {
    return Boolean(baseUrl() && process.env.SCORING_SERVICE_TOKEN);
}

/**
 * Shape a stored donation into the scoring contract.
 *
 * Only what the service is entitled to derive from: the record, its parties,
 * and its timestamps. Nothing is computed here.
 */
function toPayload(donation) {
    return {
        donation_id: String(donation._id),
        donation_version: donation.donationVersion || 1,
        sender_ref: {
            entity_id: donation.senderRef?.entityId ? String(donation.senderRef.entityId) : null,
            raw_text: donation.senderRef?.rawText || null,
            entity_type: donation.senderRef?.entityType || 'unknown',
            resolution_confidence: donation.senderRef?.resolutionConfidence ?? null,
        },
        receiver_ref: {
            entity_id: donation.receiverRef?.entityId ? String(donation.receiverRef.entityId) : null,
            raw_text: donation.receiverRef?.rawText || null,
            entity_type: donation.receiverRef?.entityType || 'unknown',
            resolution_confidence: donation.receiverRef?.resolutionConfidence ?? null,
        },
        amount_idr: donation.amountIdr,
        amount_raw: donation.amountRaw || null,
        occurred_at: donation.occurredAt.toISOString(),
        occurred_at_precision: donation.occurredAtPrecision || 'day',
        recorded_at: donation.recordedAt.toISOString(),
        transaction_kind: donation.transactionKind || 'unknown',
        channel: donation.channel,
        electoral_context: donation.electoralContext || null,
        is_self_funded_declared: donation.isSelfFundedDeclared ?? null,
    };
}

async function post(path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!isConfigured()) {
        throw new ScoringUnavailable(
            'SCORING_SERVICE_URL and SCORING_SERVICE_TOKEN must both be set',
        );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${baseUrl()}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.SCORING_SERVICE_TOKEN}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new ScoringUnavailable(
                `scoring service returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
            );
        }
        return response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new ScoringUnavailable(`scoring service did not respond within ${timeoutMs}ms`);
        }
        throw error instanceof ScoringUnavailable
            ? error
            : new ScoringUnavailable(`scoring service unreachable: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Persist a scoring result against the donation version it judged.
 *
 * Events accumulate rather than replace. A re-score is a new event, so an
 * analyst who cleared an alert can still see what they were looking at and a
 * subject contesting a score can see the score they are contesting.
 */
async function recordEvent(donation, result, rescoreReason = null) {
    return ScoringEvent.create({
        donationId: donation._id,
        donationVersion: donation.donationVersion || 1,
        scoredAt: result.scored_at ? new Date(result.scored_at) : new Date(),
        modelVersion: result.versions?.model || null,
        ruleSetVersion: result.versions?.rule_set,
        featureSetVersion: result.versions?.features,
        legalFindings: result.legal_findings || [],
        indeterminateRules: result.indeterminate_rules || [],
        behavioural: result.behavioural || null,
        rescoreReason,
    });
}

async function scoreDonation(donation, { requestId = null } = {}) {
    const body = {
        request_id: requestId || `score-${donation._id}`,
        donation: toPayload(donation),
    };
    const response = await post('/v1/score', body);
    const result = response.result;
    await recordEvent(donation, result);
    return result;
}

/**
 * Score a set of donations without letting a failure lose the records.
 *
 * Returns what succeeded and what did not. Callers report the outstanding work
 * rather than treating the batch as failed, because the donations are already
 * stored and a score can be produced later.
 */
async function scoreMany(donations, { requestId = null } = {}) {
    if (!donations.length) return { scored: [], pending: [], available: isConfigured() };
    if (!isConfigured()) {
        return {
            scored: [],
            pending: donations.map((d) => String(d._id)),
            available: false,
            reason: 'the scoring service is not configured',
        };
    }

    try {
        const response = await post('/v1/score/batch', {
            request_id: requestId || `batch-${Date.now()}`,
            donations: donations.map(toPayload),
        });

        const byId = new Map(donations.map((d) => [String(d._id), d]));
        const scored = [];
        const pending = [];

        for (const item of response.items || []) {
            const donation = byId.get(item.donation_id);
            if (item.ok && donation) {
                await recordEvent(donation, item.result);
                scored.push(item.donation_id);
            } else {
                pending.push(item.donation_id);
            }
        }
        return { scored, pending, available: true };
    } catch (error) {
        // Scoring is downstream of storage. The donations are kept and the
        // work stays outstanding rather than the ingestion reporting failure.
        return {
            scored: [],
            pending: donations.map((d) => String(d._id)),
            available: false,
            reason: error.message,
        };
    }
}

module.exports = {
    scoreDonation,
    scoreMany,
    toPayload,
    recordEvent,
    isConfigured,
    ScoringUnavailable,
};
