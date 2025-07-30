const express = require('express');
const paperRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');

const paperController = require('./paper.controller');

paperRouter.post('/input', verifyToken, paperController.input);

module.exports = paperRouter;