const express = require('express');
const quarantineRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const quarantineController = require('./quarantine.controller');

// Oldest first: quarantine has a retention period, and working newest-first
// would let the tail expire unread.
quarantineRouter.get('/', verifyToken, quarantineController.list);

// A corrected record goes back through the same validation that rejected it,
// not a path that skips it because a human vouched for the correction.
quarantineRouter.post('/resubmit', verifyToken, quarantineController.resubmit);

quarantineRouter.post('/dismiss', verifyToken, quarantineController.dismiss);

module.exports = quarantineRouter;
