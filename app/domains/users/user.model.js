const mongoose = require('mongoose');

const { ROLES, DEFAULT_ROLE } = require('../../middlewares/auth/roles');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    password: { type: String, required: false },
    type: { type: String, enum: ['individual', 'corporation', 'organization', 'political-party', 'government', 'kpu', 'other'], required: true },

    // What this account may do, as distinct from what kind of party it
    // represents. `type` describes the donor category the account belongs to;
    // a corporation and an individual can both be recipients of attributions,
    // and neither should reach the review queue for that reason.
    role: { type: String, enum: ROLES, default: DEFAULT_ROLE },

    // The entity this account is verified to be, used to scope which
    // attributions it may see. Names are not identities: two users called
    // "Budi Santoso" would otherwise each be shown the other's donations, which
    // in this domain means disclosing somebody's political giving to a
    // stranger.
    entityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', default: null },
    entityLinkVerifiedAt: { type: Date, default: null },
    entityLinkBasis: { type: String, default: null },
});

userSchema.index({ email: 1 });
userSchema.index({ entityId: 1 });

const User = mongoose.model("User", userSchema);

module.exports = {
    User
};
