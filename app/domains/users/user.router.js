const express = require('express');
const userRouter = express.Router();
const bodyParser = require('body-parser');

const authRouter = require('./auth/user.auth.routes');

userRouter.use(bodyParser.json());
userRouter.use('/auth', authRouter);

module.exports = userRouter;