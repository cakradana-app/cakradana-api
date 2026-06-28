<div align="center">
  <table border="1">
    <tr>
      <td align="center" style="padding: 20px;">
        <h3>📢 Domain & Email Migration Notice</h3>
        <p>From <b>July 29 th, 2026</b>, Cakradana will transition to new domains as <code>cakradana.org</code> will not be renewed:</p>
        <p>🌐 <b>Website:</b> <a href="https://cakradana.faizath.com">cakradana.faizath.com</a> (formerly <i>cakradana.org</i>)<br>
        ⚙️ <b>API:</b> <a href="https://cakradana-api.faizath.com">cakradana-api.faizath.com</a> (formerly <i>api.cakradana.org</i>)<br>
        📧 <b>Email:</b> <a href="mailto:contact@cakradana.faizath.com">contact@cakradana.faizath.com</a> (formerly <i>contact@cakradana.org</i>)<br>
        🛰️ <b>CDN:</b> <a>cakradana-cdn.faizath.com</a> (formerly <i>cdn.cakradana.org</i>)<br>
        📈 <b>Status Pages:</b> <a href="https://status.faizath.com/status/cakradana">https://status.faizath.com/status/cakradana</a> (formerly <i>status.cakradana.org</i>)
        </p>
      </td>
    </tr>
  </table>
</div>

# 🏛️ Cakradana API

<div align="center">

![Cakradana Logo](assets/logo.png)

