const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const ejs = require('ejs');

const app = express();

app.use(cors({
    origin: [
        'http://localhost:80',
        'http://localhost:3000',
        'http://localhost:4173',
        'http://localhost:5173',
        'http://localhost:8080',
        'https://cakradana.org',
        'https://api.cakradana.org',
    ],
    credentials: true
}));

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates/pages'));

// Serve static files from the templates directory
app.use(express.static(path.join(__dirname, 'templates')));

const userRouter = require('./domains/users/user.router');
app.use('/user', userRouter);

const serviceRouter = require('./domains/services/services.router');
app.use('/service', serviceRouter);

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'templates/pages/index.html'));
});

app.get('/test', function(req, res) {
  res.sendFile(path.join(__dirname, 'templates/pages/test.html'));
});

// Route for reset password page
app.get('/changepassword', function(req, res) {
  res.render('reset', { token: req.query.token });
});

module.exports = app;