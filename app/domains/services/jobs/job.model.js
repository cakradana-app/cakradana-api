/**
 * Long-running work, and its progress.
 *
 * Extracting donations from a ten-page scan means ten OCR passes and ten model
 * calls. Holding the HTTP connection open for that ties the upload's success to
 * a proxy's idle timeout: the work completes, the connection has already been
 * dropped, and the uploader is told it failed. They upload again, and the
 * deduplication is the only thing standing between that and doubled records.
 *
 * So the upload returns a handle and the work continues behind it. The handle
 * is worth little without progress, because a job that reports nothing until it
 * finishes is indistinguishable from a job that has hung.
 */

const mongoose = require('mongoose');

const JOB_STATES = Object.freeze([
    'queued',
    'running',
    'succeeded',
    'partially_succeeded',
    'failed',
]);

const jobSchema = new mongoose.Schema(
    {
        kind: { type: String, required: true },
        state: { type: String, enum: JOB_STATES, default: 'queued' },
        createdBy: { type: String, default: null },

        // What the job is working through, so a caller can tell slow from
        // stuck. Both numbers, because a percentage alone hides whether the
        // denominator was what the uploader expected.
        progress: {
            done: { type: Number, default: 0 },
            total: { type: Number, default: 0 },
            stage: { type: String, default: null },
        },

        result: { type: mongoose.Schema.Types.Mixed, default: null },
        // Named `failures` rather than `errors`: mongoose reserves the latter
        // for a document's own validation state, and shadowing it makes
        // validation errors and job errors the same field.
        //
        // Present on a partial success as well as a failure. A batch where two
        // of ten pages were unreadable succeeded at eight and failed at two,
        // and reporting only the eight would lose the two.
        failures: { type: [String], default: [] },

        startedAt: { type: Date, default: null },
        finishedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

jobSchema.index({ state: 1, createdAt: -1 });
jobSchema.index({ createdBy: 1, createdAt: -1 });

jobSchema.virtual('durationMs').get(function durationMs() {
    if (!this.startedAt) return null;
    return (this.finishedAt || new Date()).getTime() - this.startedAt.getTime();
});

const Job = mongoose.model('Job', jobSchema);

module.exports = { Job, JOB_STATES };
