// Required dependencies - install these first:
// npm install whatsapp-web.js qrcode-terminal express body-parser cors multer exceljs fs-extra

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { engine } = require('express-handlebars');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 4000;

// Configure file uploads
const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);

const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function(req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(uploadDir));
app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', './views');


// Track client ready state
let isClientReady = false;

// Store QR code for frontend display
let lastQrCode = '';

// Function to initialize WhatsApp client with error handling
function initializeWhatsAppClient() {
    try {
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'session-' + Date.now() // Use a timestamp to create a unique session
            }),
            puppeteer: {
                browserWSEndpoint: process.env.PUPPETEER_WS_ENDPOINT
            }
        });
        
        // When QR code is received
        client.on('qr', (qr) => {
            console.log('QR RECEIVED. Scan this QR code with your WhatsApp app:');
            qrcode.generate(qr, { small: true });
            lastQrCode = qr; // Store the QR code for the endpoint
        });
        
        // When client is ready
        client.on('ready', () => {
            console.log('WhatsApp client is ready!');
            isClientReady = true;
        });
        
        // Handle authentication failures
        client.on('auth_failure', (error) => {
            console.error('Authentication failed:', error);
            isClientReady = false;
        });
        
        // Handle disconnections
        client.on('disconnected', (reason) => {
            console.log('Client was disconnected:', reason);
            isClientReady = false;
            // Attempt to reinitialize the client
            client.initialize().catch(err => {
                console.error('Failed to reinitialize after disconnect:', err);
                console.log('You may need to restart the application.');
            });
        });
        
        // Initialize the client
        client.initialize().catch(err => {
            console.error('Error during initialization:', err);
            if (err.message.includes('EBUSY') || err.message.includes('locked')) {
                console.log('\n==================================================');
                console.log('SESSION FILES ARE LOCKED!');
                console.log('Try these solutions:');
                console.log('1. Close all Chrome/Chromium processes in Task Manager');
                console.log('2. Delete the .wwebjs_auth folder and restart the app');
                console.log('3. Restart your computer if the issue persists');
                console.log('==================================================\n');
                process.exit(1);
            }
        });
        
        return client;
    } catch (error) {
        console.error('Fatal error creating client:', error);
        process.exit(1);
    }
}

// Initialize the WhatsApp client
const client = initializeWhatsAppClient();

// Helper function to send message to a single recipient
async function sendMessage(phoneNumber, message, mediaPath = null) {
    // Format the phone number
    const formattedNumber = phoneNumber?.includes('@c.us') 
        ? phoneNumber 
        : `${phoneNumber}@c.us`;
    
    try {
        // Check if number exists on WhatsApp
        const isRegistered = await client.isRegisteredUser(formattedNumber);
        
        if (isRegistered) {
            let sentMessage;
            
            if (mediaPath) {
                const media = MessageMedia.fromFilePath(mediaPath);
                sentMessage = await client.sendMessage(formattedNumber, media, {
                    caption: message
                });
            } else {
                sentMessage = await client.sendMessage(formattedNumber, message);
            }
            
            console.log(`Message sent successfully to ${phoneNumber}`);
            return { success: true, phoneNumber, status: 'sent' };
        } else {
            console.log(`The number ${phoneNumber} is not registered on WhatsApp`);
            return { success: false, phoneNumber, status: 'not_registered' };
        }
    } catch (error) {
        console.error(`Error sending message to ${phoneNumber}:`, error);
        return { success: false, phoneNumber, status: 'error', error: error.message };
    }
}

