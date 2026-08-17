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
 */

const Service = require('../services.model').Service;
const User = require('../../users/user.model').User;
const { record } = require('../../canonical/retention');
const { log } = require('../../../utils/observability/logging');

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

const entities = async (req, res) => {
    try {
        await record({
            actor: req.user?.email || null,
            action: 'list-entities',
            subjectType: 'Entity',
        });

        let getService = await Service.findOne();
        if (!getService) {
            getService = await Service.create({
                entities: [],
                donations: []
            });
        }

        let getServiceData = getService.toObject();
        getServiceData.entities = getServiceData.entities.map(({_id, ...keys}) => keys);

        return res.status(200).json({
            status: 'success',
            message: "Entities fetched successfully",
            data: getServiceData.entities
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Internal Server Error",
            data: {}
        });
    }
};

const list = async (req, res) => {
    try {
        await record({
            actor: req.user?.email || null,
            action: 'list-donations',
            subjectType: 'Donation',
        });

        let getService = await Service.findOne();
        if (!getService) {
            getService = await Service.create({
                entities: [],
                donations: []
            });
        }

        let getServiceData = getService.toObject();
        // getServiceData.donations = getServiceData.donations.map(({_id, ...keys}) => keys);

        return res.status(200).json({
            status: 'success',
            message: "Donations fetched successfully",
            data: getServiceData.donations
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Internal Server Error",
            data: {}
        });
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
        if (!user) {
            return res.status(404).json({
                status: 'error',
                message: "User not found",
                data: {}
            });
        }

        const scope = await subjectScope(user);
        if (scope.kind === 'refused') {
            return res.status(409).json({
                status: 'error',
                message: scope.reason,
                data: { remedy: 'link this account to a verified entity' },
            });
        }

        await record({
            actor: req.user.email,
            action: `list-own-donations-as-${party}`,
            subjectType: 'User',
            subjectId: String(user._id),
        });

        // The legacy document holds names rather than entity ids, so an
        // entity-scoped account resolves back to the names that entity is
        // known by. Aliases are included: a record filed under an earlier
        // spelling is still that person's record.
        let names = [user.name];
        if (scope.kind === 'entity') {
            const { Entity } = require('../../canonical/canonical.model');
            const entity = await Entity.findById(scope.entityId).lean();
            if (entity) names = [entity.canonicalName, ...(entity.aliases || [])];
        }

        const services = await Service.find({ [`donations.${party}`]: { $in: names } });

        const allDonations = services.flatMap((service) =>
            service.donations
                .filter((donation) => names.includes(donation[party]))
                .map((donation) => ({
                    _id: donation._id,
                    sender: donation.sender,
                    receiver: donation.receiver,
                    amount: donation.amount,
                    date: donation.date,
                    type: donation.type,
                    senderConfirmed: donation.senderConfirmed,
                    receiverConfirmed: donation.receiverConfirmed
                })),
        );

        return res.status(200).json({
            status: 'success',
            message: `Donations as ${party} fetched successfully`,
            data: allDonations,
            // Stated so a subject knows how firmly the system believes these
            // are theirs. A name match and a verified link are different
            // claims, and only one of them is an identity.
            scope: scope.kind === 'entity' ? 'verified entity link' : 'name match',
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Internal Server Error",
            data: {}
        });
    }
}

const listAsSender = (req, res) => listAsParty(req, res, 'sender');
const listAsReceiver = (req, res) => listAsParty(req, res, 'receiver');

const confirmAsSender = async (req, res) => {
    try {
        const { donationId } = req.body;
        
        if (!donationId) {
            return res.status(400).json({
                status: 'error',
                message: "Donation ID is required",
                data: {}
            });
        }

        const user = await User.findOne({ email: req.user.email });
        if (!user) {
            return res.status(400).json({
                status: 'error',
                message: "User not found",
                data: {}
            });
        }

        // Find the service that contains this donation and update it
        const service = await Service.findOneAndUpdate(
            { 
                "donations._id": donationId,
                "donations.sender": user.name
            },
            { 
                $set: { "donations.$.senderConfirmed": true }
            },
            { new: true }
        );

        if (!service) {
            return res.status(404).json({
                status: 'error',
                message: "Donation not found or you are not the sender",
                data: {}
            });
        }

        const confirmedDonation = service.donations.id(donationId);

        return res.status(200).json({
            status: 'success',
            message: "Donation confirmed as sender successfully",
            data: {
                _id: confirmedDonation._id,
                sender: confirmedDonation.sender,
                receiver: confirmedDonation.receiver,
                amount: confirmedDonation.amount,
                date: confirmedDonation.date,
                type: confirmedDonation.type,
                senderConfirmed: confirmedDonation.senderConfirmed,
                receiverConfirmed: confirmedDonation.receiverConfirmed
            }
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Internal Server Error",
            data: {}
        });
    }
};

const confirmAsReceiver = async (req, res) => {
    try {
        const { donationId } = req.body;
        
        if (!donationId) {
            return res.status(400).json({
                status: 'error',
                message: "Donation ID is required",
                data: {}
            });
        }

        // Get user details to find their name
        const user = await User.findOne({ email: req.user.email });
        if (!user) {
            return res.status(400).json({
                status: 'error',
                message: "User not found",
                data: {}
            });
        }

        // Find the service that contains this donation and update it
        const service = await Service.findOneAndUpdate(
            { 
                "donations._id": donationId,
                "donations.receiver": user.name
            },
            { 
                $set: { "donations.$.receiverConfirmed": true }
            },
            { new: true }
        );

        if (!service) {
            return res.status(404).json({
                status: 'error',
                message: "Donation not found or you are not the receiver",
                data: {}
            });
        }

        const confirmedDonation = service.donations.id(donationId);

        return res.status(200).json({
            status: 'success',
            message: "Donation confirmed as receiver successfully",
            data: {
                _id: confirmedDonation._id,
                sender: confirmedDonation.sender,
                receiver: confirmedDonation.receiver,
                amount: confirmedDonation.amount,
                date: confirmedDonation.date,
                type: confirmedDonation.type,
                senderConfirmed: confirmedDonation.senderConfirmed,
                receiverConfirmed: confirmedDonation.receiverConfirmed
            }
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Internal Server Error",
            data: {}
        });
    }
};

module.exports = {
    entities,
    list,
    listAsSender,
    listAsReceiver,
    confirmAsSender,
    confirmAsReceiver,
    subjectScope
};