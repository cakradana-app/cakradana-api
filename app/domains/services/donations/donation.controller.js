const Service = require('../services.model').Service;
const User = require('../../users/user.model').User;

const entities = async (req, res) => {
    try {
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
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

const list = async (req, res) => {
    try {
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
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

const listAsSender = async (req, res) => {
    try {
        const user = await User.findOne({ email: req.user.email });
        if (!user) {
            return res.status(400).json({
                status: 'error',
                message: "User not found",
                data: {}
            });
        }

        const services = await Service.find({ "donations.sender": user.name });
        
        let allDonations = [];
        services.forEach(service => {
            const userDonations = service.donations.filter(donation => donation.sender === user.name);
            const cleanDonations = userDonations.map(donation => ({
                _id: donation._id,
                sender: donation.sender,
                receiver: donation.receiver,
                amount: donation.amount,
                date: donation.date,
                type: donation.type,
                senderConfirmed: donation.senderConfirmed,
                receiverConfirmed: donation.receiverConfirmed
            }));
            allDonations = allDonations.concat(cleanDonations);
        });

        return res.status(200).json({
            status: 'success',
            message: "Donations as sender fetched successfully",
            data: allDonations
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

const listAsReceiver = async (req, res) => {
    try {
        const user = await User.findOne({ email: req.user.email });
        if (!user) {
            return res.status(400).json({
                status: 'error',
                message: "User not found",
                data: {}
            });
        }

        const services = await Service.find({ "donations.receiver": user.name });
        
        let allDonations = [];
        services.forEach(service => {
            const userDonations = service.donations.filter(donation => donation.receiver === user.name);
            const cleanDonations = userDonations.map(donation => ({
                _id: donation._id,
                sender: donation.sender,
                receiver: donation.receiver,
                amount: donation.amount,
                date: donation.date,
                type: donation.type,
                senderConfirmed: donation.senderConfirmed,
                receiverConfirmed: donation.receiverConfirmed
            }));
            allDonations = allDonations.concat(cleanDonations);
        });

        return res.status(200).json({
            status: 'success',
            message: "Donations as receiver fetched successfully",
            data: allDonations
        });
    } catch(err) {
        console.error('Error:', err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

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
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
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
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
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
    confirmAsReceiver
};