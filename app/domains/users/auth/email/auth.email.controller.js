const User = require('../..//user.model').User;
const Service = require('../../../services/services.model').Service;

const bcrypt = require('bcrypt');
const signToken = require('../../../../utils/auth/jwt/sign');
const verifyAccessToken = require('../../../../utils/auth/jwt/verify');
const mailrenderer = require('../../../../utils/mail/renderer');
const mailsender = require('../../../../utils/mail/sender');

const register = async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({
                status: 'error',
                message: 'Parameter "email" and "password" required',
                data: {}
            });
        }

        const getUser = await User.findOne({ email: email });
    
        if (getUser) {
            return res.status(400).json({
                status: 'error',
                message: process.env.DEBUG ? "User already registered" : "Bad Request",
                data: {}
            });
        }

        const newUser = new User({
            email: email,
            password: await bcrypt.hash(password, 10)
        });
        await newUser.save();

        const newService = new Service({
            email: email
        });
        await newService.save();

        const userTokenSign = {
            email: email
        }
        
        return res.status(200).json({
            status: 'success',
            message: "Email registration successful",
            data: {
                email: email,
                access_token: signToken(userTokenSign)
            }
        });
    } catch(err) {
        console.error(err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                status: 'error',
                message: 'Parameter "email" and "password" required',
                data: {}
            });
        }

        const getUser = await User.findOne({ email: email });
    
        if (!getUser) {
            return res.status(400).json({
                status: 'error',
                message: process.env.DEBUG ? "Email not Found" : "Invalid Credentials",
                data: {}
            });
        }

        if (bcrypt.compareSync(password, getUser.password)) {
            const userTokenSign = {
                email: email,
                auth: "email",
            }
            return res.status(200).json({
                status: 'success',
                message: "Login Success",
                data: {
                    email: email,
                    access_token: signToken(userTokenSign)
                }
            });
        } else {
            return res.status(400).json({
                status: 'error',
                message: process.env.DEBUG ? "Wrong Password" : "Invalid Credentials",
                data: {}
            });
        }
    } catch(err) {
        console.error(err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

const forgot = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                status: 'error',
                message: 'Parameter "email" required',
                data: {}
            });
        }

        const getUser = await User.findOne({ email: email });
    
        if (!getUser) {
            return res.status(400).json({
                status: 'error',
                message: process.env.DEBUG ? "Email not Found" : "Invalid Credentials",
                data: {}
            });
        }

        const verificationToken = signToken({
            email: email,
            isForgotPassword: true
        }, '1h');

        
        const html = await mailrenderer('reset', {
            reset_url: `https://api.cakradana.org/changepassword?token=${encodeURIComponent(verificationToken)}`
        });

        await mailsender.sendmail({
            fromaddres: 'Cakradana <noreply@cakradana.org>',
            receipients: email,
            subject: 'Password Reset for Cakradana',
            message: html,
            html: true
        });
        
        return res.status(200).json({
            status: 'success',
            message: 'Email sent. Please check yout inbox',
            data: {}
        });
    } catch(err) {
        console.error(err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    } 
};

const change = async (req, res) => {
    try {
        const { password, token } = req.body;

        if (!password || !token) {
            return res.status(400).json({
                status: 'error',
                message: 'Parameter "password" and "token" required',
                data: {}
            });
        }

        const verification = verifyAccessToken(token);
        if (verification.status == "error") {
            return res.status(401).json({
                status: "error", 
                message: "Password Change Token Expired. Please request password reset again.",
                data: {}
            });
        } else {
            if (verification.data.isForgotPassword) {
                const getUser = await User.findOne({ email: verification.data.email });
                if (getUser) {
                    getUser.password = await bcrypt.hash(password, 10);
                    getUser.save();
                    return res.status(200).json({
                        status: "success", 
                        message: "User password changed",
                        data: {}
                    });
                } else {
                    return res.status(401).json({
                        status: "error", 
                        message: "Error: User not found",
                        data: {}
                    });
                }
            } else {
                return res.status(400).json({
                    status: 'error',
                    message: "Invalid Authentication",
                    data: {
                        email: verification.data.email,
                        isVerified: false
                    }
                });
            }
        }
    } catch(err) {
        console.error(err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

const emailAuthController = {
    register,
    login,
    forgot,
    change
};

module.exports = emailAuthController;