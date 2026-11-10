// SETUP: libraries, app, database connection
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { ROOT } = ctx;
    const express = require('express');
    const { Pool, types } = require('pg');
    // DATE columns come back as plain text "2026-11-05" (no time-zone shifting of dates)
    types.setTypeParser(1082, v => v);
    const cors = require('cors');
    const path = require('path');
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');
    const rateLimit = require('express-rate-limit');
    const helmet = require('helmet');
    const crypto = require('crypto');

    const app = express();
    const PORT = process.env.PORT || 3000;

    // Railway puts a proxy in front of the app. Without this line every visitor looks like
    // the same person, so the login limit (10 tries) would be shared by ALL users.
    app.set('trust proxy', 1);

    app.use(helmet({ contentSecurityPolicy: false }));
    // Extra browser protections. The CSP is in REPORT-ONLY mode: the browser only reports what it would block, nothing breaks.
    // When /api/csp-report shows no more surprises, the header name can be changed to Content-Security-Policy.
    const CSP = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "connect-src 'self'",
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
        'report-uri /api/csp-report'
    ].join('; ');
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy-Report-Only', CSP);
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
        next();
    });

    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET environment variable missing. System cannot start securely.");
    }
    const JWT_SECRET = process.env.JWT_SECRET;

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: (process.env.DATABASE_URL && process.env.DB_SSL !== 'false') ? { rejectUnauthorized: false } : false
    });

    // CORS: the app is served from the same address, so only the listed sites may call the API from another origin.
    // Add more with the CORS_ORIGINS variable (comma separated). Requests with no Origin (same site, server tools) always pass.
    const CORS_ALLOWED = ['https://keyarch.site', 'https://www.keyarch.site']
        .concat(String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
    app.use(cors({ origin: (origin, cb) => cb(null, !origin || CORS_ALLOWED.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) }));
    // every visitor (by IP) may make this many API calls per minute. Normal use is far below it.
    app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: parseInt(process.env.API_RATE_MAX) || 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down and try again in a minute.' } }));
    // the browser posts CSP reports here (small, only logged)
    app.post('/api/csp-report', (req, res) => {
        try { console.warn('CSP report:', JSON.stringify(req.body || {}).slice(0, 400)); } catch (e) { /* ignore */ }
        res.status(204).end();
    });
    app.use(express.json({ limit: '12mb' })); // 12mb: Luku stock files are sent as base64
    // Only these two files are public. Every other file in the project
    // (server.js, database.sql, package.json ...) stays private.
    app.get('/style.css', (req, res) => res.sendFile(path.join(ROOT, 'style.css')));
    app.get('/index.html', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
    // The page's code lives in two small public folders: /js (one file per section) and /css.
    // Only plain file names like 08-tenants.js are served (no sub-folders, no "..").
    // 'no-cache' = the browser asks every time and only downloads a file when it changed, so updates show at once.
    function servePublic(dir, ext) {
        return (req, res) => {
            const name = String(req.params.file || '');
            if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.') || !name.endsWith(ext)) return res.status(404).end();
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Content-Type', ext === '.js' ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8');
            res.sendFile(path.join(ROOT, dir, name), err => { if (err && !res.headersSent) res.status(404).end(); });
        };
    }
    app.get('/js/:file', servePublic('js', '.js'));
    app.get('/css/:file', servePublic('css', '.css'));

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: parseInt(process.env.LOGIN_RATE_MAX) || 10,
        message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
    });

    async function createAuditLog(clientOrPool, companyId, userId, action, moduleAffected, ipAddress, metadata = {}) {
        try {
            await clientOrPool.query(
                'INSERT INTO audit_logs (company_id, user_id, action_performed, module_affected, ip_address, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
                [companyId || null, userId || null, action, moduleAffected, ipAddress || '127.0.0.1', JSON.stringify(metadata)]
            );
        } catch (err) {
            console.error('Audit Log Warning:', err.message);
        }
    }
    return { JWT_SECRET, PORT, app, bcrypt, createAuditLog, crypto, jwt, loginLimiter, path, pool, rateLimit, types };
};
