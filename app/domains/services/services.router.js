const express = require('express');
const serviceRouter = express.Router();

const bodyParser = require('body-parser');
serviceRouter.use(bodyParser.json());
serviceRouter.use(bodyParser.urlencoded({ extended: true }));

const verifyToken = require('../../middlewares/auth/jwt/jwt.verify')

const digitalFormRouter = require('./digital-form/digital.router');
const paperFormRouter = require('./paper-form/paper.router');
const webScrapeRouter = require('./web-scrape/scrape.router');
const donationRouter = require('./donations/donation.router');
const disputeRouter = require('./disputes/dispute.router');
const notificationRouter = require('./notifications/notification.router');
const quarantineRouter = require('./quarantine/quarantine.router');
const caseRouter = require('./cases/case.router');
const jobRouter = require('./jobs/job.router');
const monitoringRouter = require('./monitoring/monitoring.router');

serviceRouter.use('/digital-form', digitalFormRouter);
serviceRouter.use('/paper-form', paperFormRouter);
serviceRouter.use('/web-scrape', webScrapeRouter);
serviceRouter.use('/donations', donationRouter);
serviceRouter.use('/disputes', disputeRouter);
serviceRouter.use('/notifications', notificationRouter);
serviceRouter.use('/quarantine', quarantineRouter);
serviceRouter.use('/cases', caseRouter);
serviceRouter.use('/jobs', jobRouter);
serviceRouter.use('/monitoring', monitoringRouter);

module.exports = serviceRouter;