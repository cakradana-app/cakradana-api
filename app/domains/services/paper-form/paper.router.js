const express = require('express');
const paperRouter = express.Router();

const verifyToken = require('../../../middlewares/auth/jwt/jwt.verify');
const { uploadMultipleImages } = require('../../../middlewares/upload/multer.config');

const paperController = require('./paper.controller');

paperRouter.post('/input', verifyToken, uploadMultipleImages, paperController.input);

module.exports = paperRouter;