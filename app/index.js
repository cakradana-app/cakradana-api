require('dotenv').config();

const mongodb = require('./configs/database/mongodb/mongodb.client');
mongodb.connectDB();

const app = require('./server');
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});