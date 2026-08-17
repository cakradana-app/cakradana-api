const express = require('express');
const caseRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const { requireRole, REVIEWERS } = require('../../../middlewares/auth/roles');
const caseController = require('./case.controller');

caseRouter.get('/', verifyToken, requireRole(REVIEWERS), caseController.list);
caseRouter.post('/', verifyToken, requireRole(REVIEWERS), caseController.open);
caseRouter.put('/', verifyToken, requireRole(REVIEWERS), caseController.update);
caseRouter.get('/:caseId', verifyToken, requireRole(REVIEWERS), caseController.detail);

// A report is drawn from a case, never from a score. Requiring the case first
// means a person chose these records and wrote down what connects them.
caseRouter.get('/:caseId/report/draft', verifyToken, requireRole(REVIEWERS), caseController.draft);
caseRouter.post('/report/approve', verifyToken, requireRole(REVIEWERS), caseController.approve);

// Every approval and read is recorded. A trail nobody can read cannot answer
// the question it exists for.
caseRouter.get('/:caseId/audit', verifyToken, requireRole(REVIEWERS), caseController.exportLog);

module.exports = caseRouter;
