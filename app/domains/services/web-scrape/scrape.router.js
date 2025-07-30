const express = require('express');
const scrapeRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');

const scrapeController = require('./scrape.controller');

scrapeRouter.post('/input', verifyToken, scrapeController.input);

module.exports = scrapeRouter;