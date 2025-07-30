const GoogleStrategy = require('passport-google-oauth2').Strategy;
const User = require('../../../domainsprev/users/entities/user.model').User;
const createUser = require('../../../domainsprev/users/entities/user.controller').createUser;

const Strategy = new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_OAUTH_CALLBACK,
    passReqToCallback: true,
}, async function(request, accessToken, refreshToken, profile, done) {
    try {
        const getEmail = await User.findOne({ email: profile.email });
        if (!getEmail) {
            await createUser(profile.email, profile.displayName, profile.email, profile.picture);
        }
        return done(null, profile);
    } catch (err) {
        console.error(err);
    }
});

const serializeUser = (user, done) => {
    done(null, user);
};

const deserializeUser = (user, done) => {
    done(null, user);
};

const isLoggedIn = (req, res, next) => {
    req.user ? next() : res.status(401).json({
        status: 'error',
        message: 'Google Auth Unauthorized',
        data: {}
    });
};

module.exports = {
    Strategy,
    serializeUser,
    deserializeUser,
    isLoggedIn
};