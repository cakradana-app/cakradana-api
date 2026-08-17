const express = require('express');
const entityRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const { requireRole, REVIEWERS } = require('../../../middlewares/auth/roles');
const reviewController = require('./resolution-review.controller');

// Soonest deadline first. While a review is open the cumulative limit rules
// are counting one donor as two, so the oldest pair is doing the most damage.
entityRouter.get('/review', verifyToken, requireRole(REVIEWERS), reviewController.list);

entityRouter.get('/review/:id', verifyToken, requireRole(REVIEWERS), reviewController.detail);

// Both decisions require a named actor and a reason. A merge attributes one
// person's donations to another; keeping two records separate without a
// recorded reason means the same pair is raised again by the next donation.
entityRouter.post('/review/:id/merge', verifyToken, requireRole(REVIEWERS), reviewController.merge);

entityRouter.post(
    '/review/:id/keep-separate',
    verifyToken,
    requireRole(REVIEWERS),
    reviewController.keepSeparate,
);

module.exports = entityRouter;
