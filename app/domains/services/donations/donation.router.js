const express = require('express');
const donationRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');

const donationController = require('./donation.controller');

donationRouter.get('/entities', verifyToken, donationController.entities);
donationRouter.get('/list', verifyToken, donationController.list);
donationRouter.get('/list-as-sender', verifyToken, donationController.listAsSender);
donationRouter.get('/list-as-receiver', verifyToken, donationController.listAsReceiver);
donationRouter.post('/confirm-as-sender', verifyToken, donationController.confirmAsSender);
donationRouter.post('/confirm-as-receiver', verifyToken, donationController.confirmAsReceiver);

module.exports = donationRouter;