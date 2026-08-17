const express = require('express');
const disputeRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const disputeController = require('./dispute.controller');

// Raising is open to any authenticated subject. Restricting it to resolved
// parties would exclude exactly the case that most needs contesting: an
// attribution made from a scanned document that named someone in raw text and
// linked them to nothing.
disputeRouter.post('/', verifyToken, disputeController.raise);

// What a subject is told about an attribution: what was observed, and where it
// was read from. Not the analyst's evidence bundle, which holds third-party
// records.
disputeRouter.get('/basis/:donationId', verifyToken, disputeController.basis);

disputeRouter.get('/queue', verifyToken, disputeController.queue);
disputeRouter.post('/acknowledge', verifyToken, disputeController.acknowledge);
disputeRouter.post('/assign', verifyToken, disputeController.assign);

// Adjudication. There is no path here that resolves a dispute without naming
// the person resolving it.
disputeRouter.post('/resolve', verifyToken, disputeController.resolve);

module.exports = disputeRouter;
