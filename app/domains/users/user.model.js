const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    password: { type: String, required: false },
    type: { type: String, enum: ['individual', 'corporation', 'organization', 'political-party', 'government', 'other'], required: true }
});

const User = mongoose.model("User", userSchema);

module.exports = {
    User
};