const jwt = require("jsonwebtoken");

const verify = (token) => {
    let verification;
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            verification = {
                status: "error",
                message: process.env.DEBUG ? err.message : "Invalid Token",
                data: {}
            }
        } else {
            verification = {
                status: "success",
                message: "Token Verified",
                data: decoded
            }
        }
    });
    return verification;
};

module.exports = verify;