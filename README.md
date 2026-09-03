# PML MyBox - Multi-Factor Authentication (2FA) & Configuration Microservice

[![License: Elastic-2.0](https://img.shields.io/badge/License-Elastic--2.0-orange.svg)](https://www.elastic.co/licensing/elastic-license)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B%20%7C%20v20%2B-green.svg)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/Database-MySQL%205.7%2B%20%7C%208.0%2B-blue.svg)](https://www.mysql.com/)

This repository is the dedicated, production-ready **Multi-Factor Authentication (2FA / MFA)** and **System Configuration Microservice** for the **PML Smart Locker / MY BOX IoT Ecosystem**.

It operates independently on port **3002** and securely interfaces with the MySQL database, delivery gateways (Africa's Talking & SMTP), and frontend admin dashboards.

---

## Table of Contents
1. [Architecture & Workflow](#1-architecture--workflow)
2. [Supported 2FA Channels](#2-supported-2fa-channels)
3. [Prerequisites](#3-prerequisites)
4. [Step-by-Step Installation & Setup](#4-step-by-step-installation--setup)
5. [Configuration & Environment Variables](#5-configuration--environment-variables)
6. [Database Setup & Migrations](#6-database-setup--migrations)
7. [Running in Production (PM2 / Systemd)](#7-running-in-production-pm2--systemd)
8. [Nginx Reverse Proxy & SSL (HTTPS)](#8-nginx-reverse-proxy--ssl-https)
9. [Connecting Frontend to This 2FA Server](#9-connecting-frontend-to-this-2fa-server)
10. [Verification & Test Commands](#10-verification--test-commands)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)

---

## 1. Architecture & Workflow

```text
[ Admin / User ] ──▶ [ Frontend (:5173) ] ──▶ [ 2FA Microservice (:3002) ]
                                                        │
         ┌──────────────────────────────────────────────┼──────────────────────────────┐
         ▼                                              ▼                              ▼
 [ RFC 6238 TOTP ]                                [ SMS Gateway ]              [ SMTP Mailer ]
 Google Authenticator                             Africa's Talking             Custom Mail Server
 Microsoft Authenticator                                │                              │
                                                        ▼                              ▼
                                             [ MySQL Database (:3306) ]
```

---

## 2. Supported 2FA Channels

| Method | Provider / Engine | Description |
| :--- | :--- | :--- |
| **Authenticator App** | RFC 6238 Speakeasy + QRCode | Time-based One-Time Passwords (TOTP) compatible with Google Authenticator, Microsoft Authenticator, Authy, 1Password. |
| **SMS OTP** | Africa's Talking | 6-digit one-time code delivered via SMS to registered mobile numbers across Africa and internationally. |
| **Email OTP** | SMTP / Nodemailer | Branded HTML email containing a secure 6-digit authorization code. |
| **Passkeys / FIDO2** | WebAuthn Browser Native | Biometric hardware authentication (Face ID, Touch ID, Windows Hello). |

---

## 3. Prerequisites

Ensure your target server has the following installed:
- **Operating System**: Linux (Ubuntu 20.04/22.04/24.04 LTS, Debian, CentOS, RHEL) or Windows Server
- **Node.js**: `v18.x` or `v20.x LTS` (Recommended: Node 20 LTS)
- **Package Manager**: `npm` (v9+)
- **MySQL Database**: `v5.7+` or `v8.0+` (Database name: `smartlocker`)
- **Git**: Installed and configured

---

## 4. Step-by-Step Installation & Setup

### Step 1: Install Node.js and Git (Ubuntu / Debian Linux)
```bash
# Update package lists
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS via official NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential

# Verify versions
node -v   # Expected: v20.x.x
npm -v    # Expected: v10.x.x
```

### Step 2: Clone This Repository
```bash
cd /opt
git clone https://github.com/tatendatembojnr-code/mybox-2fa-server.git
cd mybox-2fa-server
```

### Step 3: Install Node Dependencies
```bash
npm install
```

---

## 5. Configuration & Environment Variables

Create your `.env` configuration file by copying `.env.example`:

```bash
cp .env.example .env
nano .env
```

### Configuration Parameters:

```ini
# ==============================================================================
# SERVER & PORT
# ==============================================================================
PORT=3002

# ==============================================================================
# DATABASE CONNECTION (MySQL)
# ==============================================================================
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=smartlocker
DB_USER=root
DB_PASSWORD=your_mysql_password

# ==============================================================================
# AFRICA'S TALKING (SMS OTP)
# ==============================================================================
AFRICASTALKING_USERNAME=your_username
AFRICASTALKING_API_KEY=your_api_key
AFRICASTALKING_SENDER_ID=your_sender_id_optional

# ==============================================================================
# EMAIL SMTP SETTINGS (Email OTP & Password Reset)
# ==============================================================================
EMAIL_SERVER_SMTP_HOST=your_smtp_host
EMAIL_SERVER_SMTP_PORT=587
EMAIL_SERVER_SMTP_USER=your_smtp_user
EMAIL_SERVER_SMTP_PASSWORD=your_smtp_password
EMAIL_SERVER_SMTP_FROM=your_sender_email
```

> **Security Note**: Never commit your `.env` file to source control. The `.gitignore` file is pre-configured to ignore all `.env` files automatically.

---

## 6. Database Setup & Migrations

Ensure your MySQL database `smartlocker` is running. Run the included migration scripts to create the necessary 2FA tables, audit logs, and employee columns:

```bash
node run_migration.js
node run_employee_migration.js
```

---

## 7. Running in Production (PM2 / Systemd)

### Option A: Using PM2 Process Manager (Recommended)
PM2 keeps the 2FA server running continuously, restarts it automatically if it crashes, and boots it on server restart.

```bash
# 1. Install PM2 globally
sudo npm install -g pm2

# 2. Start the service
pm2 start server.js --name "mybox-2fa"

# 3. Configure PM2 to start on system boot
pm2 startup
# (Run the sudo env command generated in the output)

# 4. Save the running process list
pm2 save

# 5. Monitor and check logs
pm2 status
pm2 logs mybox-2fa
```

### Option B: Using Linux Systemd
Create a systemd service definition:

```bash
sudo nano /etc/systemd/system/mybox-2fa.service
```

Paste the following content:
```ini
[Unit]
Description=PML MyBox 2FA & Config Microservice
After=network.target mysql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mybox-2fa-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/mybox-2fa-server/.env

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable mybox-2fa
sudo systemctl start mybox-2fa
sudo systemctl status mybox-2fa
```

---

## 8. Nginx Reverse Proxy & SSL (HTTPS)

To expose this service securely behind a custom domain with SSL:

```nginx
server {
    listen 80;
    server_name 2fa.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name 2fa.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/2fa.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/2fa.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Obtain a free SSL certificate via Let's Encrypt:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 2fa.yourdomain.com
```

---

## 9. Connecting Frontend to This 2FA Server

In your Frontend application (`berry_admin_frontend` or mobile apps):
Update the API service configuration to point to this server:

```javascript
// Example in src/services/api.js
const CONFIG_SERVER_URL = "http://YOUR_SERVER_IP:3002"; 
// OR if using domain: "https://2fa.yourdomain.com"
```

---

## 10. Verification & Test Commands

### 1. Health & Server Device IP Check
```bash
curl http://localhost:3002/api/system/device-ip
# Output: {"ip":"<YOUR_SERVER_IP>","location":"Harare, Zimbabwe"}
```

### 2. Check 2FA Status for an Admin
```bash
curl "http://localhost:3002/2fa/status?username=admin"
```

### 3. Generate QR Code for Authenticator App
```bash
curl -X POST "http://localhost:3002/2fa/setup" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'
```

### 4. Verify a 6-Digit OTP Code
```bash
curl -X POST "http://localhost:3002/2fa/verify" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin", "code":"123456"}'
```

### 5. Send Test SMS via Africa's Talking
```bash
curl -X POST "http://localhost:3002/send-sms" \
  -H "Content-Type: application/json" \
  -d '{"to":"+263771234567", "message":"Test OTP: 549210"}'
```

---

## 11. Troubleshooting & FAQ

| Problem | Cause | Solution |
| :--- | :--- | :--- |
| **`ECONNREFUSED 127.0.0.1:3306`** | MySQL server is down or rejecting connection. | Run `sudo systemctl status mysql`. Verify `DB_HOST`, `DB_PORT`, and credentials in `.env`. |
| **`EADDRINUSE :::3002`** | Another process is occupying port 3002. | Find the process: `sudo lsof -i :3002` and stop it, or change `PORT=3003` in `.env`. |
| **`Invalid OTP code`** | Time drift between client device and server clock. | Ensure server system clock is NTP synchronized: `sudo timedatectl set-ntp on`. |
| **SMS fails to send** | Africa's Talking credentials invalid or balance low. | Verify `AFRICASTALKING_API_KEY` and account balance in your Africa's Talking dashboard. |

---

## License

This software is licensed under the **Elastic License 2.0 (ELv2)**. See the [LICENSE](LICENSE) file for details.
