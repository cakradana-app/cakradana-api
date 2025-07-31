const path = require('path');

// Tesseract OCR Configuration
const tesseractConfig = {
    // Path to traineddata files
    langPath: path.join(__dirname, 'tesseract'),
    
    // Available languages (based on traineddata files)
    availableLanguages: {
        'eng': 'English',
        'ind': 'Indonesian'
    },
    
    // Default language
    defaultLanguage: 'ind',
    
    // OCR Engine Mode (OEM)
    // 0: Legacy engine only
    // 1: Neural nets LSTM engine only
    // 2: Legacy + LSTM engines
    // 3: Default, based on what is available
    oem: 3,
    
    // Page Segmentation Mode (PSM)
    // 3: Fully automatic page segmentation, but no OSD (default)
    // 6: Assume a single uniform block of text
    // 8: Treat the image as a single word
    // 13: Raw line. Treat the image as a single text line
    psm: 3,
    
    // Worker options
    workerOptions: {
        // Logging level: 0 = no logs, 1 = errors, 2 = warnings, 3 = info, 4 = debug
        logger: message => {
            if (process.env.NODE_ENV === 'development') {
                console.log('[Tesseract]', message);
            }
        }
    }
};

module.exports = tesseractConfig;