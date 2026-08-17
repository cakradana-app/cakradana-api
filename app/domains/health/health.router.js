const express = require('express');
const healthRouter = express.Router();

const healthController = require('./health.controller');

// Unauthenticated, and deliberately so: a probe that needs a token fails when
// the auth path is what is broken, which is when the answer matters most.
// Neither endpoint reveals anything about donations or people.
healthRouter.get('/health', healthController.live);
healthRouter.get('/ready', healthController.ready);

// Metrics carry counts, never records. Restricted by network placement rather
// than by a token, as scrapers generally cannot hold one.
healthRouter.get('/metrics', healthController.metrics);

module.exports = healthRouter;
