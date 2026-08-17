const express = require('express');
const publicRouter = express.Router();

const publicController = require('./public.controller');

// Unauthenticated by design, and served only from the materialised collection.
// A public endpoint that filters the operational store is one filter bug away
// from publishing risk scores about named people.
publicRouter.get('/aggregates', publicController.dataset);
publicRouter.get('/operations', publicController.operations);

module.exports = publicRouter;
