const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
    entities: [
        {
            name: { type: String, required: true, unique: true },
            type: { type: String, enum: ['individual', 'corporation', 'organization', 'political-party', 'government', 'other'], required: false },
        }
    ],
    donations: [
        {
            sender: { type: String, required: false },
            receiver: { type: String, required: false },
            amount: { type: Number, required: false },
            date: { type: Date, required: false },
            type: { type: String, enum: ['digital-form', 'paper-form', 'web-scrape'], required: false },
            senderConfirmed: { type: Boolean, default: false },
            receiverConfirmed: { type: Boolean, default: false },
        }
    ],
});

const Service = mongoose.model("Service", serviceSchema);

module.exports = {
    Service
};