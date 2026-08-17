const express = require('express');
const entityRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const {
    requireRole,
    requireRoleStrict,
    REVIEWERS,
} = require('../../../middlewares/auth/roles');
const reviewController = require('./resolution-review.controller');

// Soonest deadline first. While a review is open the cumulative limit rules
// are counting one donor as two, so the oldest pair is doing the most damage.
entityRouter.get('/review', verifyToken, requireRole(REVIEWERS), reviewController.list);

entityRouter.get('/review/:id', verifyToken, requireRole(REVIEWERS), reviewController.detail);

// Both decisions require a named actor and a reason. A merge attributes one
// person's donations to another; keeping two records separate without a
// recorded reason means the same pair is raised again by the next donation.
//
// Strict, so neither waits on the enforcement flag. Shadow mode is a sound
// trade for a read — the cost of being wrong is a log line — and not for a
// write that cannot be undone.
entityRouter.post(
    '/review/:id/merge',
    verifyToken,
    requireRoleStrict(REVIEWERS),
    reviewController.merge,
);

entityRouter.post(
    '/review/:id/keep-separate',
    verifyToken,
    requireRoleStrict(REVIEWERS),
    reviewController.keepSeparate,
);

module.exports = entityRouter;
