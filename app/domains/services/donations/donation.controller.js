/**
 * The subject-facing donation views.
 *
 * These answer "what does the system say about me", which makes getting the
 * scope wrong worse here than anywhere else in the API: a donation record is a
 * political preference attached to a name, and showing one to the wrong person
 * discloses somebody's politics to a stranger.
 *
 * Scope therefore comes from a verified account↔entity link where one exists.
 * Where it does not, the fallback matches on name only when that name belongs
 * to exactly one account — two users called "Budi Santoso" would otherwise each
 * be shown the other's donations, and neither would know.
 *
 * These views read the canonical collections. They used to read a single
 * document holding every entity and every donation the system had ever seen,
 * which was how the service started and which no longer works past a certain
 * amount of data: MongoDB refuses a document over sixteen megabytes, so the
 * store had a size at which ingestion would begin failing for reasons no error
 * message would connect to a donation. Reading the collections also means an
 * entity that has been merged away no longer appears as a second donor, and a
 * corrected record no longer appears alongside the correction.
 */

const { Donation, Entity, Label } = require('../../canonical/canonical.model');
const User = require('../../users/user.model').User;
const { record } = require('../../canonical/retention');
const { log } = require('../../../utils/observability/logging');

//: A page of records. The subject views were previously unbounded because the
//: whole store was one document and there was nothing to page; a name matching
//: many donations would now load all of them.
const PAGE = 200;

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

/**
 * How to find the donations belonging to this account.
 *
 * Returns the match to apply, or a refusal. A refusal is a better answer than a
 * list assembled from an ambiguous name: the account holder sees that the
 * system cannot safely identify them, which is true and actionable, rather than
 * a list that may not be theirs.
 */
async function subjectScope(user) {
    if (user.entityId && user.entityLinkVerifiedAt) {
        return { kind: 'entity', entityId: user.entityId };
    }

    const sharing = await User.countDocuments({ name: user.name });
    if (sharing > 1) {
        // The collision this system must not resolve by guessing.
        log.warn('refusing a name-scoped subject view', {
            reason: 'more than one account shares this name',
            accounts: sharing,
        });
        return {
            kind: 'refused',
            reason:
                'more than one account uses this name, and this account is not yet ' +
                'linked to a verified entity. Showing donations matched on name ' +
                'alone could disclose another person’s records.',
        };
    }

    return { kind: 'name', name: user.name };
}

/**
 * Which parties have confirmed each of these donations.
 *
 * Returned as a map rather than joined per donation, so a page of two hundred
 * costs one query instead of two hundred.
 */
async function confirmationsFor(donationIds) {
    const labels = await Label.find({
        donationId: { $in: donationIds },
        source: 'recipient_confirmation',
    })
        .select('donationId confirmedParty')
        .lean();

    const byDonation = new Map();
    for (const label of labels) {
        const key = String(label.donationId);
        const seen = byDonation.get(key) || { sender: false, receiver: false };
        if (label.confirmedParty === 'sender') seen.sender = true;
        if (label.confirmedParty === 'receiver') seen.receiver = true;
        byDonation.set(key, seen);
    }
    return byDonation;
}

/**
 * A donation in the shape this endpoint has always returned.
 *
 * The names are the raw text the source document carried rather than the
 * resolved entity's canonical name. What a subject is shown has to be what was
 * written about them; the canonical name is this system's reading of it, and
 * showing that instead would hide the very difference a subject might contest.
 */
function present(donation, confirmed) {
    const seen = confirmed.get(String(donation._id)) || {};
    return {
        _id: donation._id,
        sender: donation.senderRef?.rawText || null,
        receiver: donation.receiverRef?.rawText || null,
        amount: donation.amountIdr,
        date: donation.occurredAt,
        type: donation.channel,
        senderConfirmed: Boolean(seen.sender),
        receiverConfirmed: Boolean(seen.receiver),
    };
}

const entities = async (req, res) => {
    try {
        await record({
            actor: req.user?.email || null,
            action: 'list-entities',
            subjectType: 'Entity',
        });

        // Entities merged away are excluded. One of the things a merge is for
        // is that the absorbed record stops being a second donor, and listing
        // it here would undo that for every reader of this endpoint.
        const found = await Entity.find({ mergedInto: null })
            .select('canonicalName entityType aliases firstSeen lastSeen')
            .sort({ canonicalName: 1 })
            .limit(PAGE)
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Entities fetched successfully',
            data: found.map((entity) => ({
                name: entity.canonicalName,
                type: entity.entityType,
                aliases: entity.aliases || [],
                first_seen: entity.firstSeen,
                last_seen: entity.lastSeen,
            })),
        });
    } catch (err) {
        return serverError(res, err, 'Error listing entities');
    }
};

const list = async (req, res) => {
    try {
        await record({
            actor: req.user?.email || null,
            action: 'list-donations',
            subjectType: 'Donation',
        });

        // Superseded records are excluded. A correction is a new version
        // rather than an edit, so both exist; returning both would show the
        // same donation twice, once with the value that was corrected.
        const found = await Donation.find({ supersededBy: null })
            .sort({ occurredAt: -1 })
            .limit(PAGE)
            .lean();
        const confirmed = await confirmationsFor(found.map((d) => d._id));

        return res.status(200).json({
            status: 'success',
            message: 'Donations fetched successfully',
            data: found.map((donation) => present(donation, confirmed)),
        });
    } catch (err) {
        return serverError(res, err, 'Error listing donations');
    }
};

