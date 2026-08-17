const express = require('express');
const notificationRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const { requireRole, REVIEWERS } = require('../../../middlewares/auth/roles');
const notificationController = require('./notification.controller');

notificationRouter.get('/', verifyToken, requireRole(REVIEWERS), notificationController.pending);

// What the subject would see, readable before the decision rather than after
// it. Approving a notice without being able to read it is approval in name.
notificationRouter.get(
    '/preview/:notificationId',
    verifyToken,
    requireRole(REVIEWERS),
    notificationController.preview,
);

// Both outcomes are decisions and both are recorded. Withholding is the one
// that most needs a record: a notice never sent leaves no trace of its absence.
notificationRouter.post('/decide', verifyToken, requireRole(REVIEWERS), notificationController.decide);

// Refuses unless this deployment is configured to contact subjects at all.
notificationRouter.post('/deliver', verifyToken, requireRole('administrator', 'kpu_officer'), notificationController.deliver);

module.exports = notificationRouter;
