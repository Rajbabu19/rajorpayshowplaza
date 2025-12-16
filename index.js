require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors'); // Frontend connection ke liye

const app = express();
app.use(bodyParser.json());
app.use(cors()); // Allow requests from any frontend

// ==========================================
// CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Sheet1';

// Razorpay Instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Google Sheets Auth
const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json', // Ye file project folder me honi chahiye
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==========================================
// API 1: CREATE ORDER (Frontend calls this)
// ==========================================
app.post('/create-order', async(req, res) => {
    try {
        const { data } = req.body;
        const amountInPaise = Math.round(data.amount_paid * 100);

        // --- LOGIC: Handle Product Name & Size ---

        // 1. Hardcoded Product Name (Jo Sheet aur Razorpay dono me dikhega)
        const fixedProductName = "Comfortable Shoes for winter";

        // 2. Extract Size if available
        let size = "N/A";
        if (data.product_name && data.product_name.includes("(Size:")) {
            const parts = data.product_name.split("(Size:");
            size = parts[1].replace(")", "").trim();
        }

        // --- RAZORPAY ORDER ---
        const options = {
            amount: amountInPaise,
            currency: "INR",
            receipt: "receipt_" + Date.now(),
            payment_capture: 1,

            // NOTES: Ye data Razorpay Dashboard me save hoga aur Webhook me wapas milega
            notes: {
                product_name: fixedProductName, // Razorpay Dashboard ke liye
                size: size,

                customer_name: data.customer_details.customer_name,
                customer_phone: String(data.customer_details.customer_phone),
                address: data.customer_details.address_line1,
                landmark: data.customer_details.landmark,
                pincode: String(data.customer_details.pincode),
                city: data.customer_details.city,
                state: data.customer_details.state,

                method: data.payment_method, // Prepaid/COD
                amount_paid: data.amount_paid,
                amount_remaining: data.amount_remaining,
                total_amount: data.total_amount,

                // Sheet mapping keys
                product: fixedProductName // Sheet ke liye
            }
        };

        const order = await razorpay.orders.create(options);

        res.json({
            status: 'OK',
            order_id: order.id,
            amount: amountInPaise,
            key_id: process.env.RAZORPAY_KEY_ID,
            product_name: fixedProductName
        });

    } catch (error) {
        console.error("Order Creation Error:", error);
        res.status(500).json({ status: 'FAILED', message: error.message });
    }
});

// ==========================================
// API 2: WEBHOOK (Razorpay calls this on success)
// ==========================================
app.post('/razorpay-webhook', async(req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // 1. Verify Signature (Security Check)
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest === signature) {
        console.log('Webhook: Payment Verified');

        // 2. Check Event Type
        if (req.body.event === 'payment.captured') {
            const paymentEntity = req.body.payload.payment.entity;
            const notes = paymentEntity.notes; // Hamara bheja hua data

            try {
                // Sheet me data save karo
                await saveToGoogleSheet(paymentEntity.order_id, paymentEntity.id, notes);
                res.status(200).json({ status: 'ok' });
            } catch (err) {
                console.error("Sheet Error:", err);
                res.status(500).send("Error saving to sheet");
            }
        } else {
            res.status(200).json({ status: 'ignored' });
        }
    } else {
        console.log("Webhook: Invalid Signature");
        res.status(400).json({ status: 'invalid_signature' });
    }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================
async function saveToGoogleSheet(orderId, paymentId, notes) {
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: client });

    // 1. Last Row nikalo (ID generate karne ke liye)
    const getRows = await googleSheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
    });
    const rows = getRows.data.values || [];

    // 2. Generate ID (SPL325 -> SPL326 logic)
    const newCustomId = generateCustomId(rows);
    const isoDate = new Date().toISOString();

    // 3. Data Prepare karo
    const newRow = [
        isoDate, // [0] Date
        newCustomId, // [1] Custom ID
        orderId, // [2] Rzp Order ID
        notes.customer_name, // [3] Name
        notes.customer_phone, // [4] Phone
        notes.address, // [5] Add1
        notes.landmark, // [6] Landmark
        notes.pincode, // [7] Pin
        notes.city, // [8] City
        notes.state, // [9] State
        notes.product, // [10] Product (Fixed Name)
        notes.size, // [11] Size
        notes.method, // [12] Method
        notes.amount_paid, // [13] Paid
        notes.amount_remaining, // [14] Remaining
        notes.total_amount, // [15] Total
        "Payment Received" // [16] Status
    ];

    // 4. Sheet me likho
    await googleSheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [newRow] },
    });
    console.log(`Saved to Sheet: ${newCustomId}`);
}

function generateCustomId(rows) {
    const ID_PREFIX = "SPL";
    const START_BATCH = 351;
    let currentBatch = START_BATCH;
    let currentSequence = 1;

    if (rows.length > 1) {
        const lastRowIndex = rows.length - 1;
        const lastId = rows[lastRowIndex][1]; // Col B me ID hai
        if (lastId) {
            const match = lastId.match(/^SPL(\d{3})(\d{3})$/);
            if (match) {
                currentBatch = parseInt(match[1]);
                currentSequence = parseInt(match[2]) + 1;
                if (currentSequence > 999) {
                    currentBatch++;
                    currentSequence = 1;
                }
            }
        }
    }
    return ID_PREFIX + currentBatch + ("000" + currentSequence).slice(-3);
}

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});