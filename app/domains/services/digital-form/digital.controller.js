const Service = require('../services.model').Service;

const input = async (req, res) => {
    try {
        const digitalForm = req.body;
        
        const getService = await Service.findOne({ email: req.user.email });
        if (!getService) {
            return res.status(400).json({
                status: 'error',
                message: "User is not registered yet",
                data: {}
            });
        }

        for (const form of digitalForm) {
            const newDonation = {
                sender: form.sender,
                receiver: form.receiver,
                amount: form.amount,
                date: form.date,
                type: 'digital-form'
            };
            getService.donations.push(newDonation);

            if (!getService.entities.includes(form.sender)) {
                getService.entities.push(form.sender);
            }

            if (!getService.entities.includes(form.receiver)) {
                getService.entities.push(form.receiver);
            }
        }

        await getService.save();

        return res.status(200).json({
            status: 'success',
            message: 'Successfully added digital form donations',
            data: {
                donations: digitalForm
            }
        });
    } catch(err) {
        console.error(err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

module.exports = { 
    input
};