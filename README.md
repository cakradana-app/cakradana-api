# 🏛️ Cakradana API

<div align="center">

![Cakradana Logo](assets/logo.png)

**Sistem AI untuk Transparansi Pembiayaan Pemilu Indonesia**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.21+-blue.svg)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-8.9+-green.svg)](https://www.mongodb.com/)

</div>

---

## 📋 Daftar Isi

- [🎯 Tentang Cakradana](#-tentang-cakradana)
- [❌ Masalah yang Dipecahkan](#-masalah-yang-dipecahkan)
- [✅ Solusi Cakradana](#-solusi-cakradana)
- [🚀 Fitur Utama](#-fitur-utama)
- [🛠️ Tech Stack](#️-tech-stack)
- [⚡ Quick Start](#-quick-start)
- [📚 API Documentation](#-api-documentation)
- [🔧 Instalasi](#-instalasi)
- [🌍 Environment Variables](#-environment-variables)
- [📖 Cara Penggunaan](#-cara-penggunaan)
- [🤝 Kontribusi](#-kontribusi)
- [📄 Lisensi](#-lisensi)

---

## 🎯 Tentang Cakradana

**Cakradana** adalah sistem berbasis kecerdasan buatan (AI) yang dirancang khusus untuk meningkatkan transparansi dan mendeteksi risiko dalam pembiayaan pemilu di Indonesia. Platform ini menggunakan teknologi canggih untuk menganalisis, memproses, dan memvisualisasikan data donasi politik secara real-time.

Nama "Cakradana" diambil dari bahasa Sanskerta yang berarti "roda pemberian" - melambangkan siklus transparansi dalam sistem demokrasi yang sehat.

---

## ❌ Masalah yang Dipecahkan

### 🔍 Kurangnya Transparansi
- **Donasi politik yang tidak terlacak** dengan baik oleh sistem konvensional
- **Sulitnya mengakses informasi** pembiayaan kampanye secara real-time
- **Keterbatasan dalam menganalisis pola** donasi yang kompleks

### 📊 Fragmentasi Data
- **Data donasi tersebar** di berbagai format (digital, kertas, website)
- **Proses manual yang lambat** dalam pengumpulan dan verifikasi data
- **Kesulitan dalam mengidentifikasi jaringan** dan koneksi antar entitas

### 🚨 Risiko Korupsi & Money Politics
- **Deteksi dini yang lemah** terhadap pola donasi mencurigakan
- **Kurangnya analisis jaringan** untuk mengidentifikasi potensi konflik kepentingan
- **Minimnya tools otomatis** untuk monitoring pembiayaan kampanye

---

## ✅ Solusi Cakradana

### 🤖 Teknologi AI & Machine Learning
Cakradana menggunakan AI untuk:
- **Ekstraksi otomatis** data donasi dari berbagai sumber
- **Analisis pola** dan deteksi anomali dalam pembiayaan
- **Prediksi risiko** berdasarkan historical data dan network analysis

### 🔄 Integrasi Multi-Channel
Platform ini menyatukan data dari:
- **📱 Form Digital** - Input manual melalui API
- **📄 Dokumen Fisik** - OCR untuk ekstraksi data dari scan dokumen
- **🌐 Web Scraping** - Otomatis mengumpulkan data dari website publik

### 📈 Visualisasi & Analytics
- **Real-time dashboard** untuk monitoring donasi
- **Network visualization** untuk melihat koneksi antar entitas
- **Risk scoring** otomatis berdasarkan berbagai parameter
- **Laporan komprehensif** dalam format yang mudah dipahami

---

## 🚀 Fitur Utama

### 🔐 Autentikasi & Keamanan
- **JWT-based authentication** untuk akses yang aman
- **Email verification** dan password reset
- **Role-based access control** untuk berbagai tingkat pengguna

### 📊 Input Data Multi-Format
- **Digital Form Processing** - API endpoint untuk input data terstruktur
- **OCR Document Processing** - Ekstraksi data dari scan dokumen (mendukung bahasa Indonesia & Inggris)
- **Web Scraping** - Otomatis mengumpulkan data dari halaman web publik

### 🕸️ Network Analysis
- **Entity Management** - Tracking donor, penerima, dan entitas terkait
- **Relationship Mapping** - Visualisasi hubungan antar entitas
- **Risk Detection** - Identifikasi pola donasi yang mencurigakan

### 📱 RESTful API
- **OpenAPI 3.0 Documentation** - Dokumentasi lengkap dan interaktif
- **Postman Collection** - Ready-to-use API testing
- **CORS Support** - Cross-origin resource sharing untuk frontend integration

---

## 🛠️ Tech Stack

### 🖥️ Backend Framework
- **Node.js** `18+` - Runtime environment
- **Express.js** `4.21+` - Web application framework
- **Body-parser** - Request body parsing middleware
- **CORS** - Cross-origin resource sharing

### 🗄️ Database & Storage
- **MongoDB** `8.9+` - NoSQL database dengan Mongoose ODM
- **Cloudflare R2** - Object storage untuk file handling

### 🔒 Authentication & Security
- **JSON Web Token (JWT)** - Stateless authentication
- **bcrypt** `6.0+` - Password hashing
- **Passport.js** - Google OAuth2 integration

### 🤖 AI & Data Processing
- **Tesseract.js** `6.0+` - OCR (Optical Character Recognition)
- **Cheerio** `1.1+` - Server-side HTML parsing untuk web scraping
- **OpenRouter API** - LLM integration untuk natural language processing

### 📧 Communication
- **Nodemailer** `7.0+` - Email service integration
- **EJS** `3.1+` - Template engine untuk email dan web pages

### 🛠️ Development Tools
- **Multer** - File upload handling
- **dotenv** - Environment variables management
- **Nodemon** - Development auto-restart

### 🐳 Deployment
- **Docker** - Containerization dengan compose.yml
- **Linux** - Production environment support

---

## ⚡ Quick Start

### Prasyarat
```bash
Node.js >= 18.0.0
MongoDB >= 8.9.0
npm atau yarn
```

### Instalasi Cepat
```bash
# Clone repository
git clone https://github.com/cakradana-app/cakradana-api.git
cd cakradana-api

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
# Edit .env dengan konfigurasi Anda

# Jalankan development server
npm run dev
```

---

## 📚 API Documentation

### 🔗 Endpoint Utama

#### Authentication
- `POST /user/auth/email/login` - Login dengan email
- `POST /user/auth/email/register` - Registrasi pengguna baru
- `GET /user/auth/refresh-token` - Refresh access token
- `POST /user/auth/email/forgot-password` - Reset password
- `PUT /user/auth/email/change-password` - Ubah password

#### Digital Form Services
- `POST /service/digital-form/input` - Input data donasi manual

#### Paper Form Services
- `POST /service/paper-form/input` - Upload dan proses dokumen fisik via OCR

#### Web Scraping Services
- `POST /service/web-scrape/input` - Scraping data dari website

#### Donation Management
- `GET /service/donations/list` - Daftar semua donasi user
- `GET /service/donations/entities` - Daftar entitas (donor/penerima)

### 📋 Import Postman Collection
```bash
# Import file postman.json ke Postman untuk testing API
```

---

## 🔧 Instalasi

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
# Pastikan MongoDB berjalan
sudo systemctl start mongod

# Atau menggunakan Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

### 4. Setup OCR Language Data
```bash
# Download language data untuk Tesseract.js (sudah disediakan)
# eng.traineddata - English
# ind.traineddata - Indonesian
```

### 5. Jalankan Aplikasi
```bash
# Development
npm run dev

# Production
npm start
```

---

## 🌍 Environment Variables

Buat file `.env` di root directory dengan konfigurasi berikut:

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

# OpenRouter API (untuk LLM)
OPENROUTER_API_URL=https://openrouter.ai/api/v1/chat/completions
OPENROUTER_API_KEY=
OPENROUTER_API_MODEL=deepseek/deepseek-r1-distill-qwen-7b
```

---

## 📖 Cara Penggunaan

### 1. Registrasi & Login
```javascript
// Registrasi pengguna baru
POST /user/auth/email/register
{
  "email": "user@example.com",
  "password": "password123"
}

// Login
POST /user/auth/email/login
{
  "email": "user@example.com", 
  "password": "password123"
}
```

### 2. Input Data Donasi Digital
```javascript
POST /service/digital-form/input
Authorization: Bearer YOUR_JWT_TOKEN
[
  {
    "sender": "Orang A",
    "sender_type": "individual",
    "receiver": "Parpol B",
    "receiver_type": "political-party",
    "date": "2025-07-30",
    "amount": 2000000
  },
  {
    "sender": "Orang B",
    "sender_type": "individual", 
    "receiver": "Parpol C",
    "receiver_type": "political-party",
    "date": "2025-07-30",
    "amount": 2000000
  }
]
```

### 3. Proses Dokumen OCR
```javascript
POST /service/paper-form/input?lang=ind
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: multipart/form-data

// Upload file gambar dokumen donasi
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

### 5. Ambil Data Donasi
```javascript
// Semua donasi
GET /service/donations/list
Authorization: Bearer YOUR_JWT_TOKEN

// Semua entitas
GET /service/donations/entities
Authorization: Bearer YOUR_JWT_TOKEN
```

---

## 🤝 Kontribusi

Kami menyambut kontribusi dari komunitas! Berikut cara berkontribusi:

### 🐛 Melaporkan Bug
1. Buka [Issues](https://github.com/cakradana-app/cakradana-api/issues)
2. Gunakan template bug report
3. Sertakan detail sistem dan langkah reproduksi

### 💡 Fitur Baru
1. Fork repository ini
2. Buat branch baru (`git checkout -b feature/AmazingFeature`)
3. Commit perubahan (`git commit -m 'Add some AmazingFeature'`)
4. Push ke branch (`git push origin feature/AmazingFeature`)
5. Buat Pull Request

### 📝 Dokumentasi
- Perbaiki typo atau tambahkan penjelasan
- Tambahkan contoh penggunaan
- Terjemahkan ke bahasa lain

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah [MIT License](LICENSE) - lihat file LICENSE untuk detail lengkap.

---

<div align="center">

**Dibuat dengan ❤️ oleh Tim Cakradana**

[🌐 Website](https://cakradana.org) | [📧 Email](mailto:dev@cakradana.org) | [📝 Dokumentasi API](https://api.cakradana.org)

---

© 2025 Cakradana. Membangun demokrasi yang lebih transparan melalui teknologi.

</div>