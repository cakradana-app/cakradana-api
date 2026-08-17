/**
 * Running work behind a handle, and reporting on it.
 *
 * The runner is in-process. That is a deliberate limit rather than an
 * oversight: a queue backed by a broker is the right answer at the volumes in
 * the scale requirements, and this is not that. What it does provide is the
 * property the synchronous version could not — the uploader's connection is no
 * longer what decides whether the work survives.
 *
 * A restart loses running jobs. They are marked as such on the way back up
 * rather than left as 'running' forever, because a job that says it is running
 * three days after the process that owned it died is worse than one that
 * admits it was interrupted.
 */

const { Job } = require('./job.model');
const { log } = require('../../../utils/observability/logging');
const metrics = require('../../../utils/observability/metrics');

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

/**
 * Start a job and return its handle immediately.
 *
 * `work` receives a reporter it calls as it goes. Whatever it returns becomes
 * the result; whatever it throws becomes the error, and neither takes the
 * process down.
 */
async function run(kind, { actor = null, total = 0 }, work) {
    const job = await Job.create({
        kind,
        createdBy: actor,
        state: 'queued',
        progress: { done: 0, total, stage: 'queued' },
    });

    const report = async (done, stage) => {
        await Job.updateOne(
            { _id: job._id },
            { 'progress.done': done, 'progress.stage': stage },
        );
    };

    // Deliberately not awaited: the caller gets the handle now.
    (async () => {
        const started = Date.now();
        await Job.updateOne(
            { _id: job._id },
            { state: 'running', startedAt: new Date(), 'progress.stage': 'starting' },
        );
        try {
            const result = await work(report);
            const failures = result?.errors || [];
            await Job.updateOne(
                { _id: job._id },
                {
                    state: failures.length ? 'partially_succeeded' : 'succeeded',
                    result,
                    failures,
                    finishedAt: new Date(),
                    'progress.stage': 'done',
                },
            );
            metrics.increment('cakradana_jobs_total', {
                kind,
                outcome: failures.length ? 'partial' : 'ok',
            });
            metrics.observe('cakradana_job_duration_ms', Date.now() - started, { kind });
        } catch (error) {
            log.error('job failed', { kind, job_id: String(job._id), error: error.message });
            metrics.increment('cakradana_jobs_total', { kind, outcome: 'failed' });
            await Job.updateOne(
                { _id: job._id },
                {
                    state: 'failed',
                    failures: [error.message],
                    finishedAt: new Date(),
                    'progress.stage': 'failed',
                },
            );
        }
    })();

    return job;
}

const status = async (req, res) => {
    try {
        const job = await Job.findById(req.params.jobId).lean();
        if (!job) return fail(res, 404, 'No such job');

        return res.status(200).json({
            status: 'success',
            message: 'Job status',
            data: {
                job_id: String(job._id),
                kind: job.kind,
                state: job.state,
                progress: job.progress,
                // Both present on a partial success. A batch where two of ten
                // pages were unreadable succeeded at eight and failed at two,
                // and reporting only one half loses the other.
                result: job.result,
                failures: job.failures,
                started_at: job.startedAt,
                finished_at: job.finishedAt,
            },
        });
    } catch (err) {
        console.error('Error reading job:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

const list = async (req, res) => {
    try {
        const filter = {};
        if (req.query.kind) filter.kind = req.query.kind;
        if (req.query.state) filter.state = req.query.state;
        if (req.query.mine === 'true') filter.createdBy = req.user?.email || null;

        const jobs = await Job.find(filter)
            .sort({ createdAt: -1 })
            .limit(Math.min(Number.parseInt(req.query.limit, 10) || 25, 100))
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Jobs',
            data: jobs.map((job) => ({
                job_id: String(job._id),
                kind: job.kind,
                state: job.state,
                progress: job.progress,
                created_at: job.createdAt,
                finished_at: job.finishedAt,
            })),
        });
    } catch (err) {
        console.error('Error listing jobs:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

/**
 * Mark jobs orphaned by a restart.
 *
 * Called at startup. A job still claiming to be running days after the process
 * that owned it died is worse than one that admits it was interrupted: the
 * first invites waiting, the second invites re-uploading.
 */
async function reapInterrupted() {
    const result = await Job.updateMany(
        { state: { $in: ['queued', 'running'] } },
        {
            state: 'failed',
            failures: ['interrupted by a restart; the work did not complete'],
            finishedAt: new Date(),
            'progress.stage': 'interrupted',
        },
    );
    if (result.modifiedCount) {
        log.warn('marked jobs interrupted by restart', { jobs: result.modifiedCount });
    }
    return result.modifiedCount ?? 0;
}

module.exports = { run, status, list, reapInterrupted };
