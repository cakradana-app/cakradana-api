const express = require('express');
const quarantineRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const { requireRole, REVIEWERS } = require('../../../middlewares/auth/roles');
const quarantineController = require('./quarantine.controller');

// Oldest first: quarantine has a retention period, and working newest-first
// would let the tail expire unread.
quarantineRouter.get('/', verifyToken, requireRole(REVIEWERS), quarantineController.list);

// A corrected record goes back through the same validation that rejected it,
// not a path that skips it because a human vouched for the correction.
quarantineRouter.post('/resubmit', verifyToken, requireRole(REVIEWERS), quarantineController.resubmit);

quarantineRouter.post('/dismiss', verifyToken, requireRole(REVIEWERS), quarantineController.dismiss);

module.exports = quarantineRouter;
