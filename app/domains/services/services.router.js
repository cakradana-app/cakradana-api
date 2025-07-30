const express = require('express');
const serviceRouter = express.Router();

const bodyParser = require('body-parser');
serviceRouter.use(bodyParser.json());
serviceRouter.use(bodyParser.urlencoded({ extended: true }));

const verifyToken = require('../../middlewares/auth/jwt/jwt.verify')

const serviceController = require('./services.controller');
const digitalFormRouter = require('./digital-form/digital.router');
const paperFormRouter = require('./paper-form/paper.router');
const webScrapeRouter = require('./web-scrape/scrape.router');

serviceRouter.get('/entities', verifyToken, serviceController.entities);
serviceRouter.use('/digital-form', digitalFormRouter);
serviceRouter.use('/paper-form', paperFormRouter);
serviceRouter.use('/web-scrape', webScrapeRouter);

module.exports = serviceRouter;