// Extract contacts from groups
async function extractGroupContacts(groupId) {
    try {
        const chat = await client.getChatById(groupId);
        
        let participants = [];
        
        // Try to get participants from groupMetadata first
        if (chat.groupMetadata && Array.isArray(chat.groupMetadata.participants)) {
            console.log('Getting participants from groupMetadata');
            participants = chat.groupMetadata.participants;
        } 
        // If not available, try to fetch them
        else {
            try {
                console.log('Fetching participants using fetchGroupMetadata');
                // Try to fetch the metadata (more reliable in newer versions)
                const metadata = await client.getGroupMetadata(chat.id._serialized);
                participants = metadata.participants || [];
                console.log(`Fetched ${participants.length} participants`);
            } catch (metadataErr) {
                console.error('Error fetching group metadata:', metadataErr);
                
                // Last resort - try direct participants property if it's a function or promise
                try {
                    if (typeof chat.participants === 'function') {
                        participants = await chat.participants();
                    } else if (chat.participants && typeof chat.participants.then === 'function') {
                        participants = await chat.participants;
                    }
                } catch (participantsErr) {
                    console.error('Error getting participants directly:', participantsErr);
                }
            }
        }
        
        if (!participants || participants.length === 0) {
            console.warn('No participants found using standard methods, attempting alternative approach');
            
            // Alternative approach using raw API method if available
            try {
                const rawData = await client.pupPage.evaluate(async (groupId) => {
                    // This uses the internal WhatsApp Web functions
                    const WWebJS = window.Store;
                    const group = await WWebJS.Chat.get(groupId);
                    const participants = group.groupMetadata.participants.getModelsArray();
                    return participants.map(p => ({
                        id: p.id._serialized,
                        isAdmin: p.isAdmin,
                        isSuperAdmin: p.isSuperAdmin
                    }));
                }, chat.id._serialized);
                
                if (rawData && rawData.length > 0) {
                    participants = rawData;
                    console.log(`Retrieved ${participants.length} participants using alternative method`);
                }
            } catch (rawError) {
                console.error('Alternative participant retrieval failed:', rawError);
            }
        }
        
        // Extract participant info
        const contacts = [];
        for (const participant of participants) {
            try {
                // Get participant ID (handle different object structures)
                let participantId;
                
                if (typeof participant === 'string') {
                    participantId = participant;
                } else if (participant.id) {
                    participantId = participant.id._serialized || participant.id;
                } else if (participant._serialized) {
                    participantId = participant._serialized;
                }
                
                if (!participantId) {
                    console.error('Could not extract participant ID from:', participant);
                    continue;
                }
                
                // Get contact info
                console.log(`Getting contact info for: ${participantId}`);
                const contact = await client.getContactById(participantId);
                
                contacts.push({
                    id: participantId,
                    number: contact.number || participantId.split('@')[0],
                    name: contact.name || contact.pushname || 'Unknown',
                    isMyContact: contact.isMyContact || false
                });
            } catch (err) {
                console.error(`Error getting contact info for participant:`, err);
                // Add basic info if contact details fail
                try {
                    contacts.push({
                        id: participant.id?._serialized || participant.id || participant,
                        number: (participant.id?._serialized || participant.id || participant).split('@')[0],
                        name: 'Unknown',
                        isMyContact: false
                    });
                } catch (innerErr) {
                    console.error('Could not add basic participant info:', innerErr);
                }
            }
        }
        
        return {
            success: true,
            groupName: chat.name,
            participantCount: participants.length,
            contacts: contacts
        };
    } catch (error) {
        console.error('Error extracting group contacts:', error);
        return { success: false, error: error.message };
    }
}

// Extract all saved contacts
async function extractAllContacts() {
    try {
        const contacts = await client.getContacts();
        
        // Filter and format contacts
        const savedContacts = contacts
            .filter(contact => contact.isMyContact && contact.number)
            .map(contact => ({
                id: contact.id._serialized,
                number: contact.number,
                name: contact.name || contact.pushname || 'Unknown',
                isMyContact: contact.isMyContact,
                isBusiness: contact.isBusiness
            }));
        
        return {
            success: true,
            contactCount: savedContacts.length,
            contacts: savedContacts
        };
    } catch (error) {
        console.error('Error extracting saved contacts:', error);
        return { success: false, error: error.message };
    }
}

// Extract all groups
async function extractAllGroups() {
    try {
        const chats = await client.getChats();
        
        // Filter and format groups
        const groups = chats
            .filter(chat =>  (chat.id && chat.id._serialized && chat.id._serialized.endsWith('@g.us')) || (chat.groupMetadata !== undefined))
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                participantCount: chat.participants ? chat.participants.length : 'Unknown'
            }));
        
        return {
            success: true,
            groupCount: groups.length,
            groups: groups
        };
    } catch (error) {
        console.error('Error extracting groups:', error);
        return { success: false, error: error.message };
    }
}

