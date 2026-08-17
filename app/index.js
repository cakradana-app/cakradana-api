require('dotenv').config();

const mongodb = require('./configs/database/mongodb/mongodb.client');
mongodb.connectDB();

const app = require('./server');
const retention = require('./domains/canonical/retention.scheduler');
const sweeper = require('./utils/scoring/sweeper');
const jobs = require('./domains/services/jobs/job.controller');
const { log } = require('./utils/observability/logging');

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    log.info('server listening', { port: Number(PORT) });
});

// A retention period nothing enforces is not a retention period. Started here
// rather than left to an external cron, so a deployment cannot end up running
// the service without it.
retention.start();

// Ingestion never blocks on scoring, which is only honest if something later
// picks up what was left outstanding. Without the sweep, a donation nothing
// evaluated is indistinguishable from one evaluated and found clean.
sweeper.start();

// A job still claiming to be running days after the process that owned it died
// invites waiting; one that admits it was interrupted invites re-uploading.
jobs.reapInterrupted().catch((error) =>
    log.error('could not reap interrupted jobs', { error: error.message }),
);
