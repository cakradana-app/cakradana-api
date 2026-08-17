const express = require('express');
const identifierRouter = express.Router();

const verifyToken = require('../../middlewares/auth/jwt/jwt.verify');
const { requireRoleStrict, REVIEWERS } = require('../../middlewares/auth/roles');

const controller = require('./identifier.controller');

// Every route here is strict. Shadow mode exists so an operator can read the
// blast radius of enforcement before switching it on, and for most reads that
// is a sound trade — the cost of being wrong is a log line. It is not a sound
// trade for these two, which were the exception: with `ENFORCE_ROLES=false` any
// account at all could walk the entity list and learn which named people have a
// NIK or a passport on file in a political-donation risk system. That is a
// disclosure, and a disclosure cannot be un-made by turning the flag on later.

// Whether this deployment can hold identifiers at all. Discloses nothing about
// any person, and an operator needs it before the first attempt rather than as
// an error on it.
identifierRouter.get('/status', verifyToken, requireRoleStrict(REVIEWERS), controller.status);

// What an entity is identified by, with none of the values. The question
// nearly every caller is actually asking.
identifierRouter.get(
    '/entity/:id',
    verifyToken,
    requireRoleStrict(REVIEWERS),
    controller.forEntity,
);

// Recording an identifier is not reversible in the way that matters: the value
// is now held, and a value held is a value that can leak. It does not wait for
// the enforcement flag.
identifierRouter.post('/', verifyToken, requireRoleStrict(REVIEWERS), controller.mint);

// A match discloses nothing — the caller supplies a value they already hold and
// learns whether the system knows it. Still restricted, because the pattern it
// enables is enumeration, and still strict, because shadow mode would let an
// unauthorised caller enumerate while being logged as refused.
identifierRouter.post('/match', verifyToken, requireRoleStrict(REVIEWERS), controller.match);

// The one call that is a disclosure. Refused whatever the enforcement flag
// says: a value read cannot be un-read, so there is no shadow-mode version of
// it — logging that it would have been refused, after returning it, is a
// record of the disclosure rather than a prevention of it.
identifierRouter.post(
    '/:ref/reveal',
    verifyToken,
    requireRoleStrict(REVIEWERS),
    controller.reveal,
);

module.exports = identifierRouter;
