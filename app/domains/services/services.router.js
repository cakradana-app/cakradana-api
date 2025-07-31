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

serviceRouter.use('/digital-form', digitalFormRouter);
serviceRouter.use('/paper-form', paperFormRouter);
serviceRouter.use('/web-scrape', webScrapeRouter);
serviceRouter.use('/donations', donationRouter);

module.exports = serviceRouter;