/**
 * OpenRouter LLM utility functions
 * Used for text processing and extraction tasks
 */

/**
 * Extract donation information from Indonesian text using OpenRouter API
 * @param {string} text - The text to extract donation information from
 * @returns {Promise<Array>} Array of donation objects with available structured data
 * 
 * Note: All fields are optional. Only information clearly present in the text will be extracted.
 * Supported date formats: "YYYY-MM-DD", "YYYY-MM-DD HH", "YYYY-MM-DD HH:MM", "YYYY-MM-DD HH:MM:SS"
 */
async function extractDonations(text) {
    try {
        const systemPrompt = `You are an expert at extracting financial donation information from Indonesian text. Your task is to identify and extract all donation transactions mentioned in the text.

For each donation found, extract the following information (only include fields that are clearly available in the text):
- sender: The name of who is giving the donation (optional)
- sender_type: Type of sender - must be one of: "individual", "company", "political-party" (optional)
- receiver: The name of who is receiving the donation (optional)
- receiver_type: Type of receiver - must be one of: "individual", "company", "political-party" (optional)
- amount: The donation amount in rupiah (as a number, without currency symbols) (optional)
- date: The date in one of these formats: "YYYY-MM-DD", "YYYY-MM-DD HH", "YYYY-MM-DD HH:MM", "YYYY-MM-DD HH:MM:SS" (optional)

Classification guidelines:
- "individual": People's names (e.g., "Budi Santoso", "Dr. Ani Kusuma")
- "company": Business entities starting with PT, CV, UD, or other company indicators
- "political-party": Political parties (e.g., "Partai Maju", "Partai Persatuan")

IMPORTANT: Only extract information that is clearly present in the text. If some information is missing or unclear, omit those fields from the JSON object. Each donation object can have different combinations of available fields.

Return ONLY a valid JSON array of objects. Do not include any explanations or additional text.

Example format:
[
  {
    "sender": "Budi Santoso",
    "sender_type": "individual",
    "receiver": "Partai Maju", 
    "receiver_type": "political-party",
    "amount": 100000000,
    "date": "2025-06-05"
  },
  {
    "sender": "PT Sumber Sejahtera",
    "amount": 250000000,
    "date": "2025-06-10 14:30"
  }
]`;

        const userPrompt = `Extract all donation information from the following Indonesian text:

${text}`;

        const requestBody = {
            model: process.env.OPENROUTER_API_MODEL || "deepseek/deepseek-r1-distill-qwen-7b",
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user", 
                    content: userPrompt
                }
            ],
            temperature: 0.1,
            max_tokens: 2000,
            top_p: 0.9
        };

        const response = await fetch(process.env.OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://api.cakradana.org',
                'X-Title': 'Cakradana, Sistem AI untuk memantau dan mendeteksi risiko dalam pembiayaan pemilu',
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Invalid response format from OpenRouter API');
        }

        const extractedText = data.choices[0].message.content.trim();
        
        // Parse the JSON response
        let donations;
        try {
            donations = JSON.parse(extractedText);
        } catch (parseError) {
            // If JSON parsing fails, try to extract JSON from the response
            const jsonMatch = extractedText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                donations = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('Failed to parse donation data from LLM response');
            }
        }

        // Validate the extracted donations
        if (!Array.isArray(donations)) {
            throw new Error('Expected array of donations');
        }

        // Validate each donation object (only validate fields that are present)
        const validatedDonations = donations.map((donation, index) => {
            const validSenderTypes = ['individual', 'company', 'political-party'];
            const validReceiverTypes = ['individual', 'company', 'political-party'];

            // Validate sender_type if present
            if (donation.sender_type && !validSenderTypes.includes(donation.sender_type)) {
                throw new Error(`Invalid sender_type '${donation.sender_type}' in donation ${index + 1}. Must be one of: ${validSenderTypes.join(', ')}`);
            }

            // Validate receiver_type if present
            if (donation.receiver_type && !validReceiverTypes.includes(donation.receiver_type)) {
                throw new Error(`Invalid receiver_type '${donation.receiver_type}' in donation ${index + 1}. Must be one of: ${validReceiverTypes.join(', ')}`);
            }

            // Validate amount if present
            if (donation.amount !== undefined) {
                if (typeof donation.amount !== 'number' || donation.amount <= 0) {
                    throw new Error(`Invalid amount '${donation.amount}' in donation ${index + 1}. Must be a positive number`);
                }
            }

            // Validate date format if present (multiple formats supported)
            if (donation.date) {
                const dateRegex = /^\d{4}-\d{2}-\d{2}(\s\d{1,2}(:\d{2}(:\d{2})?)?)?$/;
                if (!dateRegex.test(donation.date)) {
                    throw new Error(`Invalid date format '${donation.date}' in donation ${index + 1}. Expected formats: YYYY-MM-DD, YYYY-MM-DD HH, YYYY-MM-DD HH:MM, or YYYY-MM-DD HH:MM:SS`);
                }
                
                // Additional validation: try to parse with JavaScript Date
                const parsedDate = new Date(donation.date);
                if (isNaN(parsedDate.getTime())) {
                    throw new Error(`Invalid date '${donation.date}' in donation ${index + 1}. Date cannot be parsed by JavaScript Date constructor`);
                }
            }

            return donation;
        });

        return validatedDonations;

    } catch (error) {
        console.error('Error extracting donations:', error);
        throw new Error(`Failed to extract donations: ${error.message}`);
    }
}

/**
 * Test function to verify donation extraction with the provided example
 * @returns {Promise<Array>} Test results
 */
async function testDonationExtraction() {
    const testText = `Menjelang pemilihan umum 2025, pada 5 Juni Budi Santoso menyampaikan dukungan moral dan finansial dengan menyerahkan sumbangan senilai Rp100.000.000 kepada Partai Maju sebagai wujud komitmennya terhadap proses demokrasi. Beberapa hari kemudian, tepatnya pada 10 Juni, PT Sumber Sejahtera ikut ambil bagian dengan mengalokasikan dana sebesar Rp250.000.000 untuk membantu kegiatan sosial yang digagas oleh Dr. Ani Kusuma. Tidak kalah penting, pada 15 Juni Partai Persatuan mengumumkan penyaluran dana kampanye sebesar Rp500.000.000 kepada PT Pilar Bangsa untuk mendukung logistik dan koordinasi di lapangan.`;
    
    try {
        const result = await extractDonations(testText);
        console.log('Donation extraction test result:', JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        console.error('Test failed:', error);
        throw error;
    }
}

module.exports = {
    extractDonations,
    testDonationExtraction
};
