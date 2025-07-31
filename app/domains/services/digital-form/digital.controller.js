const Service = require('../services.model').Service;

const input = async (req, res) => {
    try {
        const digitalForm = req.body;
        
        let getService = await Service.findOne();
        if (!getService) {
            getService = await Service.create({
                entities: [],
                donations: []
            });
        }

        for (const form of digitalForm) {
            const newDonation = {
                sender: form.sender || null,
                receiver: form.receiver || null,
                amount: form.amount || null,
                date: form.date || null,
                type: 'digital-form'
            };
            getService.donations.push(newDonation);

            if (form.sender && !getService.entities.some(entity => entity.name === form.sender)) {
                getService.entities.push({
                    name: form.sender,
                    type: form.sender_type || null
                });
            }

            if (form.receiver && !getService.entities.some(entity => entity.name === form.receiver)) {
                getService.entities.push({
                    name: form.receiver,
                    type: form.receiver_type || null
                });
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