const signToken = require('../../../utils/auth/jwt/sign');

const refresh = async (req, res) => {
    return res.status(200).json({
        status: 'success',
        message: "Token Refresh Success",
        data: {
            email: req.user.email,
            token: signToken({
                email: req.user.email,
                auth: req.user.auth
            })
        }
    });
};

module.exports = {
    refresh
};