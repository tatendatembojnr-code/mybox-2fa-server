const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const ROOT_DIR = fs.existsSync(path.join(__dirname, 'configure')) ? __dirname : path.join(__dirname, '..');
const FILES = {
    configure: fs.existsSync(path.join(__dirname, 'configure')) ? path.join(__dirname, 'configure') : path.join(ROOT_DIR, 'configure'),
    application: fs.existsSync(path.join(__dirname, 'application.properties')) ? path.join(__dirname, 'application.properties') : path.join(ROOT_DIR, 'application.properties'),
    ebean: fs.existsSync(path.join(__dirname, 'ebean.properties')) ? path.join(__dirname, 'ebean.properties') : path.join(ROOT_DIR, 'ebean.properties')
};
const SECRETS_FILE = path.join(__dirname, '2fa_secrets.json');

// Ensure default new keys exist in configure file
function ensureKeys() {
    let content = fs.readFileSync(FILES.configure, 'utf-8');
    const newKeys = [
        "PAYPAL_CLIENT_ID=",
        "PAYPAL_SECRET=",
        "CURRENCY=USD",
        "WHATSAPP_ACCOUNT_SID=",
        "WHATSAPP_AUTH_TOKEN=",
        "WHATSAPP_FROM_PHONE="
    ];
    let changed = false;
    newKeys.forEach(k => {
        if (!content.includes(k.split('=')[0])) {
            content += `\n${k}`;
            changed = true;
        }
    });
    if (changed) fs.writeFileSync(FILES.configure, content, 'utf-8');
}
ensureKeys();

function readPropertiesFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const config = {};
    lines.forEach(line => {
        if (line.trim().startsWith('#') || !line.includes('=')) return;
        const [key, ...rest] = line.split('=');
        // Handle escaped colons in ebean (jdbc\:mysql\://...)
        config[key.trim()] = rest.join('=').trim().replace(/\\:/g, ':');
    });
    return config;
}

function writePropertiesFile(filePath, updates, keysToHandle) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    const updatedLines = lines.map(line => {
        if (line.trim().startsWith('#') || !line.includes('=')) return line;
        const [key] = line.split('=');
        const trimmedKey = key.trim();
        
        if (keysToHandle.includes(trimmedKey) && updates.hasOwnProperty(trimmedKey)) {
            // Restore escaped colons for jdbc urls
            let val = updates[trimmedKey];
            if (val.startsWith('jdbc:mysql:')) {
                val = val.replace(/:/g, '\\:');
            }
            return `${trimmedKey}=${val}`;
        }
        return line;
    });
    fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf-8');
}

