const express = require('express');
const donationRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');

const donationController = require('./donation.controller');

donationRouter.get('/entities', verifyToken, donationController.entities);
donationRouter.get('/list', verifyToken, donationController.list);

module.exports = donationRouter;