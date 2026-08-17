require('dotenv').config();

const mongodb = require('./configs/database/mongodb/mongodb.client');
mongodb.connectDB();

const app = require('./server');
const retention = require('./domains/canonical/retention.scheduler');
const { log } = require('./utils/observability/logging');

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    log.info('server listening', { port: Number(PORT) });
});

// A retention period nothing enforces is not a retention period. Started here
// rather than left to an external cron, so a deployment cannot end up running
// the service without it.
retention.start();
