const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
    email: { type: String, required: true },
    entities: [{ type: String, required: true }],
    donations: [
        {
            sender: { type: String, required: true },
            receiver: { type: String, required: true },
            amount: { type: Number, required: false },
            date: { type: Date, required: false },
            type: { type: String, enum: ['digital-form', 'paper-form', 'web-scrape'], required: true },
        }
    ],
});

const Service = mongoose.model("Service", serviceSchema);

module.exports = {
    Service
};