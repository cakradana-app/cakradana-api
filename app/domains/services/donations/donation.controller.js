const Service = require('../services.model').Service;

const entities = async (req, res) => {
    try {
        const getService = await Service.findOne({ email: req.user.email });
        if (!getService) {
            return res.status(400).json({
                status: 'error',
                message: "User is not registered yet",
                data: {}
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
        const getService = await Service.findOne({ email: req.user.email });
        if (!getService) {
            return res.status(400).json({
                status: 'error',
                message: "User is not registered yet",
                data: {}
            });
        }

        let getServiceData = getService.toObject();
        getServiceData.donations = getServiceData.donations.map(({_id, ...keys}) => keys);

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

module.exports = { 
    entities,
    list
};