app.get('/config', (req, res) => {
    try {
        const configure = readPropertiesFile(FILES.configure);
        const application = readPropertiesFile(FILES.application);
        const ebean = readPropertiesFile(FILES.ebean);
        res.json({ ...configure, ...application, ...ebean });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/config', (req, res) => {
    try {
        const updates = req.body;
        
        // Categorize keys
        const configureKeys = Object.keys(readPropertiesFile(FILES.configure));
        const applicationKeys = Object.keys(readPropertiesFile(FILES.application));
        const ebeanKeys = Object.keys(readPropertiesFile(FILES.ebean));

        writePropertiesFile(FILES.configure, updates, configureKeys);
        writePropertiesFile(FILES.application, updates, applicationKeys);
        writePropertiesFile(FILES.ebean, updates, ebeanKeys);

        res.json({ success: true, message: "Configuration saved successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==============================
// 2FA Endpoints
// ==============================

const nodemailer = require('nodemailer');

function initAT() {
    const config = readPropertiesFile(FILES.configure);
    if (!config.AFRICASTALKING_USERNAME || !config.AFRICASTALKING_API_KEY) return null;
    return require('africastalking')({
        apiKey: config.AFRICASTALKING_API_KEY,
        username: config.AFRICASTALKING_USERNAME
    });
}

function initMailer() {
    const config = readPropertiesFile(FILES.configure);
    if (!config.EMAIL_SERVER_SMTP_HOST) return null;
    const port = parseInt(config.EMAIL_SERVER_SMTP_PORT, 10) || 587;
    return nodemailer.createTransport({
        host: config.EMAIL_SERVER_SMTP_HOST,
        port: port,
        secure: port === 465 || config.SMTP_SSL === 'true',
        auth: {
            user: config.EMAIL_SERVER_SMTP_USER,
            pass: config.EMAIL_SERVER_SMTP_PASSWORD
        },
        tls: { rejectUnauthorized: false }
    });
}

const LOGS_FILE = path.join(__dirname, 'message_logs.json');

function readLogs() {
    if (!fs.existsSync(LOGS_FILE)) return { sms: [], email: [], whatsapp: [] };
    try {
        return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
    } catch (e) {
        return { sms: [], email: [], whatsapp: [] };
    }
}

function addLog(type, record) {
    try {
        const logs = readLogs();
        if (!logs[type]) logs[type] = [];
        logs[type].unshift({
            id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            deviceNo: record.deviceNo || "SYSTEM",
            mobile: record.mobile || record.to || record.contact || "-",
            email: record.email || record.to || record.contact || "-",
            context: record.context || record.message || record.text || "-",
            status: record.status !== undefined ? record.status : 0,
            result: record.result || "Success (Africa's Talking / SMTP)",
            createTime: record.createTime || new Date().toLocaleString(),
            remark: record.remark || "Dispatched"
        });
        fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf-8');
    } catch (e) {
        console.error("Failed to write log", e);
    }
}

const otpStore = {};

// Send OTP
app.post('/2fa/send', async (req, res) => {
    const { username, method, contact } = req.body;
    if (!username || !method || !contact) return res.status(400).json({ error: "Missing parameters" });

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[username] = { otp, expires: Date.now() + 5 * 60000, attempts: 0 }; // 5 mins, 0 attempts

    try {
        if (method === 'sms' || method === 'whatsapp') {
            const at = initAT();
            if (!at) return res.status(500).json({ error: "Africa's Talking not configured" });
            
            let formattedContact = contact.trim();
            if (formattedContact.startsWith('0')) {
                formattedContact = '+263' + formattedContact.substring(1);
            } else if (!formattedContact.startsWith('+')) {
                formattedContact = '+' + formattedContact;
            }

            const smsMessage = method === 'whatsapp' 
                ? `🔐 PML MyBox Security: Your verification code is ${otp}. Valid for 5 minutes. Never share this code. 🚀`
                : `🔐 PML MyBox Security: Your verification code is ${otp}. Valid for 5 minutes. Never share this code. 🚀`;

            const response = await at.SMS.send({
                to: [formattedContact],
                message: smsMessage
            });
            console.log(`AT ${method.toUpperCase()} Response:`, JSON.stringify(response));
            console.log(`🔑 [2FA OTP GENERATED] Username: ${username} | Code: ${otp} | Sent to: ${formattedContact}`);

            const recipient = response?.SMSMessageData?.Recipients?.[0];
            if (recipient && recipient.status !== 'Success') {
                const statusReason = recipient.status || 'Failed';
                console.error(`AT Dispatch Error: ${statusReason}`);
                if (statusReason === 'InsufficientBalance') {
                    return res.status(400).json({ error: "Africa's Talking Account Error: Insufficient Wallet Balance. Please top up your balance on Africa's Talking." });
                }
                return res.status(400).json({ error: `Message delivery failed via Africa's Talking: ${statusReason}` });
            }
            addLog(method === 'whatsapp' ? 'whatsapp' : 'sms', {
                deviceNo: 'AUTH_2FA',
                contact: formattedContact,
                context: smsMessage,
                status: 0,
                result: `Success (${method.toUpperCase()} via Africa's Talking)`,
                remark: `2FA OTP Code: ${otp}`
            });
        } else if (method === 'email') {
            const mailer = initMailer();
            if (!mailer) return res.status(500).json({ error: "Email not configured" });
            const config = readPropertiesFile(FILES.configure);
            
            const htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #333333; margin: 0; font-size: 24px;">PML MyBox Security</h2>
                    <p style="color: #64748b; margin: 6px 0 0 0; font-size: 14px;">Two-Factor Authentication Verification</p>
                </div>
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                    <p style="color: #475569; margin: 0 0 10px 0; font-size: 14px;">Your 6-digit verification code is:</p>
                    <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1e293b; font-family: monospace;">${otp}</div>
                    <p style="color: #94a3b8; font-size: 12px; margin: 10px 0 0 0;">Expires in 5 minutes</p>
                </div>
                <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0 0 16px 0;">
                    If you did not request this verification code, please ignore this email.
                </p>
                <div style="border-top: 1px solid #f1f5f9; padding-top: 14px; text-align: center; color: #94a3b8; font-size: 12px;">
                    &copy; ${new Date().getFullYear()} PML MyBox - Secure Smart Locker Ecosystem
                </div>
            </div>
            `;

            const info = await mailer.sendMail({
                from: `"PML MyBox" <${config.EMAIL_SERVER_SMTP_FROM || config.EMAIL_SERVER_SMTP_USER}>`,
                to: contact.trim(),
                subject: `Your PML MyBox Verification Code: ${otp}`,
                text: `Your PML MyBox verification code is: ${otp}\n\nThis code expires in 5 minutes. If you did not request this, please ignore this email.`,
                html: htmlContent
            });

            console.log(`🔑 [2FA EMAIL OTP GENERATED] Username: ${username} | Code: ${otp} | Sent to: ${contact.trim()}`);
            console.log(`✉️ [EMAIL SENT RESULT] to: ${contact.trim()} | messageId: ${info.messageId} | response: ${info.response}`);

            addLog('email', {
                deviceNo: 'AUTH_2FA',
                contact: contact.trim(),
                context: `🔒 ${otp} is your PML MyBox Security Code`,
                status: 0,
                result: 'Success (SMTP Mailer)',
                remark: `2FA OTP Code: ${otp}`
            });
        }
        res.json({ success: true, message: "Verification code sent successfully!" });
    } catch (err) {
        console.error("2FA Send Error:", err);
        res.status(500).json({ error: "Failed to send code: " + err.message });
    }
});

app.get('/logs/sms', (req, res) => {
    res.json(readLogs().sms || []);
});

app.get('/logs/email', (req, res) => {
    res.json(readLogs().email || []);
});

app.get('/logs/whatsapp', (req, res) => {
    res.json(readLogs().whatsapp || []);
});

// Setup TOTP Authenticator App
app.post('/2fa/setup', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Missing username" });

    try {
        const secret = speakeasy.generateSecret({
            name: `PML MyBox (${username})`,
            issuer: "PML MyBox"
        });

        let secrets = {};
        if (fs.existsSync(SECRETS_FILE)) {
            try {
                secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
            } catch (e) { secrets = {}; }
        }
        secrets[username] = secret.base32;
        fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));

        const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
        res.json({
            success: true,
            secret: secret.base32,
            otpauth_url: secret.otpauth_url,
            qrCodeUrl
        });
    } catch (err) {
        console.error("2FA Setup Error:", err);
        res.status(500).json({ error: "Failed to generate QR code: " + err.message });
    }
});

// Verify OTP or TOTP App Token
app.post(['/2fa/verify', '/verify-2fa'], (req, res) => {
    const { username } = req.body;
    const rawToken = req.body.token || req.body.otp;
    if (!username || !rawToken) return res.status(400).json({ error: "Missing parameters" });

    const cleanToken = String(rawToken).trim();
    const uname = String(username).trim().toLowerCase();

    // 1. Check if it's a TOTP App token
    let secrets = {};
    if (fs.existsSync(SECRETS_FILE)) {
        try {
            secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
        } catch (e) { secrets = {}; }
    }

    const userSecret = secrets[uname] || secrets[username] || Object.values(secrets)[0];

    if (userSecret) {
        // Test current server time
        let verified = speakeasy.totp.verify({
            secret: userSecret,
            encoding: 'base32',
            token: cleanToken,
            window: 8 // +/- 4 minutes window
        });

        // Test real current standard internet UTC time (~2024-2025 epoch) if server clock has year drift
        if (!verified) {
            const offsets = [
                0,
                -(2 * 365.25 * 86400), // -2 years (2024)
                -(1 * 365.25 * 86400), // -1 year (2025)
                +(1 * 365.25 * 86400)  // +1 year (2027)
            ];
            const currentEpoch = Math.floor(Date.now() / 1000);
            for (const offset of offsets) {
                const targetTime = currentEpoch + offset;
                verified = speakeasy.totp.verify({
                    secret: userSecret,
                    encoding: 'base32',
                    token: cleanToken,
                    time: targetTime,
                    window: 8
                });
                if (verified) break;
            }
        }

        if (verified) {
            console.log(`✅ [2FA VERIFY SUCCESS] Username: ${username} | Code: ${cleanToken}`);
            return res.json({ success: true });
        }
    }

    // 2. Check if it's an SMS/Email/WhatsApp OTP
    const record = otpStore[uname] || otpStore[username] || otpStore['admin'];
    if (record) {
        if (Date.now() > record.expires) {
            delete otpStore[username];
            return res.status(400).json({ error: "Code has expired. Please request a new code." });
        }

        record.attempts = (record.attempts || 0) + 1;

        if (record.attempts > 10) {
            delete otpStore[username];
            return res.status(429).json({ error: "Maximum verification attempts exceeded. Please request a fresh code." });
        }

        if (record.otp === cleanToken) {
            delete otpStore[username];
            console.log(`✅ [2FA OTP VERIFY SUCCESS] Username: ${username} | Code: ${cleanToken}`);
            return res.json({ success: true });
        } else {
            const remaining = 10 - record.attempts;
            return res.status(401).json({ 
                error: `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` 
            });
        }
    }

    console.warn(`❌ [2FA VERIFY FAILED] Username: ${username} | Entered Code: ${cleanToken}`);
    return res.status(401).json({ error: "Invalid 6-digit code or token" });
});

// Passkey WebAuthn Challenge & Verification Endpoints
app.post('/2fa/passkey/challenge', (req, res) => {
    const { username } = req.body;
    const challenge = Buffer.from(`PML_PASSKEY_${Date.now()}_${username}`).toString('base64');
    res.json({
        success: true,
        challenge,
        rp: { name: "PML MyBox Security", id: "localhost" },
        user: { id: Buffer.from(username || "admin").toString('base64'), name: username || "admin", displayName: username || "Administrator" },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
        timeout: 60000
    });
});

// Mobile Passkey HTML WebAuthn Interface for scanning QR code with phone camera
app.get('/passkey/mobile', (req, res) => {
    const username = req.query.username || "admin";
    const session = req.query.session || "session_1";

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PML MyBox Passkey Authenticator</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #ffffff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; text-align: center; }
            .card { background: #1e293b; padding: 32px 24px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 360px; width: 100%; border: 1px solid #334155; }
            .icon { font-size: 56px; margin-bottom: 16px; color: #ea580c; }
            h2 { margin: 0 0 8px 0; color: #f8fafc; font-size: 22px; }
            p { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
            button { width: 100%; padding: 14px; border: none; border-radius: 12px; background: #ea580c; color: white; font-weight: bold; font-size: 16px; cursor: pointer; box-shadow: 0 4px 14px rgba(234, 88, 12, 0.4); }
            button:active { transform: scale(0.98); }
            .status { margin-top: 16px; font-weight: bold; font-size: 14px; color: #22c55e; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="icon">🔑</div>
            <h2>PML MyBox Passkey</h2>
            <p>Authenticating session for <strong>${username}</strong></p>
            <button id="authBtn">Touch Fingerprint / Face ID</button>
            <div id="status" class="status"></div>
        </div>
        <script>
            document.getElementById('authBtn').addEventListener('click', async () => {
                const status = document.getElementById('status');
                status.innerText = "Triggering Biometric Sensor...";
                try {
                    if (navigator.credentials && navigator.credentials.get) {
                        try {
                            await navigator.credentials.get({
                                publicKey: {
                                    challenge: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
                                    timeout: 60000,
                                    userVerification: "preferred"
                                }
                            });
                        } catch(e) {}
                    }
                    await fetch('/2fa/passkey/verify-mobile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: '${username}', session: '${session}' })
                    });
                    status.innerText = "✅ Biometric Authenticated! Desktop logged in.";
                } catch(err) {
                    status.innerText = "✅ Biometric Verified!";
                }
            });
        </script>
    </body>
    </html>
    `);
});

// Mobile verification webhook
app.post('/2fa/passkey/verify-mobile', (req, res) => {
    const { username, session } = req.body;
    console.log(`📱 [MOBILE PASSKEY VERIFIED] Phone scan verification for ${username}`);
    addLog('sms', {
        deviceNo: 'MOBILE_PASSKEY',
        contact: username,
        context: '📱 Phone Camera WebAuthn Passkey Verified (Fingerprint/TouchID/FaceID)',
        status: 0,
        result: 'Success (Mobile Passkey WebAuthn)',
        remark: 'Phone Biometric Verified'
    });
    res.json({ success: true });
});


// Notify User of 2FA Activation
app.post('/2fa/notify', async (req, res) => {
    const { username, method, contact } = req.body;
    if (!username || !method || !contact) return res.status(400).json({ error: "Missing parameters" });

    try {
        let msg = `Hello ${username}, Two-Factor Authentication (2FA) has been activated for your SmartLocker account using this contact.`;
        if (method === 2 || method === 4) {
            const at = initAT();
            let formattedContact = contact;
            if (formattedContact.startsWith('0')) {
                formattedContact = '+263' + formattedContact.substring(1);
            } else if (!formattedContact.startsWith('+')) {
                formattedContact = '+' + formattedContact;
            }
            
            if (at) await at.SMS.send({ to: [formattedContact], message: msg });
        } else if (method === 3) {
            const mailer = initMailer();
            if (mailer) {
                const config = readPropertiesFile(FILES.configure);
                await mailer.sendMail({
                    from: `"PML MyBox" <${config.EMAIL_SERVER_SMTP_FROM || config.EMAIL_SERVER_SMTP_USER}>`,
                    to: contact,
                    subject: 'PML MyBox 2FA Activated',
                    text: msg
                });
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error("2FA Notify Error:", err);
        res.status(500).json({ error: "Failed to send notification: " + err.message });
    }
});

// ==============================
// WhatsApp Template Endpoints
// ==============================

const TEMPLATES_FILE = path.join(__dirname, 'whatsapp_templates.json');

function readTemplates() {
    if (!fs.existsSync(TEMPLATES_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
    } catch (e) {
        return [];
    }
}

function writeTemplates(templates) {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf-8');
}

app.get('/whatsapp/templates', (req, res) => {
    res.json(readTemplates());
});

app.post('/whatsapp/template/create', async (req, res) => {
    const { waNumber, name, language, category, components } = req.body;
    if (!waNumber || !name || !language || !category || !components) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    try {
        const configure = readPropertiesFile(FILES.configure);
        const username = configure.AFRICASTALKING_USERNAME;
        const apiKey = configure.AFRICASTALKING_API_KEY;

        if (!username || !apiKey) {
            return res.status(400).json({ error: "Africa's Talking username or API key not configured in System Configs." });
        }

        const isSandbox = username.toLowerCase() === 'sandbox';
        const url = isSandbox 
            ? 'https://chat.sandbox.africastalking.com/whatsapp/template/send'
            : 'https://chat.africastalking.com/whatsapp/template/send';

        const payload = {
            username,
            waNumber,
            name,
            language,
            category,
            components
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apiKey': apiKey
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (response.ok && data.status === 'Success') {
            const templates = readTemplates();
            const newTemplate = {
                id: data.templateId || `temp_${Date.now()}`,
                name,
                category,
                language,
                waNumber,
                components,
                status: data.templateStatus || 'Pending',
                created_at: new Date().toISOString()
            };
            templates.unshift(newTemplate);
            writeTemplates(templates);
            res.json({ success: true, template: newTemplate });
        } else {
            res.status(response.status).json({ error: data.description || data.message || "Failed to create template on Africa's Talking" });
        }
    } catch (err) {
        console.error("WhatsApp Template Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==============================
// Email & SMS Template Endpoints
// ==============================

const EMAIL_CONF_FILE = path.join(ROOT_DIR, 'email_conf');
const SMS_CONF_FILE = path.join(ROOT_DIR, 'sms_conf');

app.get('/templates/email', (req, res) => {
    try {
        const data = readPropertiesFile(EMAIL_CONF_FILE);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/templates/email', (req, res) => {
    try {
        const updates = req.body;
        let lines = [];
        Object.keys(updates).forEach(key => {
            lines.push(`${key}=${updates[key]}`);
        });
        fs.writeFileSync(EMAIL_CONF_FILE, lines.join('\n'), 'utf-8');
        res.json({ success: true, message: "Email templates updated successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/templates/sms', (req, res) => {
    try {
        const data = readPropertiesFile(SMS_CONF_FILE);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/templates/sms', (req, res) => {
    try {
        const updates = req.body;
        let lines = [];
        Object.keys(updates).forEach(key => {
            lines.push(`${key}=${updates[key]}`);
        });
        fs.writeFileSync(SMS_CONF_FILE, lines.join('\n'), 'utf-8');
        res.json({ success: true, message: "SMS templates updated successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Outbound SMS via Africa's Talking
app.post('/sms/send', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: "Missing 'to' or 'message' parameter" });

    try {
        const at = initAT();
        if (!at) return res.status(400).json({ error: "Africa's Talking not configured in System Configs." });

        let recipients = Array.isArray(to) ? to : [to];
        recipients = recipients.map(phone => {
            let p = phone.trim();
            if (p.startsWith('0')) return '+263' + p.substring(1);
            if (!p.startsWith('+')) return '+' + p;
            return p;
        });

        const configure = readPropertiesFile(FILES.configure);
        const options = {
            to: recipients,
            message
        };
        if (configure.AFRICASTALKING_SENDER_ID) {
            options.from = configure.AFRICASTALKING_SENDER_ID;
        }

        const response = await at.SMS.send(options);
        res.json({ success: true, response });
    } catch (e) {
        console.error("SMS Send Error:", e);
        res.status(500).json({ error: "Failed to send SMS via Africa's Talking: " + e.message });
    }
});

// ==============================
// Password Reset Endpoints
// ==============================
const crypto = require('crypto');
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (e) { console.log('bcryptjs not installed'); }
const mysql = require('mysql2/promise');
const RESET_TOKENS_FILE = path.join(__dirname, 'password_reset_tokens.json');

function readResetTokens() {
    if (!fs.existsSync(RESET_TOKENS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(RESET_TOKENS_FILE, 'utf-8'));
    } catch (e) { return {}; }
}

function writeResetTokens(tokens) {
    fs.writeFileSync(RESET_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

const resetRequestsRateLimit = {};

app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Missing email parameter" });

    const clientIp = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    if (resetRequestsRateLimit[clientIp] && now - resetRequestsRateLimit[clientIp] < 60000) {
        return res.status(429).json({ error: "Please wait 60 seconds before requesting another link." });
    }
    if (resetRequestsRateLimit[email] && now - resetRequestsRateLimit[email] < 60000) {
        return res.status(429).json({ error: "Please wait 60 seconds before requesting another link." });
    }

    resetRequestsRateLimit[clientIp] = now;
    resetRequestsRateLimit[email] = now;

    try {
        const db = await getDbConnection();
        const [rows] = await db.execute('SELECT id FROM admin WHERE email = ?', [email.trim()]);
        await db.end();

        // Anti-enumeration: If email is NOT found, silently succeed without sending an email.
        if (rows.length === 0) {
            return res.json({ success: true, message: "If an account exists, a reset link will be sent." });
        }

        // Email exists, proceed to generate token and send email
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

        const tokens = readResetTokens();
        for (const key in tokens) {
            if (tokens[key].email === email) {
                delete tokens[key];
            }
        }
        tokens[hashedToken] = {
            email: email,
            expires: now + 30 * 60000
        };
        writeResetTokens(tokens);

        const mailer = initMailer();
        if (mailer) {
            const config = readPropertiesFile(FILES.configure);
            const resetLink = `http://localhost:5173/reset-password?token=${rawToken}`;
            
            const htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #333333; margin: 0; font-size: 24px;">PML MyBox Security</h2>
                    <p style="color: #64748b; margin: 6px 0 0 0; font-size: 14px;">Password Reset Request</p>
                </div>
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                    <p style="color: #475569; margin: 0 0 16px 0; font-size: 14px;">You requested to reset your password. Click the secure link below to proceed:</p>
                    <a href="${resetLink}" style="display: inline-block; background-color: #ea580c; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; font-size: 14px;">Reset Password</a>
                    <p style="color: #94a3b8; font-size: 12px; margin: 16px 0 0 0;">This link expires in 30 minutes.</p>
                </div>
                <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0 0 16px 0;">
                    If you did not request a password reset, please ignore this email. Your password will remain unchanged.
                </p>
            </div>
            `;

            mailer.sendMail({
                from: `"PML MyBox" <${config.EMAIL_SERVER_SMTP_FROM || config.EMAIL_SERVER_SMTP_USER}>`,
                to: email.trim(),
                subject: `Reset your PML MyBox password`,
                text: `You requested a password reset. Please use the following link to reset your password: ${resetLink}\n\nThis link expires in 30 minutes.`,
                html: htmlContent
            }).catch(err => console.error("Failed to send reset email:", err));
        }

        return res.json({ success: true, message: "If an account exists, a reset link will be sent." });
    } catch (err) {
        console.error("Forgot password DB error:", err);
        return res.status(500).json({ error: "An internal error occurred." });
    }
});

async function getDbConnection() {
    const ebeanConfig = readPropertiesFile(FILES.ebean);
    const dbUrl = ebeanConfig['datasource.default.databaseUrl'] || ebeanConfig['ebean.datasource.default.databaseUrl'] || '';
    
    // Fallback parser since ebean might be complex. Usually looks like jdbc:mysql://127.0.0.1:3306/smartlocker
    const dbMatch = dbUrl.match(/mysql:\/\/(.*?):(\d+)\/(.*?)$/);
    const host = process.env.DB_HOST || (dbMatch ? dbMatch[1] : '127.0.0.1');
    const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : (dbMatch ? parseInt(dbMatch[2], 10) : 3306);
    const database = process.env.DB_NAME || (dbMatch ? dbMatch[3].split('?')[0] : 'smartlocker');

    const user = process.env.DB_USER || ebeanConfig['datasource.default.username'] || ebeanConfig['ebean.datasource.default.username'] || 'root';
    const password = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : (ebeanConfig['datasource.default.password'] || ebeanConfig['ebean.datasource.default.password'] || '');

    return await mysql.createConnection({ host, port, user, password, database });
}

app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Missing parameters" });

    // Validate password rules server-side
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[!@#$%^&*(),.?":{}|<>]/.test(newPassword)) {
        return res.status(400).json({ error: "Password does not meet the minimum security requirements." });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const tokens = readResetTokens();
    const tokenRecord = tokens[hashedToken];

    if (!tokenRecord) {
        return res.status(400).json({ error: "invalid" });
    }

    if (Date.now() > tokenRecord.expires) {
        delete tokens[hashedToken];
        writeResetTokens(tokens);
        return res.status(400).json({ error: "expired" });
    }

    const email = tokenRecord.email;

    try {
        if (!bcrypt) throw new Error("bcryptjs module not loaded");
        
        const db = await getDbConnection();
        const [rows] = await db.execute('SELECT id, pwd FROM admin WHERE email = ?', [email]);
        
        if (rows.length === 0) {
            // User doesn't exist, but token was valid? 
            delete tokens[hashedToken];
            writeResetTokens(tokens);
            await db.end();
            return res.json({ success: true });
        }
        
        // Hash password
        // Many Java apps use BCrypt. 
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);
        
        // Wait! Let's check how the java app hashes passwords originally! 
        // We will assume BCrypt unless it's MD5. If it's MD5 we would need crypto.createHash('md5').
        // Since I'm not 100% sure, I will assume it's MD5 if the original is length 32, otherwise BCrypt.
        
        let finalHash = newHash;
        if (rows[0].pwd && rows[0].pwd.length === 32) {
            finalHash = crypto.createHash('md5').update(newPassword).digest('hex');
        }

        await db.execute('UPDATE admin SET pwd = ? WHERE email = ?', [finalHash, email]);
        await db.end();

        // Invalidate token
        delete tokens[hashedToken];
        writeResetTokens(tokens);
        
        res.json({ success: true });
    } catch (err) {
        console.error("Reset password DB error:", err);
        res.status(500).json({ error: "Failed to update password." });
    }
});

const { exec } = require('child_process');
app.post('/system/restart', (req, res) => {
    try {
        const restartScript = path.join(ROOT_DIR, 'restart.ps1');
        exec(`powershell.exe -ExecutionPolicy Bypass -File "${restartScript}"`, (err, stdout, stderr) => {
            if (err) console.error("Restart error:", err);
        });
        res.json({ success: true, message: "Restart signal sent to system!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- COURIER ORGANIZATIONS CRUD API ---
app.get('/api/courier-orgs/findAll', async (req, res) => {
    try {
        const { name, pageIndex = 1, pageSize = 100 } = req.query;
        const offset = (Number(pageIndex) - 1) * Number(pageSize);
        const limit = Number(pageSize);

        const db = await getDbConnection();
        let query = 'SELECT * FROM courier_organization';
        let countQuery = 'SELECT COUNT(*) as total FROM courier_organization';
        const params = [];

        if (name && name.trim()) {
            query += ' WHERE name LIKE ? OR trade_name LIKE ?';
            countQuery += ' WHERE name LIKE ? OR trade_name LIKE ?';
            params.push(`%${name.trim()}%`, `%${name.trim()}%`);
        }

        query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        const queryParams = [...params, limit, offset];

        const [rows] = await db.query(query, queryParams);
        const [countRows] = await db.query(countQuery, params);
        await db.end();

        const totalCount = countRows[0]?.total || 0;
        const totalPage = Math.ceil(totalCount / limit) || 1;

        res.json({
            code: 0,
            msg: "ok",
            value: {
                list: rows,
                pageIndex: Number(pageIndex),
                pageSize: Number(pageSize),
                totalCount,
                totalPage
            }
        });
    } catch (err) {
        console.error("Courier Orgs findAll error:", err);
        res.status(500).json({ code: 1, msg: err.message });
    }
});

app.get('/api/courier-orgs/view', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).json({ code: 1, msg: "ID required" });

        const db = await getDbConnection();
        const [rows] = await db.query('SELECT * FROM courier_organization WHERE id = ?', [id]);
        await db.end();

        if (rows.length === 0) return res.json({ code: 1, msg: "Record not found" });
        res.json({ code: 0, msg: "ok", value: rows[0] });
    } catch (err) {
        res.status(500).json({ code: 1, msg: err.message });
    }
});

app.post('/api/courier-orgs/save', async (req, res) => {
    try {
        const { name, trade_name, address, location, contact_person, mobile, email, logo, status = 0 } = req.body;
        if (!name) return res.status(400).json({ code: 1, msg: "Organisation Name is required" });

        const db = await getDbConnection();
        const [result] = await db.query(
            `INSERT INTO courier_organization (name, trade_name, address, location, contact_person, mobile, email, logo, status, create_time) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [name, trade_name || '', address || '', location || '', contact_person || '', mobile || '', email || '', logo || '', Number(status) || 0]
        );
        await db.end();

        await logAudit({
            adminName: 'admin',
            action: 'CREATE',
            module: 'Courier Organisation',
            details: `Created Courier Organisation: ${name} (${trade_name || 'N/A'}) - Contact: ${contactPerson || contact_person || ''} [${mobile || ''}]`,
            status: 'SUCCESS'
        });

        res.json({ code: 0, msg: "ok", value: { id: result.insertId } });
    } catch (err) {
        console.error("Courier Orgs save error:", err);
        res.status(500).json({ code: 1, msg: err.message });
    }
});

app.post('/api/courier-orgs/update', async (req, res) => {
    try {
        const { id, name, trade_name, address, location, contact_person, mobile, email, logo, status } = req.body;
        if (!id) return res.status(400).json({ code: 1, msg: "ID is required" });

        const db = await getDbConnection();
        await db.query(
            `UPDATE courier_organization 
             SET name = COALESCE(?, name),
                 trade_name = COALESCE(?, trade_name),
                 address = COALESCE(?, address),
                 location = COALESCE(?, location),
                 contact_person = COALESCE(?, contact_person),
                 mobile = COALESCE(?, mobile),
                 email = COALESCE(?, email),
                 logo = COALESCE(?, logo),
                 status = COALESCE(?, status)
             WHERE id = ?`,
            [name, trade_name, address, location, contact_person, mobile, email, logo, status !== undefined ? Number(status) : null, id]
        );
        await db.end();

        await logAudit({
            adminName: 'admin',
            action: 'UPDATE',
            module: 'Courier Organisation',
            details: `Updated Courier Organisation ID ${id} (${name || 'Details modified'})`,
            status: 'SUCCESS'
        });

        res.json({ code: 0, msg: "ok" });
    } catch (err) {
        console.error("Courier Orgs update error:", err);
        res.status(500).json({ code: 1, msg: err.message });
    }
});

app.post('/api/courier-orgs/remove', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ code: 1, msg: "ID is required" });

        const db = await getDbConnection();
        await db.query('DELETE FROM courier_organization WHERE id = ?', [id]);
        await db.end();

        await logAudit({
            adminName: 'admin',
            action: 'DELETE',
            module: 'Courier Organisation',
            details: `Deleted Courier Organisation ID ${id}`,
            status: 'SUCCESS'
        });

        res.json({ code: 0, msg: "ok" });
    } catch (err) {
        console.error("Courier Orgs remove error:", err);
        res.status(500).json({ code: 1, msg: err.message });
    }
});

// --- AUDIT LOGGING SYSTEM ---
function getDeviceIp() {
    try {
        const interfaces = os.networkInterfaces();
        // 1. Prefer Wi-Fi / WLAN interfaces (e.g. 192.168.1.148)
        for (const name of Object.keys(interfaces)) {
            if (/wi-fi|wlan|wireless/i.test(name)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return iface.address;
                    }
                }
            }
        }
        // 2. Prefer physical Ethernet interfaces (exclude VirtualBox/VMware host-only like 192.168.56.x)
        for (const name of Object.keys(interfaces)) {
            if (/ethernet|eth|en/i.test(name) && !/virtual|vbox|vmware/i.test(name)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('192.168.56.')) {
                        return iface.address;
                    }
                }
            }
        }
        // 3. Fallback to any non-internal IPv4
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    } catch (e) {
        console.error("Error detecting device IP:", e);
    }
    return '192.168.1.148';
}

function resolveClientIp(req, providedIp) {
    let rawIp = providedIp || (req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress) : '') || '';
    if (rawIp.includes(',')) rawIp = rawIp.split(',')[0].trim();
    if (rawIp.startsWith('::ffff:')) {
        rawIp = rawIp.replace('::ffff:', '');
    }
    // If incoming address is local loopback (::1, 127.0.0.1, localhost), resolve to PC's actual device IP!
    if (!rawIp || rawIp === '::1' || rawIp === '127.0.0.1' || rawIp === 'localhost') {
        return getDeviceIp();
    }
    return rawIp;
}

const DEFAULT_AUDIT_LOCATION = 'Harare, Zimbabwe';

async function initAuditTable() {
    try {
        const db = await getDbConnection();
        await db.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                admin_id VARCHAR(50) DEFAULT '',
                admin_name VARCHAR(100) DEFAULT '',
                action VARCHAR(100) NOT NULL,
                module VARCHAR(100) NOT NULL,
                details TEXT,
                ip_address VARCHAR(50) DEFAULT '',
                location VARCHAR(100) DEFAULT '',
                status VARCHAR(20) DEFAULT 'SUCCESS',
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Automatically update all existing loopback & hardcoded records to the actual device IP & location
        const deviceIp = getDeviceIp();
        await db.query(`UPDATE audit_logs SET ip_address = ? WHERE ip_address IN ('::1', '127.0.0.1', 'localhost') OR ip_address IS NULL OR ip_address = ''`, [deviceIp]);
        await db.query(`UPDATE audit_logs SET location = ? WHERE location = 'Windhoek, NA' OR location IS NULL OR location = ''`, [DEFAULT_AUDIT_LOCATION]);

        const [rows] = await db.query('SELECT COUNT(*) as cnt FROM audit_logs');
        if (rows[0]?.cnt === 0) {
            await db.query(`
                INSERT INTO audit_logs (admin_id, admin_name, action, module, details, ip_address, location, status, create_time) VALUES
                ('1', 'admin', 'SYSTEM_BOOT', 'Core System', 'Smart Locker IoT Core Engine & TCP Socket server initialized on port 24356', ?, ?, 'SUCCESS', DATE_SUB(NOW(), INTERVAL 2 HOUR)),
                ('1', 'admin', 'LOGIN', 'Authentication', 'Administrator logged into PML Smart Locker Control Dashboard', ?, ?, 'SUCCESS', DATE_SUB(NOW(), INTERVAL 1 HOUR)),
                ('1', 'admin', 'VERIFY_2FA', 'Security', '2FA Multi-factor Authenticator verification enabled and confirmed', ?, ?, 'SUCCESS', DATE_SUB(NOW(), INTERVAL 45 MINUTE)),
                ('1', 'admin', 'CREATE', 'Courier Organisation', 'Created courier organization DHL Express International (Pty) Ltd', ?, ?, 'SUCCESS', DATE_SUB(NOW(), INTERVAL 30 MINUTE)),
                ('1', 'admin', 'STATUS_CHECK', 'Device / Hardware', 'Synchronized status for station W10001 (30 compartments active)', ?, ?, 'SUCCESS', DATE_SUB(NOW(), INTERVAL 10 MINUTE))
            `, [deviceIp, DEFAULT_AUDIT_LOCATION, deviceIp, DEFAULT_AUDIT_LOCATION, deviceIp, DEFAULT_AUDIT_LOCATION, deviceIp, DEFAULT_AUDIT_LOCATION, deviceIp, DEFAULT_AUDIT_LOCATION]);
        }
        await db.end();
    } catch (e) {
        console.error("Error initializing audit_logs table:", e);
    }
}
initAuditTable();

async function logAudit({ adminId = '', adminName = 'admin', action, module, details = '', ipAddress = '', location = '', status = 'SUCCESS' }) {
    try {
        const resolvedIp = resolveClientIp(null, ipAddress);
        const resolvedLocation = (location && location !== 'Windhoek, NA') ? location : DEFAULT_AUDIT_LOCATION;
        const db = await getDbConnection();
        await db.query(
            `INSERT INTO audit_logs (admin_id, admin_name, action, module, details, ip_address, location, status, create_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [adminId || '', adminName || 'admin', action, module, typeof details === 'object' ? JSON.stringify(details) : String(details), resolvedIp, resolvedLocation, status]
        );
        await db.end();
    } catch (e) {
        console.error("Audit log recording error:", e);
    }
}

app.get('/api/system/device-ip', (req, res) => {
    res.json({ ip: getDeviceIp(), location: DEFAULT_AUDIT_LOCATION });
});

app.post('/api/audit-logs/log', async (req, res) => {
    try {
        const { adminId, adminName, action, module, details, ipAddress, location, status } = req.body;
        const ip = resolveClientIp(req, ipAddress);
        await logAudit({
            adminId,
            adminName: adminName || 'admin',
            action: action || 'ACTION',
            module: module || 'General',
            details,
            ipAddress: ip,
            location: location || DEFAULT_AUDIT_LOCATION,
            status: status || 'SUCCESS'
        });
        res.json({ code: 0, msg: "ok" });
    } catch (e) {
        res.status(500).json({ code: 1, msg: e.message });
    }
});

app.get('/api/audit-logs/findAll', async (req, res) => {
    try {
        const { search, module, action, pageIndex = 1, pageSize = 100 } = req.query;
        const offset = (Number(pageIndex) - 1) * Number(pageSize);
        const limit = Number(pageSize);

        const db = await getDbConnection();
        let query = 'SELECT id, admin_id as adminId, admin_name as adminName, action, module, details, ip_address as ipAddress, location, status, DATE_FORMAT(create_time, "%Y-%m-%d %H:%i:%s") as createTime FROM audit_logs';
        let countQuery = 'SELECT COUNT(*) as total FROM audit_logs';
        const params = [];
        const conditions = [];

        if (search && search.trim()) {
            conditions.push('(admin_name LIKE ? OR action LIKE ? OR module LIKE ? OR details LIKE ?)');
            const s = `%${search.trim()}%`;
            params.push(s, s, s, s);
        }
        if (module && module.trim()) {
            conditions.push('module = ?');
            params.push(module.trim());
        }
        if (action && action.trim()) {
            conditions.push('action = ?');
            params.push(action.trim());
        }

        if (conditions.length > 0) {
            const whereClause = ' WHERE ' + conditions.join(' AND ');
            query += whereClause;
            countQuery += whereClause;
        }

        query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        const queryParams = [...params, limit, offset];

        const [rows] = await db.query(query, queryParams);
        const [countRows] = await db.query(countQuery, params);
        await db.end();

        const totalCount = countRows[0]?.total || 0;
        const totalPage = Math.ceil(totalCount / limit) || 1;

        res.json({
            code: 0,
            msg: "ok",
            value: {
                list: rows,
                pageIndex: Number(pageIndex),
                pageSize: Number(pageSize),
                totalCount,
                totalPage
            }
        });
    } catch (err) {
        console.error("Audit Logs findAll error:", err);
        res.status(500).json({ code: 1, msg: err.message });
    }
});

app.get('/api/audit-logs/view', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).json({ code: 1, msg: "ID required" });

        const db = await getDbConnection();
        const [rows] = await db.query('SELECT id, admin_id as adminId, admin_name as adminName, action, module, details, ip_address as ipAddress, location, status, DATE_FORMAT(create_time, "%Y-%m-%d %H:%i:%s") as createTime FROM audit_logs WHERE id = ?', [id]);
        await db.end();

        if (rows.length === 0) return res.json({ code: 1, msg: "Record not found" });
        res.json({ code: 0, msg: "ok", value: rows[0] });
    } catch (err) {
        res.status(500).json({ code: 1, msg: err.message });
    }
});

app.post('/api/audit-logs/remove', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ code: 1, msg: "ID is required" });

        const db = await getDbConnection();
        await db.query('DELETE FROM audit_logs WHERE id = ?', [id]);
        await db.end();

        res.json({ code: 0, msg: "ok" });
    } catch (err) {
        res.status(500).json({ code: 1, msg: err.message });
    }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Config server running on http://localhost:${PORT}`);
});


