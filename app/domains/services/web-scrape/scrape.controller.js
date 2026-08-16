const cheerio = require('cheerio');

const { extractDonations } = require('../../../utils/llm/extraction');
const { candidatesFromExtraction, ingestBatch } = require('../../canonical/ingest');
const { Donation } = require('../../canonical/canonical.model');
const scoring = require('../../../utils/scoring/client');

/** Elements whose text is page furniture rather than content. */
const NON_CONTENT = 'script, style, noscript, nav, header, footer, svg';

/**
 * Cap on how much page text is sent for extraction.
 *
 * A scraped page can be arbitrarily long, and the cost and the injection
 * surface both scale with it. Truncation is reported rather than silent, so a
 * short result can be told from a truncated one.
 */
const MAX_TEXT_LENGTH = 40_000;

const input = async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                status: 'error',
                message: 'URL is required',
                data: {},
            });
        }

        let target;
        try {
            target = new URL(url);
        } catch (_) {
            return res.status(400).json({
                status: 'error',
                message: 'URL is not valid',
                data: {},
            });
        }

        // Only fetch over HTTP(S). Without this the endpoint will follow
        // whatever scheme it is handed, which turns an authenticated user into
        // a way of reading files and internal services through this server.
        if (!['http:', 'https:'].includes(target.protocol)) {
            return res.status(400).json({
                status: 'error',
                message: 'Only http and https URLs can be scraped',
                data: {},
            });
        }

        const response = await fetch(target, { redirect: 'follow' });
        if (!response.ok) {
            return res.status(400).json({
                status: 'error',
                message: `Failed to fetch URL: ${response.status} ${response.statusText}`,
                data: {},
            });
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        $(NON_CONTENT).remove();

        const rawText = $('body').text().replace(/\s+/g, ' ').trim();
        const truncated = rawText.length > MAX_TEXT_LENGTH;
        const text = truncated ? rawText.slice(0, MAX_TEXT_LENGTH) : rawText;

        if (!text) {
            return res.status(400).json({
                status: 'error',
                message: 'No text content found in the webpage',
                data: {},
            });
        }

        const extraction = await extractDonations(text);
        const candidates = candidatesFromExtraction(extraction, {
            channel: 'web-scrape',
            sourceReference: target.toString(),
            retrievedAt: new Date(),
        });

        const summary = await ingestBatch(candidates);

        // Scoring runs after the records are stored and never gates them. A
        // donation that has been received and validated is worth keeping
        // whether or not anything has judged it yet.
        const stored = await Donation.find({
            _id: {
                $in: summary.results
                    .filter((r) => r.status === 'ingested')
                    .map((r) => r.donationId),
            },
        });
        const scored = await scoring.scoreMany(stored, { requestId: `scrape-${Date.now()}` });

        return res.status(200).json({
            status: 'success',
            message: `Ingested ${summary.ingested} donation(s) from ${target.hostname}`,
            data: {
                url: target.toString(),
                truncated,
                extracted: extraction.donations.length,
                // What the extractor declined to record, and why. An empty
                // result means something different when the page had no
                // donations than when nothing in it could be trusted.
                rejected: extraction.rejected,
                ingested: summary.ingested,
                duplicates: summary.duplicates,
                quarantined: summary.quarantined,
                needsEntityReview: summary.needsEntityReview,
                scoring: {
                    available: scored.available,
                    scored: scored.scored.length,
                    pending: scored.pending.length,
                    reason: scored.reason || null,
                },
            },
        });
    } catch (err) {
        console.error('Web scraping error:', err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Bad Request',
            data: {},
        });
    }
};

module.exports = { input };
