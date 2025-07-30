const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SSL,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const sendmail = async ({ fromaddres, receipients, subject, message, html }) => {
    if (html) {
        await transport.sendMail({
            from: fromaddres,
            to: receipients,
            subject: subject,
            html: message
        })
    } else {
        await transport.sendMail({
            from: fromaddres,
            to: receipients,
            subject: subject,
            text: message
        })
    }
};

module.exports = {
    sendmail
};