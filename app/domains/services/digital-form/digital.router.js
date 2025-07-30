const express = require('express');
const digitalRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');

const digitalController = require('./digital.controller');

digitalRouter.post('/input', verifyToken, digitalController.input);

module.exports = digitalRouter;