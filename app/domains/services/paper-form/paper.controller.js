/**
 * Paper forms: OCR, extraction, ingestion.
 *
 * Asynchronous. A ten-page scan is ten OCR passes and ten model calls, and
 * holding the connection open for that ties the upload's success to a proxy's
 * idle timeout — the work finishes, the connection is already gone, and the
 * uploader is told it failed. They upload again, and deduplication is all that
 * stands between that and doubled records.
 *
 * The upload now returns a handle straight away and the work continues behind
 * it, reporting progress as it goes.
 */

const { createWorker } = require('tesseract.js');

const tesseractConfig = require('../../../configs/ocr/tesseract.config');
const { extractDonations } = require('../../../utils/llm/extraction');
const { candidatesFromExtraction, ingestBatch } = require('../../canonical/ingest');
const { Donation } = require('../../canonical/canonical.model');
const scoring = require('../../../utils/scoring/client');
const jobs = require('../jobs/job.controller');
const metrics = require('../../../utils/observability/metrics');

/**
 * OCR confidence below which a page's text is treated as unreliable.
 *
 * A badly scanned page yields plausible-looking words that were never on it.
 * Extracting donations from that produces attributions to people the document
 * does not name, which is the one failure this pipeline must not make quietly.
 */
const MIN_PAGE_CONFIDENCE = 40;

/**
 * The work itself, separated from the request so it can run after the response
 * and be exercised without one.
 */
async function processPages(files, { language, actor, report }) {
    const pages = [];
    const worker = await createWorker(language, 1, {
        langPath: tesseractConfig.langPath,
        ...tesseractConfig.workerOptions,
    });

    try {
        let done = 0;
        for (const file of files) {
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
            done += 1;
            await report(done, `read ${done} of ${files.length} page(s)`);
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

    // Pages are extracted separately so a donation can be traced back to the
    // page it was read from. Concatenating them first would leave a finding
    // pointing at a document rather than at a place in it, which is not
    // something a subject can check.
    const extractions = [];
    let extracted = 0;
    for (const page of usable) {
        const extraction = await extractDonations(page.text);
        extractions.push({ page, extraction });
        extracted += 1;
        await report(
            pages.length + extracted,
            `extracted from ${extracted} of ${usable.length} readable page(s)`,
        );
    }

    const candidates = extractions.flatMap(({ page, extraction }) =>
        candidatesFromExtraction(extraction, {
            channel: 'paper-form',
            sourceReference: page.filename,
            retrievedAt: new Date(),
        }),
    );

    await report(pages.length + usable.length, 'ingesting');
    const summary = await ingestBatch(candidates);

    metrics.increment(
        'cakradana_extraction_records_total',
        { channel: 'paper-form', outcome: 'ingested' },
        summary.ingested,
    );
    metrics.increment(
        'cakradana_extraction_records_total',
        { channel: 'paper-form', outcome: 'quarantined' },
        summary.quarantined,
    );

    const stored = await Donation.find({
        _id: {
            $in: summary.results
                .filter((r) => r.status === 'ingested')
                .map((r) => r.donationId),
        },
    });
    const scored = await scoring.scoreMany(stored, { requestId: `paper-${Date.now()}` });

    return {
        ocr: pages.map(({ filename, confidence, text, languageName }) => ({
            filename,
            confidence,
            languageName,
            characters: text.length,
        })),
        // Named rather than counted, so an operator can see which uploads
        // produced nothing and re-scan them.
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
        // Surfaced on the job so a partial outcome is visible without reading
        // the whole result.
        errors: unreadable.map((page) => `${page.filename}: unreadable`),
    };
}

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

        // The buffers are held for the life of the job. Multer keeps them in
        // memory rather than on disk, so nothing unencrypted is written down
        // for a scanned identity document.
        const files = req.files.map((file) => ({
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
        }));

        const job = await jobs.run(
            'paper-extraction',
            {
                actor: req.user?.email || null,
                // Each page is read once and extracted once.
                total: files.length * 2,
            },
            (report) =>
                processPages(files, { language, actor: req.user?.email || null, report }),
        );

        return res.status(202).json({
            status: 'success',
            message: `Processing ${files.length} image(s)`,
            data: {
                job_id: String(job._id),
                pages: files.length,
                language,
                poll: `/service/jobs/${job._id}`,
                // Said plainly: a 202 means accepted, and a caller that treats
                // it as "ingested" would report a success that has not
                // happened yet.
                note: 'accepted for processing; nothing has been ingested yet',
            },
        });
    } catch (error) {
        console.error('Error accepting upload:', error);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? error.message : 'Error processing images',
            data: {},
        });
    }
};

module.exports = { input, processPages, MIN_PAGE_CONFIDENCE };