// Generate Excel file from contacts
async function generateExcelFile(contacts, filename) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Contacts');
    
    // Add columns
    worksheet.columns = [
        { header: 'Name', key: 'name', width: 30 },
        { header: 'Number', key: 'number', width: 20 },
        { header: 'Is Saved Contact', key: 'isMyContact', width: 15 },
        { header: 'Is Business', key: 'isBusiness', width: 15 },
        { header: 'WhatsApp ID', key: 'id', width: 40 }
    ];
    
    // Add rows
    contacts.forEach(contact => {
        worksheet.addRow(contact);
    });
    
    // Create output directory if it doesn't exist
    const outputDir = path.join(__dirname, 'exports');
    fs.ensureDirSync(outputDir);
    
    const filePath = path.join(outputDir, filename);
    await workbook.xlsx.writeFile(filePath);
    
    return filePath;
}


async function extractNumbersFromExcel(filePath) {
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            throw new Error('Excel file not found');
        }

        // Create a workbook and read the file
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        // Get the first worksheet
        const worksheet = workbook.worksheets[0];
        if (!worksheet) {
            throw new Error('Excel file is empty or has no sheets');
        }

        // Extract phone numbers from the first column (Assume phone numbers are in column A)
        const phoneNumbers = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header row (optional)

            const cellValue = row.getCell(1).value; // Get first column (A)
            if (typeof cellValue === 'string' || typeof cellValue === 'number') {
                const number = String(cellValue).trim();
                if (validatePhoneNumber(number)) {
                    phoneNumbers.push(number);
                }
            }
        });

        return phoneNumbers;
    } catch (error) {
        console.error('Error extracting numbers from Excel:', error.message);
        return [];
    }
}

// Helper function to validate phone numbers
function validatePhoneNumber(number) {
    return typeof number === 'string' && number.match(/^\+?\d{10,15}$/); // Allows +91 and normal 10-15 digit numbers
}

// Parse phone numbers from various formats (comma-separated, newline, Excel)
async function parsePhoneNumbers(req) {
    const { numbers, numbersText } = req.body;
    let parsedNumbers = [];
    
    // Check for uploaded Excel file
    if (req.file && req.file.path && path.extname(req.file.path).toLowerCase() === '.xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.getWorksheet(1);
        
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // Skip header row
                // Assuming phone number is in the first column
                const phoneNumber = row.getCell(1).value;
                if (phoneNumber && (typeof phoneNumber === 'string' || typeof phoneNumber === 'number')) {
                    // Clean up number (remove spaces, dashes, etc.)
                    let cleanNumber;
                    if (typeof phoneNumber === 'string') {
                         cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                    } else {
                         cleanNumber = phoneNumber.toString();
                    }
                    if (cleanNumber) {
                        parsedNumbers.push(cleanNumber);
                    }
                }
            }
        });
    }
    
    // If array of numbers provided directly
    if (Array.isArray(numbers) && numbers.length > 0) {
        parsedNumbers = parsedNumbers.concat(
            numbers.map(n => n.trim().replace(/[^0-9]/g, '')).filter(n => n)
        );
    }
    
    // If comma or newline separated text provided
    if (numbersText) {
        const textNumbers = numbersText
            .split(/[\n,]/) // Split by newline or comma
            .map(n => n.trim().replace(/[^0-9]/g, ''))
            .filter(n => n);
        
        parsedNumbers = parsedNumbers.concat(textNumbers);
    }
    
    // Remove duplicates
    return [...new Set(parsedNumbers)];
}

// API Routes

// GET endpoint to check server status
app.get('/api/status', (req, res) => {
    res.json({
        serverStatus: 'online',
        whatsappStatus: isClientReady ? 'ready' : 'not_ready'
    });
});

// GET endpoint to fetch QR code if not authenticated
app.get('/api/qrcode', (req, res) => {
    if (!isClientReady && lastQrCode) {
        res.json({ qrCode: lastQrCode });
    } else if (isClientReady) {
        res.json({ status: 'authenticated', message: 'WhatsApp client is already authenticated' });
    } else {
        res.json({ status: 'initializing', message: 'WhatsApp client is initializing, QR code not yet available' });
    }
});

