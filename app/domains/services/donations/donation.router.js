const express = require('express');
const donationRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');

const donationController = require('./donation.controller');
const labelsController = require('./labels.controller');
const networkController = require('./network.controller');
const caseController = require('./case.controller');

donationRouter.get('/entities', verifyToken, donationController.entities);
donationRouter.get('/list', verifyToken, donationController.list);
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
donationRouter.post('/disposition', verifyToken, labelsController.disposition);
donationRouter.post('/dispute-outcome', verifyToken, labelsController.disputeOutcome);

donationRouter.get('/queue', verifyToken, labelsController.queue);

// Clearing a set together records what they had in common. The same donations
// cleared one at a time lose it, and with it the only evidence that a false
// positive is systematic rather than incidental.
donationRouter.post('/bulk-clear', verifyToken, labelsController.bulkClear);

// Everything needed to judge one donation, assembled before anyone is asked to
// decide. A score with an approve button is automation with a signature.
donationRouter.get('/case/:donationId', verifyToken, caseController.detail);

// The donation graph. Findings attach to flows, never to the parties: moving a
// statutory finding onto a person turns a fact about a payment into a label on
// a name.
donationRouter.get('/network', verifyToken, networkController.network);

module.exports = donationRouter;