/**
 * Attributions naming this account, on one side of the transaction.
 *
 * The read is logged. This is personal data about a named person, and an access
 * log that records writes but not reads cannot answer the question it exists
 * for.
 */
async function listAsParty(req, res, party) {
    try {
        const user = await User.findOne({ email: req.user.email });
        if (!user) return fail(res, 404, 'User not found');

        const scope = await subjectScope(user);
        if (scope.kind === 'refused') {
            return fail(res, 409, scope.reason, {
                remedy: 'link this account to a verified entity',
            });
        }

        await record({
            actor: req.user.email,
            action: `list-own-donations-as-${party}`,
            subjectType: 'User',
            subjectId: String(user._id),
        });

        const ref = `${party}Ref`;
        let filter;
        if (scope.kind === 'entity') {
            // A verified link is an identity, so the query is on the resolved
            // entity and a record filed under any spelling of the name is
            // found. The surviving entity of a merge is followed: donations
            // repointed by a merge belong to whoever now holds them.
            const entity = await Entity.findById(scope.entityId).lean();
            const target = entity?.mergedInto || scope.entityId;
            filter = { [`${ref}.entityId`]: target };
        } else {
            // A name match is not an identity, and this is the weaker claim.
            // Matching the raw text keeps it honest: the account is shown the
            // records that name it, not the records this system decided were
            // about the same person.
            filter = { [`${ref}.rawText`]: user.name };
        }
        filter.supersededBy = null;

        const found = await Donation.find(filter)
            .sort({ occurredAt: -1 })
            .limit(PAGE)
            .lean();
        const confirmed = await confirmationsFor(found.map((d) => d._id));

        return res.status(200).json({
            status: 'success',
            message: `Donations as ${party} fetched successfully`,
            data: found.map((donation) => present(donation, confirmed)),
            // Stated so a subject knows how firmly the system believes these
            // are theirs. A name match and a verified link are different
            // claims, and only one of them is an identity.
            scope: scope.kind === 'entity' ? 'verified entity link' : 'name match',
        });
    } catch (err) {
        return serverError(res, err, `Error listing donations as ${party}`);
    }
}

const listAsSender = (req, res) => listAsParty(req, res, 'sender');
const listAsReceiver = (req, res) => listAsParty(req, res, 'receiver');

/**
 * Confirm a donation this account is party to.
 *
 * The confirmation itself is written by the label loop, which is the only place
 * that decides what a confirmation means: it records that the transaction took
 * place and carries no risk verdict, because a donation split across many
 * nominal donors is genuinely received and its recipient confirms it truthfully.
 *
 * What is checked here is that the account is the party it says it is. The
 * previous implementation matched the account's name against the donation and
 * refused otherwise, which is the right check; it is kept, and strengthened by
 * a verified entity link where the account has one.
 */
async function confirmAsParty(req, res, party) {
    try {
        const donationId = req.body?.donationId || req.body?.donation_id;
        if (!donationId) return fail(res, 400, 'Donation ID is required');

        const user = await User.findOne({ email: req.user.email });
        if (!user) return fail(res, 400, 'User not found');

        const donation = await Donation.findOne({
            _id: donationId,
            supersededBy: null,
        }).lean();
        if (!donation) {
            return fail(res, 404, `Donation not found or you are not the ${party}`);
        }

        const ref = donation[`${party}Ref`] || {};
        let entitled = ref.rawText === user.name;
        if (!entitled && user.entityId && user.entityLinkVerifiedAt) {
            const entity = await Entity.findById(user.entityId).lean();
            const target = String(entity?.mergedInto || user.entityId);
            entitled = String(ref.entityId || '') === target;
        }
        if (!entitled) {
            // The same refusal for "no such donation" and "not yours", so the
            // endpoint cannot be used to discover which donation ids exist.
            return fail(res, 404, `Donation not found or you are not the ${party}`);
        }

        // Delegated rather than reimplemented. Two places writing confirmations
        // would be two places that have to keep agreeing about what one means,
        // and the schema constraint that keeps a confirmation off the risk axis
        // lives on the other side of that boundary.
        const labels = require('./labels.controller');
        req.body = { donation_id: String(donation._id), note: req.body?.note };
        return party === 'sender'
            ? labels.confirmAsSender(req, res)
            : labels.confirmAsReceiver(req, res);
    } catch (err) {
        return serverError(res, err, `Error confirming as ${party}`);
    }
}

const confirmAsSender = (req, res) => confirmAsParty(req, res, 'sender');
const confirmAsReceiver = (req, res) => confirmAsParty(req, res, 'receiver');

module.exports = {
    entities,
    list,
    listAsSender,
    listAsReceiver,
    confirmAsSender,
    confirmAsReceiver,
    subjectScope,
};
