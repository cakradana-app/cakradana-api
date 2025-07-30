const jwt = require("jsonwebtoken");

const signToken = (user, expire=process.env.JWT_DEFAULT_EXPIRE) => {
    return jwt.sign(
        user,
        process.env.JWT_SECRET,
        { 
            expiresIn: expire 
        }
    );
}

module.exports = signToken;