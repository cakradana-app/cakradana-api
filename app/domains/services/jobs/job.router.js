const express = require('express');
const jobRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const jobController = require('./job.controller');

jobRouter.get('/', verifyToken, jobController.list);

// Progress, not just completion. A job that reports nothing until it finishes
// is indistinguishable from one that has hung.
jobRouter.get('/:jobId', verifyToken, jobController.status);

module.exports = jobRouter;
