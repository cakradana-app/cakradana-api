const Service = require('../services.model').Service;
const cheerio = require('cheerio');
const { extractDonations } = require('../../../utils/llm/openrouter/openrouter');

const input = async (req, res) => {
    try {
        const { url } = req.body;

        // Validate URL input
        if (!url) {
            return res.status(400).json({
                status: 'error',
                message: "URL is required",
                data: {}
            });
        }

        const getService = await Service.findOne({ email: req.user.email });
        if (!getService) {
            return res.status(400).json({
                status: 'error',
                message: "User is not registered yet",
                data: {}
            });
        }

        // Web scraping using cheerio
        console.log(`Scraping URL: ${url}`);
        const response = await fetch(url);
        
        if (!response.ok) {
            return res.status(400).json({
                status: 'error',
                message: `Failed to fetch URL: ${response.status} ${response.statusText}`,
                data: {}
            });
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Extract text from the body and clean it
        const rawText = $('body').text();
        const cleanText = rawText.replace(/\s+/g, ' ').trim();

        console.log(`Extracted text length: ${cleanText.length} characters`);

        if (!cleanText || cleanText.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: "No text content found in the webpage",
                data: {}
            });
        }

        // Extract donations using OpenRouter AI
        console.log('Extracting donations using AI...');
        const extractedDonations = await extractDonations(cleanText);

        console.log(`Found ${extractedDonations.length} donations`);

        if (extractedDonations.length === 0) {
            return res.status(200).json({
                status: 'success',
                message: 'No donations found in the scraped content',
                data: {
                    url: url,
                    donations: []
                }
            });
        }

        // Save donations to database (similar to digital.controller.js)
        for (const donation of extractedDonations) {
            const newDonation = {
                sender: donation.sender || null,
                receiver: donation.receiver || null,
                amount: donation.amount || null,
                date: donation.date || null,
                type: 'web-scrape'
            };
            getService.donations.push(newDonation);

            // Add sender to entities if not exists
            if (donation.sender && !getService.entities.some(entity => entity.name === donation.sender)) {
                getService.entities.push({
                    name: donation.sender,
                    type: donation.sender_type || null
                });
            }

            // Add receiver to entities if not exists
            if (donation.receiver && !getService.entities.some(entity => entity.name === donation.receiver)) {
                getService.entities.push({
                    name: donation.receiver,
                    type: donation.receiver_type || null
                });
            }
        }

        await getService.save();

        return res.status(200).json({
            status: 'success',
            message: `Successfully extracted and saved ${extractedDonations.length} donations from web scraping`,
            data: {
                url: url,
                donations: extractedDonations
            }
        });

    } catch(err) {
        console.error('Web scraping error:', err);
        return res.status(400).json({
            status: 'error',
            message: process.env.DEBUG ? err.message : "Bad Request",
            data: {}
        });
    }
};

module.exports = { 
    input
};