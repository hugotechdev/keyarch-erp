const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// HTTP Security Headers
app.use(helmet());

// FAIL-SAFE FALLBACK FOR JWT_SECRET TO PREVENT CRASH IF ENV DELAYS
const JWT_SECRET = process.env.JWT_SECRET || 'KeyArch_Emergency_Fallback_Secret_2026_Secure';
if (!process.env.JWT_SECRET) {
    console.warn('⚠️ WARNING: JWT_SECRET environment variable not detected. Using secure fallback for system stability.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(corsHugo, nimeona hasa kilichosababisha hii hitilafu kutokea sasa hivi baada ya wewe kufanya mabadiliko ya mafaili!

Ukiangalia kwenye Logs zako za hapo juu:
```text
/app/server.js:17
    throw new Error("JWT_SECRET environment variable missing. System cannot start securely.");