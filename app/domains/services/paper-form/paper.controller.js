const { createWorker } = require('tesseract.js');
const tesseractConfig = require('../../../configs/ocr/tesseract.config');
const { extractDonations } = require('../../../utils/llm/openrouter/openrouter');
const Service = require('../services.model').Service;

const input = async (req, res) => {
    try {
        // Check if files were uploaded
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No images were uploaded'
            });
        }

        // Get language from query parameter or use default
        const language = req.query.lang && tesseractConfig.availableLanguages[req.query.lang] 
            ? req.query.lang 
            : tesseractConfig.defaultLanguage;

        console.log(`Processing ${req.files.length} images for OCR using language: ${language}...`);

        // Array to store OCR results
        const ocrResults = [];

        // Create a Tesseract worker with custom configuration
        const worker = await createWorker(language, 1, {
            langPath: tesseractConfig.langPath,
            ...tesseractConfig.workerOptions
        });

        try {
            // Process each uploaded image
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                
                console.log(`Processing image ${i + 1}/${req.files.length}: ${file.originalname}`);

                // Perform OCR on the image buffer
                const { data: { text } } = await worker.recognize(file.buffer);
                
                // Store the result
                ocrResults.push({
                    filename: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                    text: text.trim(),
                    language: language,
                    languageName: tesseractConfig.availableLanguages[language]
                });

                console.log(`Completed OCR for: ${file.originalname}`);
            }
        } finally {
            // Always terminate the worker to free memory
            await worker.terminate();
        }

        // Combine all extracted text for donation extraction
        const combinedText = ocrResults.map(result => result.text).join('\n\n');
        
        let extractedDonations = [];
        let extractionError = null;
        
        // Extract donations using OpenRouter LLM if there's text content
        if (combinedText.trim().length > 0) {
            try {
                console.log('Extracting donation information using OpenRouter LLM...');
                extractedDonations = await extractDonations(combinedText);
                console.log(`Successfully extracted ${extractedDonations.length} donations`);
                
                // Save extracted donations to database
                if (extractedDonations.length > 0) {
                    const getService = await Service.findOne({ email: req.user.email });
                    if (!getService) {
                        return res.status(400).json({
                            status: 'error',
                            message: "User is not registered yet",
                            data: {}
                        });
                    } else {
                        // Add donations to the service
                        console.log('Extracted donations:', extractedDonations);
                        console.log('Current entities before adding:', getService.entities);
                        
                        for (const donation of extractedDonations) {
                            console.log('Processing donation:', donation);
                            
                            const newDonation = {
                                sender: donation.sender || null,
                                receiver: donation.receiver || null,
                                amount: donation.amount || null,
                                date: donation.date || null,
                                type: 'paper-form'
                            };
                            getService.donations.push(newDonation);

                            // Add entities if they don't exist
                            if (donation.sender && typeof donation.sender === 'string' && donation.sender.trim() !== '') {
                                const senderExists = getService.entities.some(entity => entity.name === donation.sender);
                                console.log(`Sender "${donation.sender}" exists:`, senderExists);
                                
                                if (!senderExists) {
                                    const newSenderEntity = {
                                        name: donation.sender.trim(),
                                        type: donation.sender_type || null
                                    };
                                    console.log('Adding sender entity:', newSenderEntity);
                                    getService.entities.push(newSenderEntity);
                                }
                            } else if (donation.sender) {
                                console.warn('Invalid sender data:', donation.sender);
                            }

                            if (donation.receiver && typeof donation.receiver === 'string' && donation.receiver.trim() !== '') {
                                const receiverExists = getService.entities.some(entity => entity.name === donation.receiver);
                                console.log(`Receiver "${donation.receiver}" exists:`, receiverExists);
                                
                                if (!receiverExists) {
                                    const newReceiverEntity = {
                                        name: donation.receiver.trim(),
                                        type: donation.receiver_type || null
                                    };
                                    console.log('Adding receiver entity:', newReceiverEntity);
                                    getService.entities.push(newReceiverEntity);
                                }
                            } else if (donation.receiver) {
                                console.warn('Invalid receiver data:', donation.receiver);
                            }
                        }
                        
                        console.log('Final entities before save:', getService.entities);
                        
                        // Filter out any invalid entities before saving
                        getService.entities = getService.entities.filter(entity => 
                            entity.name && typeof entity.name === 'string' && entity.name.trim() !== ''
                        );
                        console.log('Entities after filtering:', getService.entities);
                        
                        await getService.save();
                        console.log('Successfully saved extracted donations to database');
                    }
                }
            } catch (error) {
                console.error('Error extracting donations:', error);
                return res.status(500).json({
                    success: false,
                    message: 'Error extracting donations',
                    error: error.message
                });
            }
        }

        // Return comprehensive results
        return res.status(200).json({
            success: true,
            message: `Successfully processed ${req.files.length} images using ${tesseractConfig.availableLanguages[language]} OCR${extractedDonations.length > 0 ? ` and extracted ${extractedDonations.length} donations` : ''}`,
            results: {
                ocr: ocrResults,
                donations: extractedDonations
            },
            summary: {
                totalImages: req.files.length,
                language: language,
                languageName: tesseractConfig.availableLanguages[language],
                totalTextExtracted: ocrResults.reduce((total, result) => total + result.text.length, 0),
                donationsExtracted: extractedDonations.length,
                savedToDatabase: extractedDonations.length > 0 && !extractionError
            }
        });

    } catch (error) {
        console.error('Error during OCR processing:', error);
        
        return res.status(500).json({
            success: false,
            message: 'Error processing images for OCR',
            error: error.message
        });
    }
};

module.exports = { 
    input
};