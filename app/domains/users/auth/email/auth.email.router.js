const express = require('express');
const emailAuthRouter = express.Router();

const emailAuthController = require('./auth.email.controller');

emailAuthRouter.post('/register', emailAuthController.register);
emailAuthRouter.post('/login', emailAuthController.login);
emailAuthRouter.post('/forgot-password', emailAuthController.forgot);
emailAuthRouter.put('/change-password', emailAuthController.change);

module.exports = emailAuthRouter;