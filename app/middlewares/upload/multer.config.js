const multer = require('multer');
const path = require('path');

// Configure multer for memory storage (store files in memory as buffers)
const storage = multer.memoryStorage();

// File filter to only allow image files
const fileFilter = (req, file, cb) => {
    // Check if the file is an image
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed!'), false);
    }
};

// Configure multer with options
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB per file
        files: 10 // Maximum 10 files
    }
});

// Middleware for multiple image uploads
const uploadMultipleImages = upload.array('images', 10); // 'images' is the field name, max 10 files

module.exports = {
    uploadMultipleImages
};