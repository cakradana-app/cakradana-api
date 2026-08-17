const express = require('express');
const monitoringRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const { requireRole, REVIEWERS } = require('../../../middlewares/auth/roles');
const monitoringController = require('./monitoring.controller');

monitoringRouter.get(
    '/model-health',
    verifyToken,
    requireRole(REVIEWERS, 'ml_engineer'),
    monitoringController.health,
);

// Not published and not public: a cluster is a hypothesis about a set of
// people, and one nobody has looked at should not leave the review surface.
monitoringRouter.get('/alerts', verifyToken, requireRole(REVIEWERS), monitoringController.alerts);

// A register that went stale produces no error and no finding, which reads as
// a clean population. This is the only place the difference is visible.
monitoringRouter.get(
    '/registers',
    verifyToken,
    requireRole(REVIEWERS, 'ml_engineer'),
    monitoringController.registers,
);

// Carries no donation content — objectives, the age of the last backup, and
// what is not covered. Reachable by an administrator for that reason, who
// configures the system and has no business in the queue.
monitoringRouter.get(
    '/resilience',
    verifyToken,
    requireRole(REVIEWERS, 'ml_engineer', 'administrator'),
    monitoringController.resilience,
);

module.exports = monitoringRouter;