> **Empowering Clean & Transparent Elections with AI-Powered AML Detection**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.21+-blue.svg)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-8.9+-green.svg)](https://www.mongodb.com/)

</div>

---

## 📋 Table of Contents

- [🎯 About Cakradana](#-about-cakradana)
- [❌ Problems Solved](#-problems-solved)
- [✅ Cakradana Solution](#-cakradana-solution)
- [🚀 Key Features](#-key-features)
- [🛠️ Tech Stack](#️-tech-stack)
- [⚡ Quick Start](#-quick-start)
- [📚 API Documentation](#-api-documentation)
- [🔧 Installation](#-installation)
- [🌍 Environment Variables](#-environment-variables)
- [📖 How to Use](#-how-to-use)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

---

## 🎯 About Cakradana

**Cakradana** is an artificial intelligence (AI) system specifically designed to enhance transparency and detect risks in election financing in Indonesia. This platform uses advanced technology to analyze, process, and visualize political donation data in real-time.

The name "Cakradana" is derived from Sanskrit meaning "wheel of giving" - symbolizing the cycle of transparency in a healthy democratic system.

---

## ❌ Problems Solved

### 🔍 Lack of Transparency
- **Untraceable political donations** by conventional systems
- **Difficulty accessing information** about campaign financing in real-time
- **Limitations in analyzing complex** donation patterns

### 📊 Data Fragmentation
- **Donation data scattered** across various formats (digital, paper, website)
- **Slow manual processes** in data collection and verification
- **Difficulty identifying networks** and connections between entities

### 🚨 Corruption & Money Politics Risk
- **Weak early detection** of suspicious donation patterns
- **Lack of network analysis** to identify potential conflicts of interest
- **Minimal automated tools** for monitoring campaign financing

---

## ✅ Cakradana Solution

### 🤖 AI & Machine Learning Technology
Cakradana uses AI for:
- **Automatic extraction** of donation data from various sources
- **Pattern analysis** and anomaly detection in financing
- **Risk prediction** based on historical data and network analysis

### 🔄 Multi-Channel Integration
This platform unifies data from:
- **📱 Digital Forms** - Manual input via API
- **📄 Physical Documents** - OCR for data extraction from scanned documents
- **🌐 Web Scraping** - Automatically collecting data from public websites

### 📈 Visualization & Analytics
- **Real-time dashboard** for donation monitoring
- **Network visualization** to see connections between entities
- **Automatic risk scoring** based on various parameters
- **Comprehensive reports** in easily understandable formats

---

## 🚀 Key Features

### 🔐 Authentication & Security
- **JWT-based authentication** for secure access
- **Email verification** and password reset
- **Role-based access control** for various user levels

### 📊 Multi-Format Data Input
- **Digital Form Processing** - API endpoint for structured data input
- **OCR Document Processing** - Data extraction from scanned documents (supports Indonesian & English)
- **Web Scraping** - Automatically collecting data from public web pages

### 🕸️ Network Analysis
- **Entity Management** - Tracking donors, recipients, and related entities
- **Relationship Mapping** - Visualization of relationships between entities
- **Risk Detection** - Identification of suspicious donation patterns

### 📱 RESTful API
- **OpenAPI 3.0 Documentation** - Complete and interactive documentation
- **Postman Collection** - Ready-to-use API testing
- **CORS Support** - Cross-origin resource sharing for frontend integration

---

## 🛠️ Tech Stack

### 🖥️ Backend Framework
- **Node.js** `18+` - Runtime environment
- **Express.js** `4.21+` - Web application framework
- **Body-parser** - Request body parsing middleware
- **CORS** - Cross-origin resource sharing

### 🗄️ Database & Storage
- **MongoDB** `8.9+` - NoSQL database with Mongoose ODM
- **Cloudflare R2** - Object storage for file handling

### 🔒 Authentication & Security
- **JSON Web Token (JWT)** - Stateless authentication
- **bcrypt** `6.0+` - Password hashing
- **Passport.js** - Google OAuth2 integration

### 🤖 AI & Data Processing
- **Tesseract.js** `6.0+` - OCR (Optical Character Recognition)
- **Cheerio** `1.1+` - Server-side HTML parsing for web scraping
- **OpenRouter API** - LLM integration for natural language processing

### 📧 Communication
- **Nodemailer** `7.0+` - Email service integration
- **EJS** `3.1+` - Template engine for email and web pages

### 🛠️ Development Tools
- **Multer** - File upload handling
- **dotenv** - Environment variables management
- **Nodemon** - Development auto-restart

### 🐳 Deployment
- **Docker** - Containerization with compose.yml
- **Linux** - Production environment support

---

## ⚡ Quick Start

### Prerequisites
```bash
Node.js >= 18.0.0
MongoDB >= 8.9.0
npm or yarn
```

### Quick Installation
```bash
# Clone repository
git clone https://github.com/cakradana-app/cakradana-api.git
cd cakradana-api

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
# Edit .env with your configuration

# Run development server
npm run dev
```

---

## 📚 API Documentation

### 🔗 Main Endpoints

#### Authentication
- `POST /user/auth/email/login` - Login with email
- `POST /user/auth/email/register` - Register new user
- `GET /user/auth/refresh-token` - Refresh access token
- `POST /user/auth/email/forgot-password` - Reset password
- `PUT /user/auth/email/change-password` - Change password

#### Digital Form Services
- `POST /service/digital-form/input` - Manual donation data input

#### Paper Form Services
- `POST /service/paper-form/input` - Upload and process physical documents via OCR

#### Web Scraping Services
- `POST /service/web-scrape/input` - Scrape data from websites

#### Donation Management
- `GET /service/donations/list` - List all user donations
- `GET /service/donations/entities` - List entities (donors/recipients)

---

## 🔧 Installation

### 1. Clone Repository
```bash
git clone https://github.com/cakradana-app/cakradana-api.git
cd cakradana-api
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Setup Database
```bash
# Ensure MongoDB is running
sudo systemctl start mongod

# Or using Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

### 4. Setup OCR Language Data
```bash
# Download language data for Tesseract.js (already provided)
# eng.traineddata - English
# ind.traineddata - Indonesian
```

### 5. Run Application
```bash
# Development
npm run dev

# Production
npm start
```

---

## 🌍 Environment Variables

Create a `.env` file in the root directory with the following configuration:

```env
# Server Configuration
PORT=8080
NODE_ENV=development
DEBUG=true

# Database
MONGODB_URI=mongodb://admin:password@localhost:27017/cakradana?authSource=admin

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRES_IN=4h

# Email Configuration
EMAIL_HOST=
EMAIL_PORT=465
EMAIL_SSL=true
EMAIL_USER=
EMAIL_PASS=

# OpenRouter API (for LLM)
OPENROUTER_API_URL=https://openrouter.ai/api/v1/chat/completions
OPENROUTER_API_KEY=
OPENROUTER_API_MODEL=deepseek/deepseek-r1-distill-qwen-7b
```

---

## 📖 How to Use

### 1. Registration & Login
```javascript
// Register new user
POST /user/auth/email/register
{
  "email": "user@example.com",
  "password": "password123",
  "name": "User Name",
  "type": "individual"
}

// Response:
{
  "status": "success",
  "message": "Email registration successful",
  "data": {
    "name": "User Name",
    "email": "user@example.com",
    "type": "individual",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}

// Login
POST /user/auth/email/login
{
  "email": "user@example.com", 
  "password": "password123"
}

// Response:
{
  "status": "success",
  "message": "Login Success",
  "data": {
    "name": "User Name",
    "email": "user@example.com",
    "type": "individual",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### 2. Input Digital Donation Data
```javascript
POST /service/digital-form/input
Authorization: Bearer YOUR_JWT_TOKEN
[
  {
    "sender": "Person A",
    "sender_type": "individual",
    "receiver": "Party B",
    "receiver_type": "political-party",
    "date": "2025-07-30",
    "amount": 2000000
  },
  {
    "sender": "Person B",
    "sender_type": "individual", 
    "receiver": "Party C",
    "receiver_type": "political-party",
    "date": "2025-07-30",
    "amount": 2000000
  }
]
```

### 3. Process OCR Documents
```javascript
POST /service/paper-form/input?lang=ind
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: multipart/form-data

// Upload image files of donation documents
images: [file1.jpg, file2.png]
```

### 4. Web Scraping
```javascript
POST /service/web-scrape/input
Authorization: Bearer YOUR_JWT_TOKEN
{
  "url": "https://example.com/donation-page"
}
```

### 5. Retrieve Donation Data
```javascript
// All donations
GET /service/donations/list
Authorization: Bearer YOUR_JWT_TOKEN

// All entities
GET /service/donations/entities
Authorization: Bearer YOUR_JWT_TOKEN
```

---

## 🤝 Contributing

We welcome contributions from the community! Here's how to contribute:

### 🐛 Reporting Bugs
1. Open [Issues](https://github.com/cakradana-app/cakradana-api/issues)
2. Use the bug report template
3. Include system details and reproduction steps

### 💡 New Features
1. Fork this repository
2. Create a new branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Create a Pull Request

### 📝 Documentation
- Fix typos or add explanations
- Add usage examples
- Translate to other languages

---

<div align="center">

**Made with ❤️ by the Cakradana Team**

[🌐 Website](https://cakradana.org) | [📧 Email](mailto:dev@cakradana.org) | [📝 API Documentation](https://api.cakradana.org)

---

© 2025 Cakradana. Building a more transparent democracy through technology.

</div>