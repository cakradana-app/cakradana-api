const verify = require('../../../utils/auth/jwt/verify');

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({
            status: "error", 
            message: "Unauthorized: Authentication required",
            data: {}
        });
    }

    const verification = verify(token);
    if (verification.status == "error") {
        return res.status(401).json({
            status: "error", 
            message: process.env.DEBUG ? verification.message : "Invalid Authentication",
            data: {}
        });
    }

    req.user = verification.data;
    next();
};

module.exports = verifyToken;