// GET endpoint to get all groups
app.get('/api/groups', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready'
        });
    }
    
    try {
        const result = await extractAllGroups();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// GET endpoint to get contacts from a specific group
app.get('/api/groups/:groupId/contacts', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready'
        });
    }
    
    try {
        const result = await extractGroupContacts(req.params.groupId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// GET endpoint to export group contacts to Excel
app.get('/api/groups/:groupId/export', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready'
        });
    }
    
    try {
        const result = await extractGroupContacts(req.params.groupId);
        
        if (!result.success) {
            return res.status(500).json(result);
        }
        
        const filename = `group-${result.groupName.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.xlsx`;
        const filePath = await generateExcelFile(result.contacts, filename);
        
        res.json({
            success: true,
            filename: filename,
            downloadUrl: `/exports/${filename}`,
            contactCount: result.contacts.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// GET endpoint to get all saved contacts
app.get('/api/contacts', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready'
        });
    }
    
    try {
        const result = await extractAllContacts();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// GET endpoint to export all contacts to Excel
app.get('/api/contacts/export', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready'
        });
    }
    
    try {
        const result = await extractAllContacts();
        
        if (!result.success) {
            return res.status(500).json(result);
        }
        
        const filename = `all-contacts-${Date.now()}.xlsx`;
        const filePath = await generateExcelFile(result.contacts, filename);
        
        res.json({
            success: true,
            filename: filename,
            downloadUrl: `/exports/${filename}`,
            contactCount: result.contacts.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST endpoint to send messages to multiple recipients with media support and delay
app.post('/api/send', upload.fields([{ name: 'media' }, { name: 'excel' }]), async (req, res) => {
    try {
        const { message, delaySeconds = 1 } = req.body;
        
        if (!message) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }
        
        if (!isClientReady) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp client is not ready. Please authenticate first by scanning the QR code.' 
            });
        }
        
        // Handle Excel file upload
        let numbers = [];
        if (req.files['excel'] && req.files['excel'][0]) {
            const excelFilePath = req.files['excel'][0].path;
            numbers = await extractNumbersFromExcel(excelFilePath); // Function to read numbers from Excel
        } else {
            numbers = await parsePhoneNumbers(req); // Parse from text input if no Excel file is uploaded
        }

        if (numbers.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'No valid phone numbers found. Please provide recipients.' 
            });
        }

        // Handle media file
        let mediaPath = null;
        if (req.files['media'] && req.files['media'][0]) {
            mediaPath = req.files['media'][0].path;
        }

        res.json({
            success: true,
            message: `Started sending messages to ${numbers.length} recipients with random delays between 3 and ${delaySeconds} seconds.`,
            numbersCount: numbers.length,
            mediaAttached: !!mediaPath,
            delaySeconds: delaySeconds
        });

        // Sending process
        const results = [];
        for (let i = 0; i < numbers.length; i++) {
            const number = numbers[i];
            try {
                if (i > 0 && delaySeconds > 3) {
                    const randomDelay = Math.floor(Math.random() * (delaySeconds - 3 + 1)) + 3;
                    await new Promise(resolve => setTimeout(resolve, randomDelay * 1000));
                }

                const result = await sendMessage(number, message, mediaPath);
                results.push(result);
                console.log(`Sent to ${number} (${i+1}/${numbers.length}): ${result.success ? 'Success' : 'Failed'}`);
            } catch (error) {
                console.error(`Error sending to ${number}:`, error);
                results.push({ success: false, phoneNumber: number, error: error.message });
            }
        }

        console.log(`Completed sending. Success: ${results.filter(r => r.success).length}/${numbers.length}`);

    } catch (error) {
        console.error('Error in send endpoint:', error);
        res.status(500).json({ success: false, error: 'Server error while sending messages' });
    }
});



// Make sure export directory exists
app.use('/exports', express.static(path.join(__dirname, 'exports')));

// Main webpage with advanced interface
app.get('/', (req, res) => {
    res.render('index');
});

// Start the server
app.listen(PORT, () => {
    console.log(`WhatsApp Marketing Tool is running on http://localhost:${PORT}`);
    console.log(`Open this URL in your browser to access the web interface`);
});