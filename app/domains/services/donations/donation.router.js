const express = require('express');
const donationRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const {
    requireRole,
    requireRoleStrict,
    REVIEWERS,
} = require('../../../middlewares/auth/roles');

const donationController = require('./donation.controller');
const labelsController = require('./labels.controller');
const networkController = require('./network.controller');
const caseController = require('./case.controller');

// Everyone's donations, which is a reviewer's view rather than a subject's.
donationRouter.get('/entities', verifyToken, requireRole(REVIEWERS), donationController.entities);
donationRouter.get('/list', verifyToken, requireRole(REVIEWERS), donationController.list);

// A subject's own attributions. Open to any account, and scoped to that
// account rather than filtered in the client.
donationRouter.get('/list-as-sender', verifyToken, donationController.listAsSender);
donationRouter.get('/list-as-receiver', verifyToken, donationController.listAsReceiver);

// Confirmation records that a donation occurred. It deliberately carries no
// risk verdict: a donation split across many nominal donors is genuinely
// received, and its recipient confirms it truthfully.
donationRouter.post('/confirm-as-sender', verifyToken, donationController.confirmAsSender);
donationRouter.post('/confirm-as-receiver', verifyToken, donationController.confirmAsReceiver);
donationRouter.post('/occurred-as-sender', verifyToken, labelsController.confirmAsSender);
donationRouter.post('/occurred-as-receiver', verifyToken, labelsController.confirmAsReceiver);

// Human judgement about risk. These are the labels the model is measured
// against; agreement with the behavioural heuristics is not a success metric.
donationRouter.post('/disposition', verifyToken, requireRole(REVIEWERS), labelsController.disposition);
donationRouter.post('/dispute-outcome', verifyToken, requireRole(REVIEWERS), labelsController.disputeOutcome);

donationRouter.get('/queue', verifyToken, requireRole(REVIEWERS), labelsController.queue);

// Clearing a set together records what they had in common. The same donations
// cleared one at a time lose it, and with it the only evidence that a false
// positive is systematic rather than incidental.
donationRouter.post('/bulk-clear', verifyToken, requireRole(REVIEWERS), labelsController.bulkClear);

// A cluster is one finding, so it takes one judgement. Clearing a forty-donation
// fan-in as forty separate decisions loses the fact that a group was examined as
// a group, and makes the retraining signal count one conclusion forty times.
// Members can be excepted individually, and an exception is marked as one.
// Strict: one call writes an analyst disposition onto every member of the
// cluster, which is the training signal and the review record at once.
donationRouter.post(
    '/disposition-alert',
    verifyToken,
    requireRoleStrict(REVIEWERS),
    labelsController.dispositionAlert,
);
donationRouter.get(
    '/alert/:id/disposition',
    verifyToken,
    requireRole(REVIEWERS),
    labelsController.alertDisposition,
);

// Everything needed to judge one donation, assembled before anyone is asked to
// decide. A score with an approve button is automation with a signature.
donationRouter.get('/case/:donationId', verifyToken, requireRole(REVIEWERS), caseController.detail);

// The donation graph. Findings attach to flows, never to the parties: moving a
// statutory finding onto a person turns a fact about a payment into a label on
// a name.
donationRouter.get('/network', verifyToken, requireRole(REVIEWERS), networkController.network);

module.exports = donationRouter;
