const { createWorker } = require('tesseract.js');

const tesseractConfig = require('../../../configs/ocr/tesseract.config');
const { extractDonations } = require('../../../utils/llm/extraction');
const { candidatesFromExtraction, ingestBatch } = require('../../canonical/ingest');
const { Donation } = require('../../canonical/canonical.model');
const scoring = require('../../../utils/scoring/client');

/**
 * OCR confidence below which a page's text is treated as unreliable.
 *
 * A badly scanned page yields plausible-looking words that were never on it.
 * Extracting donations from that produces attributions to people the document
 * does not name, which is the one failure this pipeline must not make quietly.
 */
const MIN_PAGE_CONFIDENCE = 40;

const input = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'No images were uploaded',
                data: {},
            });
        }

        const language =
            req.query.lang && tesseractConfig.availableLanguages[req.query.lang]
                ? req.query.lang
                : tesseractConfig.defaultLanguage;

        const pages = [];
        const worker = await createWorker(language, 1, {
            langPath: tesseractConfig.langPath,
            ...tesseractConfig.workerOptions,
        });

        try {
            for (const file of req.files) {
                const { data } = await worker.recognize(file.buffer);
                pages.push({
                    filename: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                    text: (data.text || '').trim(),
                    confidence: typeof data.confidence === 'number' ? data.confidence : null,
                    language,
                    languageName: tesseractConfig.availableLanguages[language],
                });
            }
        } finally {
            await worker.terminate();
        }

        const usable = pages.filter(
            (page) =>
                page.text.length > 0 &&
                (page.confidence === null || page.confidence >= MIN_PAGE_CONFIDENCE),
        );
        const unreadable = pages.filter((page) => !usable.includes(page));

        // Pages are extracted separately so a donation can be traced back to
        // the page it was read from. Concatenating them first would leave a
        // finding pointing at a document rather than at a place in it, which
        // is not something a subject can check.
        const extractions = [];
        for (const page of usable) {
            const extraction = await extractDonations(page.text);
            extractions.push({ page, extraction });
        }

        const candidates = extractions.flatMap(({ page, extraction }) =>
            candidatesFromExtraction(extraction, {
                channel: 'paper-form',
                sourceReference: page.filename,
                retrievedAt: new Date(),
            }),
        );

        const summary = await ingestBatch(candidates);

        const stored = await Donation.find({
            _id: {
                $in: summary.results
                    .filter((r) => r.status === 'ingested')
                    .map((r) => r.donationId),
            },
        });
        const scored = await scoring.scoreMany(stored, { requestId: `paper-${Date.now()}` });

        return res.status(200).json({
            status: 'success',
            message:
                `Processed ${pages.length} image(s) and ingested ${summary.ingested} donation(s)`,
            data: {
                ocr: pages.map(({ filename, confidence, text, languageName }) => ({
                    filename,
                    confidence,
                    languageName,
                    characters: text.length,
                })),
                // Named rather than counted, so an operator can see which
                // uploads produced nothing and re-scan them.
                unreadable: unreadable.map((page) => ({
                    filename: page.filename,
                    confidence: page.confidence,
                    reason:
                        page.text.length === 0
                            ? 'no text could be read from this image'
                            : `OCR confidence ${page.confidence} is too low to extract from`,
                })),
                extracted: extractions.reduce((n, e) => n + e.extraction.donations.length, 0),
                rejected: extractions.flatMap(({ page, extraction }) =>
                    extraction.rejected.map((r) => ({ filename: page.filename, ...r })),
                ),
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
    } catch (error) {
        console.error('Error during OCR processing:', error);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? error.message : 'Error processing images',
            data: {},
        });
    }
};

module.exports = { input };
