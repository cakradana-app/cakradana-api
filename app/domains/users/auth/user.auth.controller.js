const signToken = require('../../../utils/auth/jwt/sign');
const { DEFAULT_ROLE } = require('../../../middlewares/auth/roles');
const { User } = require('../user.model');

/**
 * Issue a fresh token.
 *
 * The account is re-read rather than the existing claims copied forward. Two
 * reasons: the previous version dropped `name` and `type` on refresh, so a
 * refreshed session lost the identity the subject-facing views scope on; and a
 * role that has been changed or revoked should take effect at the next refresh
 * rather than surviving until the old token happens to expire.
 */
const refresh = async (req, res) => {
    try {
        const user = await User.findOne({ email: req.user.email });
        if (!user) {
            return res.status(404).json({
                status: 'error',
                message: 'User not found',
                data: {},
            });
        }

        return res.status(200).json({
            status: 'success',
            message: 'Token Refresh Success',
            data: {
                email: user.email,
                name: user.name,
                type: user.type,
                role: user.role || DEFAULT_ROLE,
                token: signToken({
                    name: user.name,
                    email: user.email,
                    type: user.type,
                    role: user.role || DEFAULT_ROLE,
                }),
            },
        });
    } catch (err) {
        console.error('Error refreshing token:', err);
        return res.status(500).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : 'Internal Server Error',
            data: {},
        });
    }
};

module.exports = {
    refresh
};
