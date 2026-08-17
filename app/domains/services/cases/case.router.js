const express = require('express');
const caseRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const caseController = require('./case.controller');

caseRouter.get('/', verifyToken, caseController.list);
caseRouter.post('/', verifyToken, caseController.open);
caseRouter.put('/', verifyToken, caseController.update);
caseRouter.get('/:caseId', verifyToken, caseController.detail);

// A report is drawn from a case, never from a score. Requiring the case first
// means a person chose these records and wrote down what connects them.
caseRouter.get('/:caseId/report/draft', verifyToken, caseController.draft);
caseRouter.post('/report/approve', verifyToken, caseController.approve);

// Every approval and read is recorded. A trail nobody can read cannot answer
// the question it exists for.
caseRouter.get('/:caseId/audit', verifyToken, caseController.exportLog);

module.exports = caseRouter;
