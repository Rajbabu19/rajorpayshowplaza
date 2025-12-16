require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// ==========================================
// CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Sheet1';

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Google Sheets Auth Logic
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
} else {
    auth = new google.auth.GoogleAuth({
        keyFile: 'google-credentials.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

// ==========================================
// API 1: CREATE ORDER (Modified for Speed & Random ID)
// ==========================================
app.post('/create-order', async (req, res) => {
    try {
        const { data } = req.body;
        const amountInPaise = Math.round(data.amount_paid * 100);

        // 1. Product Name Logic
        const fixedProductName = "Comfortable Shoes for winter";
        
        let size = "N/A";
        if(data.product_name && data.product_name.includes("(Size:")) {
            const parts = data.product_name.split("(Size:");
            size = parts[1].replace(")", "").trim();
        }

        // 2. Google Sheet में 'Pending' Data सेव करें
        // Note: Ab yeh function pehle sheet READ nahi karega, seedha random ID banakar WRITE karega
        const sheetId = await savePendingOrderToSheet(data, fixedProductName, size);

        // 3. Razorpay ke liye ek alag Receipt ID (Internal use)
        const randomReceipt = "rcpt_" + crypto.randomBytes(4).toString('hex');

        // 4. Razorpay Order Create
        const options = {
            amount: amountInPaise,
            currency: "INR",
            receipt: randomReceipt,
            payment_capture: 1,
            notes: {
                sheet_id: sheetId,           // Tracking ID (Important)
                product_name: fixedProductName,
                customer_name: data.customer_details.customer_name
            }
        };

        const order = await razorpay.orders.create(options);

        res.json({
            status: 'OK',
            order_id: order.id,
            amount: amountInPaise,
            key_id: process.env.RAZORPAY_KEY_ID,
            product_name: fixedProductName,
            custom_id: sheetId // Frontend tracking ke liye random ID return kar rahe hain
        });

    } catch (error) {
        console.error("Order Creation Error:", error);
        res.status(500).json({ status: 'FAILED', message: error.message });
    }
});

// ==========================================
// API 2: WEBHOOK (Status Update)
// ==========================================
app.post('/razorpay-webhook', async (req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest === signature) {
        console.log('Webhook: Verified');
        
        if (req.body.event === 'payment.captured') {
            const paymentEntity = req.body.payload.payment.entity;
            const notes = paymentEntity.notes;

            // Sheet ID note se nikalen
            const customSheetId = notes.sheet_id; 

            if (customSheetId) {
                try {
                    // Sheet me Status Update karein
                    await updateSheetStatus(customSheetId, paymentEntity.id);
                    res.status(200).json({ status: 'ok' });
                } catch (err) {
                    console.error("Update Error:", err);
                    res.status(500).send("Error updating sheet");
                }
            } else {
                console.log("No Sheet ID found in notes");
                res.status(200).json({ status: 'no_id_found' });
            }
        } else {
            res.status(200).json({ status: 'ignored' });
        }
    } else {
        res.status(400).json({ status: 'invalid_signature' });
    }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Function 1: Generate Random ID (New Logic)
function generateCustomId() {
    // Generate SPL + 8 random hex characters (e.g., SPL4F2A9B)
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    return "SPL" + randomPart;
}

// Function 2: Save Pending Order (Optimized - No Read, Only Write)
async function savePendingOrderToSheet(data, product, size) {
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: client });

    // Generate Random ID immediately
    const newCustomId = generateCustomId(); 
    const isoDate = new Date().toISOString();

    const newRow = [
        isoDate,                              // [0] Date
        newCustomId,                          // [1] Custom ID (Random)
        "Generating...",                      // [2] Rzp Order ID (Initially Empty)
        data.customer_details.customer_name,  // [3] Name
        String(data.customer_details.customer_phone), // [4] Phone
        data.customer_details.address_line1,  // [5] Add1
        data.customer_details.landmark,       // [6] Landmark
        String(data.customer_details.pincode),// [7] Pin
        data.customer_details.city,           // [8] City
        data.customer_details.state,          // [9] State
        product,                              // [10] Product
        size,                                 // [11] Size
        data.payment_method,                  // [12] Method
        data.amount_paid,                     // [13] Paid
        data.amount_remaining,                // [14] Remaining
        data.total_amount,                    // [15] Total
        "Pending Payment"                     // [16] Status (Pending)
    ];

    await googleSheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [newRow] },
    });
    
    console.log(`Lead Created: ${newCustomId}`);
    return newCustomId;
}

// Function 3: Update Status After Payment
async function updateSheetStatus(targetId, rzpPaymentId) {
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: client });

    // 1. Column B (IDs) laayein taaki row number mil sake
    const getIds = await googleSheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME + '!B:B', // Column B contains Custom IDs
    });

    const rows = getIds.data.values;
    let rowIndex = -1;

    // Row search karein
    if (rows && rows.length) {
        for (let i = 0; i < rows.length; i++) {
            // Check match (targetId jo webhook se aaya vs Sheet ID)
            if (rows[i][0] === targetId) {
                rowIndex = i + 1; // Sheet row index (1-based)
                break;
            }
        }
    }

    if (rowIndex !== -1) {
        // Update Razorpay ID (Column C)
        await googleSheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!C${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[rzpPaymentId]] }
        });

        // Update Status (Column Q)
        await googleSheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!Q${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [["Payment Received - PAID"]] }
        });

        console.log(`Updated Status for ${targetId}`);
    } else {
        console.log(`ID ${targetId} not found in sheet.`);
    }
}

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
