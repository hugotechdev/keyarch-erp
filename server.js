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

if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable missing. System cannot start securely.");
}
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.DATABASE_URL && process.env.DB_SSL !== 'false') ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '12mb' })); // 12mb: Luku stock files are sent as base64
// Only these two files are public. Every other file in the project
// (server.js, database.sql, package.json ...) stays private.
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
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

// ============================================================
// PAYMENT CALCULATOR (the server is the only source of truth)
// Total Rent  = Rent Price x Number of periods
// Total To Pay = Total Rent - Discount
// Balance      = Total To Pay - Amount Paid
//   Balance > 0  -> tenant still owes   (UNPAID / PARTIAL)
//   Balance = 0  -> fully paid          (PAID)
//   Balance < 0  -> tenant paid extra   (EXTRA_PAID)
// ============================================================
const ALLOWED_RENT_PERIODS = ['Day', 'Week', 'Month', 'Year'];
const ALLOWED_ID_TYPES = ['NIDA', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID'];

function calculatePayment({ rent_price, number_of_periods, discount, paid_amount }) {
    const price = parseFloat(rent_price);
    const periods = parseFloat(number_of_periods);
    const disc = parseFloat(discount || 0);
    const paid = parseFloat(paid_amount || 0);

    if (!(price > 0)) return { error: 'Rent Price must be greater than 0.' };
    if (!(periods > 0)) return { error: 'Number of periods must be greater than 0.' };
    if (isNaN(disc) || disc < 0) return { error: 'Discount must be 0 or more.' };
    if (isNaN(paid) || paid < 0) return { error: 'Amount Paid must be 0 or more.' };

    const totalRent = Math.round(price * periods);
    if (disc > totalRent) return { error: 'Discount cannot be more than the Total Rent.' };

    const totalToPay = totalRent - disc;
    const balance = Math.round((totalToPay - paid) * 100) / 100;

    let status;
    if (balance < 0) status = 'EXTRA_PAID';
    else if (balance === 0) status = 'PAID';
    else if (paid > 0) status = 'PARTIAL';
    else status = 'UNPAID';

    return {
        price,
        periods,
        discount: disc,
        paid,
        totalRent,
        totalToPay,
        amountDue: Math.max(0, balance),
        extraPaid: Math.max(0, -balance),
        status
    };
}


// Writes a line in the tenant history (renewals, extensions, move-outs...).
// Uses a savepoint so a problem here can never break the main action.
async function logLeaseEvent(client, companyId, leaseId, tenantId, type, description, amount, userId) {
    try {
        await client.query('SAVEPOINT lease_event');
        await client.query(
            'INSERT INTO lease_events (company_id, lease_id, tenant_id, event_type, description, amount, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [companyId, leaseId, tenantId, type, description, amount || null, userId || null]
        );
        await client.query('RELEASE SAVEPOINT lease_event');
    } catch (err) {
        console.error('Lease event warning:', err.message);
        try { await client.query('ROLLBACK TO SAVEPOINT lease_event'); } catch (e) { /* ignore */ }
    }
}

// The payments table only accepts CASH / MOBILE_MONEY / BANK_TRANSFER / CHEQUE
function normalizePaymentMethod(m) {
    const t = String(m || '').toLowerCase();
    if (t.includes('mobile') || t.includes('mpesa') || t.includes('m-pesa')) return 'MOBILE_MONEY';
    if (t.includes('bank') || t.includes('transfer')) return 'BANK_TRANSFER';
    if (t.includes('cheque') || t.includes('check')) return 'CHEQUE';
    return 'CASH';
}

// Keeps the old "status" column (ACTIVE / EXPIRED / TERMINATED) in step with lease_state.
// Safe: if the database refuses the value, the main action still goes ahead.
async function setLeaseStatus(client, leaseId, companyId, status) {
    try {
        await client.query('SAVEPOINT lease_status');
        await client.query('UPDATE leases SET status = $1 WHERE lease_id = $2 AND company_id = $3', [status, leaseId, companyId]);
        await client.query('RELEASE SAVEPOINT lease_status');
    } catch (err) {
        console.error('Lease status warning:', err.message);
        try { await client.query('ROLLBACK TO SAVEPOINT lease_status'); } catch (e) { /* ignore */ }
    }
}

function payStatusOf(toPay, paid) {
    const balance = Math.round((toPay - paid) * 100) / 100;
    if (balance < 0) return 'EXTRA_PAID';
    if (balance === 0) return 'PAID';
    return paid > 0 ? 'PARTIAL' : 'UNPAID';
}

// ============================================================
// SHARED HELPERS (invoices, payments, dates, roles)
// ============================================================
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Dates follow Tanzania time (UTC+3), so a payment recorded after midnight there is not called "future"
function todayStr() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); }
function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
function niceDate(s) {            // 2026-11-05 -> 05 Nov 2026
    if (!isDateStr(String(s).slice(0, 10))) return s || '';
    const d = String(s).slice(0, 10);
    return `${d.slice(8, 10)} ${MONTHS_EN[parseInt(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
function monthLabel(ym) {         // 2026-11 -> November 2026
    return `${MONTHS_FULL[parseInt(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}
function fmtMoney(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function periodWord(period, n) { return `${period}${Number(n) === 1 ? '' : 's'}`; }
const wrapAsync = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
    console.error('Route error:', req.method, req.originalUrl, err.message);
    res.status(err.status || 500).json({ error: err.message });
});

// who can do what
const R_ADMIN = ['SUPER_ADMIN', 'COMPANY_ADMIN'];
const R_MANAGE = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'];
const R_MONEY = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'];
const R_VIEW_MONEY = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'VIEWER']; // everyone except MAINTENANCE_MANAGER
const R_FIN_VIEW = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTANT', 'PROPERTY_MANAGER'];
const R_FIN_WRITE = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTANT'];
const CURRENCIES = ['TZS', 'USD'];
const cleanCur = v => (String(v || '').toUpperCase() === 'USD' ? 'USD' : 'TZS');
const R_TICKETS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'MAINTENANCE_MANAGER'];
const ALL_ROLES = ['COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'MAINTENANCE_MANAGER', 'VIEWER'];

const INVOICE_TYPES = ['RENT', 'SERVICE', 'EXTENSION', 'DEPOSIT', 'UTILITY', 'PENALTY', 'REPAIR', 'OTHER'];
const MANUAL_INVOICE_TYPES = ['RENT', 'SERVICE', 'DEPOSIT', 'UTILITY', 'PENALTY', 'REPAIR', 'OTHER'];

// Creates an invoice with its own details. Used by onboarding, renew, extend, service charges and manual invoices.
async function createInvoice(client, o) {
    const subtotal = Math.round(parseFloat(o.subtotal) * 100) / 100;
    const discount = Math.round(parseFloat(o.discount || 0) * 100) / 100;
    const total = Math.round((subtotal - discount) * 100) / 100;
    const seq = await client.query("SELECT nextval('invoice_seq')");
    const number = `INV-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
    const issue = isDateStr(o.issueDate) ? o.issueDate : todayStr();
    const curRow = await client.query('SELECT COALESCE(currency, \'TZS\') AS currency FROM leases WHERE lease_id = $1', [o.leaseId]);
    const currency = cleanCur(o.currency || (curRow.rows[0] && curRow.rows[0].currency));
    const r = await client.query(
        `INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status, invoice_type, description, subtotal, discount,
                               issue_date, period_start, period_end, notes, lease_charge, created_by, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
        [o.companyId, o.leaseId, number, total, o.dueDate || issue, o.status || (total <= 0 ? 'PAID' : 'PENDING'),
         o.type || 'RENT', o.description || null, subtotal, discount, issue,
         isDateStr(o.periodStart) ? o.periodStart : null, isDateStr(o.periodEnd) ? o.periodEnd : null,
         o.notes || null, o.leaseCharge !== false, o.userId || null, currency]
    );
    return r.rows[0];
}

// A finance account must belong to the company and use the same currency as the money going in or out.
async function checkAccount(db, companyId, accountId, currency) {
    if (accountId === undefined || accountId === null || accountId === '') return null;
    const r = await db.query('SELECT currency, is_active FROM finance_accounts WHERE account_id = $1 AND company_id = $2', [accountId, companyId]);
    if (r.rows.length === 0) { const e = new Error('Account not found.'); e.status = 400; throw e; }
    if (r.rows[0].currency !== currency) { const e = new Error(`This account holds ${r.rows[0].currency}, but the money is in ${currency}. Choose an account in ${currency}.`); e.status = 400; throw e; }
    if (r.rows[0].is_active === false) { const e = new Error('This account is closed. Choose another one.'); e.status = 400; throw e; }
    return parseInt(accountId, 10);
}

// Saves a payment and gives it a receipt number (RCT-2026-100001)
async function addPayment(client, o) {
    const seq = await client.query("SELECT nextval('receipt_seq')");
    const receipt = `RCT-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
    let when = null;
    if (isDateStr(o.date) && o.date !== todayStr()) when = o.date + ' 12:00:00';
    const detail = o.methodDetail ? String(o.methodDetail).slice(0, 40) : null;
    const invCur = await client.query('SELECT COALESCE(currency, \'TZS\') AS currency FROM invoices WHERE invoice_id = $1', [o.invoiceId]);
    const currency = cleanCur(invCur.rows[0] && invCur.rows[0].currency);
    const recvCur = o.receivedCurrency && cleanCur(o.receivedCurrency) !== currency ? cleanCur(o.receivedCurrency) : null;
    const accountId = await checkAccount(client, o.companyId, o.accountId, recvCur || currency);
    const r = await client.query(
        `INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method, method_detail, reference_no, notes, receipt_number, recorded_by, currency, account_id, received_currency, received_amount, exchange_rate)
         VALUES ($1, $2, $3, COALESCE($4::timestamp, (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [o.companyId, o.invoiceId, o.amount, when, normalizePaymentMethod(o.method), detail,
         o.reference ? String(o.reference).slice(0, 100) : null, o.notes || null, receipt, o.userId || null, currency, accountId, recvCur, recvCur ? o.receivedAmount : null, recvCur ? o.rate : null]
    );
    return r.rows[0];
}

// After a payment on a lease invoice, keeps the lease totals in step
async function syncLeasePayment(client, leaseId, companyId) {
    const r = await client.query(
        `UPDATE leases SET amount_paid = COALESCE((
                SELECT SUM(py.amount_paid) FROM payments py JOIN invoices i ON py.invoice_id = i.invoice_id
                WHERE i.lease_id = $1 AND i.company_id = $2 AND COALESCE(i.lease_charge, true) = true), 0)
         WHERE lease_id = $1 AND company_id = $2
         RETURNING COALESCE(total_to_pay, agreed_rent) AS to_pay, amount_paid`,
        [leaseId, companyId]
    );
    if (r.rows.length === 0) return null;
    const toPay = parseFloat(r.rows[0].to_pay || 0), paid = parseFloat(r.rows[0].amount_paid || 0);
    const status = payStatusOf(toPay, paid);
    await client.query('UPDATE leases SET amount_due = $1, payment_status = $2 WHERE lease_id = $3 AND company_id = $4',
        [Math.max(0, Math.round((toPay - paid) * 100) / 100), status, leaseId, companyId]);
    return status;
}

// 1 100 000 -> "One million one hundred thousand" (English, for receipts)
function amountInWords(n) {
    n = Math.round(Number(n) || 0);
    if (n === 0) return 'Zero';
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const below1000 = (x) => {
        let s = '';
        if (x >= 100) { s += ones[Math.floor(x / 100)] + ' hundred'; x %= 100; if (x) s += ' and '; }
        if (x >= 20) { s += tens[Math.floor(x / 10)]; if (x % 10) s += '-' + ones[x % 10]; }
        else if (x > 0) s += ones[x];
        return s;
    };
    const scales = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
    let out = [];
    for (const [v, name] of scales) {
        if (n >= v) { out.push(below1000(Math.floor(n / v)) + ' ' + name); n %= v; }
    }
    if (n > 0) out.push(below1000(n));
    const text = out.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// ============================================================
// PLANS, FEATURES AND ACCESS (Standard / Pro)
// Change the numbers below to change what each plan allows.
// ============================================================
const GRACE_DAYS = 0; // extra days of access after a subscription ends
const SUPPORT = { name: 'HUGO TECH', whatsapp: '+255785799530', email: 'info@hugotech.co.tz' };

const PLAN_DEFAULTS = {
    STANDARD: { luku: false, tickets: false, reports_advanced: false, backup_full: false, max_properties: 5, max_staff: 3 },
    PRO:      { luku: true,  tickets: true,  reports_advanced: true,  backup_full: true,  max_properties: null, max_staff: null }
};
const FEATURE_KEYS = ['luku', 'tickets', 'reports_advanced', 'backup_full'];
const LIMIT_KEYS = ['max_properties', 'max_staff'];

// plan defaults + the special settings the Super Admin gave to one company (0 = unlimited)
function effectiveFeatures(plan, overrides) {
    const eff = { ...(PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.STANDARD) };
    if (overrides && typeof overrides === 'object') {
        FEATURE_KEYS.forEach(k => { if (typeof overrides[k] === 'boolean') eff[k] = overrides[k]; });
        LIMIT_KEYS.forEach(k => {
            if (typeof overrides[k] === 'number') eff[k] = overrides[k] === 0 ? null : overrides[k];
        });
    }
    return eff;
}

function sanitizeFeatures(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    FEATURE_KEYS.forEach(k => { if (typeof input[k] === 'boolean') out[k] = input[k]; });
    LIMIT_KEYS.forEach(k => { const n = parseInt(input[k]); if (!isNaN(n) && n >= 0) out[k] = n; });
    return out;
}

const accessCache = new Map();
function clearAccessCache(companyId) { accessCache.delete(String(companyId)); }

async function getCompanyAccess(companyId) {
    const key = String(companyId);
    const hit = accessCache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.data;
    try {
        const r = await pool.query(
            `SELECT company_id, company_name, is_active, plan, access_status, billing_type, features,
                    to_char(paid_until, 'YYYY-MM-DD') AS paid_until,
                    (paid_until::date - CURRENT_DATE) AS days_left,
                    (billing_type = 'SUBSCRIPTION' AND (paid_until IS NULL OR paid_until::date < CURRENT_DATE - $2::int)) AS expired
             FROM companies WHERE company_id = $1`,
            [companyId, GRACE_DAYS]
        );
        const data = r.rows[0] || null;
        accessCache.set(key, { at: Date.now(), data });
        return data;
    } catch (err) {
        console.error('Access check warning (allowing access):', err.message);
        return null;
    }
}

function accessBlock(a) {
    if (!a) return null;
    if (a.is_active === false || a.access_status === 'SUSPENDED') {
        return { code: 'ACCOUNT_SUSPENDED', message: 'Your account is suspended. Please contact ' + SUPPORT.name + ' to restore access.' };
    }
    if (a.access_status === 'PENDING') {
        return { code: 'ACCOUNT_PENDING', message: 'Your company is registered but not active yet. Access starts after your payment is confirmed.' };
    }
    if (a.expired) {
        return { code: 'SUBSCRIPTION_EXPIRED', message: 'Your subscription has ended. Please renew to continue using the system.' };
    }
    return null;
}

function companyInfo(a) {
    const plan = a ? (a.plan || 'STANDARD') : 'PRO';
    return {
        company_id: a ? a.company_id : null,
        company_name: a ? a.company_name : null,
        plan,
        access_status: a ? a.access_status : 'ACTIVE',
        billing_type: a ? a.billing_type : null,
        paid_until: a ? a.paid_until : null,
        days_left: a && a.days_left !== null && a.days_left !== undefined ? Number(a.days_left) : null,
        features: effectiveFeatures(plan, a ? a.features : null),
        support: SUPPORT
    };
}

function superAdminCompanyInfo(name) {
    return {
        company_name: name, plan: 'PRO', access_status: 'ACTIVE', billing_type: 'ONE_TIME', paid_until: null, days_left: null,
        features: effectiveFeatures('PRO', {}), support: SUPPORT
    };
}

// use on routes that belong to Pro features:  app.get('/x', authenticateToken, requireFeature('luku'), ...)
function requireFeature(key) {
    return async (req, res, next) => {
        if (req.user.role === 'SUPER_ADMIN') return next();
        const a = await getCompanyAccess(req.user.company_id);
        if (!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null)[key]) {
            return res.status(403).json({ error: 'This feature is available on the Pro plan. Please contact ' + SUPPORT.name + ' to upgrade.', code: 'FEATURE_LOCKED' });
        }
        next();
    };
}

// returns a message when the company reached its plan limit, otherwise null
async function checkLimit(user, limitKey, countSql, what) {
    if (user.role === 'SUPER_ADMIN') return null;
    const a = await getCompanyAccess(user.company_id);
    const limit = effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null)[limitKey];
    if (limit === null || limit === undefined) return null;
    const count = parseInt((await pool.query(countSql, [user.company_id])).rows[0].count);
    if (count >= limit) {
        return `Your plan allows up to ${limit} ${what}. Please contact ${SUPPORT.name} to upgrade.`;
    }
    return null;
}

// ============================================================
// DATABASE SETUP
// Every step runs on its own: one problem never stops the others.
// The Super Admin can also run it from Platform Admin > Run Database Setup.
// ============================================================
const SERVER_VERSION = 'v8.4 - 2026-11-06 - maintenance manager + workers';

const SETUP_STEPS = [
    { name: "Base columns (leases, users)", sql: `
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leases' AND column_name='amount_paid') THEN
                    ALTER TABLE leases ADD COLUMN amount_paid NUMERIC(12, 2) DEFAULT 0.00;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leases' AND column_name='amount_due') THEN
                    ALTER TABLE leases ADD COLUMN amount_due NUMERIC(12, 2) DEFAULT 0.00;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='can_edit_tenants') THEN
                    ALTER TABLE users ADD COLUMN can_edit_tenants BOOLEAN DEFAULT true;
                END IF;
            END $$;
` },
    { name: "Lease payment columns", sql: `
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_price NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_period VARCHAR(10) DEFAULT 'Month';
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS number_of_periods NUMERIC(8, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_rent NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS discount NUMERIC(12, 2) DEFAULT 0.00;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_to_pay NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20);
` },
    { name: "Tenant form columns", sql: `
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS full_name VARCHAR(150);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nida_passport_no VARCHAR(60);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS start_date DATE;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS end_date DATE;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS duration_days INTEGER;
` },
    { name: "Lease property_id", sql: `
            DO $$
            DECLARE pid_type text;
            BEGIN
                SELECT format_type(a.atttypid, a.atttypmod) INTO pid_type
                FROM pg_attribute a
                WHERE a.attrelid = 'public.properties'::regclass AND a.attname = 'property_id' AND NOT a.attisdropped;

                IF pid_type IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'property_id'
                ) THEN
                    EXECUTE format('ALTER TABLE leases ADD COLUMN property_id %s', pid_type);
                END IF;
            END $$;
` },
    { name: "Fill old leases", sql: `
            UPDATE leases l SET property_id = u.property_id FROM units u WHERE l.unit_id = u.unit_id AND l.property_id IS NULL;
            UPDATE leases SET
                rent_price = COALESCE(rent_price, agreed_rent),
                rent_period = COALESCE(rent_period, 'Month'),
                number_of_periods = COALESCE(number_of_periods, 1),
                total_rent = COALESCE(total_rent, agreed_rent),
                discount = COALESCE(discount, 0),
                total_to_pay = COALESCE(total_to_pay, agreed_rent),
                duration_days = COALESCE(duration_days, (end_date::date - start_date::date))
            WHERE total_to_pay IS NULL OR rent_price IS NULL OR duration_days IS NULL;
            UPDATE leases SET payment_status = CASE
                WHEN COALESCE(amount_paid, 0) > total_to_pay THEN 'EXTRA_PAID'
                WHEN COALESCE(amount_paid, 0) = total_to_pay THEN 'PAID'
                WHEN COALESCE(amount_paid, 0) > 0 THEN 'PARTIAL'
                ELSE 'UNPAID' END
            WHERE payment_status IS NULL AND total_to_pay IS NOT NULL;
` },
    { name: "Lease state (current/renewed/ended)", sql: `
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'lease_state') THEN
                    ALTER TABLE leases ADD COLUMN lease_state VARCHAR(12) DEFAULT 'CURRENT';
                    UPDATE leases SET lease_state = 'ENDED' WHERE status IS NOT NULL AND UPPER(status::text) <> 'ACTIVE';
                END IF;
            END $$;
` },
    { name: "Tenant history table", sql: `
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS ended_reason VARCHAR(200);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS previous_lease_id INTEGER;
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
            CREATE TABLE IF NOT EXISTS lease_events (
                event_id SERIAL PRIMARY KEY,
                company_id INTEGER,
                lease_id INTEGER,
                tenant_id INTEGER,
                event_type VARCHAR(20),
                description TEXT,
                amount NUMERIC(12,2),
                created_by INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_lease_events_tenant ON lease_events (tenant_id);
            CREATE INDEX IF NOT EXISTS idx_leases_tenant ON leases (tenant_id);
` },
    { name: "Plans, access and platform payments", sql: `
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan VARCHAR(12) DEFAULT 'PRO';
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS access_status VARCHAR(12) DEFAULT 'ACTIVE';
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_type VARCHAR(12) DEFAULT 'ONE_TIME';
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS paid_until DATE;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'::jsonb;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
            CREATE TABLE IF NOT EXISTS platform_payments (
                payment_id   SERIAL PRIMARY KEY,
                company_id   INTEGER,
                payment_type VARCHAR(20),
                amount       NUMERIC(14,2),
                method       VARCHAR(40),
                reference    VARCHAR(80),
                months       INTEGER,
                period_until DATE,
                notes        TEXT,
                recorded_by  INTEGER,
                paid_at      TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_platform_payments_company ON platform_payments (company_id);
` },
    { name: "Invoice number sequence", sql: `CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000` },
    { name: "Lease rule: one CURRENT lease per unit", sql: `
        DROP INDEX IF EXISTS one_active_lease_per_unit;
        CREATE UNIQUE INDEX IF NOT EXISTS one_current_lease_per_unit ON leases (unit_id) WHERE lease_state = 'CURRENT'
    ` },
    { name: "Tenant ID number is unique per company", sql: `
        ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_nida_passport_no_key;
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_id_per_company ON tenants (company_id, nida_passport_no)
    ` },

    // ---------- v6 ----------
    { name: "Company profile and financial year", sql: `
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS email VARCHAR(120);
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS tin VARCHAR(40);
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS fy_start_month INTEGER DEFAULT 1;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_instructions TEXT;
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS luku_low_threshold INTEGER DEFAULT 5
    ` },
    { name: "Company logo", sql: `
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data TEXT
    ` },
    { name: "Password reset links", sql: `
        CREATE TABLE IF NOT EXISTS password_resets (
            reset_id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            used_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets (token_hash)
    ` },
    { name: "Allow VIEWER role", sql: `
        DO $$
        DECLARE c record;
        BEGIN
            FOR c IN SELECT conname FROM pg_constraint
                     WHERE conrelid = 'public.users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
            LOOP
                EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
            END LOOP;
            ALTER TABLE users ADD CONSTRAINT users_role_check
                CHECK (role IN ('SUPER_ADMIN','COMPANY_ADMIN','PROPERTY_MANAGER','ACCOUNTANT','TECHNICIAN','MAINTENANCE_MANAGER','VIEWER'));
        END $$;
    ` },
    { name: "Invoice details", sql: `
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type VARCHAR(20) DEFAULT 'RENT';
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2);
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date DATE;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_start DATE;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_end DATE;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS lease_charge BOOLEAN DEFAULT true;
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by INTEGER;
        UPDATE invoices SET issue_date = created_at::date WHERE issue_date IS NULL;
        CREATE INDEX IF NOT EXISTS idx_invoices_type_period ON invoices (lease_id, invoice_type, period_start)
    ` },
    { name: "Receipts and payment details", sql: `
        CREATE SEQUENCE IF NOT EXISTS receipt_seq START 100000;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(40);
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS method_detail VARCHAR(40);
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS notes TEXT;
        CREATE INDEX IF NOT EXISTS idx_payments_company_date ON payments (company_id, payment_date)
    ` },
    { name: "Service charges", sql: `
        ALTER TABLE units ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12,2) DEFAULT 0;
        ALTER TABLE units ADD COLUMN IF NOT EXISTS service_inclusive BOOLEAN DEFAULT false;
        ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12,2) DEFAULT 0;
        ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS service_inclusive BOOLEAN DEFAULT false;
        ALTER TABLE properties ADD COLUMN IF NOT EXISTS service_charge_label VARCHAR(60) DEFAULT 'Service charge'
    ` },
    { name: "Expenses details", sql: `
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee VARCHAR(120);
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ticket_id INTEGER;
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
        DO $$
        DECLARE c record;
        BEGIN
            FOR c IN SELECT conname FROM pg_constraint
                     WHERE conrelid = 'public.expenses'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%category%'
            LOOP
                EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', c.conname);
            END LOOP;
        END $$;
    ` },
    { name: "Maintenance ticket details", sql: `
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS property_id INTEGER;
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS actual_cost NUMERIC(12,2);
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by INTEGER;
        UPDATE work_orders w SET property_id = u.property_id FROM units u WHERE w.unit_id = u.unit_id AND w.property_id IS NULL
    ` },
    { name: "Luku stock", sql: `
        CREATE TABLE IF NOT EXISTS luku_stock (
            stock_id    SERIAL PRIMARY KEY,
            company_id  INTEGER NOT NULL,
            unit_name   VARCHAR(80) NOT NULL,
            token       VARCHAR(40) NOT NULL,
            price       NUMERIC(12,2) NOT NULL,
            kwh         NUMERIC(10,2),
            status      VARCHAR(10) DEFAULT 'AVAILABLE',
            batch       VARCHAR(80),
            uploaded_at TIMESTAMP DEFAULT NOW(),
            sold_at     TIMESTAMP,
            sold_to     VARCHAR(120),
            sold_by     INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_luku_token_per_company ON luku_stock (company_id, token);
        CREATE INDEX IF NOT EXISTS idx_luku_stock_lookup ON luku_stock (company_id, unit_name, price, status)
    ` },
    { name: "Make sure columns exist (older databases)", sql: `
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_by INTEGER;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100);
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS property_id INTEGER;
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recorded_by INTEGER;
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(12,2) DEFAULT 0;
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS assigned_technician_id INTEGER;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
    ` },
    { name: "Payments: remove old type rule", sql: `
        DO $$
        DECLARE c record;
        BEGIN
            FOR c IN SELECT conname FROM pg_constraint
                     WHERE conrelid = 'public.payments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%payment_type%'
            LOOP
                EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
            END LOOP;
        END $$;
    ` },
    { name: "Luku sales table allows the same token text per company", sql: `
        ALTER TABLE luku_vouchers DROP CONSTRAINT IF EXISTS luku_vouchers_token_number_key;
        ALTER TABLE luku_vouchers ADD COLUMN IF NOT EXISTS unit_name VARCHAR(80);
        ALTER TABLE luku_vouchers ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30)
    ` },
    { name: "Staff must ask before editing tenants (one time)", sql: `
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edit_requests') THEN
                UPDATE users SET can_edit_tenants = false WHERE role NOT IN ('COMPANY_ADMIN', 'SUPER_ADMIN');
            END IF;
        END $$;
    ` },
    { name: "Edit requests table", sql: `
        CREATE TABLE IF NOT EXISTS edit_requests (
            request_id    SERIAL PRIMARY KEY,
            company_id    INTEGER,
            entity_type   VARCHAR(20) NOT NULL,
            entity_id     INTEGER NOT NULL,
            entity_label  VARCHAR(200),
            section       VARCHAR(30) NOT NULL,
            reason        TEXT,
            requested_by  INTEGER,
            status        VARCHAR(12) DEFAULT 'PENDING',
            decided_by    INTEGER,
            decided_at    TIMESTAMP,
            decision_note TEXT,
            expires_at    TIMESTAMP,
            used_at       TIMESTAMP,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_edit_requests_company ON edit_requests (company_id, status)
    ` }
    ,{ name: "Finance: currency, accounts, income", sql: `
        ALTER TABLE leases ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_id INTEGER;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_currency VARCHAR(3);
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_amount NUMERIC(14, 2);
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14, 4);
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS account_id INTEGER;
        CREATE TABLE IF NOT EXISTS finance_accounts (
            account_id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            name VARCHAR(100) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'TZS',
            kind VARCHAR(20) DEFAULT 'CASH',
            opening_balance NUMERIC(14, 2) DEFAULT 0,
            is_active BOOLEAN DEFAULT true,
            created_by INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS finance_income (
            income_id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            account_id INTEGER,
            property_id INTEGER,
            description TEXT NOT NULL,
            amount NUMERIC(14, 2) NOT NULL,
            currency VARCHAR(3) DEFAULT 'TZS',
            category VARCHAR(30) DEFAULT 'OTHER',
            income_date DATE DEFAULT CURRENT_DATE,
            payer VARCHAR(120),
            reference VARCHAR(100),
            notes TEXT,
            recorded_by INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fin_income_company ON finance_income (company_id, income_date);
        CREATE INDEX IF NOT EXISTS idx_fin_accounts_company ON finance_accounts (company_id)
    ` }
    ,{ name: "Finance: TSh-only views", sql: `
        DROP VIEW IF EXISTS payments_tzs;
        DROP VIEW IF EXISTS invoices_tzs;
        DROP VIEW IF EXISTS expenses_tzs;
        CREATE VIEW payments_tzs AS SELECT * FROM payments WHERE COALESCE(currency, 'TZS') = 'TZS';
        CREATE VIEW invoices_tzs AS SELECT * FROM invoices WHERE COALESCE(currency, 'TZS') = 'TZS';
        CREATE VIEW expenses_tzs AS SELECT * FROM expenses WHERE COALESCE(currency, 'TZS') = 'TZS'
    ` }
    ,{ name: "Maintenance workers (no login) and role MAINTENANCE_MANAGER", sql: `
        DO $$ DECLARE c record; BEGIN
            FOR c IN SELECT conname FROM pg_constraint
                     WHERE conrelid = 'public.users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
            LOOP EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname); END LOOP;
            ALTER TABLE users ADD CONSTRAINT users_role_check
                CHECK (role IN ('SUPER_ADMIN','COMPANY_ADMIN','PROPERTY_MANAGER','ACCOUNTANT','TECHNICIAN','MAINTENANCE_MANAGER','VIEWER'));
        END $$;
        CREATE TABLE IF NOT EXISTS maintenance_workers (
            worker_id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            full_name VARCHAR(120) NOT NULL,
            phone_number VARCHAR(40),
            is_active BOOLEAN DEFAULT true,
            legacy_user_id INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_mworkers_company ON maintenance_workers(company_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_mworkers_legacy ON maintenance_workers(legacy_user_id) WHERE legacy_user_id IS NOT NULL;
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS worker_id INTEGER;
        INSERT INTO maintenance_workers (company_id, full_name, phone_number, is_active, legacy_user_id)
            SELECT u.company_id, u.full_name, u.phone_number, u.is_active, u.user_id FROM users u
            WHERE u.role = 'TECHNICIAN' AND u.company_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM maintenance_workers m WHERE m.legacy_user_id = u.user_id);
        UPDATE work_orders w SET worker_id = m.worker_id FROM maintenance_workers m
            WHERE w.worker_id IS NULL AND w.assigned_technician_id IS NOT NULL AND m.legacy_user_id = w.assigned_technician_id;
        UPDATE users SET role = 'MAINTENANCE_MANAGER' WHERE role = 'TECHNICIAN';
    ` }
];

async function seedMasterAdmin() {
    // The owner of the system (SUPER_ADMIN) is created from Railway Variables, never from the code:
    //   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD  (used only when the account is created / adopted)
    //   RESET_SUPER_ADMIN_PASSWORD               (emergency: sets a new password, remove it after one deploy)
    const companyCheck = await pool.query("SELECT * FROM companies WHERE company_name = 'Hugo Tech Platform Master'");
    let masterCompanyId;
    if (companyCheck.rows.length === 0) {
        const newComp = await pool.query("INSERT INTO companies (company_name, subscription_plan) VALUES ('Hugo Tech Platform Master', 'ENTERPRISE') RETURNING company_id");
        masterCompanyId = newComp.rows[0].company_id;
    } else {
        masterCompanyId = companyCheck.rows[0].company_id;
    }

    const envEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
    const envPass = String(process.env.SUPER_ADMIN_PASSWORD || '');
    const existingAdmins = (await pool.query("SELECT user_id, email FROM users WHERE role = 'SUPER_ADMIN' ORDER BY user_id ASC")).rows;
    await pool.query("UPDATE users SET company_id = $1 WHERE role = 'SUPER_ADMIN' AND company_id IS NULL", [masterCompanyId]);

    if (envEmail && envPass.length >= 8) {
        const mine = (await pool.query('SELECT user_id, role FROM users WHERE LOWER(email) = $1', [envEmail])).rows[0];
        if (!mine) {
            const hashed = await bcrypt.hash(envPass, 10);
            if (existingAdmins.length > 0) {
                // an older owner account exists: it takes the new email and password (once)
                await pool.query("UPDATE users SET email = $1, password_hash = $2, is_active = true WHERE user_id = $3", [envEmail, hashed, existingAdmins[0].user_id]);
                console.log('✅ Super Admin account moved to the email from SUPER_ADMIN_EMAIL');
            } else {
                await pool.query(
                    "INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, 'SUPER_ADMIN', true, true)",
                    [masterCompanyId, 'System Owner', envEmail, hashed, '']
                );
                console.log('✅ Super Admin created from SUPER_ADMIN_EMAIL');
            }
        } else if (mine.role !== 'SUPER_ADMIN') {
            console.error('❌ SUPER_ADMIN_EMAIL belongs to a normal user. Use another email.');
        }
        // an account that already exists is NOT touched: the owner may have changed the password on the Super Admin page
    } else if (existingAdmins.length === 0) {
        console.error('⚠️ No Super Admin exists. Add SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (min 8 characters) in Railway Variables and redeploy.');
    }

    if (process.env.RESET_SUPER_ADMIN_PASSWORD && String(process.env.RESET_SUPER_ADMIN_PASSWORD).length >= 8) {
        const target = envEmail ? (await pool.query("SELECT user_id FROM users WHERE LOWER(email) = $1 AND role = 'SUPER_ADMIN'", [envEmail])).rows[0] : null;
        const uid = target ? target.user_id : (existingAdmins[0] && existingAdmins[0].user_id);
        if (uid) {
            const hashed = await bcrypt.hash(String(process.env.RESET_SUPER_ADMIN_PASSWORD), 10);
            await pool.query("UPDATE users SET password_hash = $1, is_active = true WHERE user_id = $2", [hashed, uid]);
            console.log('✅ Super Admin password was reset from RESET_SUPER_ADMIN_PASSWORD (remove this variable now)');
        }
    }
}

async function runDatabaseSetup() {
    const results = [];
    const run = async (name, fn) => {
        try { await fn(); results.push({ step: name, ok: true }); }
        catch (err) {
            console.error(`❌ Setup step failed [${name}]:`, err.message);
            results.push({ step: name, ok: false, error: err.message });
        }
    };

    for (const step of SETUP_STEPS) {
        // blocks with $$ run whole; plain blocks run statement by statement
        const parts = step.sql.includes('$$') ? [step.sql] : step.sql.split(';').map(x => x.trim()).filter(Boolean);
        for (const part of parts) {
            const label = parts.length > 1 ? `${step.name}: ${part.replace(/\s+/g, ' ').slice(0, 70)}` : step.name;
            await run(label, () => pool.query(part));
        }
    }
    await run('Master admin account', seedMasterAdmin);
    accessCache.clear();
    return results;
}

async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;
        console.log('🔄 Connecting to Database & Initializing Core Setup...');
        await pool.query('SELECT NOW()');
        const results = await runDatabaseSetup();
        const failed = results.filter(r => !r.ok);
        if (failed.length === 0) console.log(`✅ Database Initialization Complete. (${results.length} steps OK)`);
        else console.error(`⚠️ Database setup finished with ${failed.length} problem(s) out of ${results.length} steps. See the lines marked ❌ above.`);
    } catch (err) {
        console.error('❌ DB Initialization Error:', err.message);
    }
}


app.get('/api/version', (req, res) => res.json({ server_version: SERVER_VERSION }));

const sendHome = (req, res) => res.sendFile(path.join(__dirname, 'index.html'));
app.get('/', sendHome);
app.get('/admin', sendHome);
app.get('/admin/', sendHome);

const userCache = new Map();
function clearUserCache(userId) { userCache.delete(String(userId)); }
async function getUserState(userId) {
    const key = String(userId);
    const hit = userCache.get(key);
    if (hit && Date.now() - hit.at < 20000) return hit.data;
    try {
        const r = await pool.query('SELECT is_active, role, can_edit_tenants FROM users WHERE user_id = $1', [userId]);
        const data = r.rows[0] || null;
        userCache.set(key, { at: Date.now(), data });
        return data;
    } catch (err) { return null; }
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. Missing authentication token.' });

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired or invalid token. Please log in again.' });
        try {
            req.user = user;

            // role changes and switched-off users take effect within seconds (not after 12 hours)
            if (user.role !== 'SUPER_ADMIN') {
                const state = await getUserState(user.user_id);
                if (state) {
                    if (state.is_active === false) return res.status(403).json({ error: 'Your account has been switched off. Please contact your administrator.', code: 'ACCOUNT_SUSPENDED' });
                    req.user.role = state.role;
                    req.user.can_edit_tenants = state.can_edit_tenants;
                }
                // every request checks that the company is paid and active
                const access = await getCompanyAccess(user.company_id);
                const block = accessBlock(access);
                if (block) return res.status(403).json({ error: block.message, code: block.code });
            }
            next();
        } catch (e) {
            console.error('Auth error:', e.message);
            res.status(500).json({ error: 'Authentication check failed: ' + e.message });
        }
    });
}

function allowRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Access Denied: Unauthorized role permission.' });
        }
        next();
    };
}

// 1. AUTHENTICATION
// the owner of the system signs in on its own page (/admin) and nowhere else
app.post('/api/auth/admin-login', loginLimiter, (req, res, next) => { req.isOwnerLogin = true; next(); }, (req, res, next) => loginHandler(req, res, next));
app.post('/api/auth/login', loginLimiter, (req, res, next) => loginHandler(req, res, next));
async function loginHandler(req, res) {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and Password are required.' });

    try {
        const userQuery = await pool.query(
            `SELECT u.*, c.company_name
             FROM users u
             LEFT JOIN companies c ON u.company_id = c.company_id
             WHERE LOWER(u.email) = LOWER($1)`,
            [email]
        );
        if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Invalid Email or Password.' });

        const user = userQuery.rows[0];
        if (req.isOwnerLogin && user.role !== 'SUPER_ADMIN') return res.status(401).json({ error: 'Invalid Email or Password.' });
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Invalid Email or Password.' });

        if (!user.is_active) return res.status(403).json({ error: 'Account suspended.', code: 'ACCOUNT_SUSPENDED' });
        if (user.role === 'SUPER_ADMIN' && !req.isOwnerLogin) return res.status(403).json({ error: 'Invalid Email or Password.' });

        let company;
        if (user.role === 'SUPER_ADMIN') {
            company = superAdminCompanyInfo(user.company_name);
        } else {
            const access = await getCompanyAccess(user.company_id);
            const block = accessBlock(access);
            if (block) return res.status(403).json({ error: block.message, code: block.code });
            company = companyInfo(access);
        }

        const token = jwt.sign(
            { user_id: user.user_id, company_id: user.company_id, email: user.email, role: user.role, full_name: user.full_name, can_edit_tenants: user.can_edit_tenants },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        await createAuditLog(pool, user.company_id, user.user_id, `User Logged In`, 'AUTH', req.ip, { email: user.email });

        res.json({
            message: 'Login successful',
            token,
            user: { user_id: user.user_id, company_id: user.company_id, company_name: user.company_name, full_name: user.full_name, email: user.email, role: user.role, can_edit_tenants: user.can_edit_tenants },
            company
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Server error during login: ' + err.message });
    }
}


// ============================================================
// FORGOT PASSWORD: a reset link is sent to the user's email
// Needs these Railway variables (Gmail example):
//   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_USER=youraddress@gmail.com
//   SMTP_PASS=<Gmail "App password">   SMTP_FROM="KEY ARCH <youraddress@gmail.com>"
//   APP_URL=https://your-app.up.railway.app   (optional, the link of your system)
// ============================================================
const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5,
    message: { error: 'Too many requests. Please try again after 15 minutes.' }
});

function mailConfigured() { return !!(process.env.SMTP_USER && process.env.SMTP_PASS); }

async function sendMail(to, subject, text, html) {
    const nodemailer = loadOptional('nodemailer');
    const port = parseInt(process.env.SMTP_PORT) || 465;
    const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') }
    });
    await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
}

app.post('/api/auth/forgot', forgotLimiter, async (req, res) => {
    // same answer whether or not the email exists, so nobody can test which emails are registered
    const generic = { message: 'If this email is registered, a password reset link has been sent. Check your inbox (and Spam). The link works for 1 hour.' };
    try {
        const email = String((req.body || {}).email || '').trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
        const u = (await pool.query('SELECT user_id, full_name, email, is_active FROM users WHERE LOWER(email) = $1', [email])).rows[0];
        if (!u || !u.is_active) return res.json(generic);
        if (!mailConfigured()) {
            console.error('Forgot password: email is not set up. Add SMTP_USER and SMTP_PASS in Railway Variables.');
            return res.status(503).json({ error: 'Email sending is not set up yet. Please contact HUGO TECH on WhatsApp +255 785 799 530 to reset your password.' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [u.user_id]);
        await pool.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + interval '1 hour')", [u.user_id, hash]);
        const host = String(req.headers.host || '');
        const proto = String(req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https')).split(',')[0];
        const base = (process.env.APP_URL || `${proto}://${host}`).replace(/\/+$/, '');
        const link = `${base}/?reset=${token}`;
        const text = `Habari ${u.full_name},\n\nTumepokea ombi la kubadilisha password ya KEY ARCH.\nBonyeza link hii kuweka password mpya (inafanya kazi kwa saa 1):\n${link}\n\nUsipoomba wewe, puuza ujumbe huu - password yako haitabadilika.\n\n---\nHello ${u.full_name},\nWe received a request to reset your KEY ARCH password. Open this link to choose a new one (valid for 1 hour):\n${link}\nIf you did not ask for this, ignore this email.\n\nHUGO TECH`;
        const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="color:#1d4ed8">KEY ARCH</h2><p>Habari <b>${String(u.full_name).replace(/[<>&"]/g, '')}</b>,</p><p>Tumepokea ombi la kubadilisha password yako. Bonyeza kitufe hapa chini kuweka password mpya (inafanya kazi kwa <b>saa 1</b>).</p><p style="text-align:center;margin:24px 0"><a href="${link}" style="background:#2563eb;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Weka Password Mpya</a></p><p style="font-size:12px;color:#666">Kama kitufe hakifanyi kazi, nakili link hii kwenye browser:<br>${link}</p><p style="font-size:12px;color:#666">Usipoomba wewe, puuza ujumbe huu - password yako haitabadilika.</p><hr><p style="font-size:12px;color:#666">Hello, we received a request to reset your password. If it was not you, ignore this email.<br>HUGO TECH</p></div>`;
        await sendMail(u.email, 'KEY ARCH - Password Reset / Weka Password Mpya', text, html);
        await createAuditLog(pool, null, u.user_id, 'Password reset requested', 'AUTH', req.ip, {});
        res.json(generic);
    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ error: err.code === 'MISSING_PACKAGE' ? 'Email sending is not installed on the server yet (add nodemailer). Contact HUGO TECH.' : 'The email could not be sent. Please try again later or contact HUGO TECH.' });
    }
});

app.post('/api/auth/reset', forgotLimiter, async (req, res) => {
    try {
        const { token, password } = req.body || {};
        if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return res.status(400).json({ error: 'This reset link is not valid.' });
        if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const row = (await pool.query('SELECT reset_id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()', [hash])).rows[0];
        if (!row) return res.status(400).json({ error: 'This reset link has expired or was already used. Please ask for a new one.' });
        const newHash = await bcrypt.hash(String(password), 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [newHash, row.user_id]);
        await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
        clearUserCache(row.user_id);
        await createAuditLog(pool, null, row.user_id, 'Password reset completed', 'AUTH', req.ip, {});
        res.json({ message: 'Your password has been changed. You can sign in now.' });
    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ error: 'Could not reset the password. Please try again.' });
    }
});

// Fresh plan / features / subscription info (the page asks for this when it opens)
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        if (req.user.role === 'SUPER_ADMIN') {
            const c = await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [req.user.company_id]);
            return res.json({ company: superAdminCompanyInfo(c.rows[0] ? c.rows[0].company_name : 'Platform') });
        }
        const access = await getCompanyAccess(req.user.company_id);
        res.json({ company: companyInfo(access) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PROPERTIES & UNITS FOR SELECTORS
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, COALESCE(p.property_name, p.title) as property_name, COUNT(u.unit_id) as total_units_count
             FROM properties p
             LEFT JOIN units u ON p.property_id = u.property_id
             WHERE p.company_id = $1
             GROUP BY p.property_id
             ORDER BY p.created_at DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/units/by-property/:property_id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM units WHERE property_id = $1 AND company_id = $2 AND status = 'VACANT' ORDER BY unit_number ASC",
            [req.params.property_id, req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// WIZARD API FOR PROPERTY
app.post('/api/properties/wizard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_name, address, property_type, number_of_units, groups } = req.body;
    const companyId = req.user.company_id;

    if (!property_name || !address || !property_type || !groups || !Array.isArray(groups)) {
        return res.status(400).json({ error: 'Please provide valid property details and group array.' });
    }

    const propLimit = await checkLimit(req.user, 'max_properties', 'SELECT COUNT(*) FROM properties WHERE company_id = $1', 'properties');
    if (propLimit) return res.status(403).json({ error: propLimit, code: 'LIMIT_REACHED' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const propRes = await client.query(
            'INSERT INTO properties (company_id, property_name, title, address, category, total_units, service_charge_label) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [companyId, property_name, property_name, address, property_type, groups.reduce((n, g) => n + (parseInt(g.units_in_group) || 1), 0), String(req.body.service_charge_label || 'Service charge').slice(0, 60)]
        );
        const property = propRes.rows[0];

        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
            const grp = groups[gIdx];
            const svcAmount = Math.max(0, parseFloat(grp.service_charge) || 0);
            const svcInclusive = !!grp.service_inclusive;
            await client.query(
                `INSERT INTO unit_groups
                 (company_id, property_id, group_name, units_in_group, bedrooms, bathrooms, rent_timeline, currency, rent_amount, payment_method, furnishing_status, service_charge, service_inclusive)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    companyId, property.property_id, grp.group_name || `Group ${gIdx + 1}`, grp.units_in_group || 1, grp.bedrooms || 0, grp.bathrooms || 0,
                    grp.rent_timeline || 'Per Month', grp.currency || 'TSH', grp.rent_amount || 0, grp.payment_method || 'Cash', grp.furnishing_status || 'Unfurnished',
                    svcAmount, svcInclusive
                ]
            );

            const unitsCount = Math.min(500, Math.max(1, parseInt(grp.units_in_group || 1)));
            const cleanGrpName = (grp.group_name || `G${gIdx + 1}`).replace(/\s+/g, '-');


            for (let uIdx = 1; uIdx <= unitsCount; uIdx++) {
                const unitNumber = `${cleanGrpName}-${uIdx}`;
                await client.query(
                    `INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished, service_charge, service_inclusive)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [companyId, property.property_id, unitNumber, grp.rent_amount || 0, grp.currency || 'TSH', 'VACANT', grp.furnishing_status === 'Furnished', svcAmount, svcInclusive]
                );
            }
        }

        await createAuditLog(client, companyId, req.user.user_id, 'Created Multi-Group Property Wizard', 'PROPERTIES', req.ip, { property_id: property.property_id });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Property created successfully', property });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to create property: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

// TENANT ONBOARDING WITH AUTO-INVOICE GENERATION
app.post('/api/tenants/onboard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    let client;
    try {
        const { full_name, nida_passport_no, identity_type, phone_number, property_id, unit_id, start_date, end_date, discount, paid_amount, agreed_rent } = req.body;
        const leaseCurrency = cleanCur(req.body.currency);
        let { rent_price, rent_period, number_of_periods } = req.body;
        const companyId = req.user.company_id;

        // Old frontend compatibility: only "agreed_rent" sent = one period
        if (rent_price === undefined && agreed_rent !== undefined) {
            rent_price = agreed_rent;
            number_of_periods = number_of_periods ?? 1;
            rent_period = rent_period || 'Month';
        }
        rent_period = rent_period || 'Month';

        if (!full_name || !nida_passport_no || !phone_number || !property_id || !unit_id || !start_date || !rent_price) {
            return res.status(400).json({ error: 'Please fill in all required fields (*).' });
        }
        if (!ALLOWED_RENT_PERIODS.includes(rent_period)) {
            return res.status(400).json({ error: 'Invalid rent period. Use Day, Week, Month or Year.' });
        }

        // The server calculates everything again. Browser figures are never trusted.
        const calc = calculatePayment({ rent_price, number_of_periods, discount, paid_amount });
        if (calc.error) return res.status(400).json({ error: calc.error });

        client = await pool.connect();
        await client.query('BEGIN');

        const unitCheck = await client.query(
            `SELECT u.status, u.property_id, u.service_charge, u.service_inclusive, u.currency AS unit_currency, p.service_charge_label AS service_label
             FROM units u JOIN properties p ON p.property_id = u.property_id WHERE u.unit_id = $1 AND u.company_id = $2`, [unit_id, companyId]);
        if (unitCheck.rows.length === 0) throw new Error('Unit not found.');
        const unitRow = unitCheck.rows[0];
        if (String(unitCheck.rows[0].property_id) !== String(property_id)) throw new Error('This unit does not belong to the selected property.');
        if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('This unit already has a tenant.');

        // same person (same ID number) renting again: reuse the record so the history stays together
        let tenant;
        const existingTenant = await client.query(
            'SELECT * FROM tenants WHERE company_id = $1 AND nida_passport_no = $2 ORDER BY tenant_id ASC LIMIT 1',
            [companyId, String(nida_passport_no).trim()]
        );
        if (existingTenant.rows.length > 0) {
            tenant = existingTenant.rows[0];
            await client.query('UPDATE tenants SET phone_number = $1, is_active = true WHERE tenant_id = $2', [phone_number, tenant.tenant_id]);
        } else {
            const tenantRes = await client.query(
                'INSERT INTO tenants (company_id, full_name, identity_type, nida_passport_no, phone_number) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [companyId, full_name, ALLOWED_ID_TYPES.includes(identity_type) ? identity_type : 'NIDA', String(nida_passport_no).trim(), phone_number]
            );
            tenant = tenantRes.rows[0];
        }

        const leaseEndDate = end_date || new Date(new Date(start_date).setFullYear(new Date(start_date).getFullYear() + 1)).toISOString().split('T')[0];

        const durationDays = Math.max(0, Math.round((new Date(leaseEndDate) - new Date(start_date)) / 86400000));

        // agreed_rent keeps the "Total To Pay" so older reports that use it still work
        const leaseRes = await client.query(
            `INSERT INTO leases
             (company_id, unit_id, tenant_id, property_id, start_date, end_date, duration_days, agreed_rent, amount_paid, amount_due, payment_cycle, status,
              rent_price, rent_period, number_of_periods, total_rent, discount, total_to_pay, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
            [
                companyId, unit_id, tenant.tenant_id, property_id, start_date, leaseEndDate, durationDays, calc.totalToPay, calc.paid, calc.amountDue, 'MONTHLY', 'ACTIVE',
                calc.price, rent_period, calc.periods, calc.totalRent, calc.discount, calc.totalToPay, calc.status
            ]
        );
        const lease = leaseRes.rows[0];
        if (leaseCurrency !== 'TZS') { await client.query('UPDATE leases SET currency = $1 WHERE lease_id = $2', [leaseCurrency, lease.lease_id]); lease.currency = leaseCurrency; }

        await client.query("UPDATE units SET status = 'OCCUPIED' WHERE unit_id = $1 AND company_id = $2", [unit_id, companyId]);

        // Auto Generate Invoice & Receipt
        const invoice = await createInvoice(client, {
            companyId, leaseId: lease.lease_id, type: 'RENT', subtotal: calc.totalRent, discount: calc.discount,
            description: `Rent: ${calc.periods} ${periodWord(rent_period, calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(start_date)} - ${niceDate(leaseEndDate)})`,
            issueDate: start_date, dueDate: start_date, periodStart: start_date, periodEnd: leaseEndDate, leaseCharge: true, userId: req.user.user_id,
            status: calc.amountDue === 0 ? 'PAID' : 'PENDING'
        });

        let payment = null;
        if (calc.paid > 0) {
            payment = await addPayment(client, {
                companyId, invoiceId: invoice.invoice_id, amount: calc.paid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                reference: req.body.payment_reference, date: start_date <= todayStr() ? start_date : todayStr(), userId: req.user.user_id, accountId: req.body.account_id
            });
        }

        // service charge of the first month (unless it is already included in the rent)
        let serviceInvoice = null;
        // the unit may be priced in the other currency: the service charge follows the same exchange rate as the rent
        const unitCur = String(unitRow.unit_currency || '').toUpperCase() === 'USD' ? 'USD' : 'TZS';
        const xr = parseFloat(req.body.exchange_rate);
        if (unitCur !== leaseCurrency && !(xr > 0)) throw new Error('Please enter the exchange rate (TSh for 1 USD).');
        const convUnit = n => unitCur === leaseCurrency ? n : (leaseCurrency === 'USD' ? Math.round(n / xr * 100) / 100 : Math.round(n * xr));
        const svc = convUnit(parseFloat(unitRow.service_charge || 0));
        if (svc > 0 && !unitRow.service_inclusive) {
            const ym = String(start_date).slice(0, 7);
            const range = monthRange(ym);
            serviceInvoice = await createInvoice(client, {
                companyId, leaseId: lease.lease_id, type: 'SERVICE', subtotal: svc, discount: 0,
                description: `${unitRow.service_label || 'Service charge'} - ${monthLabel(ym)}`,
                issueDate: start_date, dueDate: start_date, periodStart: range.start, periodEnd: range.end, leaseCharge: false, userId: req.user.user_id
            });
            const svcPaid = Math.min(svc, Math.max(0, parseFloat(req.body.service_paid) || 0));
            if (svcPaid > 0) {
                await addPayment(client, {
                    companyId, invoiceId: serviceInvoice.invoice_id, amount: svcPaid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                    reference: req.body.payment_reference, date: start_date <= todayStr() ? start_date : todayStr(), userId: req.user.user_id, accountId: req.body.account_id
                });
                if (svcPaid >= svc) await client.query("UPDATE invoices SET status = 'PAID' WHERE invoice_id = $1", [serviceInvoice.invoice_id]);
            }
        }

        await logLeaseEvent(client, companyId, lease.lease_id, tenant.tenant_id, 'CREATED',
            `Lease started: ${start_date} to ${leaseEndDate} (${calc.periods} ${rent_period}${calc.periods === 1 ? '' : 's'})`, calc.totalToPay, req.user.user_id);
        await createAuditLog(client, companyId, req.user.user_id, `Onboarded Tenant & Auto-Generated Invoice`, 'TENANTS', req.ip, {
            tenant_id: tenant.tenant_id,
            invoice_id: invoice.invoice_id,
            total_rent: calc.totalRent,
            discount: calc.discount,
            total_to_pay: calc.totalToPay,
            paid: calc.paid,
            payment_status: calc.status
        });
        await client.query('COMMIT');

        res.status(201).json({
            message: 'Tenant onboarded successfully',
            tenant,
            lease,
            payment_status: calc.status,
            payment,
            service_invoice: serviceInvoice,
            invoice: {
                ...invoice,
                paid_amount: calc.paid,
                amount_due: calc.amountDue,
                extra_paid: calc.extraPaid,
                agreed_rent: calc.totalToPay,
                total_rent: calc.totalRent,
                discount: calc.discount,
                total_to_pay: calc.totalToPay
            }
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Onboarding Failed: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

// ============================================================
// TENANTS: one row per tenant (their current / latest lease)
// ============================================================
const LEASE_MANAGERS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'];

app.get('/api/tenants', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM (
                SELECT DISTINCT ON (t.tenant_id)
                       t.*, COALESCE(t.is_active, true) AS tenant_active,
                       l.lease_id, l.start_date, l.end_date, l.lease_state, l.agreed_rent,
                       l.rent_price, l.rent_period, l.number_of_periods, l.total_rent, COALESCE(l.discount, 0) AS discount,
                       COALESCE(l.total_to_pay, l.agreed_rent) AS total_to_pay, l.payment_status,
                       COALESCE(l.amount_paid, 0) AS amount_paid, COALESCE(l.amount_due, l.agreed_rent) AS amount_due,
                       (l.end_date::date - CURRENT_DATE) AS days_left,
                       u.unit_id, u.unit_number, COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
                       p.property_id, COALESCE(p.property_name, p.title) AS property_name,
                       (SELECT COUNT(*) FROM payments py JOIN invoices i4 ON py.invoice_id = i4.invoice_id JOIN leases l4 ON i4.lease_id = l4.lease_id
                         WHERE l4.tenant_id = t.tenant_id AND py.company_id = $1) AS payment_count,
                       (SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0)
                          FROM invoices_tzs inv JOIN leases l2 ON inv.lease_id = l2.lease_id
                         WHERE l2.tenant_id = t.tenant_id AND inv.company_id = $1) AS balance_owed,
                       (SELECT COUNT(*) FROM leases l3 WHERE l3.tenant_id = t.tenant_id) AS lease_count
                FROM tenants t
                JOIN leases l ON t.tenant_id = l.tenant_id
                JOIN units u ON l.unit_id = u.unit_id
                JOIN properties p ON u.property_id = p.property_id
                WHERE t.company_id = $1
                ORDER BY t.tenant_id, (l.lease_state = 'CURRENT') DESC, l.lease_id DESC
             ) x
             ORDER BY (x.lease_state = 'CURRENT') DESC, x.tenant_id DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// FULL HISTORY OF ONE TENANT (all leases, invoices, payments, activity)
app.get('/api/tenants/:id/history', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    const cId = req.user.company_id;
    const tenantId = req.params.id;
    try {
        const tenantRes = await pool.query('SELECT * FROM tenants WHERE tenant_id = $1 AND company_id = $2', [tenantId, cId]);
        if (tenantRes.rows.length === 0) return res.status(404).json({ error: 'Tenant not found.' });

        const leases = (await pool.query(
            `SELECT l.*, to_char(l.start_date, 'YYYY-MM-DD') AS start_str, to_char(l.end_date, 'YYYY-MM-DD') AS end_str,
                    (l.end_date::date - CURRENT_DATE) AS days_left,
                    u.unit_number, COALESCE(p.property_name, p.title) AS property_name
             FROM leases l JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
             WHERE l.tenant_id = $1 AND l.company_id = $2 ORDER BY l.lease_id DESC`,
            [tenantId, cId]
        )).rows;

        const invoices = (await pool.query(
            `SELECT inv.invoice_id, inv.invoice_number, inv.amount_due, inv.due_date, inv.lease_id, inv.invoice_type, inv.description, inv.issue_date, COALESCE(pay.paid, 0) AS paid
             FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id
             LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
             WHERE l.tenant_id = $1 AND inv.company_id = $2 ORDER BY inv.invoice_id DESC`,
            [tenantId, cId]
        )).rows;

        const payments = (await pool.query(
            `SELECT pay.payment_id, pay.receipt_number, pay.amount_paid, pay.payment_date, pay.payment_method, pay.method_detail, pay.reference_no, inv.invoice_id, inv.invoice_number, inv.invoice_type
             FROM payments pay JOIN invoices inv ON pay.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
             WHERE l.tenant_id = $1 AND pay.company_id = $2 ORDER BY pay.payment_date DESC`,
            [tenantId, cId]
        )).rows;

        let events = [];
        try {
            events = (await pool.query(
                'SELECT event_type, description, amount, created_at FROM lease_events WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC',
                [tenantId, cId]
            )).rows;
        } catch (e) { console.error('History events warning:', e.message); }

        const billed = invoices.reduce((s, i) => s + parseFloat(i.amount_due), 0);
        const paid = invoices.reduce((s, i) => s + parseFloat(i.paid), 0);
        const balance = invoices.reduce((s, i) => s + Math.max(0, parseFloat(i.amount_due) - parseFloat(i.paid)), 0);

        res.json({ tenant: tenantRes.rows[0], leases, invoices, payments, events, totals: { billed, paid, balance } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// EDIT TENANT (personal details + lease end date)

// ============================================================
// EDITING TENANTS AFTER SAVING: the owner/admin edits directly; staff ask for permission first
// ============================================================
const EDIT_SECTIONS = { TENANT_INFO: 'Tenant details (name, phone, ID)', LEASE_TERMS: 'Rent price, discount, periods and dates' };
async function checkEditPermission(req, client, tenantId, section) {
    const role = req.user.role;
    if (role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN') return { ok: true };
    if (section === 'TENANT_INFO' && req.user.can_edit_tenants) return { ok: true };
    const rid = parseInt((req.body || {}).request_id);
    const deny = { ok: false, status: 403, code: 'NEEDS_APPROVAL', error: 'You need permission from the owner/admin to edit this. Ask for permission first.' };
    if (!rid) return deny;
    const r = (await client.query('SELECT * FROM edit_requests WHERE request_id = $1 AND company_id = $2 AND requested_by = $3 FOR UPDATE', [rid, req.user.company_id, req.user.user_id])).rows[0];
    if (!r || r.entity_type !== 'TENANT' || Number(r.entity_id) !== Number(tenantId) || r.section !== section) return deny;
    if (r.status !== 'APPROVED' || r.used_at || !r.expires_at || new Date(r.expires_at) < new Date()) return { ...deny, error: 'This permission has expired or was already used. Please ask again.' };
    return { ok: true, requestId: rid };
}
async function markRequestUsed(client, requestId) { if (requestId) await client.query("UPDATE edit_requests SET status = 'USED', used_at = NOW() WHERE request_id = $1", [requestId]); }

app.put('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { full_name, nida_passport_no, identity_type, phone_number, end_date, lease_id } = req.body;
    const tenantId = req.params.id;
    if (!full_name || !phone_number || !nida_passport_no) {
        return res.status(400).json({ error: 'Name, phone and ID number are required.' });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const gate = await checkEditPermission(req, client, tenantId, 'TENANT_INFO');
        if (!gate.ok) { await client.query('ROLLBACK'); return res.status(gate.status).json({ error: gate.error, code: gate.code }); }

        const upd = await client.query(
            `UPDATE tenants SET full_name = $1, nida_passport_no = $2, phone_number = $3, identity_type = COALESCE($4, identity_type)
             WHERE tenant_id = $5 AND company_id = $6 RETURNING tenant_id`,
            [String(full_name).trim(), String(nida_passport_no).trim(), String(phone_number).trim(),
             ALLOWED_ID_TYPES.includes(identity_type) ? identity_type : null, tenantId, req.user.company_id]
        );
        if (upd.rows.length === 0) throw new Error('Tenant not found.');

        if (end_date && lease_id) {
            const l = (await client.query(
                `SELECT lease_id, to_char(start_date, 'YYYY-MM-DD') AS start_str, to_char(end_date, 'YYYY-MM-DD') AS end_str
                 FROM leases WHERE lease_id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
                [lease_id, tenantId, req.user.company_id]
            )).rows[0];
            if (!l) throw new Error('Lease not found.');
            if (end_date < l.start_str) throw new Error('End date cannot be before the start date.');
            if (end_date !== l.end_str) {
                const days = Math.max(0, Math.round((new Date(end_date) - new Date(l.start_str)) / 86400000));
                await client.query('UPDATE leases SET end_date = $1, duration_days = $2 WHERE lease_id = $3 AND company_id = $4', [end_date, days, lease_id, req.user.company_id]);
                await logLeaseEvent(client, req.user.company_id, lease_id, tenantId, 'EDITED', `Lease end date changed from ${l.end_str} to ${end_date}`, null, req.user.user_id);
            }
        }
        await markRequestUsed(client, gate.requestId);
        await createAuditLog(client, req.user.company_id, req.user.user_id, 'Updated Tenant Details', 'TENANTS', req.ip, { tenant_id: tenantId, via_request: gate.requestId || null });
        await client.query('COMMIT');
        res.json({ message: 'Tenant updated successfully' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// correct a saved contract: price, discount, periods, dates (the invoice and balances follow)
app.put('/api/leases/:id/correct', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const cId = req.user.company_id, b = req.body || {};
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const lease = (await client.query(
            `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_str, to_char(end_date, 'YYYY-MM-DD') AS end_str FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE`,
            [req.params.id, cId])).rows[0];
        if (!lease) throw new Error('Contract not found.');
        const gate = await checkEditPermission(req, client, lease.tenant_id, 'LEASE_TERMS');
        if (!gate.ok) { await client.query('ROLLBACK'); return res.status(gate.status).json({ error: gate.error, code: gate.code }); }

        const calc = calculatePayment({
            rent_price: b.rent_price !== undefined && b.rent_price !== '' ? b.rent_price : lease.rent_price,
            number_of_periods: b.number_of_periods !== undefined && b.number_of_periods !== '' ? b.number_of_periods : lease.number_of_periods,
            discount: b.discount !== undefined && b.discount !== '' ? b.discount : lease.discount, paid_amount: 0
        });
        if (calc.error) throw new Error(calc.error);
        const start = b.start_date || lease.start_str, end = b.end_date || lease.end_str;
        if (!isDateStr(start) || !isDateStr(end)) throw new Error('Please enter valid dates.');
        if (end < start) throw new Error('End date cannot be before the start date.');
        const days = Math.max(0, Math.round((new Date(end) - new Date(start)) / 86400000));

        const rentInv = (await client.query("SELECT invoice_id FROM invoices WHERE lease_id = $1 AND company_id = $2 AND invoice_type = 'RENT' AND COALESCE(lease_charge, true) = true ORDER BY invoice_id ASC LIMIT 1", [lease.lease_id, cId])).rows[0];
        let others = { due: 0, sub: 0, disc: 0 };
        if (rentInv) {
            const o = (await client.query("SELECT COALESCE(SUM(amount_due),0) AS due, COALESCE(SUM(subtotal),0) AS sub, COALESCE(SUM(discount),0) AS disc FROM invoices WHERE lease_id = $1 AND company_id = $2 AND COALESCE(lease_charge, true) = true AND invoice_id <> $3", [lease.lease_id, cId, rentInv.invoice_id])).rows[0];
            others = { due: parseFloat(o.due), sub: parseFloat(o.sub), disc: parseFloat(o.disc) };
            const desc = `Rent: ${calc.periods} ${periodWord(lease.rent_period || 'Month', calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(start)} - ${niceDate(end)})`;
            await client.query('UPDATE invoices SET subtotal = $1, discount = $2, amount_due = $3, description = $4, period_start = $5, period_end = $6, issue_date = $5, due_date = $5 WHERE invoice_id = $7 AND company_id = $8',
                [calc.totalRent, calc.discount, calc.totalToPay, desc, start, end, rentInv.invoice_id, cId]);
            const paid = parseFloat((await client.query('SELECT COALESCE(SUM(amount_paid),0) AS s FROM payments WHERE invoice_id = $1', [rentInv.invoice_id])).rows[0].s);
            await client.query('UPDATE invoices SET status = $1 WHERE invoice_id = $2', [paid >= calc.totalToPay ? 'PAID' : 'PENDING', rentInv.invoice_id]);
        }
        const toPay = calc.totalToPay + others.due;
        await client.query(
            `UPDATE leases SET start_date = $1, end_date = $2, duration_days = $3, rent_price = $4, number_of_periods = $5,
                    total_rent = $6, discount = $7, total_to_pay = $8, agreed_rent = $8 WHERE lease_id = $9 AND company_id = $10`,
            [start, end, days, calc.price, calc.periods, calc.totalRent + others.sub, calc.discount + others.disc, toPay, lease.lease_id, cId]);
        await syncLeasePayment(client, lease.lease_id, cId);
        await logLeaseEvent(client, cId, lease.lease_id, lease.tenant_id, 'EDITED',
            `Contract corrected: rent ${fmtMoney(lease.rent_price)} x ${lease.number_of_periods} -> ${fmtMoney(calc.price)} x ${calc.periods}, discount ${fmtMoney(calc.discount)}, ${lease.start_str} to ${lease.end_str} -> ${start} to ${end}`,
            toPay, req.user.user_id);
        await markRequestUsed(client, gate.requestId);
        await createAuditLog(client, cId, req.user.user_id, 'Corrected contract terms', 'TENANTS', req.ip, { lease_id: lease.lease_id, via_request: gate.requestId || null });
        await client.query('COMMIT');
        res.json({ message: 'Contract updated. The invoice and the balance were updated too.' });
    } catch (err) {
        if (client) { try { await client.query('ROLLBACK'); } catch (e) { } }
        res.status(400).json({ error: err.message });
    } finally { if (client) client.release(); }
});

// ---- requests for permission to edit ----
app.post('/api/edit-requests', authenticateToken, allowRoles('PROPERTY_MANAGER', 'ACCOUNTANT'), wrapAsync(async (req, res) => {
    const cId = req.user.company_id, b = req.body || {};
    const tenantId = parseInt(b.tenant_id), section = String(b.section || '');
    if (!EDIT_SECTIONS[section]) return res.status(400).json({ error: 'Please choose what you want to edit.' });
    const reason = String(b.reason || '').trim().slice(0, 500);
    if (reason.length < 3) return res.status(400).json({ error: 'Please write what was wrong (the reason).' });
    const t = (await pool.query(
        `SELECT t.full_name, (SELECT COALESCE(p.property_name, p.title) || ' (' || u.unit_number || ')' FROM leases l JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                              WHERE l.tenant_id = t.tenant_id ORDER BY (l.lease_state = 'CURRENT') DESC, l.lease_id DESC LIMIT 1) AS place
         FROM tenants t WHERE t.tenant_id = $1 AND t.company_id = $2`, [tenantId, cId])).rows[0];
    if (!t) return res.status(404).json({ error: 'Tenant not found.' });
    const dup = (await pool.query("SELECT request_id FROM edit_requests WHERE company_id = $1 AND entity_type = 'TENANT' AND entity_id = $2 AND section = $3 AND requested_by = $4 AND status = 'PENDING'", [cId, tenantId, section, req.user.user_id])).rows[0];
    if (dup) return res.status(400).json({ error: 'You already asked for this. Wait for the owner/admin to answer.' });
    const label = (t.full_name + (t.place ? ' · ' + t.place : '')).slice(0, 200);
    const r = await pool.query("INSERT INTO edit_requests (company_id, entity_type, entity_id, entity_label, section, reason, requested_by) VALUES ($1, 'TENANT', $2, $3, $4, $5, $6) RETURNING request_id", [cId, tenantId, label, section, reason, req.user.user_id]);
    await createAuditLog(pool, cId, req.user.user_id, 'Asked permission to edit', 'TENANTS', req.ip, { tenant_id: tenantId, section });
    res.status(201).json({ message: 'Request sent. The owner/admin will see it.', request_id: r.rows[0].request_id });
}));

app.get('/api/edit-requests', authenticateToken, allowRoles('COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), wrapAsync(async (req, res) => {
    const isAdmin = req.user.role === 'COMPANY_ADMIN';
    const params = [req.user.company_id]; let where = 'e.company_id = $1';
    if (!isAdmin) { params.push(req.user.user_id); where += ' AND e.requested_by = $2'; }
    const rows = (await pool.query(
        `SELECT e.*, u.full_name AS requested_by_name, d.full_name AS decided_by_name,
                (e.status = 'APPROVED' AND e.used_at IS NULL AND e.expires_at > NOW()) AS usable
         FROM edit_requests e LEFT JOIN users u ON e.requested_by = u.user_id LEFT JOIN users d ON e.decided_by = d.user_id
         WHERE ${where} ORDER BY (e.status = 'PENDING') DESC, e.created_at DESC LIMIT 200`, params)).rows;
    res.json({ requests: rows.map(r => ({ ...r, section_label: EDIT_SECTIONS[r.section] || r.section })) });
}));

app.get('/api/edit-requests/summary', authenticateToken, wrapAsync(async (req, res) => {
    const cId = req.user.company_id;
    if (req.user.role === 'COMPANY_ADMIN') {
        const r = (await pool.query("SELECT COUNT(*) AS n FROM edit_requests WHERE company_id = $1 AND status = 'PENDING'", [cId])).rows[0];
        return res.json({ count: parseInt(r.n) });
    }
    if (['PROPERTY_MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
        const r = (await pool.query("SELECT COUNT(*) AS n FROM edit_requests WHERE company_id = $1 AND requested_by = $2 AND status = 'APPROVED' AND used_at IS NULL AND expires_at > NOW()", [cId, req.user.user_id])).rows[0];
        return res.json({ count: parseInt(r.n) });
    }
    res.json({ count: 0 });
}));

app.put('/api/edit-requests/:id/decision', authenticateToken, allowRoles('COMPANY_ADMIN'), wrapAsync(async (req, res) => {
    const b = req.body || {}; const approve = b.approve === true || b.approve === 'true';
    const r = (await pool.query("SELECT * FROM edit_requests WHERE request_id = $1 AND company_id = $2", [req.params.id, req.user.company_id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (r.status !== 'PENDING') return res.status(400).json({ error: 'This request was already answered.' });
    await pool.query(
        `UPDATE edit_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3, expires_at = ${approve ? "NOW() + interval '24 hours'" : 'NULL'} WHERE request_id = $4`,
        [approve ? 'APPROVED' : 'REJECTED', req.user.user_id, String(b.note || '').slice(0, 300) || null, r.request_id]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, approve ? 'Allowed an edit' : 'Refused an edit', 'TENANTS', req.ip, { request_id: r.request_id });
    res.json({ message: approve ? 'Allowed. The staff member can edit for the next 24 hours (one time).' : 'Refused.' });
}));

app.put('/api/edit-requests/:id/cancel', authenticateToken, allowRoles('PROPERTY_MANAGER', 'ACCOUNTANT'), wrapAsync(async (req, res) => {
    const r = await pool.query("UPDATE edit_requests SET status = 'CANCELLED' WHERE request_id = $1 AND company_id = $2 AND requested_by = $3 AND status IN ('PENDING','APPROVED') RETURNING request_id", [req.params.id, req.user.company_id, req.user.user_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Request not found.' });
    res.json({ message: 'Cancelled.' });
}));

// RENEW CONTRACT: a NEW lease record for the same tenant and unit
app.post('/api/leases/:id/renew', authenticateToken, allowRoles(...LEASE_MANAGERS), async (req, res) => {
    const { start_date, end_date, rent_price, number_of_periods, discount, paid_amount } = req.body;
    const rent_period = req.body.rent_period || 'Month';
    const companyId = req.user.company_id;

    if (!start_date) return res.status(400).json({ error: 'New lease start date is required.' });
    if (!ALLOWED_RENT_PERIODS.includes(rent_period)) return res.status(400).json({ error: 'Invalid rent period.' });
    if (end_date && end_date < start_date) return res.status(400).json({ error: 'End date cannot be before the start date.' });

    const calc = calculatePayment({ rent_price, number_of_periods, discount, paid_amount });
    if (calc.error) return res.status(400).json({ error: calc.error });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const old = (await client.query('SELECT * FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId])).rows[0];
        if (!old) throw new Error('Lease not found.');
        if (old.lease_state !== 'CURRENT') throw new Error('Only a current lease can be renewed.');

        const newEnd = end_date || new Date(new Date(start_date).setFullYear(new Date(start_date).getFullYear() + 1)).toISOString().split('T')[0];
        const durationDays = Math.max(0, Math.round((new Date(newEnd) - new Date(start_date)) / 86400000));

        await client.query("UPDATE leases SET lease_state = 'RENEWED', ended_at = NOW(), ended_reason = 'Renewed' WHERE lease_id = $1 AND company_id = $2", [old.lease_id, companyId]);
        await setLeaseStatus(client, old.lease_id, companyId, 'EXPIRED');

        const leaseRes = await client.query(
            `INSERT INTO leases
             (company_id, unit_id, tenant_id, property_id, start_date, end_date, duration_days, agreed_rent, amount_paid, amount_due, payment_cycle, status,
              rent_price, rent_period, number_of_periods, total_rent, discount, total_to_pay, payment_status, previous_lease_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
            [
                companyId, old.unit_id, old.tenant_id, old.property_id, start_date, newEnd, durationDays, calc.totalToPay, calc.paid, calc.amountDue, 'MONTHLY', 'ACTIVE',
                calc.price, rent_period, calc.periods, calc.totalRent, calc.discount, calc.totalToPay, calc.status, old.lease_id
            ]
        );
        const lease = leaseRes.rows[0];
        if (old.currency && old.currency !== 'TZS') await client.query('UPDATE leases SET currency = $1 WHERE lease_id = $2', [old.currency, lease.lease_id]);

        const invoice = await createInvoice(client, {
            companyId, leaseId: lease.lease_id, type: 'RENT', subtotal: calc.totalRent, discount: calc.discount,
            description: `Rent (renewal): ${calc.periods} ${periodWord(rent_period, calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(start_date)} - ${niceDate(newEnd)})`,
            issueDate: start_date <= todayStr() ? start_date : todayStr(), dueDate: start_date, periodStart: start_date, periodEnd: newEnd, leaseCharge: true, userId: req.user.user_id,
            status: calc.amountDue === 0 ? 'PAID' : 'PENDING'
        });

        if (calc.paid > 0) {
            await addPayment(client, {
                companyId, invoiceId: invoice.invoice_id, amount: calc.paid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                reference: req.body.payment_reference, date: todayStr(), userId: req.user.user_id
            });
        }

        await logLeaseEvent(client, companyId, lease.lease_id, old.tenant_id, 'RENEWED',
            `Contract renewed: ${start_date} to ${newEnd} (${calc.periods} ${rent_period}${calc.periods === 1 ? '' : 's'})`, calc.totalToPay, req.user.user_id);
        await createAuditLog(client, companyId, req.user.user_id, 'Renewed Lease', 'LEASES', req.ip, { old_lease_id: old.lease_id, new_lease_id: lease.lease_id });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Contract renewed.', lease, invoice });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// EXTEND STAY: same lease, later end date, extra charge as its own invoice
app.post('/api/leases/:id/extend', authenticateToken, allowRoles(...LEASE_MANAGERS), async (req, res) => {
    const { new_end_date, extra_periods, rent_price, discount, paid_amount } = req.body;
    const companyId = req.user.company_id;
    if (!new_end_date) return res.status(400).json({ error: 'New end date is required.' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const lease = (await client.query(
            `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_str, to_char(end_date, 'YYYY-MM-DD') AS end_str
             FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE`,
            [req.params.id, companyId]
        )).rows[0];
        if (!lease) throw new Error('Lease not found.');
        if (lease.lease_state !== 'CURRENT') throw new Error('Only a current lease can be extended.');
        if (new_end_date <= lease.end_str) throw new Error(`New end date must be after the current end date (${lease.end_str}).`);

        const period = lease.rent_period || 'Month';
        const calc = calculatePayment({
            rent_price: rent_price !== undefined && rent_price !== '' ? rent_price : lease.rent_price,
            number_of_periods: extra_periods, discount, paid_amount
        });
        if (calc.error) throw new Error(calc.error);

        const oldToPay = parseFloat(lease.total_to_pay ?? lease.agreed_rent ?? 0);
        const newToPay = oldToPay + calc.totalToPay;
        const newPaid = parseFloat(lease.amount_paid || 0) + calc.paid;
        const newDue = Math.max(0, Math.round((newToPay - newPaid) * 100) / 100);
        const durationDays = Math.max(0, Math.round((new Date(new_end_date) - new Date(lease.start_str)) / 86400000));

        await client.query(
            `UPDATE leases SET end_date = $1, duration_days = $2,
                number_of_periods = COALESCE(number_of_periods, 0) + $3,
                total_rent = COALESCE(total_rent, 0) + $4,
                discount = COALESCE(discount, 0) + $5,
                total_to_pay = $6, agreed_rent = $6,
                amount_paid = $7, amount_due = $8, payment_status = $9
             WHERE lease_id = $10 AND company_id = $11`,
            [new_end_date, durationDays, calc.periods, calc.totalRent, calc.discount, newToPay, newPaid, newDue, payStatusOf(newToPay, newPaid), lease.lease_id, companyId]
        );

        const invoice = await createInvoice(client, {
            companyId, leaseId: lease.lease_id, type: 'EXTENSION', subtotal: calc.totalRent, discount: calc.discount,
            description: `Extra stay: ${calc.periods} ${periodWord(period, calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(lease.end_str)} - ${niceDate(new_end_date)})`,
            issueDate: todayStr(), dueDate: todayStr(), periodStart: lease.end_str, periodEnd: new_end_date, leaseCharge: true, userId: req.user.user_id,
            status: calc.amountDue === 0 ? 'PAID' : 'PENDING'
        });

        if (calc.paid > 0) {
            await addPayment(client, {
                companyId, invoiceId: invoice.invoice_id, amount: calc.paid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                reference: req.body.payment_reference, date: todayStr(), userId: req.user.user_id
            });
        }

        await logLeaseEvent(client, companyId, lease.lease_id, lease.tenant_id, 'EXTENDED',
            `Stay extended from ${lease.end_str} to ${new_end_date} (+${calc.periods} ${period}${calc.periods === 1 ? '' : 's'})`, calc.totalToPay, req.user.user_id);
        await createAuditLog(client, companyId, req.user.user_id, 'Extended Lease', 'LEASES', req.ip, { lease_id: lease.lease_id, new_end_date });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Stay extended.', invoice });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// MOVE OUT: ends the lease, frees the unit, keeps the history and any unpaid balance
app.post('/api/leases/:id/end', authenticateToken, allowRoles(...LEASE_MANAGERS), async (req, res) => {
    const companyId = req.user.company_id;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const lease = (await client.query('SELECT * FROM leases WHERE lease_id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId])).rows[0];
        if (!lease) throw new Error('Lease not found.');
        if (lease.lease_state !== 'CURRENT') throw new Error('This lease has already ended.');

        await client.query(
            "UPDATE leases SET lease_state = 'ENDED', ended_at = NOW(), ended_reason = $1 WHERE lease_id = $2 AND company_id = $3",
            [String(req.body.reason || 'Moved out').slice(0, 200), lease.lease_id, companyId]
        );
        await client.query("UPDATE units SET status = 'VACANT' WHERE unit_id = $1 AND company_id = $2", [lease.unit_id, companyId]);
        await setLeaseStatus(client, lease.lease_id, companyId, 'TERMINATED');
        await client.query(
            `UPDATE tenants SET is_active = EXISTS (SELECT 1 FROM leases WHERE tenant_id = $1 AND company_id = $2 AND lease_state = 'CURRENT')
             WHERE tenant_id = $1 AND company_id = $2`,
            [lease.tenant_id, companyId]
        );

        const owed = (await client.query(
            `SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0) AS owed
             FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id WHERE l.tenant_id = $1 AND inv.company_id = $2`,
            [lease.tenant_id, companyId]
        )).rows[0].owed;

        await logLeaseEvent(client, companyId, lease.lease_id, lease.tenant_id, 'MOVED_OUT', `Moved out. Unpaid balance: ${parseFloat(owed).toLocaleString('en-US')}`, parseFloat(owed), req.user.user_id);
        await createAuditLog(client, companyId, req.user.user_id, 'Ended Lease (Move Out)', 'LEASES', req.ip, { lease_id: lease.lease_id });
        await client.query('COMMIT');
        res.json({ message: 'Tenant moved out. The unit is now vacant.', balance_owed: parseFloat(owed) });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// DELETE a tenant that was entered by mistake (only if no payment was ever recorded)
// DASHBOARD METRICS
app.get('/api/dashboard/metrics', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    const cId = req.user.company_id;
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties WHERE company_id = $1', [cId]);
        const totalUnits = await pool.query('SELECT COUNT(*) FROM units WHERE company_id = $1', [cId]);
        const occupiedUnits = await pool.query("SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'OCCUPIED'", [cId]);
        const vacantUnits = await pool.query("SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'VACANT'", [cId]);
        const activeTenants = await pool.query("SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE company_id = $1 AND lease_state = 'CURRENT'", [cId]);

        const unitsTotal = parseInt(totalUnits.rows[0]?.count || 0);
        const unitsOccupied = parseInt(occupiedUnits.rows[0]?.count || 0);

        res.json({
            totalProperties: parseInt(totalProperties.rows[0]?.count || 0),
            totalUnits: unitsTotal,
            occupiedUnits: unitsOccupied,
            vacantUnits: parseInt(vacantUnits.rows[0]?.count || 0),
            occupancyRate: unitsTotal > 0 ? Math.round((unitsOccupied / unitsTotal) * 100) : 0,
            activeTenants: parseInt(activeTenants.rows[0]?.count || 0)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// REGISTRATION (company + staff)
// ============================================================
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Too many registrations. Please try again later.' }
});

app.post('/api/auth/register-company', registerLimiter, async (req, res) => {
    const { company_name, admin_full_name, email, phone_number, password } = req.body;
    if (!company_name || !admin_full_name || !email || !phone_number || !password) {
        return res.status(400).json({ error: 'Please fill in all required fields.' });
    }
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    let logo;
    try { logo = cleanLogo(req.body.logo_data); } catch (e) { return res.status(400).json({ error: e.message }); }

    const cleanEmail = String(email).trim().toLowerCase();
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const exists = await client.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
        if (exists.rows.length > 0) throw new Error('This email is already registered.');

        const comp = await client.query(
            "INSERT INTO companies (company_name, subscription_plan, plan, access_status, billing_type) VALUES ($1, 'BASIC', 'STANDARD', 'PENDING', NULL) RETURNING company_id",
            [String(company_name).trim()]
        );
        const companyId = comp.rows[0].company_id;
        if (logo) await client.query('UPDATE companies SET logo_data = $1 WHERE company_id = $2', [logo, companyId]);

        const hashed = await bcrypt.hash(String(password), 10);
        await client.query(
            'INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [companyId, String(admin_full_name).trim(), cleanEmail, hashed, phone_number, 'COMPANY_ADMIN', true, true]
        );

        await createAuditLog(client, companyId, null, 'Company Registered', 'AUTH', req.ip, { email: cleanEmail });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Company registered. Access starts after your payment is confirmed.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/auth/register-staff', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), async (req, res) => {
    const { full_name, email, password, role } = req.body;
    const allowed = ['PROPERTY_MANAGER', 'ACCOUNTANT', 'MAINTENANCE_MANAGER', 'VIEWER'];
    if (!full_name || !email || !password) return res.status(400).json({ error: 'Please fill in all required fields.' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    const staffLimit = await checkLimit(req.user, 'max_staff', "SELECT COUNT(*) FROM users WHERE company_id = $1 AND role <> 'COMPANY_ADMIN'", 'staff members');
    if (staffLimit) return res.status(403).json({ error: staffLimit, code: 'LIMIT_REACHED' });

    const cleanEmail = String(email).trim().toLowerCase();
    try {
        const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'This email is already registered.' });

        const hashed = await bcrypt.hash(String(password), 10);
        await pool.query(
            'INSERT INTO users (company_id, full_name, email, password_hash, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [req.user.company_id, String(full_name).trim(), cleanEmail, hashed, role, true, false]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Registered staff (${role})`, 'USERS', req.ip, { email: cleanEmail });
        res.status(201).json({ message: 'Staff registered successfully.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/staff', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT user_id, full_name, email, role, is_active FROM users WHERE company_id = $1 ORDER BY full_name ASC',
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// UNITS & LEASES (selectors)
// ============================================================
app.get('/api/units', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.*, COALESCE(p.property_name, p.title) AS property_name
             FROM units u JOIN properties p ON u.property_id = p.property_id
             WHERE u.company_id = $1 ORDER BY p.property_id, u.unit_number`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// PROPERTIES PAGE: every property with its units, tenants and service-charge status
// ============================================================
function serviceStatusOf(u) {
    if (u.status !== 'OCCUPIED') return 'VACANT';
    if (u.service_inclusive) return 'INCLUSIVE';
    if (!(parseFloat(u.service_charge) > 0)) return 'NONE';
    if (u.service_amount === null || u.service_amount === undefined) return 'NOT_BILLED';
    const bal = parseFloat(u.service_balance), amt = parseFloat(u.service_amount);
    if (bal <= 0) return 'PAID';
    return bal < amt ? 'PARTIAL' : 'UNPAID';
}

const UNITS_WITH_TENANT_SQL = `
    SELECT u.unit_id, u.property_id, u.unit_number, u.rent_amount, u.currency, u.status, u.is_furnished,
           COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
           l.lease_id, l.end_date, l.rent_period, t.tenant_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
           sv.invoice_id AS service_invoice_id, sv.amount AS service_amount, sv.balance AS service_balance
    FROM units u
    LEFT JOIN leases l ON l.unit_id = u.unit_id AND l.lease_state = 'CURRENT'
    LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
        SELECT inv.invoice_id, inv.amount_due AS amount,
               inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments py WHERE py.invoice_id = inv.invoice_id), 0) AS balance
        FROM invoices inv
        WHERE inv.lease_id = l.lease_id AND inv.invoice_type = 'SERVICE' AND inv.period_start = date_trunc('month', CURRENT_DATE)::date
        ORDER BY inv.invoice_id DESC LIMIT 1
    ) sv ON true
    WHERE u.company_id = $1`;

app.get('/api/properties/overview', authenticateToken, wrapAsync(async (req, res) => {
    const cId = req.user.company_id;
    const props = (await pool.query(
        `SELECT property_id, COALESCE(property_name, title) AS property_name, address, category, total_units,
                COALESCE(service_charge_label, 'Service charge') AS service_charge_label, created_at
         FROM properties WHERE company_id = $1 ORDER BY created_at DESC, property_id DESC`, [cId]
    )).rows;
    const units = (await pool.query(`${UNITS_WITH_TENANT_SQL} ORDER BY u.property_id, u.unit_id`, [cId])).rows;

    const byProp = {};
    units.forEach(u => {
        u.service_status = serviceStatusOf(u);
        (byProp[u.property_id] = byProp[u.property_id] || []).push(u);
    });
    res.json(props.map(p => {
        const list = byProp[p.property_id] || [];
        const occupied = list.filter(u => u.status === 'OCCUPIED').length;
        return {
            ...p, units: list, units_count: list.length, occupied, vacant: list.filter(u => u.status === 'VACANT').length,
            service_unpaid: list.filter(u => ['UNPAID', 'PARTIAL', 'NOT_BILLED'].includes(u.service_status)).length
        };
    }));
}));

app.put('/api/properties/:id', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
    const { property_name, address, category, service_charge_label } = req.body;
    if (!property_name || !address) return res.status(400).json({ error: 'Property name and address are required.' });
    const r = await pool.query(
        `UPDATE properties SET property_name = $1, title = $1, address = $2, category = COALESCE($3, category),
                service_charge_label = COALESCE($4, service_charge_label)
         WHERE property_id = $5 AND company_id = $6 RETURNING property_id`,
        [String(property_name).trim(), String(address).trim(), category || null, service_charge_label ? String(service_charge_label).slice(0, 60) : null, req.params.id, req.user.company_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Property', 'PROPERTIES', req.ip, { property_id: req.params.id });
    res.json({ message: 'Property updated.' });
}));

app.post('/api/properties/:id/units', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
    const { unit_number, rent_amount, service_charge, service_inclusive } = req.body;
    const count = Math.min(100, Math.max(1, parseInt(req.body.count) || 1));
    const rent = parseFloat(rent_amount);
    if (!unit_number || !(rent >= 0)) return res.status(400).json({ error: 'Unit name and rent amount are required.' });
    const prop = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (prop.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
    const svc = Math.max(0, parseFloat(service_charge) || 0);
    const base = String(unit_number).trim();
    try {
        for (let i = 1; i <= count; i++) {
            await pool.query(
                `INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished, service_charge, service_inclusive)
                 VALUES ($1, $2, $3, $4, 'TSH', 'VACANT', false, $5, $6)`,
                [req.user.company_id, req.params.id, count > 1 ? `${base}-${i}` : base, rent, svc, !!service_inclusive]
            );
        }
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'A unit with this name already exists in this property.' });
        throw err;
    }
    await pool.query('UPDATE properties SET total_units = (SELECT COUNT(*) FROM units WHERE property_id = $1) WHERE property_id = $1', [req.params.id]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added Units', 'UNITS', req.ip, { property_id: req.params.id, base, count });
    res.status(201).json({ message: count > 1 ? `${count} units added.` : 'Unit added.' });
}));

app.put('/api/units/:id', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
    const { unit_number, rent_amount, service_charge, service_inclusive, status } = req.body;
    const rent = parseFloat(rent_amount);
    if (!unit_number || !(rent >= 0)) return res.status(400).json({ error: 'Unit name and rent amount are required.' });
    const unit = (await pool.query('SELECT status FROM units WHERE unit_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0];
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });
    let newStatus = unit.status;
    if (unit.status !== 'OCCUPIED' && ['VACANT', 'UNDER_MAINTENANCE'].includes(status)) newStatus = status;
    try {
        await pool.query(
            `UPDATE units SET unit_number = $1, rent_amount = $2, service_charge = $3, service_inclusive = $4, status = $5
             WHERE unit_id = $6 AND company_id = $7`,
            [String(unit_number).trim(), rent, Math.max(0, parseFloat(service_charge) || 0), !!service_inclusive, newStatus, req.params.id, req.user.company_id]
        );
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'A unit with this name already exists in this property.' });
        throw err;
    }
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Unit', 'UNITS', req.ip, { unit_id: req.params.id });
    res.json({ message: 'Unit updated. New rent applies to new tenants; existing contracts keep their agreed price.' });
}));

// change rent / service charge of many units at once
app.put('/api/properties/:id/bulk-units', authenticateToken, allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
    const { rent_amount, service_charge, service_inclusive, scope } = req.body;
    const sets = [], vals = [];
    if (rent_amount !== undefined && rent_amount !== '' && rent_amount !== null) {
        if (!(parseFloat(rent_amount) >= 0)) return res.status(400).json({ error: 'Invalid rent amount.' });
        vals.push(parseFloat(rent_amount)); sets.push(`rent_amount = $${vals.length}`);
    }
    if (service_charge !== undefined && service_charge !== '' && service_charge !== null) {
        if (!(parseFloat(service_charge) >= 0)) return res.status(400).json({ error: 'Invalid service charge.' });
        vals.push(parseFloat(service_charge)); sets.push(`service_charge = $${vals.length}`);
    }
    if (typeof service_inclusive === 'boolean') { vals.push(service_inclusive); sets.push(`service_inclusive = $${vals.length}`); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change.' });
    vals.push(req.params.id, req.user.company_id);
    const r = await pool.query(
        `UPDATE units SET ${sets.join(', ')} WHERE property_id = $${vals.length - 1} AND company_id = $${vals.length}
         ${scope === 'VACANT' ? "AND status = 'VACANT'" : ''} RETURNING unit_id`, vals
    );
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Bulk edited units', 'UNITS', req.ip, { property_id: req.params.id, count: r.rows.length });
    res.json({ message: `${r.rows.length} unit(s) updated.`, updated: r.rows.length });
}));


// ============================================================
// DELETING (tenants, units, properties) - normal delete keeps history safe,
// "force" (owner/admin + typed confirmation) removes the history too
// ============================================================
async function wipeLeases(client, cId, leaseIds) {
    if (!leaseIds.length) return;
    await client.query('DELETE FROM payments WHERE company_id = $2 AND invoice_id IN (SELECT invoice_id FROM invoices WHERE company_id = $2 AND lease_id = ANY($1::int[]))', [leaseIds, cId]);
    await client.query('DELETE FROM invoices WHERE company_id = $2 AND lease_id = ANY($1::int[])', [leaseIds, cId]);
    try { await client.query('SAVEPOINT wipe_events'); await client.query('DELETE FROM lease_events WHERE company_id = $2 AND lease_id = ANY($1::int[])', [leaseIds, cId]); await client.query('RELEASE SAVEPOINT wipe_events'); }
    catch (e) { await client.query('ROLLBACK TO SAVEPOINT wipe_events'); }
    await client.query('DELETE FROM leases WHERE company_id = $2 AND lease_id = ANY($1::int[])', [leaseIds, cId]);
}
async function dropOrphanTenants(client, cId, tenantIds) {
    if (!tenantIds.length) return;
    await client.query('UPDATE payments SET tenant_id = NULL WHERE tenant_id = ANY($1::int[])', [tenantIds]);
    await client.query('DELETE FROM tenants t WHERE t.company_id = $2 AND t.tenant_id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = t.tenant_id)', [tenantIds, cId]);
}
function wantsForce(req) {
    const b = req.body || {}, q = req.query || {};
    const force = String(b.force || q.force || '') === '1' || b.force === true;
    const confirm = String(b.confirm || q.confirm || '');
    return force && confirm === 'DELETE' && ['COMPANY_ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
}
async function removeTenant(client, cId, userId, ip, tenantId, force) {
    const t = (await client.query('SELECT tenant_id, full_name FROM tenants WHERE tenant_id = $1 AND company_id = $2 FOR UPDATE', [tenantId, cId])).rows[0];
    if (!t) throw new Error('Tenant not found.');
    const pays = (await client.query(
        `SELECT COUNT(*) AS c FROM payments pay JOIN invoices inv ON pay.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
         WHERE l.tenant_id = $1 AND pay.company_id = $2`, [tenantId, cId])).rows[0].c;
    if (parseInt(pays) > 0 && !force) throw new Error(t.full_name + ' has payment records, so it cannot be deleted. Use "Move Out" to keep the history, or delete everything with the history option.');
    await client.query(
        "UPDATE units SET status = 'VACANT' WHERE company_id = $2 AND unit_id IN (SELECT unit_id FROM leases WHERE tenant_id = $1 AND company_id = $2 AND lease_state = 'CURRENT')", [tenantId, cId]);
    const leaseIds = (await client.query('SELECT lease_id FROM leases WHERE tenant_id = $1 AND company_id = $2', [tenantId, cId])).rows.map(r => r.lease_id);
    await wipeLeases(client, cId, leaseIds);
    await client.query('UPDATE payments SET tenant_id = NULL WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM tenants WHERE tenant_id = $1 AND company_id = $2', [tenantId, cId]);
    await createAuditLog(client, cId, userId, force ? 'Deleted Tenant with all history' : 'Deleted Tenant', 'TENANTS', ip, { tenant_id: tenantId, name: t.full_name });
}
async function removeUnit(client, cId, userId, ip, unitId, force) {
    const u = (await client.query('SELECT unit_id, unit_number, property_id, status FROM units WHERE unit_id = $1 AND company_id = $2 FOR UPDATE', [unitId, cId])).rows[0];
    if (!u) throw new Error('Unit not found.');
    const used = (await client.query('SELECT (SELECT COUNT(*) FROM leases WHERE unit_id = $1) AS leases, (SELECT COUNT(*) FROM work_orders WHERE unit_id = $1) AS tickets', [u.unit_id])).rows[0];
    if (!force) {
        if (u.status === 'OCCUPIED') throw new Error('Unit ' + u.unit_number + ' has a tenant. Move the tenant out first, or delete with the history option.');
        if (parseInt(used.leases) > 0 || parseInt(used.tickets) > 0) throw new Error('Unit ' + u.unit_number + ' has history (tenants or tickets), so it cannot be deleted. You can set it to "Under maintenance", or delete with the history option.');
    } else {
        const leaseRows = (await client.query('SELECT lease_id, tenant_id FROM leases WHERE unit_id = $1 AND company_id = $2', [u.unit_id, cId])).rows;
        await wipeLeases(client, cId, leaseRows.map(r => r.lease_id));
        await dropOrphanTenants(client, cId, [...new Set(leaseRows.map(r => r.tenant_id))]);
        await client.query('DELETE FROM work_orders WHERE unit_id = $1 AND company_id = $2', [u.unit_id, cId]);
    }
    await client.query('DELETE FROM units WHERE unit_id = $1 AND company_id = $2', [u.unit_id, cId]);
    await client.query('UPDATE properties SET total_units = (SELECT COUNT(*) FROM units WHERE property_id = $1) WHERE property_id = $1', [u.property_id]);
    await createAuditLog(client, cId, userId, force ? 'Deleted Unit with all history' : 'Deleted Unit', 'UNITS', ip, { unit_id: u.unit_id, unit: u.unit_number });
}
async function removeProperty(client, cId, userId, ip, propertyId, force) {
    const pr = (await client.query('SELECT property_id, COALESCE(property_name, title) AS name FROM properties WHERE property_id = $1 AND company_id = $2 FOR UPDATE', [propertyId, cId])).rows[0];
    if (!pr) throw new Error('Property not found.');
    const used = (await client.query(
        'SELECT (SELECT COUNT(*) FROM leases WHERE property_id = $1 AND company_id = $2) AS leases, (SELECT COUNT(*) FROM work_orders w JOIN units u ON w.unit_id = u.unit_id WHERE u.property_id = $1 AND w.company_id = $2) AS tickets', [propertyId, cId])).rows[0];
    if (!force) {
        if (parseInt(used.leases) > 0) throw new Error(pr.name + ' has tenant history, so it cannot be deleted. Delete with the history option if you really want it gone.');
        if (parseInt(used.tickets) > 0) throw new Error(pr.name + ' has maintenance tickets, so it cannot be deleted. Delete with the history option if you really want it gone.');
    } else {
        const leaseRows = (await client.query('SELECT lease_id, tenant_id FROM leases WHERE property_id = $1 AND company_id = $2', [propertyId, cId])).rows;
        await wipeLeases(client, cId, leaseRows.map(r => r.lease_id));
        await dropOrphanTenants(client, cId, [...new Set(leaseRows.map(r => r.tenant_id))]);
        await client.query('DELETE FROM work_orders WHERE company_id = $2 AND unit_id IN (SELECT unit_id FROM units WHERE property_id = $1)', [propertyId, cId]);
    }
    await client.query('UPDATE expenses SET property_id = NULL WHERE property_id = $1 AND company_id = $2', [propertyId, cId]);
    await client.query('DELETE FROM units WHERE property_id = $1 AND company_id = $2', [propertyId, cId]);
    await client.query('DELETE FROM properties WHERE property_id = $1 AND company_id = $2', [propertyId, cId]);
    await createAuditLog(client, cId, userId, force ? 'Deleted Property with all history' : 'Deleted Property', 'PROPERTIES', ip, { property_id: propertyId, name: pr.name });
}
// runs one delete in its own transaction
async function inTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
    catch (e) { try { await client.query('ROLLBACK'); } catch (x) { } throw e; }
    finally { client.release(); }
}
function makeDeleter(kind, remover, roles) {
    // single delete
    return {
        one: async (req, res) => {
            try {
                await inTx(c => remover(c, req.user.company_id, req.user.user_id, req.ip, parseInt(req.params.id), wantsForce(req)));
                res.json({ message: kind + ' deleted.' });
            } catch (err) { res.status(400).json({ error: err.message }); }
        },
        many: async (req, res) => {
            const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(x => parseInt(x)).filter(x => x > 0).slice(0, 200) : [];
            if (!ids.length) return res.status(400).json({ error: 'Nothing selected.' });
            const force = wantsForce(req); const failed = []; let deleted = 0;
            for (const id of ids) {
                try { await inTx(c => remover(c, req.user.company_id, req.user.user_id, req.ip, id, force)); deleted++; }
                catch (err) { failed.push({ id, error: err.message }); }
            }
            res.json({ message: deleted + ' deleted' + (failed.length ? ', ' + failed.length + ' could not be deleted.' : '.'), deleted, failed });
        }
    };
}
const delTenant = makeDeleter('Tenant', removeTenant), delUnit = makeDeleter('Unit', removeUnit), delProp = makeDeleter('Property', removeProperty);
app.delete('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), delTenant.one);
app.post('/api/tenants/bulk-delete', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), delTenant.many);
app.delete('/api/units/:id', authenticateToken, allowRoles(...R_MANAGE), delUnit.one);
app.post('/api/units/bulk-delete', authenticateToken, allowRoles(...R_MANAGE), delUnit.many);
app.delete('/api/properties/:id', authenticateToken, allowRoles(...R_ADMIN), delProp.one);
app.post('/api/properties/bulk-delete', authenticateToken, allowRoles(...R_ADMIN), delProp.many);

// ============================================================
// SERVICE CHARGES (fixed monthly amount per unit: security, garbage, water pump...)
// ============================================================
function monthRange(ym) {
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return null;
    const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(5, 7));
    if (m < 1 || m > 12) return null;
    const start = `${ym}-01`;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { start, end };
}

async function loadServiceStatus(cId, ym, propertyId) {
    const range = monthRange(ym);
    const params = [cId, range.start];
    let extra = '';
    if (propertyId) { params.push(propertyId); extra = ` AND u.property_id = $${params.length}`; }
    const rows = (await pool.query(
        `SELECT u.unit_id, u.unit_number, u.property_id, COALESCE(p.property_name, p.title) AS property_name,
                COALESCE(u.service_charge, 0) AS service_charge, COALESCE(u.service_inclusive, false) AS service_inclusive,
                l.lease_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
                sv.invoice_id, sv.amount, sv.balance
         FROM units u
         JOIN properties p ON p.property_id = u.property_id
         JOIN leases l ON l.unit_id = u.unit_id AND l.lease_state = 'CURRENT'
         JOIN tenants t ON t.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
             SELECT inv.invoice_id, inv.amount_due AS amount,
                    inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments py WHERE py.invoice_id = inv.invoice_id), 0) AS balance
             FROM invoices inv WHERE inv.lease_id = l.lease_id AND inv.invoice_type = 'SERVICE' AND inv.period_start = $2::date
             ORDER BY inv.invoice_id DESC LIMIT 1
         ) sv ON true
         WHERE u.company_id = $1 AND u.status = 'OCCUPIED' AND COALESCE(u.service_charge, 0) > 0 ${extra}
         ORDER BY property_name, u.unit_number`, params
    )).rows;
    const items = rows.map(r => {
        let status;
        if (r.service_inclusive) status = 'INCLUSIVE';
        else if (r.amount === null) status = 'NOT_BILLED';
        else if (parseFloat(r.balance) <= 0) status = 'PAID';
        else status = parseFloat(r.balance) < parseFloat(r.amount) ? 'PARTIAL' : 'UNPAID';
        return { ...r, status };
    });
    const count = (st) => items.filter(i => i.status === st).length;
    return {
        month: ym,
        summary: {
            units: items.filter(i => i.status !== 'INCLUSIVE').length,
            paid: count('PAID'), partial: count('PARTIAL'), unpaid: count('UNPAID'), not_billed: count('NOT_BILLED'), inclusive: count('INCLUSIVE'),
            not_paid_total: count('PARTIAL') + count('UNPAID') + count('NOT_BILLED')
        },
        items
    };
}

app.get('/api/service-charges/status', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const ym = req.query.month || todayStr().slice(0, 7);
    if (!monthRange(ym)) return res.status(400).json({ error: 'Invalid month.' });
    res.json(await loadServiceStatus(req.user.company_id, ym, req.query.property_id));
}));

// creates the service-charge invoice of a month for every occupied unit that has one (never twice)
app.post('/api/service-charges/generate', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
    const ym = req.body.month || todayStr().slice(0, 7);
    const range = monthRange(ym);
    if (!range) return res.status(400).json({ error: 'Invalid month.' });
    const cId = req.user.company_id;
    const due = isDateStr(req.body.due_date) ? req.body.due_date : new Date(Date.UTC(parseInt(ym.slice(0, 4)), parseInt(ym.slice(5, 7)) - 1, 7)).toISOString().slice(0, 10);

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const params = [cId, range.start, range.end];
        let extra = '';
        if (req.body.property_id) { params.push(req.body.property_id); extra = ` AND u.property_id = $${params.length}`; }
        const leases = (await client.query(
            `SELECT l.lease_id, u.service_charge, COALESCE(p.service_charge_label, 'Service charge') AS label
             FROM leases l JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
             WHERE l.company_id = $1 AND l.lease_state = 'CURRENT' AND COALESCE(u.service_charge, 0) > 0 AND COALESCE(u.service_inclusive, false) = false
               AND l.start_date <= $3::date AND l.end_date >= $2::date ${extra}
               AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id = l.lease_id AND i.invoice_type = 'SERVICE' AND i.period_start = $2::date)`, params
        )).rows;
        for (const l of leases) {
            await createInvoice(client, {
                companyId: cId, leaseId: l.lease_id, type: 'SERVICE', subtotal: l.service_charge, discount: 0,
                description: `${l.label} - ${monthLabel(ym)}`, dueDate: due, periodStart: range.start, periodEnd: range.end,
                leaseCharge: false, userId: req.user.user_id
            });
        }
        await createAuditLog(client, cId, req.user.user_id, 'Generated service charges', 'INVOICES', req.ip, { month: ym, created: leases.length });
        await client.query('COMMIT');
        res.status(201).json({ message: leases.length ? `${leases.length} service charge invoice(s) created for ${monthLabel(ym)}.` : `All service charges for ${monthLabel(ym)} were already created.`, created: leases.length });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { if (client) client.release(); }
}));


app.get('/api/leases', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT l.*, t.full_name AS tenant_name, u.unit_number
             FROM leases l JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id
             WHERE l.company_id = $1 ORDER BY l.lease_id DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// INVOICES, PAYMENTS, RECEIPTS
// balance = invoice total - sum of its payments
// ============================================================
const INVOICE_BALANCES_SQL = `
    SELECT COALESCE(inv.currency, 'TZS') AS currency, inv.invoice_id, inv.invoice_number, inv.status, inv.due_date, inv.amount_due, inv.invoice_type, inv.description,
           inv.issue_date, COALESCE(inv.discount, 0) AS discount, COALESCE(inv.lease_charge, true) AS lease_charge,
           COALESCE(pay.paid, 0) AS paid,
           inv.amount_due - COALESCE(pay.paid, 0) AS balance,
           (inv.due_date::date - CURRENT_DATE) AS days_left,
           l.lease_id, t.tenant_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
           u.unit_id, u.unit_number, p.property_id, COALESCE(p.property_name, p.title) AS property_name
    FROM invoices inv
    JOIN leases l ON inv.lease_id = l.lease_id
    JOIN tenants t ON l.tenant_id = t.tenant_id
    JOIN units u ON l.unit_id = u.unit_id
    JOIN properties p ON u.property_id = p.property_id
    LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay
           ON pay.invoice_id = inv.invoice_id
    WHERE inv.company_id = $1`;

app.get('/api/invoices', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const result = await pool.query(`${INVOICE_BALANCES_SQL} ORDER BY inv.invoice_id DESC LIMIT 1000`, [req.user.company_id]);
    res.json(result.rows);
}));

app.post('/api/invoices/issue', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
    const { lease_id, invoice_type, description, amount, discount, issue_date, due_date, period_start, period_end, notes } = req.body;
    const subtotal = parseFloat(amount);
    const disc = parseFloat(discount || 0);
    const type = MANUAL_INVOICE_TYPES.includes(invoice_type) ? invoice_type : 'OTHER';
    if (!lease_id || !(subtotal > 0) || !isDateStr(due_date)) return res.status(400).json({ error: 'Tenant, amount and due date are required.' });
    if (isNaN(disc) || disc < 0 || disc > subtotal) return res.status(400).json({ error: 'Discount must be between 0 and the amount.' });
    if (type === 'OTHER' && !String(description || '').trim()) return res.status(400).json({ error: 'Please describe what this invoice is for.' });
    if (isDateStr(issue_date) && isDateStr(due_date) && due_date < issue_date) return res.status(400).json({ error: 'Due date cannot be before the issue date.' });

    const lease = await pool.query('SELECT 1 FROM leases WHERE lease_id = $1 AND company_id = $2', [lease_id, req.user.company_id]);
    if (lease.rows.length === 0) return res.status(404).json({ error: 'Tenant contract not found.' });

    const labels = { RENT: 'Rent', SERVICE: 'Service charge', DEPOSIT: 'Deposit', UTILITY: 'Utility bill', PENALTY: 'Penalty / late fee', REPAIR: 'Repair / damage', OTHER: 'Other charge' };
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const inv = await createInvoice(client, {
            companyId: req.user.company_id, leaseId: lease_id, type, subtotal, discount: disc,
            description: String(description || '').trim() || labels[type],
            issueDate: issue_date, dueDate: due_date, periodStart: period_start, periodEnd: period_end,
            notes: String(notes || '').trim() || null, leaseCharge: false, userId: req.user.user_id
        });
        await createAuditLog(client, req.user.company_id, req.user.user_id, 'Issued Invoice', 'INVOICES', req.ip, { invoice_id: inv.invoice_id, type });
        await client.query('COMMIT');
        res.status(201).json(inv);
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { if (client) client.release(); }
}));

// delete an invoice only when nobody paid it and it is not part of the tenant's rent contract
app.delete('/api/invoices/:id', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
    const inv = (await pool.query('SELECT invoice_id, COALESCE(lease_charge, true) AS lease_charge FROM invoices WHERE invoice_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    if (inv.lease_charge) return res.status(400).json({ error: 'This invoice belongs to the rent contract. Edit or end the contract instead.' });
    const pays = (await pool.query('SELECT COUNT(*) AS c FROM payments WHERE invoice_id = $1', [inv.invoice_id])).rows[0].c;
    if (parseInt(pays) > 0) return res.status(400).json({ error: 'This invoice already has payments, so it cannot be deleted.' });
    await pool.query('DELETE FROM invoices WHERE invoice_id = $1 AND company_id = $2', [inv.invoice_id, req.user.company_id]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Invoice', 'INVOICES', req.ip, { invoice_id: inv.invoice_id });
    res.json({ message: 'Invoice deleted.' });
}));

// RECORD A PAYMENT AGAINST AN INVOICE (updates invoice, lease balance and status, creates the receipt)
app.post('/api/payments/record', authenticateToken, allowRoles(...R_MONEY), async (req, res) => {
    const { invoice_id, amount, payment_method, payment_date, reference, notes } = req.body;
    let amt = Math.round(parseFloat(amount) * 100) / 100;
    if (!invoice_id || !(amt > 0)) return res.status(400).json({ error: 'Invoice and a valid amount are required.' });
    // The customer may pay in the other currency: amount is then what was handed over, and the rate (TSh per 1 USD) turns it into the invoice currency
    const recvCur = ['TZS', 'USD'].includes(String(req.body.received_currency || '').toUpperCase()) ? String(req.body.received_currency).toUpperCase() : null;
    const rate = parseFloat(req.body.exchange_rate);
    let recvAmount = amt;
    if (payment_date && (!isDateStr(payment_date) || payment_date > todayStr())) return res.status(400).json({ error: 'Payment date cannot be in the future.' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const companyId = req.user.company_id;

        const invRes = await client.query(
            'SELECT invoice_id, lease_id, amount_due, COALESCE(lease_charge, true) AS lease_charge FROM invoices WHERE invoice_id = $1 AND company_id = $2 FOR UPDATE',
            [invoice_id, companyId]
        );
        if (invRes.rows.length === 0) throw new Error('Invoice not found.');
        const inv = invRes.rows[0];
        const invCurRow = await client.query('SELECT COALESCE(currency, \'TZS\') AS currency FROM invoices WHERE invoice_id = $1', [invoice_id]);
        const invCur = invCurRow.rows[0].currency;
        if (recvCur && recvCur !== invCur) {
            if (!(rate > 0)) throw new Error('Please enter the exchange rate (TSh for 1 USD).');
            amt = invCur === 'USD' ? Math.round(recvAmount / rate * 100) / 100 : Math.round(recvAmount * rate);
            if (!(amt > 0)) throw new Error('The converted amount is too small.');
        }

        const payment = await addPayment(client, {
            companyId, invoiceId: invoice_id, amount: amt, method: payment_method, methodDetail: payment_method,
            reference, notes: String(notes || '').trim() || null, date: payment_date, userId: req.user.user_id, accountId: req.body.account_id,
            receivedCurrency: recvCur, receivedAmount: recvAmount, rate
        });

        const sum = await client.query('SELECT COALESCE(SUM(amount_paid), 0) AS paid FROM payments WHERE invoice_id = $1 AND company_id = $2', [invoice_id, companyId]);
        const paidOnInvoice = parseFloat(sum.rows[0].paid);
        const invStatus = paidOnInvoice >= parseFloat(inv.amount_due) ? 'PAID' : 'PENDING';
        await client.query('UPDATE invoices SET status = $1 WHERE invoice_id = $2 AND company_id = $3', [invStatus, invoice_id, companyId]);

        // only the rent contract invoices change the contract totals (service charges, penalties etc. do not)
        let leaseStatus = null;
        if (inv.lease_charge) leaseStatus = await syncLeasePayment(client, inv.lease_id, companyId);

        await createAuditLog(client, companyId, req.user.user_id, 'Recorded Payment', 'PAYMENTS', req.ip, { invoice_id, amount: amt, receipt: payment.receipt_number });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Payment recorded.', credited: amt, credited_currency: invCur, invoice_status: invStatus, payment_status: leaseStatus, payment_id: payment.payment_id, receipt_number: payment.receipt_number });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// list of payments (receipts)
app.get('/api/payments', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const params = [req.user.company_id];
    let where = '';
    if (isDateStr(req.query.from)) { params.push(req.query.from); where += ` AND py.payment_date::date >= $${params.length}`; }
    if (isDateStr(req.query.to)) { params.push(req.query.to); where += ` AND py.payment_date::date <= $${params.length}`; }
    const rows = (await pool.query(
        `SELECT py.payment_id, py.receipt_number, py.amount_paid, py.payment_date, py.payment_method, py.method_detail, py.reference_no, COALESCE(py.currency, 'TZS') AS currency, py.account_id,
                inv.invoice_id, inv.invoice_number, inv.invoice_type, t.full_name AS tenant_name, u.unit_number, COALESCE(p.property_name, p.title) AS property_name
         FROM payments py
         JOIN invoices inv ON py.invoice_id = inv.invoice_id
         JOIN leases l ON inv.lease_id = l.lease_id
         JOIN tenants t ON l.tenant_id = t.tenant_id
         JOIN units u ON l.unit_id = u.unit_id
         JOIN properties p ON u.property_id = p.property_id
         WHERE py.company_id = $1 ${where}
         ORDER BY py.payment_date DESC, py.payment_id DESC LIMIT 500`, params
    )).rows;
    res.json(rows);
}));

const COMPANY_PROFILE_SQL = `SELECT company_name, address, phone, email, tin, payment_instructions, logo_data FROM companies WHERE company_id = $1`;

// A logo is sent by the browser as a small PNG/JPEG data URL. Anything else is refused.
function cleanLogo(v) {
    if (v === undefined) return undefined;          // not sent: leave as it is
    if (v === null || v === '') return null;        // removed
    const str = String(v);
    if (!/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+\/=]+$/.test(str)) { const e = new Error('The logo must be a PNG or JPG picture.'); e.status = 400; throw e; }
    if (str.length > 600000) { const e = new Error('The logo is too big. Use a smaller picture.'); e.status = 400; throw e; }
    return str;
}
function logoBuffer(dataUrl) {
    if (!dataUrl) return null;
    const m = /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/.exec(String(dataUrl));
    return m ? Buffer.from(m[1], 'base64') : null;
}

// THE RECEIPT OF ONE PAYMENT
async function getReceiptData(cId, payId) {
    let pay = (await pool.query(
        `SELECT py.*, u2.full_name AS received_by FROM payments py LEFT JOIN users u2 ON u2.user_id = py.recorded_by
         WHERE py.payment_id = $1 AND py.company_id = $2`, [payId, cId]
    )).rows[0];
    if (!pay) { const e = new Error('Payment not found.'); e.status = 404; throw e; }

    // old payments (made before receipts existed) get their number now
    if (!pay.receipt_number) {
        const seq = await pool.query("SELECT nextval('receipt_seq')");
        pay.receipt_number = `RCT-${new Date(pay.payment_date).getFullYear()}-${seq.rows[0].nextval}`;
        await pool.query('UPDATE payments SET receipt_number = $1 WHERE payment_id = $2', [pay.receipt_number, pay.payment_id]);
    }

    const inv = (await pool.query(
        `SELECT inv.invoice_id, inv.invoice_number, inv.invoice_type, inv.description, inv.amount_due, COALESCE(inv.currency, 'TZS') AS currency,
                t.full_name AS tenant_name, t.phone_number AS tenant_phone, u.unit_number, COALESCE(p.property_name, p.title) AS property_name
         FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id
         JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
         WHERE inv.invoice_id = $1 AND inv.company_id = $2`, [pay.invoice_id, cId]
    )).rows[0];
    const paidToDate = parseFloat((await pool.query(
        'SELECT COALESCE(SUM(amount_paid), 0) AS s FROM payments WHERE invoice_id = $1 AND payment_id <= $2',
        [pay.invoice_id, pay.payment_id]
    )).rows[0].s);
    const company = (await pool.query(COMPANY_PROFILE_SQL, [cId])).rows[0];
    const total = parseFloat(inv.amount_due);
    return {
        receipt_number: pay.receipt_number, payment_id: pay.payment_id, payment_date: pay.payment_date,
        amount_paid: parseFloat(pay.amount_paid), currency: inv.currency || 'TZS', received_currency: pay.received_currency || null, received_amount: pay.received_amount ? parseFloat(pay.received_amount) : null, exchange_rate: pay.exchange_rate ? parseFloat(pay.exchange_rate) : null, amount_words: amountInWords(pay.amount_paid) + (inv.currency === 'USD' ? ' US dollars only' : ' shillings only'),
        method: pay.method_detail || pay.payment_method, reference: pay.reference_no, notes: pay.notes, received_by: pay.received_by,
        invoice: { invoice_id: inv.invoice_id, invoice_number: inv.invoice_number, invoice_type: inv.invoice_type, description: inv.description, total },
        paid_to_date: paidToDate, balance_after: Math.max(0, Math.round((total - paidToDate) * 100) / 100), extra_paid: Math.max(0, Math.round((paidToDate - total) * 100) / 100),
        tenant_name: inv.tenant_name, tenant_phone: inv.tenant_phone, unit_number: inv.unit_number, property_name: inv.property_name, company
    };
}
app.get('/api/payments/:id/receipt', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try { res.json(await getReceiptData(req.user.company_id, req.params.id)); }
    catch (err) { if (!err.status) console.error('Receipt error:', err); res.status(err.status || 500).json({ error: err.message }); }
});

// FULL INVOICE FOR PRINTING (built from the invoice's own details)
async function getInvoicePrintData(cId, invId) {
    const row = (await pool.query(
        `SELECT inv.*, l.start_date AS lease_start, l.end_date AS lease_end, l.rent_price, l.rent_period, l.number_of_periods, l.total_rent AS lease_total_rent,
                COALESCE(l.discount, 0) AS lease_discount, COALESCE(l.total_to_pay, l.agreed_rent) AS lease_to_pay,
                t.full_name AS tenant_name, t.phone_number AS tenant_phone, t.nida_passport_no, t.identity_type,
                u.unit_number, COALESCE(p.property_name, p.title) AS property_name, p.address AS property_address
         FROM invoices inv
         JOIN leases l ON inv.lease_id = l.lease_id
         JOIN tenants t ON l.tenant_id = t.tenant_id
         JOIN units u ON l.unit_id = u.unit_id
         JOIN properties p ON u.property_id = p.property_id
         WHERE inv.invoice_id = $1 AND inv.company_id = $2`, [invId, cId]
    )).rows[0];
    if (!row) { const e = new Error('Invoice not found.'); e.status = 404; throw e; }

    const payments = (await pool.query(
        `SELECT payment_id, receipt_number, amount_paid, payment_date, payment_method, method_detail, reference_no
         FROM payments WHERE invoice_id = $1 AND company_id = $2 ORDER BY payment_date, payment_id`, [row.invoice_id, cId]
    )).rows;
    const paid = payments.reduce((s, p) => s + parseFloat(p.amount_paid), 0);
    const total = parseFloat(row.amount_due);
    const discount = parseFloat(row.discount || 0);
    // invoices made before v6 have no saved details: rebuild them from the contract
    let subtotal = row.subtotal !== null && row.subtotal !== undefined ? parseFloat(row.subtotal) : total + discount;
    let description = row.description;
    if (!description) {
        description = (row.invoice_type || 'RENT') === 'RENT' && row.rent_price
            ? `Rent: ${parseFloat(row.number_of_periods || 1)} ${periodWord(row.rent_period || 'Month', row.number_of_periods || 1)} x ${fmtMoney(row.rent_price)} (${niceDate(row.lease_start)} - ${niceDate(row.lease_end)})`
            : 'Rent charges';
    }
    const company = (await pool.query(COMPANY_PROFILE_SQL, [cId])).rows[0];
    return {
        invoice: {
            invoice_id: row.invoice_id, invoice_number: row.invoice_number, invoice_type: row.invoice_type || 'RENT', status: row.status,
            issue_date: row.issue_date || String(row.created_at).slice(0, 10), due_date: row.due_date, period_start: row.period_start, period_end: row.period_end,
            currency: row.currency || 'TZS', notes: row.notes, description, subtotal, discount, total, paid, balance: Math.round((total - paid) * 100) / 100
        },
        lines: [{ description, amount: subtotal }],
        payments,
        tenant: { name: row.tenant_name, phone: row.tenant_phone, id_type: row.identity_type, id_number: row.nida_passport_no },
        unit_number: row.unit_number, property_name: row.property_name, property_address: row.property_address,
        company
    };
}
app.get('/api/invoices/:id/print', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try { res.json(await getInvoicePrintData(req.user.company_id, req.params.id)); }
    catch (err) { if (!err.status) console.error('Invoice print error:', err); res.status(err.status || 500).json({ error: err.message }); }
});

// ---- PDF of one invoice / one receipt (logo + company details on top) ----
function pdfHeader(doc, company, title, numberLine) {
    const left = doc.page.margins.left, usable = doc.page.width - left - doc.page.margins.right;
    let textX = left;
    const logo = logoBuffer(company && company.logo_data);
    if (logo) { try { doc.image(logo, left, 40, { fit: [70, 70] }); textX = left + 82; } catch (e) { /* bad picture: skip it */ } }
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text((company && company.company_name) || '', textX, 42, { width: usable - 190 });
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    [company && company.address, company && company.phone, company && company.email, company && company.tin ? 'TIN: ' + company.tin : ''].filter(Boolean)
        .forEach(l => doc.text(String(l), textX, doc.y, { width: usable - 190 }));
    doc.fillColor('#1F3A5F').font('Helvetica-Bold').fontSize(22).text(title, left, 42, { width: usable, align: 'right' });
    doc.fillColor('#333').font('Helvetica').fontSize(10).text(numberLine, left, 70, { width: usable, align: 'right' });
    doc.y = Math.max(doc.y, 125);
    doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).strokeColor('#1F3A5F').lineWidth(1.5).stroke();
    doc.moveDown(0.8);
}
function pdfKV(doc, x, y, label, value, w) {
    doc.fillColor('#777').font('Helvetica').fontSize(8).text(label.toUpperCase(), x, y, { width: w });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(String(value === undefined || value === null || value === '' ? '-' : value), x, doc.y, { width: w });
}
function writeInvoicePdf(res, filename, d) {
    const PDFDocument = loadOptional('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);
    const left = doc.page.margins.left, usable = doc.page.width - left - doc.page.margins.right;
    const inv = d.invoice;
    pdfHeader(doc, d.company, 'INVOICE', inv.invoice_number);
    let y = doc.y;
    const colW = usable / 3 - 8;
    pdfKV(doc, left, y, 'Billed to', d.tenant.name, colW);
    doc.fillColor('#555').font('Helvetica').fontSize(9).text(d.tenant.phone || '', left, doc.y, { width: colW });
    pdfKV(doc, left + colW + 12, y, 'Property / unit', `${d.property_name} - ${d.unit_number}`, colW);
    pdfKV(doc, left + 2 * (colW + 12), y, 'Issue date', niceDate(inv.issue_date), colW);
    doc.fillColor('#777').font('Helvetica').fontSize(8).text('DUE DATE', left + 2 * (colW + 12), doc.y + 4, { width: colW });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(inv.due_date ? niceDate(inv.due_date) : '-', left + 2 * (colW + 12), doc.y, { width: colW });
    doc.y = Math.max(doc.y, y + 70) + 6;

    // lines table
    y = doc.y;
    doc.save().rect(left, y, usable, 20).fill('#1F3A5F').restore();
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('Description', left + 6, y + 6).text('Amount (' + (inv.currency || 'TZS') + ')', left, y + 6, { width: usable - 6, align: 'right' });
    y += 24;
    (d.lines || []).forEach(l => {
        const h = doc.heightOfString(l.description || '', { width: usable - 140 });
        doc.fillColor('#111').font('Helvetica').fontSize(10).text(l.description || '', left + 6, y, { width: usable - 140 });
        doc.text(fmtMoney(l.amount), left, y, { width: usable - 6, align: 'right' });
        y += Math.max(h, 14) + 8;
    });
    doc.moveTo(left, y).lineTo(left + usable, y).strokeColor('#ccc').lineWidth(0.5).stroke();
    y += 8;
    const totalRow = (label, val, bold, color) => {
        doc.fillColor(color || '#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10)
           .text(label, left + usable - 260, y, { width: 150 }).text(fmtMoney(val), left + usable - 110, y, { width: 104, align: 'right' });
        y += bold ? 20 : 16;
    };
    if (inv.discount > 0) { totalRow('Subtotal', inv.subtotal); totalRow('Discount', -inv.discount); }
    totalRow('Total', inv.total, true);
    totalRow('Paid', inv.paid, false, '#166534');
    totalRow('Balance due', inv.balance, true, inv.balance > 0 ? '#B91C1C' : '#166534');
    doc.y = y + 8;

    if (d.payments && d.payments.length) {
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text('Payments received', left, doc.y);
        doc.moveDown(0.3);
        d.payments.forEach(p => doc.font('Helvetica').fontSize(9).fillColor('#333')
            .text(`${niceDate(String(p.payment_date).slice(0, 10))}   ${p.receipt_number || ''}   ${p.method_detail || p.payment_method || ''}   ${inv.currency || 'TZS'} ${fmtMoney(p.amount_paid)}`, left, doc.y));
        doc.moveDown(0.6);
    }
    if (d.company && d.company.payment_instructions) {
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text('How to pay', left, doc.y);
        doc.font('Helvetica').fontSize(9).fillColor('#333').text(String(d.company.payment_instructions), left, doc.y, { width: usable });
        doc.moveDown(0.6);
    }
    if (inv.notes) { doc.font('Helvetica').fontSize(9).fillColor('#555').text('Notes: ' + inv.notes, left, doc.y, { width: usable }); }
    doc.fillColor('#999').font('Helvetica').fontSize(8).text('Thank you for your business.   |   KEY ARCH', left, doc.page.height - 60, { width: usable, align: 'center', lineBreak: false });
    doc.end();
}
function writeReceiptPdf(res, filename, d) {
    const PDFDocument = loadOptional('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);
    const left = doc.page.margins.left, usable = doc.page.width - left - doc.page.margins.right;
    pdfHeader(doc, d.company, 'RECEIPT', d.receipt_number);
    let y = doc.y;
    const colW = usable / 2 - 8;
    pdfKV(doc, left, y, 'Received from', d.tenant_name, colW);
    pdfKV(doc, left + colW + 16, y, 'Date', niceDate(String(d.payment_date).slice(0, 10)), colW);
    doc.y = y + 44; y = doc.y;
    pdfKV(doc, left, y, 'Property / unit', `${d.property_name} - ${d.unit_number}`, colW);
    pdfKV(doc, left + colW + 16, y, 'Payment method', d.method + (d.reference ? ' (' + d.reference + ')' : ''), colW);
    doc.y = y + 44; y = doc.y;
    pdfKV(doc, left, y, 'For invoice', `${d.invoice.invoice_number}${d.invoice.description ? ' - ' + d.invoice.description : ''}`, usable);
    doc.y += 14; y = doc.y;
    doc.save().roundedRect(left, y, usable, 54, 6).fill('#EEF3FA').restore();
    doc.fillColor('#555').font('Helvetica').fontSize(9).text('AMOUNT RECEIVED', left + 14, y + 10);
    doc.fillColor('#1F3A5F').font('Helvetica-Bold').fontSize(20).text((d.currency || 'TZS') + ' ' + fmtMoney(d.amount_paid), left + 14, y + 24);
    doc.y = y + 66;
    doc.fillColor('#555').font('Helvetica').fontSize(9).text(d.amount_words || '', left, doc.y, { width: usable });
    doc.moveDown(0.8);
    y = doc.y;
    const row = (l, v, color) => { doc.fillColor('#333').font('Helvetica').fontSize(10).text(l, left, y, { width: 200 });
        doc.fillColor(color || '#111').font('Helvetica-Bold').text((d.currency || 'TZS') + ' ' + fmtMoney(v), left, y, { width: usable, align: 'right' }); y += 18; };
    row('Invoice total', d.invoice.total); row('Paid to date', d.paid_to_date, '#166534');
    row('Balance remaining', d.balance_after, d.balance_after > 0 ? '#B91C1C' : '#166534');
    if (d.extra_paid > 0) row('Extra paid (credit)', d.extra_paid);
    doc.y = y + 10;
    if (d.received_by) doc.fillColor('#555').font('Helvetica').fontSize(9).text('Received by: ' + d.received_by, left, doc.y);
    doc.fillColor('#999').font('Helvetica').fontSize(8).text('This receipt confirms the payment above.   |   KEY ARCH', left, doc.page.height - 60, { width: usable, align: 'center', lineBreak: false });
    doc.end();
}
function pdfFail(res, err) {
    if (!err.status) console.error('PDF error:', err);
    if (!res.headersSent) res.status(err.status || (err.code === 'MISSING_PACKAGE' ? 501 : 500)).json({ error: err.message, code: err.code }); else res.end();
}
app.get('/api/invoices/:id/pdf', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try { const d = await getInvoicePrintData(req.user.company_id, req.params.id); writeInvoicePdf(res, `${d.invoice.invoice_number}.pdf`, d); }
    catch (err) { pdfFail(res, err); }
});
app.get('/api/payments/:id/receipt-pdf', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try { const d = await getReceiptData(req.user.company_id, req.params.id); writeReceiptPdf(res, `${d.receipt_number}.pdf`, d); }
    catch (err) { pdfFail(res, err); }
});

// ============================================================
// DASHBOARD OVERVIEW (one call for the whole dashboard)
// Tickets and expenses use safe queries: if a column name is
// different in your database they return null instead of crashing.
// ============================================================
async function safeRows(sql, params) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('Overview warning:', err.message); return null; }
}

app.get('/api/dashboard/overview', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    const cId = req.user.company_id;
    try {
        const counts = (await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM properties WHERE company_id = $1) AS properties,
                (SELECT COUNT(*) FROM units WHERE company_id = $1) AS units,
                (SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'OCCUPIED') AS occupied,
                (SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE company_id = $1 AND lease_state = 'CURRENT') AS tenants`,
            [cId]
        )).rows[0];

        const unitsTotal = parseInt(counts.units);
        const unitsOccupied = parseInt(counts.occupied);

        // everything that is still owed, by invoice
        const owed = (await pool.query(
            `${INVOICE_BALANCES_SQL} AND inv.amount_due - COALESCE(pay.paid, 0) > 0 ORDER BY inv.due_date ASC`,
            [cId]
        )).rows.filter(r => r.currency === 'TZS');

        const bucket = (rows) => ({
            count: rows.length,
            amount: rows.reduce((sum, r) => sum + parseFloat(r.balance), 0),
            items: rows.slice(0, 50)
        });
        const due = {
            overdue: bucket(owed.filter(r => r.days_left < 0)),
            week: bucket(owed.filter(r => r.days_left >= 0 && r.days_left <= 7)),
            month: bucket(owed.filter(r => r.days_left > 7 && r.days_left <= 30))
        };
        const outstanding = owed.reduce((sum, r) => sum + parseFloat(r.balance), 0);

        // top balances per tenant
        const byTenant = {};
        owed.forEach(r => {
            const key = `${r.lease_id}`;
            if (!byTenant[key]) byTenant[key] = { tenant_name: r.tenant_name, property_name: r.property_name, unit_number: r.unit_number, balance: 0 };
            byTenant[key].balance += parseFloat(r.balance);
        });
        const debtors = Object.values(byTenant).sort((a, b) => b.balance - a.balance).slice(0, 5);

        const collectedRow = (await pool.query(
            "SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments_tzs WHERE company_id = $1 AND payment_date >= date_trunc('month', CURRENT_DATE)",
            [cId]
        )).rows[0];
        const collectedThisMonth = parseFloat(collectedRow.total);

        const leaseRow = (await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE end_date < CURRENT_DATE) AS expired,
                COUNT(*) FILTER (WHERE end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + 7) AS week,
                COUNT(*) FILTER (WHERE end_date > CURRENT_DATE + 7 AND end_date <= CURRENT_DATE + 30) AS month
             FROM leases WHERE company_id = $1 AND lease_state = 'CURRENT'`,
            [cId]
        )).rows[0];

        // property performance = half occupancy + half collection rate
        const perfRows = (await pool.query(
            `SELECT p.property_id, COALESCE(p.property_name, p.title) AS property_name,
                    (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id) AS units,
                    (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id AND u.status = 'OCCUPIED') AS occupied,
                    COALESCE(b.billed, 0) AS billed, COALESCE(b.collected, 0) AS collected
             FROM properties p
             LEFT JOIN (
                 SELECT u.property_id,
                        SUM(inv.amount_due) AS billed,
                        SUM(LEAST(COALESCE(pay.paid, 0), inv.amount_due)) AS collected
                 FROM invoices_tzs inv
                 JOIN leases l ON inv.lease_id = l.lease_id
                 JOIN units u ON l.unit_id = u.unit_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments_tzs WHERE company_id = $1 GROUP BY invoice_id) pay
                        ON pay.invoice_id = inv.invoice_id
                 WHERE inv.company_id = $1
                 GROUP BY u.property_id
             ) b ON b.property_id = p.property_id
             WHERE p.company_id = $1`,
            [cId]
        )).rows;

        const properties = perfRows.map(r => {
            const units = parseInt(r.units), occupied = parseInt(r.occupied);
            const billed = parseFloat(r.billed), collected = parseFloat(r.collected);
            const occupancy = units > 0 ? Math.round((occupied / units) * 100) : 0;
            const collection = billed > 0 ? Math.round((collected / billed) * 100) : null;
            const score = collection === null ? occupancy : (occupancy + collection) / 2;
            return {
                property_id: r.property_id, property_name: r.property_name,
                units, occupied, occupancy_rate: occupancy,
                billed, collected, collection_rate: collection, score
            };
        }).sort((a, b) => b.score - a.score);

        // optional parts (names of columns in your tables may differ, so they fail safely)
        const workloadRows = await safeRows(
            `SELECT tech.worker_id AS user_id, tech.full_name, COUNT(*) AS n, MAX(CURRENT_DATE - w.created_at::date) AS oldest
             FROM work_orders w JOIN maintenance_workers tech ON tech.worker_id = w.worker_id
             WHERE tech.company_id = $1 AND w.status IN ('OPEN','IN_PROGRESS')
             GROUP BY tech.worker_id, tech.full_name ORDER BY n DESC`, [cId]
        );
        const ticketRows = await safeRows(
            "SELECT COUNT(*) AS c FROM work_orders w LEFT JOIN units u ON w.unit_id = u.unit_id WHERE COALESCE(w.company_id, u.company_id) = $1 AND w.status IN ('OPEN','IN_PROGRESS')",
            [cId]
        );
        const expenseRows = await safeRows(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses_tzs WHERE company_id = $1 AND expense_date >= date_trunc('month', CURRENT_DATE)",
            [cId]
        );
        const expensesThisMonth = expenseRows ? parseFloat(expenseRows[0].total) : null;

        // vacant units, contracts ending soon (with names), service charges and a 6-month picture
        const vacantList = (await pool.query(
            `SELECT u.unit_id, u.unit_number, u.rent_amount, COALESCE(p.property_name, p.title) AS property_name
             FROM units u JOIN properties p ON p.property_id = u.property_id
             WHERE u.company_id = $1 AND u.status = 'VACANT' ORDER BY p.property_id, u.unit_number LIMIT 30`, [cId]
        )).rows;
        const expiring = (await pool.query(
            `SELECT l.lease_id, l.end_date, (l.end_date::date - CURRENT_DATE) AS days_left, t.tenant_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
                    u.unit_number, COALESCE(p.property_name, p.title) AS property_name
             FROM leases l JOIN tenants t ON t.tenant_id = l.tenant_id JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
             WHERE l.company_id = $1 AND l.lease_state = 'CURRENT' AND l.end_date <= CURRENT_DATE + 30
             ORDER BY l.end_date ASC LIMIT 30`, [cId]
        )).rows;
        let service = null;
        try { service = (await loadServiceStatus(cId, todayStr().slice(0, 7), null)).summary; } catch (e) { console.error('Overview service warning:', e.message); }

        const paySeries = (await pool.query(
            `SELECT to_char(m.month, 'YYYY-MM') AS ym,
                    COALESCE((SELECT SUM(amount_paid) FROM payments_tzs WHERE company_id = $1 AND date_trunc('month', payment_date) = m.month), 0) AS collected
             FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') AS m(month)
             ORDER BY m.month`, [cId]
        )).rows;
        const expSeries = await safeRows(
            `SELECT to_char(m.month, 'YYYY-MM') AS ym,
                    COALESCE((SELECT SUM(amount) FROM expenses_tzs WHERE company_id = $1 AND date_trunc('month', expense_date) = m.month), 0) AS expenses
             FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') AS m(month)
             ORDER BY m.month`, [cId]
        );
        const monthly = paySeries.map((r, i) => ({
            month: r.ym, collected: parseFloat(r.collected), expenses: expSeries && expSeries[i] ? parseFloat(expSeries[i].expenses) : 0
        }));

        res.json({
            vacantList, expiring, service, monthly,
            totals: {
                properties: parseInt(counts.properties),
                units: unitsTotal,
                occupied: unitsOccupied,
                vacant: unitsTotal - unitsOccupied,
                tenants: parseInt(counts.tenants),
                occupancyRate: unitsTotal > 0 ? Math.round((unitsOccupied / unitsTotal) * 100) : 0
            },
            money: {
                collectedThisMonth,
                outstanding,
                expensesThisMonth,
                profit: expensesThisMonth === null ? null : collectedThisMonth - expensesThisMonth
            },
            due,
            leases: { expired: parseInt(leaseRow.expired), week: parseInt(leaseRow.week), month: parseInt(leaseRow.month) },
            properties,
            debtors,
            tickets: { pending: ticketRows ? parseInt(ticketRows[0].c) : null, workload: (workloadRows || []).map(r => ({ technician_id: r.user_id, technician: r.full_name, unfinished: parseInt(r.n), oldest_days: parseInt(r.oldest) || 0 })) }
        });
    } catch (err) {
        console.error('Overview Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// COMPANY PROFILE + FINANCIAL YEAR (printed on invoices, receipts and reports)
// ============================================================
app.get('/api/company/profile', authenticateToken, wrapAsync(async (req, res) => {
    const r = await pool.query(
        `SELECT company_name, address, phone, email, tin, payment_instructions, COALESCE(fy_start_month, 1) AS fy_start_month,
                COALESCE(luku_low_threshold, 5) AS luku_low_threshold, logo_data
         FROM companies WHERE company_id = $1`, [req.user.company_id]
    );
    res.json(r.rows[0] || {});
}));

app.put('/api/company/profile', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
    const { company_name, address, phone, email, tin, payment_instructions } = req.body;
    let logo;
    try { logo = cleanLogo(req.body.logo_data); } catch (e) { return res.status(400).json({ error: e.message }); }
    const fy = parseInt(req.body.fy_start_month);
    const low = parseInt(req.body.luku_low_threshold);
    if (!company_name || !String(company_name).trim()) return res.status(400).json({ error: 'Company name is required.' });
    if (!(fy >= 1 && fy <= 12)) return res.status(400).json({ error: 'Choose the month your financial year starts.' });
    await pool.query(
        `UPDATE companies SET company_name = $1, address = $2, phone = $3, email = $4, tin = $5, payment_instructions = $6,
                fy_start_month = $7, luku_low_threshold = $8
         WHERE company_id = $9`,
        [String(company_name).trim(), address || null, phone || null, email || null, tin || null, payment_instructions || null,
         fy, low >= 0 ? low : 5, req.user.company_id]
    );
    if (logo !== undefined) await pool.query('UPDATE companies SET logo_data = $1 WHERE company_id = $2', [logo, req.user.company_id]);
    clearAccessCache(req.user.company_id);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Updated company profile', 'SETTINGS', req.ip, {});
    res.json({ message: 'Company details saved.' });
}));

// ============================================================
// USER MANAGEMENT (company owner / admin)
// ============================================================
app.get('/api/users', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
    const r = await pool.query(
        `SELECT user_id, full_name, email, phone_number, role, is_active, COALESCE(can_edit_tenants, false) AS can_edit_tenants, created_at
         FROM users WHERE company_id = $1 AND role <> 'SUPER_ADMIN' ORDER BY (role = 'COMPANY_ADMIN') DESC, full_name ASC`, [req.user.company_id]
    );
    res.json(r.rows);
}));

app.get('/api/workers', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
    const all = req.query.all === '1';
    const r = await pool.query(
        `SELECT m.worker_id, m.full_name, m.phone_number, m.is_active,
                (SELECT COUNT(*) FROM work_orders w WHERE w.worker_id = m.worker_id AND w.status IN ('OPEN','IN_PROGRESS'))::int AS open_jobs
         FROM maintenance_workers m WHERE m.company_id = $1 ${all ? '' : 'AND m.is_active = true'} ORDER BY m.is_active DESC, m.full_name`, [req.user.company_id]);
    res.json(r.rows);
}));

app.post('/api/workers', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
    const name = String(req.body.full_name || '').trim();
    if (!name) return res.status(400).json({ error: 'Please type the worker name.' });
    if (name.length > 120) return res.status(400).json({ error: 'The name is too long.' });
    const dup = await pool.query("SELECT 1 FROM maintenance_workers WHERE company_id = $1 AND LOWER(full_name) = LOWER($2) AND is_active = true", [req.user.company_id, name]);
    if (dup.rows.length) return res.status(400).json({ error: 'A worker with this name already exists.' });
    const r = await pool.query("INSERT INTO maintenance_workers (company_id, full_name, phone_number) VALUES ($1, $2, $3) RETURNING worker_id, full_name, phone_number, is_active",
        [req.user.company_id, name, String(req.body.phone_number || '').trim().slice(0, 40) || null]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added maintenance worker', 'TICKETS', req.ip, { worker_id: r.rows[0].worker_id });
    res.status(201).json(r.rows[0]);
}));

app.put('/api/workers/:id', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
    const name = String(req.body.full_name || '').trim();
    if (!name) return res.status(400).json({ error: 'Please type the worker name.' });
    const r = await pool.query(
        `UPDATE maintenance_workers SET full_name = $1, phone_number = $2, is_active = $3 WHERE worker_id = $4 AND company_id = $5 RETURNING worker_id`,
        [name, String(req.body.phone_number || '').trim().slice(0, 40) || null, req.body.is_active !== false, req.params.id, req.user.company_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Worker not found.' });
    res.json({ message: 'Worker updated.' });
}));

app.delete('/api/workers/:id', authenticateToken, allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
    const used = await pool.query("SELECT 1 FROM work_orders WHERE worker_id = $1 LIMIT 1", [req.params.id]);
    if (used.rows.length) {
        const r = await pool.query("UPDATE maintenance_workers SET is_active = false WHERE worker_id = $1 AND company_id = $2 RETURNING worker_id", [req.params.id, req.user.company_id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Worker not found.' });
        return res.json({ message: 'This worker has past jobs, so he was switched off instead of deleted.', deactivated: true });
    }
    const r = await pool.query("DELETE FROM maintenance_workers WHERE worker_id = $1 AND company_id = $2 RETURNING worker_id", [req.params.id, req.user.company_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Worker not found.' });
    res.json({ message: 'Worker removed.' });
}));


app.post('/api/users', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
    const { full_name, email, phone_number, password, role } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (!/^\S+@\S+\.\S+$/.test(String(email).trim())) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const staffLimit = await checkLimit(req.user, 'max_staff', "SELECT COUNT(*) FROM users WHERE company_id = $1 AND role <> 'COMPANY_ADMIN'", 'staff members');
    if (staffLimit && role !== 'COMPANY_ADMIN') return res.status(403).json({ error: staffLimit, code: 'LIMIT_REACHED' });

    const cleanEmail = String(email).trim().toLowerCase();
    const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'This email is already registered.' });
    const hashed = await bcrypt.hash(String(password), 10);
    const r = await pool.query(
        `INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING user_id`,
        [req.user.company_id, String(full_name).trim(), cleanEmail, hashed, phone_number || null, role, role === 'COMPANY_ADMIN']
    );
    await createAuditLog(pool, req.user.company_id, req.user.user_id, `Added user (${role})`, 'USERS', req.ip, { email: cleanEmail });
    res.status(201).json({ message: 'User added.', user_id: r.rows[0].user_id });
}));

app.put('/api/users/:id', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
    const { full_name, phone_number, role, is_active, can_edit_tenants, password } = req.body;
    const cId = req.user.company_id;
    const target = (await pool.query("SELECT user_id, role, is_active FROM users WHERE user_id = $1 AND company_id = $2 AND role <> 'SUPER_ADMIN'", [req.params.id, cId])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!full_name) return res.status(400).json({ error: 'Name is required.' });
    if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (password && String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const isSelf = String(target.user_id) === String(req.user.user_id);
    if (isSelf && (role !== target.role || is_active === false)) return res.status(400).json({ error: 'You cannot change your own role or switch yourself off.' });

    // never leave the company without an active administrator
    if (target.role === 'COMPANY_ADMIN' && (role !== 'COMPANY_ADMIN' || is_active === false)) {
        const others = (await pool.query("SELECT COUNT(*) AS c FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' AND is_active = true AND user_id <> $2", [cId, target.user_id])).rows[0].c;
        if (parseInt(others) === 0) return res.status(400).json({ error: 'The company needs at least one active administrator.' });
    }

    const sets = ['full_name = $1', 'phone_number = $2', 'role = $3', 'is_active = $4', 'can_edit_tenants = $5'];
    const vals = [String(full_name).trim(), phone_number || null, role, is_active !== false, can_edit_tenants === true];
    if (password) { vals.push(await bcrypt.hash(String(password), 10)); sets.push(`password_hash = $${vals.length}`); }
    vals.push(target.user_id, cId);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE user_id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    clearUserCache(target.user_id);
    await createAuditLog(pool, cId, req.user.user_id, 'Updated user', 'USERS', req.ip, { user_id: target.user_id, role });
    res.json({ message: 'User updated.' });
}));

app.delete('/api/users/:id', authenticateToken, allowRoles(...R_ADMIN), wrapAsync(async (req, res) => {
    const cId = req.user.company_id;
    const target = (await pool.query("SELECT user_id, role FROM users WHERE user_id = $1 AND company_id = $2 AND role <> 'SUPER_ADMIN'", [req.params.id, cId])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (String(target.user_id) === String(req.user.user_id)) return res.status(400).json({ error: 'You cannot delete your own account.' });
    if (target.role === 'COMPANY_ADMIN') {
        const others = (await pool.query("SELECT COUNT(*) AS c FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' AND is_active = true AND user_id <> $2", [cId, target.user_id])).rows[0].c;
        if (parseInt(others) === 0) return res.status(400).json({ error: 'The company needs at least one active administrator.' });
    }
    try {
        await pool.query('DELETE FROM users WHERE user_id = $1 AND company_id = $2', [target.user_id, cId]);
        clearUserCache(target.user_id);
        res.json({ message: 'User deleted.' });
    } catch (err) {
        if (err.code === '23503') {          // the user already has records (payments, expenses...) so keep the history
            await pool.query('UPDATE users SET is_active = false WHERE user_id = $1 AND company_id = $2', [target.user_id, cId]);
            clearUserCache(target.user_id);
            return res.json({ message: 'This user has records in the system, so the account was switched off instead of deleted.' });
        }
        throw err;
    }
}));

// ============================================================
// EXPENSES
// ============================================================
const EXPENSE_CATEGORIES = ['REPAIR', 'UTILITY', 'TAX', 'SALARY', 'SUPPLIES', 'SECURITY', 'CLEANING', 'INSURANCE', 'MARKETING', 'MISC'];

app.get('/api/expenses', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const params = [req.user.company_id];
    let where = '';
    if (isDateStr(req.query.from)) { params.push(req.query.from); where += ` AND e.expense_date >= $${params.length}`; }
    if (isDateStr(req.query.to)) { params.push(req.query.to); where += ` AND e.expense_date <= $${params.length}`; }
    if (req.query.property_id) { params.push(req.query.property_id); where += ` AND e.property_id = $${params.length}`; }
    if (req.query.category) { params.push(req.query.category); where += ` AND e.category = $${params.length}`; }
    const rows = (await pool.query(
        `SELECT e.expense_id, e.description, e.amount, e.category, e.expense_date, e.property_id, e.payee, e.notes, e.ticket_id, COALESCE(e.currency, 'TZS') AS currency, e.account_id, fa.name AS account_name,
                COALESCE(p.property_name, p.title) AS property_name, u.full_name AS recorded_by_name
         FROM expenses e LEFT JOIN properties p ON p.property_id = e.property_id LEFT JOIN users u ON u.user_id = e.recorded_by LEFT JOIN finance_accounts fa ON fa.account_id = e.account_id
         WHERE e.company_id = $1 ${where} ORDER BY e.expense_date DESC, e.expense_id DESC LIMIT 1000`, params
    )).rows;
    const tz = rows.filter(r => r.currency === 'TZS');
    const total = tz.reduce((s, r) => s + parseFloat(r.amount), 0);
    const totalUsd = rows.filter(r => r.currency === 'USD').reduce((s, r) => s + parseFloat(r.amount), 0);
    const byCategory = {};
    tz.forEach(r => { byCategory[r.category] = (byCategory[r.category] || 0) + parseFloat(r.amount); });
    res.json({ total, total_usd: totalUsd, byCategory, rows });
}));

function readExpenseBody(b) {
    const amount = parseFloat(b.amount);
    if (!String(b.description || '').trim()) return { error: 'Please describe the expense.' };
    if (!(amount > 0)) return { error: 'Amount must be greater than 0.' };
    const category = EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'MISC';
    const date = isDateStr(b.expense_date) ? b.expense_date : todayStr();
    if (date > todayStr()) return { error: 'Expense date cannot be in the future.' };
    return { value: { currency: cleanCur(b.currency), account_id: b.account_id || null, description: String(b.description).trim(), amount, category, date, property_id: b.property_id || null, payee: String(b.payee || '').trim() || null, notes: String(b.notes || '').trim() || null } };
}

app.post('/api/expenses', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
    const r = readExpenseBody(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const v = r.value;
    if (v.property_id) {
        const ok = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [v.property_id, req.user.company_id]);
        if (ok.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
    }
    const accId = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
    const ins = await pool.query(
        `INSERT INTO expenses (company_id, property_id, description, amount, category, recorded_by, expense_date, payee, notes, currency, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING expense_id`,
        [req.user.company_id, v.property_id, v.description, v.amount, v.category, req.user.user_id, v.date, v.payee, v.notes, v.currency, accId]
    );
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Recorded Expense', 'EXPENSES', req.ip, { expense_id: ins.rows[0].expense_id, amount: v.amount });
    res.status(201).json({ message: 'Expense saved.', expense_id: ins.rows[0].expense_id });
}));

app.put('/api/expenses/:id', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
    const r = readExpenseBody(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const v = r.value;
    const accId = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
    const upd = await pool.query(
        `UPDATE expenses SET property_id = $1, description = $2, amount = $3, category = $4, expense_date = $5, payee = $6, notes = $7, currency = $10, account_id = $11
         WHERE expense_id = $8 AND company_id = $9 RETURNING expense_id`,
        [v.property_id, v.description, v.amount, v.category, v.date, v.payee, v.notes, req.params.id, req.user.company_id, v.currency, accId]
    );
    if (upd.rows.length === 0) return res.status(404).json({ error: 'Expense not found.' });
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Expense', 'EXPENSES', req.ip, { expense_id: req.params.id });
    res.json({ message: 'Expense updated.' });
}));

app.delete('/api/expenses/:id', authenticateToken, allowRoles(...R_MONEY), wrapAsync(async (req, res) => {
    const r = await pool.query('DELETE FROM expenses WHERE expense_id = $1 AND company_id = $2 RETURNING expense_id', [req.params.id, req.user.company_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Expense not found.' });
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Expense', 'EXPENSES', req.ip, { expense_id: req.params.id });
    res.json({ message: 'Expense deleted.' });
}));

// ============================================================
// MAINTENANCE TICKETS (Pro)
// ============================================================
const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'];

app.get('/api/tickets', authenticateToken, requireFeature('tickets'), allowRoles(...R_TICKETS, 'ACCOUNTANT', 'VIEWER'), wrapAsync(async (req, res) => {
    const params = [req.user.company_id];
    let where = '';
    const rows = (await pool.query(
        `SELECT w.ticket_id, w.title, w.description, w.priority, w.status, w.estimated_cost, w.actual_cost, w.notes, w.created_at, w.resolved_at,
                w.unit_id, COALESCE(w.property_id, u.property_id) AS property_id, w.worker_id AS assigned_technician_id,
                u.unit_number, COALESCE(p.property_name, p.title) AS property_name, tech.full_name AS technician_name
         FROM work_orders w
         LEFT JOIN units u ON u.unit_id = w.unit_id
         LEFT JOIN properties p ON p.property_id = COALESCE(w.property_id, u.property_id)
         LEFT JOIN maintenance_workers tech ON tech.worker_id = w.worker_id
         WHERE COALESCE(w.company_id, u.company_id) = $1 ${where}
         ORDER BY (w.status IN ('OPEN','IN_PROGRESS')) DESC,
                  CASE w.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, w.created_at DESC LIMIT 500`, params
    )).rows;
    res.json(rows);
}));

app.post('/api/tickets', authenticateToken, requireFeature('tickets'), allowRoles(...R_TICKETS), wrapAsync(async (req, res) => {
    const { title, description, priority, property_id, unit_id, assigned_technician_id, estimated_cost } = req.body;
    if (!String(title || '').trim()) return res.status(400).json({ error: 'Please enter a short title for the problem.' });
    if (!property_id && !unit_id) return res.status(400).json({ error: 'Choose the property (and the unit if the problem is inside one).' });
    const cId = req.user.company_id;
    let propId = property_id || null, unitId = unit_id || null;
    if (unitId) {
        const u = (await pool.query('SELECT property_id FROM units WHERE unit_id = $1 AND company_id = $2', [unitId, cId])).rows[0];
        if (!u) return res.status(404).json({ error: 'Unit not found.' });
        propId = u.property_id;
    } else {
        const ok = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [propId, cId]);
        if (ok.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });
    }
    let tech = null;
    if (assigned_technician_id) {
        const t = await pool.query("SELECT 1 FROM maintenance_workers WHERE worker_id = $1 AND company_id = $2 AND is_active = true", [assigned_technician_id, cId]);
        if (t.rows.length === 0) return res.status(400).json({ error: 'Worker not found.' });
        tech = assigned_technician_id;
    }
    const ins = await pool.query(
        `INSERT INTO work_orders (company_id, unit_id, property_id, worker_id, title, description, priority, status, estimated_cost, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9) RETURNING ticket_id`,
        [cId, unitId, propId, tech, String(title).trim(), String(description || '').trim(), TICKET_PRIORITIES.includes(priority) ? priority : 'MEDIUM',
         Math.max(0, parseFloat(estimated_cost) || 0), req.user.user_id]
    );
    await createAuditLog(pool, cId, req.user.user_id, 'Created Ticket', 'TICKETS', req.ip, { ticket_id: ins.rows[0].ticket_id });
    res.status(201).json({ message: 'Ticket created.', ticket_id: ins.rows[0].ticket_id });
}));

app.put('/api/tickets/:id', authenticateToken, requireFeature('tickets'), allowRoles(...R_TICKETS), async (req, res) => {
    const cId = req.user.company_id;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const t = (await client.query(
            `SELECT w.* , u.property_id AS unit_property_id FROM work_orders w LEFT JOIN units u ON u.unit_id = w.unit_id
             WHERE w.ticket_id = $1 AND COALESCE(w.company_id, u.company_id) = $2 FOR UPDATE OF w`, [req.params.id, cId]
        )).rows[0];
        if (!t) throw new Error('Ticket not found.');
        const canBooks = R_MANAGE.includes(req.user.role);   // only admin / property manager can write a repair cost into Expenses

        const b = req.body;
        const status = TICKET_STATUSES.includes(b.status) ? b.status : t.status;
        const priority = TICKET_PRIORITIES.includes(b.priority) ? b.priority : t.priority;
        let tech = t.worker_id;
        if (b.assigned_technician_id !== undefined) {
            tech = b.assigned_technician_id || null;
            if (tech) {
                const ok = await client.query("SELECT 1 FROM maintenance_workers WHERE worker_id = $1 AND company_id = $2 AND (is_active = true OR worker_id = $3)", [tech, cId, t.worker_id]);
                if (ok.rows.length === 0) throw new Error('Worker not found.');
            }
        }
        const title = String(b.title || t.title).trim() || t.title;
        const description = b.description !== undefined ? String(b.description) : t.description;
        const estimated = b.estimated_cost !== undefined ? Math.max(0, parseFloat(b.estimated_cost) || 0) : t.estimated_cost;
        const actual = b.actual_cost !== undefined && b.actual_cost !== '' ? Math.max(0, parseFloat(b.actual_cost) || 0) : t.actual_cost;
        const notes = b.notes !== undefined ? String(b.notes) : t.notes;
        const becameResolved = status === 'RESOLVED' && t.status !== 'RESOLVED';

        await client.query(
            `UPDATE work_orders SET title = $1, description = $2, priority = $3, status = $4, worker_id = $5,
                    estimated_cost = $6, actual_cost = $7, notes = $8,
                    resolved_at = CASE WHEN $10::boolean THEN COALESCE(resolved_at, NOW()) ELSE NULL END
             WHERE ticket_id = $9`,
            [title, description || '', priority, status, tech, estimated || 0, actual === undefined ? null : actual, notes || null, t.ticket_id, status === 'RESOLVED']
        );

        // optionally write the repair cost into Expenses (only once per ticket)
        let expenseAdded = false;
        if (becameResolved && b.add_to_expenses && canBooks && parseFloat(actual) > 0) {
            const exists = await client.query('SELECT 1 FROM expenses WHERE ticket_id = $1 AND company_id = $2', [t.ticket_id, cId]);
            if (exists.rows.length === 0) {
                await client.query(
                    `INSERT INTO expenses (company_id, property_id, description, amount, category, recorded_by, expense_date, ticket_id)
                     VALUES ($1, $2, $3, $4, 'REPAIR', $5, CURRENT_DATE, $6)`,
                    [cId, t.property_id || t.unit_property_id || null, `Repair: ${title}`, parseFloat(actual), req.user.user_id, t.ticket_id]
                );
                expenseAdded = true;
            }
        }
        await createAuditLog(client, cId, req.user.user_id, 'Updated Ticket', 'TICKETS', req.ip, { ticket_id: t.ticket_id, status });
        await client.query('COMMIT');
        res.json({ message: expenseAdded ? 'Ticket updated and the cost was added to Expenses.' : 'Ticket updated.', expense_added: expenseAdded });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { if (client) client.release(); }
});

app.delete('/api/tickets/:id', authenticateToken, requireFeature('tickets'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
    const r = await pool.query(
        `DELETE FROM work_orders w USING (SELECT ticket_id FROM work_orders w2 LEFT JOIN units u ON u.unit_id = w2.unit_id WHERE w2.ticket_id = $1 AND COALESCE(w2.company_id, u.company_id) = $2) x
         WHERE w.ticket_id = x.ticket_id RETURNING w.ticket_id`, [req.params.id, req.user.company_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ticket not found.' });
    res.json({ message: 'Ticket deleted.' });
}));

// ============================================================
// LUKU (Pro): the company uploads its own tokens, the system sells them
// File columns: unit name, token, price, kWh (optional)
// ============================================================
function parseCsvText(text) {
    text = String(text || '').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
            if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQ = false;
            else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === delim) { row.push(cur); cur = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cur); cur = '';
            if (row.some(c => String(c).trim() !== '')) rows.push(row);
            row = [];
        } else cur += ch;
    }
    row.push(cur);
    if (row.some(c => String(c).trim() !== '')) rows.push(row);
    return rows.map(r => r.map(v => ({ v: String(v).trim(), num: false })));
}

async function parseXlsxBuffer(buf) {
    const ExcelJS = loadOptional('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
        const cells = [];
        for (let c = 1; c <= row.cellCount; c++) {
            let v = row.getCell(c).value;
            let num = false;
            if (v && typeof v === 'object' && !(v instanceof Date)) v = v.text !== undefined ? v.text : (v.result !== undefined ? v.result : (v.richText ? v.richText.map(x => x.text).join('') : ''));
            if (typeof v === 'number') num = true;
            cells.push({ v: v === null || v === undefined ? '' : String(v).trim(), num });
        }
        if (cells.some(c => c.v !== '')) rows.push(cells);
    });
    return rows;
}

function loadOptional(name) {
    try { return require(name); }
    catch (e) {
        const err = new Error(`The package "${name}" is not installed on the server yet. Add it to package.json (npm install ${name}) and redeploy.`);
        err.code = 'MISSING_PACKAGE';
        throw err;
    }
}

const LUKU_ALIASES = {
    unit_name: ['unit', 'unit name', 'unit_name', 'unitname', 'house', 'room', 'meter', 'meter name', 'nyumba', 'chumba'],
    token: ['token', 'token number', 'token_number', 'tokens', 'voucher', 'luku token', 'namba ya token'],
    price: ['price', 'amount', 'bei', 'value', 'cost', 'tsh'],
    kwh: ['kwh', 'units', 'kw', 'kwh units', 'kwh_units']
};
function lukuColumnIndex(header) {
    const idx = {};
    header.forEach((cell, i) => {
        const h = cell.v.toLowerCase().replace(/[^a-z0-9_ ]/g, '').trim();
        Object.keys(LUKU_ALIASES).forEach(k => { if (idx[k] === undefined && LUKU_ALIASES[k].includes(h)) idx[k] = i; });
    });
    return idx;
}

function lukuLowFlag(available, threshold) {
    if (available === 0) return 'OUT';
    if (available <= threshold) return 'LOW';
    return 'OK';
}

app.get('/api/luku/summary', authenticateToken, requireFeature('luku'), allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const cId = req.user.company_id;
    const thr = parseInt((await pool.query('SELECT COALESCE(luku_low_threshold, 5) AS t FROM companies WHERE company_id = $1', [cId])).rows[0].t);
    const groups = (await pool.query(
        `SELECT unit_name, price, COUNT(*) FILTER (WHERE status = 'AVAILABLE') AS available, COUNT(*) FILTER (WHERE status = 'SOLD') AS sold
         FROM luku_stock WHERE company_id = $1 GROUP BY unit_name, price ORDER BY unit_name, price`, [cId]
    )).rows.map(g => ({ unit_name: g.unit_name, price: parseFloat(g.price), available: parseInt(g.available), sold: parseInt(g.sold), flag: lukuLowFlag(parseInt(g.available), thr) }));
    const sales = (await pool.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM luku_vouchers WHERE company_id = $1 AND sold_at >= date_trunc('month', CURRENT_DATE)`, [cId]
    )).rows[0];
    res.json({ threshold: thr, groups, low_count: groups.filter(g => g.flag !== 'OK').length, month_sales: { count: parseInt(sales.n), total: parseFloat(sales.total) } });
}));

app.post('/api/luku/stock/upload', authenticateToken, requireFeature('luku'), allowRoles(...R_MANAGE), async (req, res) => {
    const { filename, data } = req.body;
    if (!data) return res.status(400).json({ error: 'Please choose a file.' });
    const cId = req.user.company_id;
    let client;
    try {
        const name = String(filename || 'upload').toLowerCase();
        const buf = Buffer.from(String(data), 'base64');
        if (buf.length === 0) return res.status(400).json({ error: 'The file is empty.' });
        let rows;
        if (name.endsWith('.xlsx')) rows = await parseXlsxBuffer(buf);
        else if (name.endsWith('.csv') || name.endsWith('.txt')) rows = parseCsvText(buf.toString('utf8'));
        else return res.status(400).json({ error: 'Please upload an .xlsx or .csv file.' });
        if (rows.length < 2) return res.status(400).json({ error: 'The file has no data rows.' });
        if (rows.length > 20001) return res.status(400).json({ error: 'Too many rows. Upload at most 20,000 tokens at a time.' });

        const idx = lukuColumnIndex(rows[0]);
        if (idx.unit_name === undefined || idx.token === undefined || idx.price === undefined) {
            return res.status(400).json({ error: 'The first row must have the headings: unit name, token, price (and optionally kWh). Download the template to see an example.' });
        }

        const accepted = [], rejected = [];
        const seen = new Set();
        let duplicatesInFile = 0;
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            const line = i + 1;
            const unit = (r[idx.unit_name] || { v: '' }).v;
            const tokCell = r[idx.token] || { v: '', num: false };
            const priceRaw = (r[idx.price] || { v: '' }).v.replace(/[,\s]/g, '');
            const kwhRaw = idx.kwh !== undefined ? (r[idx.kwh] || { v: '' }).v.replace(/[,\s]/g, '') : '';
            const token = tokCell.v.replace(/[\s-]/g, '');
            const price = parseFloat(priceRaw);

            if (!unit) { rejected.push({ line, reason: 'Unit name is empty' }); continue; }
            if (!(price > 0)) { rejected.push({ line, reason: 'Price is missing or not a number' }); continue; }
            if (/e[+-]?\d+/i.test(token)) { rejected.push({ line, reason: 'Token is written like 1.23E+19. Excel rounded it. Format the token column as Text and paste the tokens again.' }); continue; }
            if (!/^\d{8,30}$/.test(token)) { rejected.push({ line, reason: 'Token must be numbers only (8 to 30 digits)' }); continue; }
            if (tokCell.num && token.length >= 16) { rejected.push({ line, reason: 'Token was saved as a number, so Excel may have changed its last digits. Format the token column as Text.' }); continue; }
            if (token.length >= 16 && /0{4,}$/.test(token)) { rejected.push({ line, reason: 'Token ends with many zeros - Excel probably rounded it. Format the token column as Text and try again.' }); continue; }
            if (seen.has(token)) { duplicatesInFile++; continue; }
            seen.add(token);
            const kwh = parseFloat(kwhRaw);
            accepted.push({ unit: unit.slice(0, 80), token, price, kwh: kwh > 0 ? kwh : null });
        }

        // if Excel damaged tokens it usually damages many: refuse the whole file instead of loading bad tokens
        if (accepted.length === 0) {
            return res.status(400).json({ error: 'No valid tokens found in the file.', rejected: rejected.slice(0, 20), rejected_count: rejected.length });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        const batch = `${String(filename || 'upload').slice(0, 50)} ${new Date().toISOString().slice(0, 10)}`;
        let inserted = 0;
        for (let i = 0; i < accepted.length; i += 1000) {
            const chunk = accepted.slice(i, i + 1000);
            const r = await client.query(
                `INSERT INTO luku_stock (company_id, unit_name, token, price, kwh, batch)
                 SELECT $1, u, t, p, k, $6 FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[]) AS x(u, t, p, k)
                 ON CONFLICT (company_id, token) DO NOTHING RETURNING stock_id`,
                [cId, chunk.map(c => c.unit), chunk.map(c => c.token), chunk.map(c => c.price), chunk.map(c => c.kwh), batch]
            );
            inserted += r.rows.length;
        }
        await createAuditLog(client, cId, req.user.user_id, 'Uploaded Luku stock', 'LUKU', req.ip, { inserted, rejected: rejected.length });
        await client.query('COMMIT');
        res.status(201).json({
            message: `${inserted} token(s) added.`, inserted,
            already_in_system: accepted.length - inserted, duplicates_in_file: duplicatesInFile,
            rejected_count: rejected.length, rejected: rejected.slice(0, 20)
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(err.code === 'MISSING_PACKAGE' ? 501 : 400).json({ error: err.message });
    } finally { if (client) client.release(); }
});

app.post('/api/luku/sell', authenticateToken, requireFeature('luku'), allowRoles(...R_MONEY), async (req, res) => {
    const { unit_name, price, customer_name, customer_phone } = req.body;
    const amount = parseFloat(price);
    if (!unit_name || !(amount > 0)) return res.status(400).json({ error: 'Choose the unit and the price.' });
    const cId = req.user.company_id;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const tok = (await client.query(
            `SELECT stock_id, token, kwh FROM luku_stock
             WHERE company_id = $1 AND unit_name = $2 AND price = $3 AND status = 'AVAILABLE'
             ORDER BY stock_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [cId, unit_name, amount]
        )).rows[0];
        if (!tok) throw new Error('No token is left for this unit at this price. Upload more tokens first.');

        await client.query(
            "UPDATE luku_stock SET status = 'SOLD', sold_at = NOW(), sold_to = $1, sold_by = $2 WHERE stock_id = $3",
            [String(customer_name || '').trim() || null, req.user.user_id, tok.stock_id]
        );
        const sale = (await client.query(
            `INSERT INTO luku_vouchers (company_id, meter_number, tenant_name, amount, token_number, kwh_units, sold_by, unit_name, customer_phone)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $2, $8) RETURNING voucher_id, sold_at`,
            [cId, String(unit_name).slice(0, 50), String(customer_name || '').trim() || null, amount, tok.token, tok.kwh, req.user.user_id, String(customer_phone || '').trim() || null]
        )).rows[0];
        const left = parseInt((await client.query(
            "SELECT COUNT(*) AS c FROM luku_stock WHERE company_id = $1 AND unit_name = $2 AND price = $3 AND status = 'AVAILABLE'", [cId, unit_name, amount]
        )).rows[0].c);
        const thr = parseInt((await client.query('SELECT COALESCE(luku_low_threshold, 5) AS t FROM companies WHERE company_id = $1', [cId])).rows[0].t);
        await createAuditLog(client, cId, req.user.user_id, 'Sold Luku token', 'LUKU', req.ip, { unit_name, amount });
        await client.query('COMMIT');
        res.status(201).json({
            token: tok.token, kwh: tok.kwh, amount, unit_name, voucher_id: sale.voucher_id, sold_at: sale.sold_at,
            remaining: left, flag: lukuLowFlag(left, thr)
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { if (client) client.release(); }
});

app.get('/api/luku/sales', authenticateToken, requireFeature('luku'), allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const params = [req.user.company_id];
    let where = '';
    if (isDateStr(req.query.from)) { params.push(req.query.from); where += ` AND v.sold_at::date >= $${params.length}`; }
    if (isDateStr(req.query.to)) { params.push(req.query.to); where += ` AND v.sold_at::date <= $${params.length}`; }
    const rows = (await pool.query(
        `SELECT v.voucher_id, v.sold_at, COALESCE(v.unit_name, v.meter_number) AS unit_name, v.tenant_name AS customer_name, v.customer_phone, v.amount, v.token_number, v.kwh_units, u.full_name AS sold_by_name
         FROM luku_vouchers v LEFT JOIN users u ON u.user_id = v.sold_by
         WHERE v.company_id = $1 ${where} ORDER BY v.sold_at DESC LIMIT 500`, params
    )).rows;
    res.json(rows);
}));

// remove unsold tokens uploaded by mistake
app.delete('/api/luku/stock', authenticateToken, requireFeature('luku'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
    const { unit_name, price } = req.query;
    if (!unit_name || !(parseFloat(price) > 0)) return res.status(400).json({ error: 'Unit and price are required.' });
    const r = await pool.query("DELETE FROM luku_stock WHERE company_id = $1 AND unit_name = $2 AND price = $3 AND status = 'AVAILABLE' RETURNING stock_id", [req.user.company_id, unit_name, parseFloat(price)]);
    res.json({ message: `${r.rows.length} unsold token(s) removed.` });
}));

app.get('/api/luku/template', authenticateToken, requireFeature('luku'), async (req, res) => {
    // Excel version keeps the token column as Text, so Excel can never round the long numbers
    try {
        const ExcelJS = loadOptional('exceljs');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Tokens');
        ws.columns = [
            { header: 'unit name', key: 'u', width: 18 }, { header: 'token', key: 't', width: 28, style: { numFmt: '@' } },
            { header: 'price', key: 'p', width: 14 }, { header: 'kWh', key: 'k', width: 10 }
        ];
        ws.getRow(1).font = { bold: true };
        ws.addRow({ u: 'A-1', t: '12345678901234567890', p: 5000, k: 18.5 });
        ws.addRow({ u: 'A-1', t: '09876543210987654321', p: 5000, k: 18.5 });
        ws.addRow({ u: 'A-2', t: '11112222333344445555', p: 10000, k: 37 });
        ws.getColumn(2).eachCell(c => { c.numFmt = '@'; });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="luku-tokens-template.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="luku-tokens-template.csv"');
        res.send('unit name,token,price,kwh\r\nA-1,12345678901234567890,5000,18.5\r\nA-1,09876543210987654321,5000,18.5\r\nA-2,11112222333344445555,10000,37\r\n');
    }
});

// ============================================================
// REPORTS (filters: type, from - to, property) -> screen, Excel, PDF
// ============================================================
function qb(cId) { const params = [cId]; return { params, p: (v) => { params.push(v); return '$' + params.length; } }; }
const sum = (rows, k) => rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0);

function monthsBetween(from, to) {
    const out = [];
    let y = parseInt(from.slice(0, 4)), m = parseInt(from.slice(5, 7));
    const ey = parseInt(to.slice(0, 4)), em = parseInt(to.slice(5, 7));
    while ((y < ey || (y === ey && m <= em)) && out.length < 60) {
        out.push(`${y}-${String(m).padStart(2, '0')}`);
        m++; if (m > 12) { m = 1; y++; }
    }
    return out;
}

async function trySql(sql, params) {
    try { return (await pool.query(sql, params)).rows; }
    catch (err) { console.error('Report warning:', err.message); return []; }
}

const OPEN_INVOICES_SQL = (q, extra = '') => `
    SELECT t.full_name AS tenant, t.phone_number AS phone, COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
           inv.invoice_number AS invoice, inv.invoice_type AS type, to_char(inv.due_date, 'YYYY-MM-DD') AS due_date,
           (CURRENT_DATE - inv.due_date::date) AS days_late, inv.amount_due AS total, COALESCE(pay.paid, 0) AS paid,
           inv.amount_due - COALESCE(pay.paid, 0) AS balance
    FROM invoices_tzs inv
    JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id
    JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
    LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
    WHERE inv.company_id = $1 AND inv.amount_due - COALESCE(pay.paid, 0) > 0 ${extra}`;

const REPORTS = {
    summary: {
        label: 'Financial summary', description: 'Billed, collected, expenses and profit month by month', pro: null,
        async run(c) {
            const months = monthsBetween(c.from, c.to);
            const q1 = qb(c.cId), a1 = q1.p(c.from), b1 = q1.p(c.to), pr1 = c.propertyId ? q1.p(c.propertyId) : null;
            const billed = await trySql(
                `SELECT to_char(date_trunc('month', COALESCE(inv.issue_date, inv.created_at::date)), 'YYYY-MM') AS ym, SUM(inv.amount_due) AS v
                 FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN units u ON l.unit_id = u.unit_id
                 WHERE inv.company_id = $1 AND COALESCE(inv.issue_date, inv.created_at::date) BETWEEN ${a1} AND ${b1} ${pr1 ? `AND u.property_id = ${pr1}` : ''} GROUP BY 1`, q1.params);
            const q2 = qb(c.cId), a2 = q2.p(c.from), b2 = q2.p(c.to), pr2 = c.propertyId ? q2.p(c.propertyId) : null;
            const collected = await trySql(
                `SELECT to_char(date_trunc('month', py.payment_date), 'YYYY-MM') AS ym, SUM(py.amount_paid) AS v
                 FROM payments_tzs py JOIN invoices_tzs inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id JOIN units u ON l.unit_id = u.unit_id
                 WHERE py.company_id = $1 AND py.payment_date::date BETWEEN ${a2} AND ${b2} ${pr2 ? `AND u.property_id = ${pr2}` : ''} GROUP BY 1`, q2.params);
            const q3 = qb(c.cId), a3 = q3.p(c.from), b3 = q3.p(c.to), pr3 = c.propertyId ? q3.p(c.propertyId) : null;
            const expenses = await trySql(
                `SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') AS ym, SUM(amount) AS v FROM expenses_tzs
                 WHERE company_id = $1 AND expense_date BETWEEN ${a3} AND ${b3} ${pr3 ? `AND property_id = ${pr3}` : ''} GROUP BY 1`, q3.params);
            const q4 = qb(c.cId);
            const open = await trySql(OPEN_INVOICES_SQL(q4, c.propertyId ? `AND p.property_id = ${q4.p(c.propertyId)}` : ''), q4.params);

            const pick = (arr, ym) => { const r = arr.find(x => x.ym === ym); return r ? parseFloat(r.v) : 0; };
            const rows = months.map(ym => {
                const b = pick(billed, ym), co = pick(collected, ym), ex = pick(expenses, ym);
                return { month: monthLabel(ym), billed: b, collected: co, expenses: ex, net: co - ex };
            });
            const tb = sum(rows, 'billed'), tc = sum(rows, 'collected'), te = sum(rows, 'expenses');
            return {
                columns: [
                    { key: 'month', label: 'Month', type: 'text' }, { key: 'billed', label: 'Billed (invoices)', type: 'money', total: true },
                    { key: 'collected', label: 'Collected (payments)', type: 'money', total: true }, { key: 'expenses', label: 'Expenses', type: 'money', total: true },
                    { key: 'net', label: 'Profit (collected - expenses)', type: 'money', total: true }
                ],
                rows,
                summary: [
                    { label: 'Billed', value: tb, type: 'money' }, { label: 'Collected', value: tc, type: 'money' },
                    { label: 'Expenses', value: te, type: 'money' }, { label: 'Profit', value: tc - te, type: 'money' },
                    { label: 'Collection rate', value: tb > 0 ? Math.round(tc / tb * 100) : 0, type: 'pct' },
                    { label: 'Still owed today (all time)', value: sum(open, 'balance'), type: 'money' }
                ]
            };
        }
    },

    payments: {
        label: 'Payments received', description: 'Every payment (receipt) in the period', pro: null,
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const rows = (await pool.query(
                `SELECT to_char(py.payment_date, 'YYYY-MM-DD') AS date, py.receipt_number AS receipt, t.full_name AS tenant, COALESCE(p.property_name, p.title) AS property,
                        u.unit_number AS unit, inv.invoice_number AS invoice, inv.invoice_type AS type, COALESCE(py.method_detail, py.payment_method) AS method,
                        py.reference_no AS reference, py.amount_paid AS amount
                 FROM payments py JOIN invoices inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
                 JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                 WHERE py.company_id = $1 AND py.payment_date::date BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                 ORDER BY py.payment_date, py.payment_id`, q.params
            )).rows;
            const byMethod = {};
            rows.forEach(r => { byMethod[r.method] = (byMethod[r.method] || 0) + parseFloat(r.amount); });
            return {
                columns: [
                    { key: 'date', label: 'Date', type: 'date' }, { key: 'receipt', label: 'Receipt', type: 'text' }, { key: 'tenant', label: 'Tenant', type: 'text' },
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'invoice', label: 'Invoice', type: 'text' },
                    { key: 'type', label: 'For', type: 'text' }, { key: 'method', label: 'Method', type: 'text' }, { key: 'reference', label: 'Reference', type: 'text' },
                    { key: 'amount', label: 'Amount', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Payments', value: rows.length, type: 'int' }, { label: 'Total received', value: sum(rows, 'amount'), type: 'money' }]
                    .concat(Object.keys(byMethod).map(k => ({ label: k, value: byMethod[k], type: 'money' })))
            };
        }
    },

    invoices: {
        label: 'Invoices issued', description: 'Invoices created in the period with their payment status', pro: null,
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const rows = (await pool.query(
                `SELECT to_char(COALESCE(inv.issue_date, inv.created_at::date), 'YYYY-MM-DD') AS issued, inv.invoice_number AS invoice, t.full_name AS tenant,
                        COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit, inv.invoice_type AS type, COALESCE(inv.description, '') AS description,
                        inv.amount_due AS total, COALESCE(pay.paid, 0) AS paid, inv.amount_due - COALESCE(pay.paid, 0) AS balance,
                        CASE WHEN inv.amount_due - COALESCE(pay.paid, 0) <= 0 THEN 'Paid' WHEN COALESCE(pay.paid, 0) > 0 THEN 'Partial'
                             WHEN inv.due_date < CURRENT_DATE THEN 'Overdue' ELSE 'Unpaid' END AS status
                 FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id
                 JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
                 WHERE inv.company_id = $1 AND COALESCE(inv.issue_date, inv.created_at::date) BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                 ORDER BY COALESCE(inv.issue_date, inv.created_at::date), inv.invoice_id`, q.params
            )).rows;
            return {
                columns: [
                    { key: 'issued', label: 'Issued', type: 'date' }, { key: 'invoice', label: 'Invoice', type: 'text' }, { key: 'tenant', label: 'Tenant', type: 'text' },
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
                    { key: 'description', label: 'Description', type: 'text', wide: true }, { key: 'total', label: 'Total', type: 'money', total: true },
                    { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }, { key: 'status', label: 'Status', type: 'text' }
                ],
                rows,
                summary: [{ label: 'Invoices', value: rows.length, type: 'int' }, { label: 'Billed', value: sum(rows, 'total'), type: 'money' },
                          { label: 'Paid', value: sum(rows, 'paid'), type: 'money' }, { label: 'Balance', value: sum(rows, 'balance'), type: 'money' }]
            };
        }
    },

    outstanding: {
        label: 'Outstanding balances (debtors)', description: 'Who still owes money, invoice by invoice', pro: null,
        async run(c) {
            const q = qb(c.cId);
            let extra = '';
            if (c.propertyId) extra += ` AND p.property_id = ${q.p(c.propertyId)}`;
            if (c.dueOnly) extra += ` AND inv.due_date <= ${q.p(c.to)}`;
            const rows = (await pool.query(`${OPEN_INVOICES_SQL(q, extra)} ORDER BY inv.due_date, t.full_name`, q.params)).rows
                .map(r => ({ ...r, days_late: Math.max(0, parseInt(r.days_late)) }));
            const tenants = new Set(rows.map(r => r.tenant + '|' + r.unit + '|' + r.property)).size;
            return {
                columns: [
                    { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'property', label: 'Property', type: 'text' },
                    { key: 'unit', label: 'Unit', type: 'text' }, { key: 'invoice', label: 'Invoice', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
                    { key: 'due_date', label: 'Due date', type: 'date' }, { key: 'days_late', label: 'Days late', type: 'int' },
                    { key: 'total', label: 'Invoice total', type: 'money', total: true }, { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Tenants owing', value: tenants, type: 'int' }, { label: 'Invoices unpaid', value: rows.length, type: 'int' }, { label: 'Total owed', value: sum(rows, 'balance'), type: 'money' }]
            };
        }
    },

    aging: {
        label: 'Debt age (how late)', description: 'Debts grouped by how many days late: 1-30, 31-60, 61-90, over 90', pro: 'reports_advanced',
        async run(c) {
            const q = qb(c.cId);
            const base = OPEN_INVOICES_SQL(q, c.propertyId ? `AND p.property_id = ${q.p(c.propertyId)}` : '');
            const rows = (await pool.query(
                `SELECT tenant, MAX(phone) AS phone, property, unit,
                        SUM(CASE WHEN days_late <= 0 THEN balance ELSE 0 END) AS not_due,
                        SUM(CASE WHEN days_late BETWEEN 1 AND 30 THEN balance ELSE 0 END) AS d30,
                        SUM(CASE WHEN days_late BETWEEN 31 AND 60 THEN balance ELSE 0 END) AS d60,
                        SUM(CASE WHEN days_late BETWEEN 61 AND 90 THEN balance ELSE 0 END) AS d90,
                        SUM(CASE WHEN days_late > 90 THEN balance ELSE 0 END) AS d90p,
                        SUM(balance) AS total
                 FROM (${base}) x GROUP BY tenant, property, unit ORDER BY total DESC`, q.params
            )).rows;
            return {
                columns: [
                    { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
                    { key: 'not_due', label: 'Not yet due', type: 'money', total: true }, { key: 'd30', label: '1-30 days', type: 'money', total: true },
                    { key: 'd60', label: '31-60 days', type: 'money', total: true }, { key: 'd90', label: '61-90 days', type: 'money', total: true },
                    { key: 'd90p', label: 'Over 90 days', type: 'money', total: true }, { key: 'total', label: 'Total owed', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Tenants owing', value: rows.length, type: 'int' }, { label: 'Total owed', value: sum(rows, 'total'), type: 'money' },
                          { label: 'Over 60 days late', value: sum(rows, 'd90') + sum(rows, 'd90p'), type: 'money' }]
            };
        }
    },

    expenses: {
        label: 'Expenses', description: 'Money spent in the period, by category', pro: null,
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const rows = (await pool.query(
                `SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS date, e.category, e.description, COALESCE(p.property_name, p.title, 'General') AS property, COALESCE(e.payee, '') AS payee, e.amount
                 FROM expenses e LEFT JOIN properties p ON p.property_id = e.property_id
                 WHERE e.company_id = $1 AND e.expense_date BETWEEN ${a} AND ${b} ${pr ? `AND e.property_id = ${pr}` : ''} ORDER BY e.expense_date, e.expense_id`, q.params
            )).rows;
            const byCat = {};
            rows.forEach(r => { byCat[r.category] = (byCat[r.category] || 0) + parseFloat(r.amount); });
            return {
                columns: [
                    { key: 'date', label: 'Date', type: 'date' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'description', label: 'Description', type: 'text', wide: true },
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'payee', label: 'Paid to', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Total expenses', value: sum(rows, 'amount'), type: 'money' }].concat(Object.keys(byCat).map(k => ({ label: k, value: byCat[k], type: 'money' })))
            };
        }
    },

    profit: {
        label: 'Profit by property', description: 'Income, expenses and profit for each property', pro: 'reports_advanced',
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const props = (await pool.query(
                `SELECT COALESCE(p.property_name, p.title) AS property,
                        COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py JOIN invoices_tzs inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
                                  JOIN units u ON l.unit_id = u.unit_id WHERE u.property_id = p.property_id AND py.company_id = $1 AND py.payment_date::date BETWEEN ${a} AND ${b}), 0) AS income,
                        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id) AS units,
                        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.property_id AND u.status = 'OCCUPIED') AS occupied,
                        p.property_id
                 FROM properties p WHERE p.company_id = $1 ${pr ? `AND p.property_id = ${pr}` : ''} ORDER BY property`, q.params
            )).rows;
            const q2 = qb(c.cId), a2 = q2.p(c.from), b2 = q2.p(c.to);
            const exp = await trySql(`SELECT property_id, SUM(amount) AS v FROM expenses_tzs WHERE company_id = $1 AND expense_date BETWEEN ${a2} AND ${b2} GROUP BY property_id`, q2.params);
            const rows = props.map(p => {
                const e = exp.find(x => String(x.property_id) === String(p.property_id));
                const income = parseFloat(p.income), expenses = e ? parseFloat(e.v) : 0;
                return { property: p.property, units: parseInt(p.units), occupied: parseInt(p.occupied), income, expenses, profit: income - expenses };
            });
            if (!c.propertyId) {
                const general = exp.find(x => x.property_id === null);
                if (general) rows.push({ property: 'General (not linked to a property)', units: 0, occupied: 0, income: 0, expenses: parseFloat(general.v), profit: -parseFloat(general.v) });
            }
            return {
                columns: [
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'units', label: 'Units', type: 'int', total: true }, { key: 'occupied', label: 'Occupied', type: 'int', total: true },
                    { key: 'income', label: 'Income (payments)', type: 'money', total: true }, { key: 'expenses', label: 'Expenses', type: 'money', total: true }, { key: 'profit', label: 'Profit', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Income', value: sum(rows, 'income'), type: 'money' }, { label: 'Expenses', value: sum(rows, 'expenses'), type: 'money' }, { label: 'Profit', value: sum(rows, 'profit'), type: 'money' }]
            };
        }
    },

    property_income: {
        label: 'Property income', description: 'Money collected by each property: rent, service charge and other', pro: null,
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const rows = (await pool.query(
                `SELECT COALESCE(p.property_name, p.title) AS property,
                        COALESCE(SUM(CASE WHEN inv.invoice_type = 'RENT' THEN py.amount_paid END), 0) AS rent,
                        COALESCE(SUM(CASE WHEN inv.invoice_type = 'SERVICE' THEN py.amount_paid END), 0) AS service,
                        COALESCE(SUM(CASE WHEN inv.invoice_type NOT IN ('RENT','SERVICE') THEN py.amount_paid END), 0) AS other,
                        COALESCE(SUM(py.amount_paid), 0) AS total, COUNT(py.payment_id) AS payments
                 FROM properties p
                 LEFT JOIN units u ON u.property_id = p.property_id
                 LEFT JOIN leases l ON l.unit_id = u.unit_id
                 LEFT JOIN invoices_tzs inv ON inv.lease_id = l.lease_id
                 LEFT JOIN payments_tzs py ON py.invoice_id = inv.invoice_id AND py.company_id = $1 AND py.payment_date::date BETWEEN ${a} AND ${b}
                 WHERE p.company_id = $1 ${pr ? `AND p.property_id = ${pr}` : ''}
                 GROUP BY p.property_id, p.property_name, p.title ORDER BY total DESC, property`, q.params
            )).rows.map(r => ({ ...r, payments: parseInt(r.payments) }));
            return {
                columns: [
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'rent', label: 'Rent', type: 'money', total: true },
                    { key: 'service', label: 'Service charge', type: 'money', total: true }, { key: 'other', label: 'Other', type: 'money', total: true },
                    { key: 'total', label: 'Total collected', type: 'money', total: true }, { key: 'payments', label: 'Payments', type: 'int', total: true }
                ],
                rows,
                summary: [{ label: 'Total collected', value: sum(rows, 'total'), type: 'money' }, { label: 'Rent', value: sum(rows, 'rent'), type: 'money' },
                          { label: 'Service charge', value: sum(rows, 'service'), type: 'money' }, { label: 'Other', value: sum(rows, 'other'), type: 'money' }]
            };
        }
    },

    maintenance: {
        label: 'Maintenance', description: 'Repair tickets of the period: status, worker and cost', pro: 'tickets',
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const raw = (await pool.query(
                `SELECT to_char(w.created_at, 'YYYY-MM-DD') AS date, w.title, COALESCE(p.property_name, p.title, '') AS property, COALESCE(u.unit_number, '') AS unit,
                        COALESCE(tech.full_name, 'Not assigned') AS technician, w.priority, w.status,
                        COALESCE(w.estimated_cost, 0) AS estimated, COALESCE(w.actual_cost, 0) AS cost,
                        (COALESCE(w.resolved_at, NOW())::date - w.created_at::date) AS days
                 FROM work_orders w
                 LEFT JOIN units u ON u.unit_id = w.unit_id
                 LEFT JOIN properties p ON p.property_id = COALESCE(w.property_id, u.property_id)
                 LEFT JOIN maintenance_workers tech ON tech.worker_id = w.worker_id
                 WHERE COALESCE(w.company_id, u.company_id) = $1 AND w.created_at::date BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                 ORDER BY w.status, w.created_at DESC`, q.params
            )).rows;
            const label = { OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved', CANCELLED: 'Cancelled' };
            const rows = raw.map(r => ({ ...r, status: label[r.status] || r.status, days: parseInt(r.days) || 0 }));
            const cnt = s => rows.filter(r => r.status === s).length;
            const byTech = {};
            rows.filter(r => r.status === 'Open' || r.status === 'In progress').forEach(r => { byTech[r.technician] = (byTech[r.technician] || 0) + 1; });
            return {
                columns: [
                    { key: 'date', label: 'Date', type: 'date' }, { key: 'title', label: 'Problem', type: 'text', wide: true }, { key: 'property', label: 'Property', type: 'text' },
                    { key: 'unit', label: 'Unit', type: 'text' }, { key: 'technician', label: 'Worker', type: 'text' }, { key: 'priority', label: 'Priority', type: 'text' },
                    { key: 'status', label: 'Status', type: 'text' }, { key: 'days', label: 'Days', type: 'int' }, { key: 'estimated', label: 'Estimated', type: 'money', total: true },
                    { key: 'cost', label: 'Actual cost', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Tickets', value: rows.length, type: 'int' }, { label: 'Open', value: cnt('Open'), type: 'int' }, { label: 'In progress', value: cnt('In progress'), type: 'int' },
                          { label: 'Resolved', value: cnt('Resolved'), type: 'int' }, { label: 'Total cost', value: sum(rows, 'cost'), type: 'money' }]
                    .concat(Object.keys(byTech).map(k => ({ label: 'Unfinished - ' + k, value: byTech[k], type: 'int' })))
            };
        }
    },

    tenants: {
        label: 'Tenants list', description: 'All tenants with their latest contract and balance', pro: null,
        async run(c) {
            const q = qb(c.cId);
            const rows = (await pool.query(
                `SELECT * FROM (
                    SELECT DISTINCT ON (t.tenant_id) t.full_name AS tenant, t.phone_number AS phone, COALESCE(t.identity_type, '') || ' ' || COALESCE(t.nida_passport_no, '') AS id_no,
                           COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
                           CASE WHEN l.lease_state = 'CURRENT' THEN 'Active' ELSE 'Moved out' END AS status,
                           to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
                           COALESCE(l.total_to_pay, l.agreed_rent, 0) AS contract_total,
                           (SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments_tzs py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0)
                              FROM invoices_tzs inv JOIN leases l2 ON inv.lease_id = l2.lease_id WHERE l2.tenant_id = t.tenant_id AND inv.company_id = $1) AS balance
                    FROM tenants t JOIN leases l ON l.tenant_id = t.tenant_id JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
                    WHERE t.company_id = $1 ${c.propertyId ? `AND p.property_id = ${q.p(c.propertyId)}` : ''}
                    ORDER BY t.tenant_id, (l.lease_state = 'CURRENT') DESC, l.lease_id DESC
                 ) x ORDER BY (status = 'Active') DESC, tenant`, q.params
            )).rows;
            return {
                columns: [
                    { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'id_no', label: 'ID', type: 'text' },
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
                    { key: 'start_date', label: 'Start', type: 'date' }, { key: 'end_date', label: 'End', type: 'date' },
                    { key: 'contract_total', label: 'Contract total', type: 'money', total: true }, { key: 'balance', label: 'Balance owed', type: 'money', total: true }
                ],
                rows,
                summary: [{ label: 'Tenants', value: rows.length, type: 'int' }, { label: 'Active', value: rows.filter(r => r.status === 'Active').length, type: 'int' }, { label: 'Total owed', value: sum(rows, 'balance'), type: 'money' }]
            };
        }
    },

    occupancy: {
        label: 'Units: occupied and vacant', description: 'Every unit with its status, rent and tenant', pro: null,
        async run(c) {
            const q = qb(c.cId);
            const rows = (await pool.query(
                `SELECT COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
                        CASE u.status WHEN 'OCCUPIED' THEN 'Occupied' WHEN 'VACANT' THEN 'Vacant' ELSE 'Under maintenance' END AS status,
                        u.rent_amount AS rent, COALESCE(u.service_charge, 0) AS service_charge, CASE WHEN COALESCE(u.service_inclusive, false) THEN 'Included in rent' ELSE '' END AS service_note,
                        COALESCE(t.full_name, '') AS tenant, COALESCE(t.phone_number, '') AS phone, COALESCE(to_char(l.end_date, 'YYYY-MM-DD'), '') AS lease_end
                 FROM units u JOIN properties p ON p.property_id = u.property_id
                 LEFT JOIN leases l ON l.unit_id = u.unit_id AND l.lease_state = 'CURRENT' LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
                 WHERE u.company_id = $1 ${c.propertyId ? `AND p.property_id = ${q.p(c.propertyId)}` : ''} ORDER BY p.property_id, u.unit_number`, q.params
            )).rows;
            const occ = rows.filter(r => r.status === 'Occupied').length;
            return {
                columns: [
                    { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
                    { key: 'rent', label: 'Rent', type: 'money' }, { key: 'service_charge', label: 'Service charge', type: 'money' }, { key: 'service_note', label: 'Note', type: 'text' },
                    { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'lease_end', label: 'Contract ends', type: 'date' }
                ],
                rows,
                summary: [{ label: 'Units', value: rows.length, type: 'int' }, { label: 'Occupied', value: occ, type: 'int' }, { label: 'Vacant', value: rows.filter(r => r.status === 'Vacant').length, type: 'int' },
                          { label: 'Occupancy', value: rows.length ? Math.round(occ / rows.length * 100) : 0, type: 'pct' }]
            };
        }
    },

    service: {
        label: 'Service charges', description: 'Service charge invoices of the period: paid and not paid', pro: 'reports_advanced',
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const rows = (await pool.query(
                `SELECT COALESCE(to_char(inv.period_start, 'YYYY-MM'), '') AS month, COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit, t.full_name AS tenant, t.phone_number AS phone,
                        inv.invoice_number AS invoice, inv.amount_due AS total, COALESCE(pay.paid, 0) AS paid, inv.amount_due - COALESCE(pay.paid, 0) AS balance,
                        CASE WHEN inv.amount_due - COALESCE(pay.paid, 0) <= 0 THEN 'Paid' WHEN COALESCE(pay.paid, 0) > 0 THEN 'Partial' ELSE 'Not paid' END AS status
                 FROM invoices_tzs inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
                 WHERE inv.company_id = $1 AND inv.invoice_type = 'SERVICE' AND COALESCE(inv.period_start, inv.issue_date) BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''}
                 ORDER BY inv.period_start, p.property_id, u.unit_number`, q.params
            )).rows;
            return {
                columns: [
                    { key: 'month', label: 'Month', type: 'text' }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'tenant', label: 'Tenant', type: 'text' },
                    { key: 'phone', label: 'Phone', type: 'text' }, { key: 'invoice', label: 'Invoice', type: 'text' }, { key: 'total', label: 'Charge', type: 'money', total: true },
                    { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }, { key: 'status', label: 'Status', type: 'text' }
                ],
                rows,
                summary: [{ label: 'Charges', value: rows.length, type: 'int' }, { label: 'Not fully paid', value: rows.filter(r => r.status !== 'Paid').length, type: 'int' },
                          { label: 'Billed', value: sum(rows, 'total'), type: 'money' }, { label: 'Not paid yet', value: sum(rows, 'balance'), type: 'money' }]
            };
        }
    },

    expiries: {
        label: 'Contracts ending', description: 'Contracts whose end date falls in the period (use it to plan renewals)', pro: 'reports_advanced',
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to), pr = c.propertyId ? q.p(c.propertyId) : null;
            const rows = (await pool.query(
                `SELECT t.full_name AS tenant, t.phone_number AS phone, COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit,
                        to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.end_date, 'YYYY-MM-DD') AS end_date, (l.end_date::date - CURRENT_DATE) AS days_left,
                        COALESCE(l.total_to_pay, l.agreed_rent, 0) AS contract_total
                 FROM leases l JOIN tenants t ON t.tenant_id = l.tenant_id JOIN units u ON u.unit_id = l.unit_id JOIN properties p ON p.property_id = u.property_id
                 WHERE l.company_id = $1 AND l.lease_state = 'CURRENT' AND l.end_date BETWEEN ${a} AND ${b} ${pr ? `AND p.property_id = ${pr}` : ''} ORDER BY l.end_date`, q.params
            )).rows.map(r => ({ ...r, days_left: parseInt(r.days_left) }));
            return {
                columns: [
                    { key: 'tenant', label: 'Tenant', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
                    { key: 'start_date', label: 'Start', type: 'date' }, { key: 'end_date', label: 'Ends', type: 'date' }, { key: 'days_left', label: 'Days left', type: 'int' },
                    { key: 'contract_total', label: 'Contract total', type: 'money' }
                ],
                rows,
                summary: [{ label: 'Contracts ending', value: rows.length, type: 'int' }]
            };
        }
    },

    luku: {
        label: 'Luku sales', description: 'Tokens sold in the period', pro: 'luku',
        async run(c) {
            const q = qb(c.cId), a = q.p(c.from), b = q.p(c.to);
            const rows = (await pool.query(
                `SELECT to_char(v.sold_at, 'YYYY-MM-DD') AS date, COALESCE(v.unit_name, v.meter_number) AS unit, COALESCE(v.tenant_name, '') AS customer, v.amount, v.kwh_units AS kwh, COALESCE(u.full_name, '') AS sold_by
                 FROM luku_vouchers v LEFT JOIN users u ON u.user_id = v.sold_by
                 WHERE v.company_id = $1 AND v.sold_at::date BETWEEN ${a} AND ${b} ORDER BY v.sold_at`, q.params
            )).rows;
            return {
                columns: [
                    { key: 'date', label: 'Date', type: 'date' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'customer', label: 'Customer', type: 'text' },
                    { key: 'amount', label: 'Amount', type: 'money', total: true }, { key: 'kwh', label: 'kWh', type: 'text' }, { key: 'sold_by', label: 'Sold by', type: 'text' }
                ],
                rows,
                summary: [{ label: 'Tokens sold', value: rows.length, type: 'int' }, { label: 'Total sales', value: sum(rows, 'amount'), type: 'money' }]
            };
        }
    }
};

function cleanReportRows(report) {
    report.rows = report.rows.map(r => {
        const o = {};
        report.columns.forEach(col => {
            let v = r[col.key];
            if (v === null || v === undefined) v = col.type === 'money' || col.type === 'int' ? 0 : '';
            if (col.type === 'money') v = Math.round((parseFloat(v) || 0) * 100) / 100;
            else if (col.type === 'int') v = parseInt(v) || 0;
            else v = String(v);
            o[col.key] = v;
        });
        return o;
    });
    return report;
}

async function buildReport(req) {
    const type = REPORTS[req.query.type] ? req.query.type : null;
    if (!type) { const e = new Error('Choose a report.'); e.status = 400; throw e; }
    const def = REPORTS[type];
    if (def.pro && req.user.role !== 'SUPER_ADMIN') {
        const a = await getCompanyAccess(req.user.company_id);
        if (!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null)[def.pro]) {
            const e = new Error('This report is available on the Pro plan. Please contact ' + SUPPORT.name + ' to upgrade.'); e.status = 403; e.code = 'FEATURE_LOCKED'; throw e;
        }
    }
    let from = isDateStr(req.query.from) ? req.query.from : todayStr().slice(0, 7) + '-01';
    let to = isDateStr(req.query.to) ? req.query.to : todayStr();
    if (to < from) { const t = from; from = to; to = t; }
    const cId = req.user.company_id;
    let propertyId = null, propertyName = 'All properties';
    if (req.query.property_id) {
        const p = (await pool.query('SELECT property_id, COALESCE(property_name, title) AS n FROM properties WHERE property_id = $1 AND company_id = $2', [req.query.property_id, cId])).rows[0];
        if (!p) { const e = new Error('Property not found.'); e.status = 404; throw e; }
        propertyId = p.property_id; propertyName = p.n;
    }
    const company = (await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [cId])).rows[0] || {};
    const report = cleanReportRows(await def.run({ cId, from, to, propertyId, dueOnly: req.query.due_only === '1' }));
    return {
        type, title: def.label, company_name: company.company_name || '', property: propertyName, from, to,
        period: `${niceDate(from)} to ${niceDate(to)}`, generated: new Date().toISOString(), ...report
    };
}

app.get('/api/reports/types', authenticateToken, allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
    const a = req.user.role === 'SUPER_ADMIN' ? null : await getCompanyAccess(req.user.company_id);
    const feats = req.user.role === 'SUPER_ADMIN' ? effectiveFeatures('PRO', {}) : effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null);
    res.json(Object.keys(REPORTS).map(k => ({ key: k, label: REPORTS[k].label, description: REPORTS[k].description, locked: !!(REPORTS[k].pro && !feats[REPORTS[k].pro]) })));
}));

app.get('/api/reports/run', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try { res.json(await buildReport(req)); }
    catch (err) { if (!err.status) console.error('Report error:', err); res.status(err.status || 500).json({ error: err.message, code: err.code }); }
});

// ---- Excel ----
function toExcelValue(v, type) {
    if (type === 'date' && isDateStr(v)) return new Date(v + 'T00:00:00Z');
    return v;
}
async function writeWorkbookTo(res, filename, sheets) {
    const ExcelJS = loadOptional('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KEY ARCH'; wb.created = new Date();
    for (const sh of sheets) {
        const ws = wb.addWorksheet(String(sh.name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
        let r = 1;
        (sh.heading || []).forEach((line, i) => {
            const row = ws.getRow(r++); row.getCell(1).value = line;
            row.getCell(1).font = i === 0 ? { bold: true, size: 14 } : (i === 1 ? { bold: true, size: 12 } : { color: { argb: 'FF555555' } });
        });
        if ((sh.summary || []).length) {
            r++;
            sh.summary.forEach(s => {
                const row = ws.getRow(r++);
                row.getCell(1).value = s.label; row.getCell(1).font = { bold: true };
                row.getCell(2).value = s.value;
                if (s.type === 'money') row.getCell(2).numFmt = '#,##0.##';
                if (s.type === 'pct') row.getCell(2).numFmt = '0"%"';
                row.getCell(2).alignment = { horizontal: 'left' };
            });
        }
        r++;
        const headerRow = r;
        const hr = ws.getRow(r++);
        sh.columns.forEach((c, i) => {
            const cell = hr.getCell(i + 1);
            cell.value = c.label;
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
            cell.alignment = { horizontal: c.type === 'money' || c.type === 'int' ? 'right' : 'left', vertical: 'middle' };
        });
        sh.rows.forEach(rowData => {
            const row = ws.getRow(r++);
            sh.columns.forEach((c, i) => {
                const cell = row.getCell(i + 1);
                cell.value = toExcelValue(rowData[c.key], c.type);
                if (c.type === 'money') cell.numFmt = '#,##0.##';
                else if (c.type === 'int') cell.numFmt = '#,##0';
                else if (c.type === 'date') cell.numFmt = 'dd mmm yyyy';
            });
        });
        if (sh.columns.some(c => c.total) && sh.rows.length) {
            const tr = ws.getRow(r++);
            sh.columns.forEach((c, i) => {
                const cell = tr.getCell(i + 1);
                cell.font = { bold: true };
                cell.border = { top: { style: 'thin' } };
                if (i === 0) cell.value = 'TOTAL';
                if (c.total) { cell.value = Math.round(sh.rows.reduce((s, x) => s + (parseFloat(x[c.key]) || 0), 0) * 100) / 100; cell.numFmt = '#,##0.##'; }
            });
        }
        sh.columns.forEach((c, i) => {
            let w = String(c.label).length + 2;
            sh.rows.slice(0, 200).forEach(x => { w = Math.max(w, String(x[c.key] === undefined ? '' : x[c.key]).length + 2); });
            ws.getColumn(i + 1).width = Math.min(Math.max(w, 10), c.wide ? 60 : 32);
        });
        ws.views = [{ state: 'frozen', ySplit: headerRow }];
        if (sh.rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: sh.columns.length } };
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
}

// ---- PDF ----
function pdfText(v, type) {
    if (type === 'money') return fmtMoney(v);
    if (type === 'int') return String(v);
    if (type === 'date') return isDateStr(v) ? niceDate(v) : String(v || '');
    return String(v === undefined || v === null ? '' : v);
}
function writeReportPdf(res, filename, rep) {
    const PDFDocument = loadOptional('pdfkit');
    const cols = rep.columns;
    const landscape = cols.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 32, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const weight = c => (c.wide ? 3 : c.type === 'money' ? 1.5 : c.type === 'date' ? 1.2 : c.type === 'int' ? 0.8 : 1.6);
    const totalW = cols.reduce((s, c) => s + weight(c), 0);
    const widths = cols.map(c => usable * weight(c) / totalW);
    const rowH = 17;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 24;

    doc.fillColor('#111').font('Helvetica-Bold').fontSize(15).text(rep.company_name || 'Report', left, doc.y);
    doc.font('Helvetica-Bold').fontSize(12).text(rep.title);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(`Period: ${rep.period}   |   ${rep.property}`);
    doc.moveDown(0.6);

    if (rep.summary && rep.summary.length) {
        rep.summary.forEach(s => {
            const val = s.type === 'money' ? fmtMoney(s.value) : (s.type === 'pct' ? s.value + '%' : String(s.value));
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(`${s.label}: `, { continued: true }).font('Helvetica').text(val);
        });
        doc.moveDown(0.6);
    }

    let y = doc.y;
    const drawHeader = () => {
        doc.save().rect(left, y, usable, rowH).fill('#1F3A5F').restore();
        let x = left;
        cols.forEach((c, i) => {
            doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8)
               .text(c.label, x + 3, y + 5, { width: widths[i] - 6, height: rowH - 5, ellipsis: true, lineBreak: false, align: (c.type === 'money' || c.type === 'int') ? 'right' : 'left' });
            x += widths[i];
        });
        y += rowH;
    };
    drawHeader();

    const drawRow = (data, bold, shade) => {
        if (y + rowH > bottom()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
        if (shade) doc.save().rect(left, y, usable, rowH).fill('#F1F4F8').restore();
        let x = left;
        cols.forEach((c, i) => {
            doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
               .text(data[i], x + 3, y + 5, { width: widths[i] - 6, height: rowH - 5, ellipsis: true, lineBreak: false, align: (c.type === 'money' || c.type === 'int') ? 'right' : 'left' });
            x += widths[i];
        });
        y += rowH;
    };
    rep.rows.forEach((r, idx) => drawRow(cols.map(c => pdfText(r[c.key], c.type)), false, idx % 2 === 1));
    if (cols.some(c => c.total) && rep.rows.length) {
        drawRow(cols.map((c, i) => c.total ? pdfText(Math.round(rep.rows.reduce((s, x) => s + (parseFloat(x[c.key]) || 0), 0) * 100) / 100, c.type) : (i === 0 ? 'TOTAL' : '')), true, false);
    }
    if (rep.rows.length === 0) { doc.fillColor('#555').font('Helvetica').fontSize(10).text('No records for this period.', left, y + 8); }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#777').font('Helvetica').fontSize(8)
           .text(`Page ${i + 1} of ${range.count}   |   Generated ${niceDate(todayStr())}   |   KEY ARCH`, left, doc.page.height - doc.page.margins.bottom + 6,
                 { width: usable, align: 'center', lineBreak: false });
    }
    doc.end();
}

app.get('/api/reports/export', authenticateToken, allowRoles(...R_VIEW_MONEY), async (req, res) => {
    try {
        const rep = await buildReport(req);
        const base = `${rep.type}-${rep.from}-to-${rep.to}`;
        if (req.query.format === 'pdf') return writeReportPdf(res, base + '.pdf', rep);
        await writeWorkbookTo(res, base + '.xlsx', [{
            name: rep.title, heading: [rep.company_name, rep.title, `Period: ${rep.period}   |   ${rep.property}`],
            summary: rep.summary, columns: rep.columns, rows: rep.rows
        }]);
    } catch (err) {
        if (!err.status) console.error('Report export error:', err);
        if (!res.headersSent) res.status(err.status || (err.code === 'MISSING_PACKAGE' ? 501 : 500)).json({ error: err.message, code: err.code });
        else res.end();
    }
});


// ============================================================
// FINANCE (accountant's small finance system)
// Accounts, manual income, one ledger of every money movement, reports to PDF / Excel
// ============================================================
const INCOME_CATEGORIES = ['RENT', 'DEPOSIT', 'SERVICE', 'LUKU', 'INTEREST', 'SALE', 'OTHER'];

app.get('/api/finance/accounts', authenticateToken, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
    const cId = req.user.company_id;
    const rows = (await pool.query(
        `SELECT a.account_id, a.name, a.currency, a.kind, a.opening_balance, a.is_active, a.created_at,
                COALESCE((SELECT SUM(COALESCE(received_amount, amount_paid)) FROM payments WHERE account_id = a.account_id AND company_id = $1), 0) AS rent_in,
                COALESCE((SELECT SUM(amount) FROM finance_income WHERE account_id = a.account_id AND company_id = $1), 0) AS other_in,
                COALESCE((SELECT SUM(amount) FROM expenses WHERE account_id = a.account_id AND company_id = $1), 0) AS spent
         FROM finance_accounts a WHERE a.company_id = $1 ORDER BY a.is_active DESC, a.currency, a.name`, [cId]
    )).rows;
    const canSee = req.user.role !== 'PROPERTY_MANAGER';
    res.json(rows.map(r => {
        const inn = parseFloat(r.rent_in) + parseFloat(r.other_in), out = parseFloat(r.spent), open = parseFloat(r.opening_balance);
        const o = { account_id: r.account_id, name: r.name, currency: r.currency, kind: r.kind, is_active: r.is_active };
        if (canSee) Object.assign(o, { opening_balance: open, money_in: inn, money_out: out, balance: Math.round((open + inn - out) * 100) / 100 });
        return o;
    }));
}));

function readAccountBody(b) {
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) return { error: 'Please give the account a name.' };
    const opening = b.opening_balance === undefined || b.opening_balance === '' ? 0 : parseFloat(b.opening_balance);
    if (isNaN(opening)) return { error: 'Opening balance must be a number.' };
    const kind = ['CASH', 'BANK', 'MOBILE', 'OTHER'].includes(b.kind) ? b.kind : 'CASH';
    return { value: { name, currency: cleanCur(b.currency), kind, opening } };
}

app.post('/api/finance/accounts', authenticateToken, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
    const r = readAccountBody(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const v = r.value;
    const dup = await pool.query('SELECT 1 FROM finance_accounts WHERE company_id = $1 AND LOWER(name) = LOWER($2) AND currency = $3', [req.user.company_id, v.name, v.currency]);
    if (dup.rows.length) return res.status(400).json({ error: 'You already have an account with this name and currency.' });
    const ins = await pool.query(
        'INSERT INTO finance_accounts (company_id, name, currency, kind, opening_balance, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING account_id',
        [req.user.company_id, v.name, v.currency, v.kind, v.opening, req.user.user_id]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Created Finance Account', 'FINANCE', req.ip, { account_id: ins.rows[0].account_id, name: v.name });
    res.status(201).json({ message: 'Account created.', account_id: ins.rows[0].account_id });
}));

app.put('/api/finance/accounts/:id', authenticateToken, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
    const r = readAccountBody(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const v = r.value;
    const cur = (await pool.query('SELECT currency FROM finance_accounts WHERE account_id = $1 AND company_id = $2', [req.params.id, req.user.company_id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Account not found.' });
    if (cur.currency !== v.currency) {
        const used = await pool.query(
            `SELECT (SELECT COUNT(*) FROM payments WHERE account_id = $1) + (SELECT COUNT(*) FROM expenses WHERE account_id = $1) + (SELECT COUNT(*) FROM finance_income WHERE account_id = $1) AS n`, [req.params.id]);
        if (parseInt(used.rows[0].n) > 0) return res.status(400).json({ error: 'The currency cannot be changed because this account already has records.' });
    }
    await pool.query('UPDATE finance_accounts SET name = $1, currency = $2, kind = $3, opening_balance = $4, is_active = $5 WHERE account_id = $6 AND company_id = $7',
        [v.name, v.currency, v.kind, v.opening, req.body.is_active === false ? false : true, req.params.id, req.user.company_id]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Finance Account', 'FINANCE', req.ip, { account_id: req.params.id });
    res.json({ message: 'Account saved.' });
}));

app.delete('/api/finance/accounts/:id', authenticateToken, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
    const used = await pool.query(
        `SELECT (SELECT COUNT(*) FROM payments WHERE account_id = $1) + (SELECT COUNT(*) FROM expenses WHERE account_id = $1) + (SELECT COUNT(*) FROM finance_income WHERE account_id = $1) AS n`, [req.params.id]);
    if (parseInt(used.rows[0].n) > 0) {
        const c = await pool.query('UPDATE finance_accounts SET is_active = false WHERE account_id = $1 AND company_id = $2 RETURNING account_id', [req.params.id, req.user.company_id]);
        if (!c.rows.length) return res.status(404).json({ error: 'Account not found.' });
        return res.json({ message: 'This account has records, so it was closed (hidden from new entries) instead of deleted.', closed: true });
    }
    const d = await pool.query('DELETE FROM finance_accounts WHERE account_id = $1 AND company_id = $2 RETURNING account_id', [req.params.id, req.user.company_id]);
    if (!d.rows.length) return res.status(404).json({ error: 'Account not found.' });
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Finance Account', 'FINANCE', req.ip, { account_id: req.params.id });
    res.json({ message: 'Account deleted.' });
}));

// ---- manual income (money that is not a tenant invoice payment)
function readIncomeBody(b) {
    const amount = parseFloat(b.amount);
    if (!String(b.description || '').trim()) return { error: 'Please describe the income.' };
    if (!(amount > 0)) return { error: 'Amount must be greater than 0.' };
    const date = isDateStr(b.income_date) ? b.income_date : todayStr();
    if (date > todayStr()) return { error: 'Income date cannot be in the future.' };
    return { value: { description: String(b.description).trim(), amount, currency: cleanCur(b.currency), account_id: b.account_id || null,
        category: INCOME_CATEGORIES.includes(b.category) ? b.category : 'OTHER', date, property_id: b.property_id || null,
        payer: String(b.payer || '').trim() || null, reference: String(b.reference || '').trim().slice(0, 100) || null, notes: String(b.notes || '').trim() || null } };
}
async function checkPropertyOwn(companyId, propertyId) {
    if (!propertyId) return;
    const ok = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [propertyId, companyId]);
    if (!ok.rows.length) { const e = new Error('Property not found.'); e.status = 404; throw e; }
}
app.post('/api/finance/income', authenticateToken, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
    const r = readIncomeBody(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const v = r.value;
    await checkPropertyOwn(req.user.company_id, v.property_id);
    const acc = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
    const ins = await pool.query(
        `INSERT INTO finance_income (company_id, account_id, property_id, description, amount, currency, category, income_date, payer, reference, notes, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING income_id`,
        [req.user.company_id, acc, v.property_id, v.description, v.amount, v.currency, v.category, v.date, v.payer, v.reference, v.notes, req.user.user_id]);
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Recorded Income', 'FINANCE', req.ip, { income_id: ins.rows[0].income_id, amount: v.amount, currency: v.currency });
    res.status(201).json({ message: 'Income saved.', income_id: ins.rows[0].income_id });
}));
app.put('/api/finance/income/:id', authenticateToken, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
    const r = readIncomeBody(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const v = r.value;
    await checkPropertyOwn(req.user.company_id, v.property_id);
    const acc = await checkAccount(pool, req.user.company_id, v.account_id, v.currency);
    const u = await pool.query(
        `UPDATE finance_income SET account_id = $1, property_id = $2, description = $3, amount = $4, currency = $5, category = $6, income_date = $7, payer = $8, reference = $9, notes = $10
         WHERE income_id = $11 AND company_id = $12 RETURNING income_id`,
        [acc, v.property_id, v.description, v.amount, v.currency, v.category, v.date, v.payer, v.reference, v.notes, req.params.id, req.user.company_id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Income record not found.' });
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Edited Income', 'FINANCE', req.ip, { income_id: req.params.id });
    res.json({ message: 'Income updated.' });
}));
app.delete('/api/finance/income/:id', authenticateToken, allowRoles(...R_FIN_WRITE), wrapAsync(async (req, res) => {
    const d = await pool.query('DELETE FROM finance_income WHERE income_id = $1 AND company_id = $2 RETURNING income_id', [req.params.id, req.user.company_id]);
    if (!d.rows.length) return res.status(404).json({ error: 'Income record not found.' });
    await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Deleted Income', 'FINANCE', req.ip, { income_id: req.params.id });
    res.json({ message: 'Income deleted.' });
}));

// ---- the ledger: every shilling and dollar in and out, with filters
const idList = v => String(v || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 0);

async function buildLedger(req) {
    const cId = req.user.company_id;
    const q = req.query;
    const to = isDateStr(q.to) ? q.to : todayStr();
    const from = isDateStr(q.from) ? q.from : to.slice(0, 8) + '01';
    const cur = ['TZS', 'USD'].includes(String(q.currency || '').toUpperCase()) ? String(q.currency).toUpperCase() : 'ALL';
    const props = idList(q.property_ids), units = idList(q.unit_ids);
    const accountId = parseInt(q.account_id, 10) || null;
    const kind = ['income', 'expense'].includes(q.kind) ? q.kind : 'all';
    const group = ['day', 'week', 'month', 'year'].includes(q.group) ? q.group : 'month';
    const wantLuku = q.luku !== '0';

    const rows = [];
    const bind = (arr, v) => { arr.push(v); return '$' + arr.length; };

    if (kind !== 'expense') {
        // rent / invoice payments
        const a = [cId, from, to];
        let w = ' AND py.payment_date::date BETWEEN $2 AND $3';
        if (cur !== 'ALL') w += ` AND COALESCE(py.received_currency, py.currency, 'TZS') = ${bind(a, cur)}`;
        if (props.length) w += ` AND p.property_id = ANY(${bind(a, props)}::int[])`;
        if (units.length) w += ` AND u.unit_id = ANY(${bind(a, units)}::int[])`;
        if (accountId) w += ` AND py.account_id = ${bind(a, accountId)}`;
        const r1 = await pool.query(
            `SELECT py.payment_id, py.payment_date::date AS date, COALESCE(py.received_amount, py.amount_paid) AS amount, COALESCE(py.received_currency, py.currency, 'TZS') AS currency, py.account_id, fa.name AS account_name,
                    py.receipt_number, py.payment_method, inv.invoice_type, inv.invoice_number, t.full_name AS tenant_name, u.unit_id, u.unit_number,
                    p.property_id, COALESCE(p.property_name, p.title) AS property_name
             FROM payments py JOIN invoices inv ON py.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
             JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id
             LEFT JOIN finance_accounts fa ON fa.account_id = py.account_id
             WHERE py.company_id = $1 ${w} ORDER BY py.payment_date DESC LIMIT 20000`, a);
        r1.rows.forEach(r => rows.push({
            id: 'P' + r.payment_id, type: 'INCOME', source: 'PAYMENT', date: String(r.date).slice(0, 10), category: r.invoice_type || 'RENT',
            description: `${r.tenant_name} - ${r.invoice_number}${r.receipt_number ? ' (' + r.receipt_number + ')' : ''}`,
            property_id: r.property_id, property: r.property_name, unit_id: r.unit_id, unit: r.unit_number, account_id: r.account_id, account: r.account_name || '',
            currency: r.currency, amount: parseFloat(r.amount), reference: r.receipt_number || '', payment_id: r.payment_id }));

        // other income (manual)
        if (!units.length) {
            const b = [cId, from, to];
            let w2 = ' AND fi.income_date BETWEEN $2 AND $3';
            if (cur !== 'ALL') w2 += ` AND fi.currency = ${bind(b, cur)}`;
            if (props.length) w2 += ` AND fi.property_id = ANY(${bind(b, props)}::int[])`;
            if (accountId) w2 += ` AND fi.account_id = ${bind(b, accountId)}`;
            const r2 = await pool.query(
                `SELECT fi.*, fa.name AS account_name, COALESCE(p.property_name, p.title) AS property_name
                 FROM finance_income fi LEFT JOIN finance_accounts fa ON fa.account_id = fi.account_id LEFT JOIN properties p ON p.property_id = fi.property_id
                 WHERE fi.company_id = $1 ${w2} ORDER BY fi.income_date DESC LIMIT 20000`, b);
            r2.rows.forEach(r => rows.push({
                id: 'I' + r.income_id, type: 'INCOME', source: 'MANUAL', date: String(r.income_date).slice(0, 10), category: r.category,
                description: r.description + (r.payer ? ' - ' + r.payer : ''), property_id: r.property_id, property: r.property_name || '', unit_id: null, unit: '',
                account_id: r.account_id, account: r.account_name || '', currency: r.currency, amount: parseFloat(r.amount), reference: r.reference || '', income_id: r.income_id, raw: r.description, party: r.payer || '', notes: r.notes || '' }));
        }

        // Luku (electricity token) sales are in TSh and are not tied to a property
        if (wantLuku && !props.length && !units.length && !accountId && cur !== 'USD') {
            try {
                const r3 = await pool.query(
                    `SELECT voucher_id, sold_at::date AS date, amount, tenant_name, unit_name, meter_number
                     FROM luku_vouchers WHERE company_id = $1 AND sold_at IS NOT NULL AND sold_at::date BETWEEN $2 AND $3 ORDER BY sold_at DESC LIMIT 20000`, [cId, from, to]);
                r3.rows.forEach(r => rows.push({
                    id: 'L' + r.voucher_id, type: 'INCOME', source: 'LUKU', date: String(r.date).slice(0, 10), category: 'LUKU',
                    description: `Luku ${r.meter_number || ''} - ${r.tenant_name || r.unit_name || ''}`.trim(), property_id: null, property: '', unit_id: null, unit: r.unit_name || '',
                    account_id: null, account: '', currency: 'TZS', amount: parseFloat(r.amount), reference: '' }));
            } catch (e) { /* no luku table yet: skip */ }
        }
    }

    if (kind !== 'income' && !units.length) {   // expenses are not tied to a unit, so a unit filter leaves them out
        const a = [cId, from, to];
        let w = ' AND e.expense_date BETWEEN $2 AND $3';
        if (cur !== 'ALL') w += ` AND COALESCE(e.currency, 'TZS') = ${bind(a, cur)}`;
        if (props.length) w += ` AND e.property_id = ANY(${bind(a, props)}::int[])`;
        if (accountId) w += ` AND e.account_id = ${bind(a, accountId)}`;
        const r4 = await pool.query(
            `SELECT e.*, COALESCE(e.currency, 'TZS') AS cur, fa.name AS account_name, COALESCE(p.property_name, p.title) AS property_name
             FROM expenses e LEFT JOIN finance_accounts fa ON fa.account_id = e.account_id LEFT JOIN properties p ON p.property_id = e.property_id
             WHERE e.company_id = $1 ${w} ORDER BY e.expense_date DESC LIMIT 20000`, a);
        r4.rows.forEach(r => rows.push({
            id: 'E' + r.expense_id, type: 'EXPENSE', source: 'EXPENSE', date: String(r.expense_date).slice(0, 10), category: r.category,
            description: r.description + (r.payee ? ' - ' + r.payee : ''), property_id: r.property_id, property: r.property_name || '', unit_id: null, unit: '',
            account_id: r.account_id, account: r.account_name || '', currency: r.cur, amount: parseFloat(r.amount), reference: '', expense_id: r.expense_id, raw: r.description, party: r.payee || '', notes: r.notes || '' }));
    }

    rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));

    // totals per currency, by category, account and source, and a time series
    const round2 = n => Math.round(n * 100) / 100;
    const totals = {};
    const ensure = c => (totals[c] = totals[c] || { income: 0, expense: 0, net: 0 });
    const byCategory = {}, byAccount = {}, bySource = {}, series = {};
    const periodKey = d => {
        if (group === 'day') return d;
        if (group === 'year') return d.slice(0, 4);
        if (group === 'month') return d.slice(0, 7);
        const dt = new Date(d + 'T00:00:00Z'); const wd = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - wd);
        return dt.toISOString().slice(0, 10);
    };
    rows.forEach(r => {
        const t = ensure(r.currency), isIn = r.type === 'INCOME';
        t[isIn ? 'income' : 'expense'] += r.amount;
        const ck = `${r.type}|${r.category}|${r.currency}`;
        byCategory[ck] = byCategory[ck] || { type: r.type, category: r.category, currency: r.currency, total: 0 }; byCategory[ck].total += r.amount;
        const ak = `${r.account_id || 0}|${r.currency}`;
        byAccount[ak] = byAccount[ak] || { account_id: r.account_id, account: r.account || '(no account)', currency: r.currency, income: 0, expense: 0 };
        byAccount[ak][isIn ? 'income' : 'expense'] += r.amount;
        const sk = `${r.source}|${r.currency}`;
        bySource[sk] = bySource[sk] || { source: r.source, currency: r.currency, total: 0 }; bySource[sk].total += r.amount;
        const pk = `${periodKey(r.date)}|${r.currency}`;
        series[pk] = series[pk] || { period: periodKey(r.date), currency: r.currency, income: 0, expense: 0 };
        series[pk][isIn ? 'income' : 'expense'] += r.amount;
    });
    Object.values(totals).forEach(t => { t.income = round2(t.income); t.expense = round2(t.expense); t.net = round2(t.income - t.expense); });
    const fix = o => Object.values(o).map(x => { Object.keys(x).forEach(k => { if (typeof x[k] === 'number' && k !== 'account_id') x[k] = round2(x[k]); }); return x; });
    const company = (await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [cId])).rows[0] || {};
    return {
        from, to, currency: cur, group, kind, company_name: company.company_name || '', property_ids: props, unit_ids: units, account_id: accountId,
        totals, rows: rows.slice(0, 5000), row_count: rows.length, truncated: rows.length > 5000,
        by_category: fix(byCategory), by_account: fix(byAccount), by_source: fix(bySource), series: fix(series).sort((x, y) => (x.period < y.period ? -1 : 1))
    };
}

app.get('/api/finance/ledger', authenticateToken, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
    res.json(await buildLedger(req));
}));

// units for the filter (all units of the chosen properties)
app.get('/api/finance/units', authenticateToken, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
    const props = idList(req.query.property_ids);
    const a = [req.user.company_id]; let w = '';
    if (props.length) { a.push(props); w = ' AND u.property_id = ANY($2::int[])'; }
    const rows = (await pool.query(
        `SELECT u.unit_id, u.unit_number, u.property_id, COALESCE(p.property_name, p.title) AS property_name
         FROM units u JOIN properties p ON p.property_id = u.property_id WHERE u.company_id = $1 ${w} ORDER BY p.property_id, u.unit_number LIMIT 2000`, a)).rows;
    res.json(rows);
}));

// Quick review for the top of the Finance page: this month and this year, one block per currency
app.get('/api/finance/overview', authenticateToken, allowRoles(...R_FIN_VIEW), wrapAsync(async (req, res) => {
    const t = todayStr();
    const mk = async (from) => (await buildLedger({ user: req.user, query: { from, to: t, currency: 'ALL', kind: 'all', group: 'month' } }));
    const month = await mk(t.slice(0, 8) + '01'), year = await mk(t.slice(0, 5) + '01-01');
    // the whole previous month, to show whether this month is going up or down
    const first = new Date(t.slice(0, 8) + '01T00:00:00Z'); const pEnd = new Date(first.getTime() - 86400000), pStart = new Date(Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth(), 1));
    const prev = await buildLedger({ user: req.user, query: { from: pStart.toISOString().slice(0, 10), to: pEnd.toISOString().slice(0, 10), currency: 'ALL', kind: 'all', group: 'month' } });
    const out = { today: t, TZS: {}, USD: {} };
    ['TZS', 'USD'].forEach(c => {
        const m = month.totals[c] || { income: 0, expense: 0 }, y = year.totals[c] || { income: 0, expense: 0 }, pv = prev.totals[c] || { income: 0, expense: 0 };
        out[c] = { month_income: m.income, month_expense: m.expense, year_income: y.income, year_expense: y.expense, prev_income: pv.income, prev_expense: pv.expense };
    });
    res.json(out);
}));

function ledgerReport(L, view) {
    const periodLabel = `${niceDate(L.from)} - ${niceDate(L.to)}`;
    const summary = [];
    Object.keys(L.totals).sort().forEach(c => {
        summary.push({ label: `${c} income`, value: L.totals[c].income, type: 'money' });
        summary.push({ label: `${c} expenses`, value: L.totals[c].expense, type: 'money' });
        summary.push({ label: `${c} net`, value: L.totals[c].net, type: 'money' });
    });
    const single = L.currency !== 'ALL';
    let columns, rows, title;
    if (view === 'summary') {
        title = 'Income and expenses summary';
        columns = [{ key: 'period', label: 'Period', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
                   { key: 'income', label: 'Income', type: 'money', total: single }, { key: 'expense', label: 'Expenses', type: 'money', total: single },
                   { key: 'net', label: 'Net', type: 'money', total: single }];
        rows = L.series.map(x => ({ period: x.period, currency: x.currency, income: x.income, expense: x.expense, net: Math.round((x.income - x.expense) * 100) / 100 }));
    } else if (view === 'accounts') {
        title = 'Accounts report';
        columns = [{ key: 'account', label: 'Account', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
                   { key: 'income', label: 'Money in', type: 'money', total: single }, { key: 'expense', label: 'Money out', type: 'money', total: single },
                   { key: 'net', label: 'Net', type: 'money', total: single }];
        rows = L.by_account.map(x => ({ account: x.account, currency: x.currency, income: x.income, expense: x.expense, net: Math.round((x.income - x.expense) * 100) / 100 }));
    } else {
        title = view === 'expenses' ? 'Expenses report' : view === 'income' ? 'Income report' : 'Finance statement';
        columns = [{ key: 'date', label: 'Date', type: 'date' }, { key: 'type', label: 'Type', type: 'text' }, { key: 'category', label: 'Category', type: 'text' },
                   { key: 'description', label: 'Description', type: 'text', wide: true }, { key: 'property', label: 'Property', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
                   { key: 'account', label: 'Account', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
                   { key: 'income', label: 'Income', type: 'money', total: single }, { key: 'expense', label: 'Expense', type: 'money', total: single }];
        rows = L.rows.map(r => ({ date: r.date, type: r.type === 'INCOME' ? 'Income' : 'Expense', category: r.category, description: r.description, property: r.property, unit: r.unit,
            account: r.account, currency: r.currency, income: r.type === 'INCOME' ? r.amount : 0, expense: r.type === 'EXPENSE' ? r.amount : 0 }));
    }
    return { type: 'finance-' + view, title, company_name: L.company_name, period: periodLabel, property: L.property_ids.length ? `${L.property_ids.length} propert${L.property_ids.length === 1 ? 'y' : 'ies'} selected` : 'All properties',
             from: L.from, to: L.to, summary, columns, rows };
}

app.get('/api/finance/export', authenticateToken, allowRoles(...R_FIN_VIEW), async (req, res) => {
    try {
        const L = await buildLedger(req);
        const view = ['statement', 'summary', 'accounts', 'income', 'expenses'].includes(req.query.view) ? req.query.view : 'statement';
        const k = view === 'income' ? 'income' : view === 'expenses' ? 'expense' : null;
        if (k && L.kind === 'all') { L.rows = L.rows.filter(r => r.type === (k === 'income' ? 'INCOME' : 'EXPENSE')); }
        const rep = ledgerReport(L, view);
        const base = `finance-${view}-${L.from}-to-${L.to}`;
        if (req.query.format === 'pdf') return writeReportPdf(res, base + '.pdf', rep);
        await writeWorkbookTo(res, base + '.xlsx', [{
            name: rep.title, heading: [rep.company_name, rep.title, `Period: ${rep.period}   |   ${rep.property}`],
            summary: rep.summary, columns: rep.columns, rows: rep.rows }]);
    } catch (err) {
        if (!err.status) console.error('Finance export error:', err);
        if (!res.headersSent) res.status(err.status || (err.code === 'MISSING_PACKAGE' ? 501 : 500)).json({ error: err.message, code: err.code });
        else res.end();
    }
});

// ============================================================
// BACKUP (everything the company has, as one Excel file)
// Standard plan: tenants + payments.  Pro plan: all data.
// ============================================================
app.get('/api/backup/export', authenticateToken, allowRoles(...R_ADMIN), async (req, res) => {
    try {
        const cId = req.user.company_id;
        let full = req.user.role === 'SUPER_ADMIN';
        if (!full) {
            const a = await getCompanyAccess(cId);
            full = !!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null).backup_full;
        }
        const text = (k, l, extra) => ({ key: k, label: l, type: 'text', ...(extra || {}) });
        const money = (k, l) => ({ key: k, label: l, type: 'money' });
        const date = (k, l) => ({ key: k, label: l, type: 'date' });
        const q = async (sql) => (await pool.query(sql, [cId])).rows.map(r => { const o = {}; Object.keys(r).forEach(k => { o[k] = r[k] instanceof Date ? r[k].toISOString().slice(0, 10) : (r[k] === null ? '' : r[k]); }); return o; });

        const sheets = [];
        sheets.push({ name: 'Tenants', columns: [text('name', 'Name'), text('phone', 'Phone'), text('id_type', 'ID type'), text('id_no', 'ID number'), text('property', 'Property'), text('unit', 'Unit'), text('status', 'Status'), date('start', 'Start'), date('end', 'End'), money('total', 'Contract total')],
            rows: await q(`SELECT * FROM (SELECT DISTINCT ON (t.tenant_id) t.full_name AS name, t.phone_number AS phone, t.identity_type AS id_type, t.nida_passport_no AS id_no,
                    COALESCE(p.property_name, p.title) AS property, u.unit_number AS unit, l.lease_state AS status, to_char(l.start_date,'YYYY-MM-DD') AS start, to_char(l.end_date,'YYYY-MM-DD') AS "end",
                    COALESCE(l.total_to_pay, l.agreed_rent, 0) AS total
                 FROM tenants t LEFT JOIN leases l ON l.tenant_id = t.tenant_id LEFT JOIN units u ON u.unit_id = l.unit_id LEFT JOIN properties p ON p.property_id = u.property_id
                 WHERE t.company_id = $1 ORDER BY t.tenant_id, (l.lease_state = 'CURRENT') DESC, l.lease_id DESC) x ORDER BY name`) });
        sheets.push({ name: 'Payments', columns: [date('date', 'Date'), text('receipt', 'Receipt'), text('tenant', 'Tenant'), text('invoice', 'Invoice'), text('method', 'Method'), text('reference', 'Reference'), money('amount', 'Amount')],
            rows: await q(`SELECT to_char(py.payment_date,'YYYY-MM-DD') AS date, py.receipt_number AS receipt, t.full_name AS tenant, inv.invoice_number AS invoice, COALESCE(py.method_detail, py.payment_method) AS method, py.reference_no AS reference, py.amount_paid AS amount
                 FROM payments py JOIN invoices inv ON inv.invoice_id = py.invoice_id JOIN leases l ON l.lease_id = inv.lease_id JOIN tenants t ON t.tenant_id = l.tenant_id
                 WHERE py.company_id = $1 ORDER BY py.payment_date`) });
        if (full) {
            sheets.push({ name: 'Properties', columns: [text('name', 'Property'), text('address', 'Address'), text('category', 'Type'), text('unit', 'Unit'), money('rent', 'Rent'), money('service', 'Service charge'), text('status', 'Status')],
                rows: await q(`SELECT COALESCE(p.property_name, p.title) AS name, p.address, p.category, u.unit_number AS unit, u.rent_amount AS rent, COALESCE(u.service_charge,0) AS service, u.status
                     FROM properties p LEFT JOIN units u ON u.property_id = p.property_id WHERE p.company_id = $1 ORDER BY p.property_id, u.unit_number`) });
            sheets.push({ name: 'Invoices', columns: [date('issued', 'Issued'), text('invoice', 'Invoice'), text('tenant', 'Tenant'), text('type', 'Type'), text('description', 'Description', { wide: true }), money('total', 'Total'), date('due', 'Due')],
                rows: await q(`SELECT to_char(COALESCE(inv.issue_date, inv.created_at::date),'YYYY-MM-DD') AS issued, inv.invoice_number AS invoice, t.full_name AS tenant, inv.invoice_type AS type, COALESCE(inv.description,'') AS description, inv.amount_due AS total, to_char(inv.due_date,'YYYY-MM-DD') AS due
                     FROM invoices inv JOIN leases l ON l.lease_id = inv.lease_id JOIN tenants t ON t.tenant_id = l.tenant_id WHERE inv.company_id = $1 ORDER BY inv.invoice_id`) });
            let exp = [];
            try { exp = await q(`SELECT to_char(e.expense_date,'YYYY-MM-DD') AS date, e.category, e.description, COALESCE(p.property_name, p.title,'') AS property, COALESCE(e.payee,'') AS payee, e.amount FROM expenses e LEFT JOIN properties p ON p.property_id = e.property_id WHERE e.company_id = $1 ORDER BY e.expense_date`); } catch (e) { /* optional */ }
            sheets.push({ name: 'Expenses', columns: [date('date', 'Date'), text('category', 'Category'), text('description', 'Description', { wide: true }), text('property', 'Property'), text('payee', 'Paid to'), money('amount', 'Amount')], rows: exp });
        }
        sheets.forEach(s => s.rows = s.rows.map(r => { const o = { ...r }; s.columns.forEach(c => { if (c.type === 'money') o[c.key] = parseFloat(o[c.key]) || 0; else o[c.key] = o[c.key] === undefined ? '' : String(o[c.key]); }); return o; }));
        const company = (await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [cId])).rows[0] || {};
        sheets.forEach(s => s.heading = [company.company_name || '', `Backup - ${s.name}`, `Created ${niceDate(todayStr())}`]);
        await createAuditLog(pool, cId, req.user.user_id, 'Downloaded backup', 'BACKUP', req.ip, { full });
        await writeWorkbookTo(res, `backup-${todayStr()}.xlsx`, sheets);
    } catch (err) {
        console.error('Backup error:', err);
        if (!res.headersSent) res.status(err.code === 'MISSING_PACKAGE' ? 501 : 500).json({ error: err.message });
        else res.end();
    }
});

// ============================================================
// PLATFORM ADMIN (only the Super Admin: all client companies)
// ============================================================
const PLATFORM_COMPANIES_SQL = `
    SELECT c.company_id, c.company_name, c.plan, c.access_status, c.billing_type, c.features, c.notes, c.is_active,
           to_char(c.paid_until, 'YYYY-MM-DD') AS paid_until,
           (c.paid_until::date - CURRENT_DATE) AS days_left,
           (c.billing_type = 'SUBSCRIPTION' AND (c.paid_until IS NULL OR c.paid_until::date < CURRENT_DATE - $1::int)) AS expired,
           c.created_at, c.activated_at,
           o.full_name AS owner_name, o.email AS owner_email, o.phone_number AS owner_phone,
           (SELECT COUNT(*) FROM properties p WHERE p.company_id = c.company_id) AS properties,
           (SELECT COUNT(*) FROM units u WHERE u.company_id = c.company_id) AS units,
           (SELECT COUNT(DISTINCT l.tenant_id) FROM leases l WHERE l.company_id = c.company_id AND l.lease_state = 'CURRENT') AS tenants,
           (SELECT COUNT(*) FROM users x WHERE x.company_id = c.company_id AND x.role <> 'COMPANY_ADMIN') AS staff,
           (SELECT MAX(pp.paid_at) FROM platform_payments pp WHERE pp.company_id = c.company_id) AS last_payment
    FROM companies c
    LEFT JOIN LATERAL (
        SELECT full_name, email, phone_number FROM users
        WHERE company_id = c.company_id AND role = 'COMPANY_ADMIN' ORDER BY user_id ASC LIMIT 1
    ) o ON true
    WHERE c.company_id <> $2
    ORDER BY c.company_id DESC`;

app.get('/api/platform/companies', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const rows = (await pool.query(PLATFORM_COMPANIES_SQL, [GRACE_DAYS, req.user.company_id])).rows;
        const received = (await pool.query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM platform_payments WHERE paid_at >= date_trunc('month', CURRENT_DATE)"
        )).rows[0].total;

        res.json({
            received_this_month: parseFloat(received),
            companies: rows.map(r => ({
                ...r,
                features: r.features || {},
                effective_features: effectiveFeatures(r.plan, r.features),
                properties: parseInt(r.properties), units: parseInt(r.units),
                tenants: parseInt(r.tenants), staff: parseInt(r.staff)
            }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/platform/companies/:id/payments', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT payment_type, amount, method, reference, months, to_char(period_until, 'YYYY-MM-DD') AS period_until, notes, paid_at
             FROM platform_payments WHERE company_id = $1 ORDER BY paid_at DESC`,
            [req.params.id]
        );
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// change status, plan, billing, expiry date, special features and notes
app.put('/api/platform/companies/:id', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    const { plan, access_status, billing_type, paid_until, features, notes } = req.body;
    if (!['STANDARD', 'PRO'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
    if (!['PENDING', 'ACTIVE', 'SUSPENDED'].includes(access_status)) return res.status(400).json({ error: 'Invalid status.' });
    const billing = billing_type || null;
    if (billing !== null && !['SUBSCRIPTION', 'ONE_TIME'].includes(billing)) return res.status(400).json({ error: 'Invalid billing type.' });
    const until = paid_until || null;
    if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return res.status(400).json({ error: 'Invalid date.' });

    try {
        const r = await pool.query(
            `UPDATE companies SET plan = $1::varchar, access_status = $2::varchar, billing_type = $3::varchar, paid_until = $4::date,
                    features = $5::jsonb, notes = $6::text,
                    activated_at = CASE WHEN $2::varchar = 'ACTIVE' AND activated_at IS NULL THEN NOW() ELSE activated_at END
             WHERE company_id = $7 AND company_id <> $8 RETURNING company_id`,
            [plan, access_status, billing, until, JSON.stringify(sanitizeFeatures(features)), notes || null, req.params.id, req.user.company_id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Company not found.' });
        clearAccessCache(req.params.id);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Platform: updated company', 'PLATFORM', req.ip, { company_id: req.params.id, plan, access_status });
        res.json({ message: 'Company updated.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// record a payment you received from a client (this also switches access on)
app.post('/api/platform/companies/:id/payments', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    const { payment_type, amount, method, reference, months, plan, notes } = req.body;
    const types = ['SUBSCRIPTION', 'ONE_TIME', 'MAINTENANCE', 'FEATURE'];
    const amt = parseFloat(amount);
    if (!types.includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type.' });
    if (!(amt > 0)) return res.status(400).json({ error: 'Please enter the amount received.' });
    if (plan && !['STANDARD', 'PRO'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });

    const companyId = req.params.id;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const comp = (await client.query('SELECT company_id FROM companies WHERE company_id = $1 AND company_id <> $2 FOR UPDATE', [companyId, req.user.company_id])).rows[0];
        if (!comp) throw new Error('Company not found.');

        let m = null, periodUntil = null;
        if (payment_type === 'SUBSCRIPTION') {
            m = Math.max(1, parseInt(months) || 1);
            const upd = await client.query(
                `UPDATE companies SET billing_type = 'SUBSCRIPTION', access_status = 'ACTIVE',
                        plan = COALESCE($2, plan),
                        paid_until = (GREATEST(COALESCE(paid_until, CURRENT_DATE), CURRENT_DATE) + make_interval(months => $3))::date,
                        activated_at = COALESCE(activated_at, NOW())
                 WHERE company_id = $1 RETURNING to_char(paid_until, 'YYYY-MM-DD') AS paid_until`,
                [companyId, plan || null, m]
            );
            periodUntil = upd.rows[0].paid_until;
        } else if (payment_type === 'ONE_TIME') {
            await client.query(
                `UPDATE companies SET billing_type = 'ONE_TIME', access_status = 'ACTIVE', paid_until = NULL,
                        plan = COALESCE($2, 'PRO'), activated_at = COALESCE(activated_at, NOW())
                 WHERE company_id = $1`,
                [companyId, plan || null]
            );
        }

        await client.query(
            `INSERT INTO platform_payments (company_id, payment_type, amount, method, reference, months, period_until, notes, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [companyId, payment_type, amt, method || null, reference || null, m, periodUntil, notes || null, req.user.user_id]
        );

        await createAuditLog(client, req.user.company_id, req.user.user_id, `Platform: recorded ${payment_type} payment`, 'PLATFORM', req.ip, { company_id: companyId, amount: amt });
        await client.query('COMMIT');
        clearAccessCache(companyId);
        res.status(201).json({ message: 'Payment recorded.', paid_until: periodUntil });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// set a new password for the owner of a company (they forgot it)
app.post('/api/platform/companies/:id/reset-password', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    const { password } = req.body;
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const owner = (await pool.query(
            "SELECT user_id, email FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' ORDER BY user_id ASC LIMIT 1", [req.params.id]
        )).rows[0];
        if (!owner) return res.status(404).json({ error: 'Owner account not found.' });
        const hashed = await bcrypt.hash(String(password), 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hashed, owner.user_id]);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Platform: reset owner password', 'PLATFORM', req.ip, { company_id: req.params.id });
        res.json({ message: 'Password changed for ' + owner.email });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// the owner changes their own name, email and password
app.get('/api/platform/account', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const u = (await pool.query('SELECT full_name, email, phone_number FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
        res.json(u || {});
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/platform/account', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const b = req.body || {};
        const cur = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
        if (!cur) return res.status(404).json({ error: 'Account not found.' });
        if (!b.current_password || !(await bcrypt.compare(String(b.current_password), cur.password_hash))) {
            return res.status(400).json({ error: 'Your current password is not correct.' });
        }
        const name = String(b.full_name || cur.full_name).trim().slice(0, 120) || cur.full_name;
        const email = String(b.email || cur.email).trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
        const clash = (await pool.query('SELECT user_id FROM users WHERE LOWER(email) = $1 AND user_id <> $2', [email, cur.user_id])).rows[0];
        if (clash) return res.status(400).json({ error: 'This email is already used by another account.' });
        let hash = cur.password_hash;
        if (b.new_password) {
            if (String(b.new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
            hash = await bcrypt.hash(String(b.new_password), 10);
        }
        await pool.query('UPDATE users SET full_name = $1, email = $2, password_hash = $3, phone_number = COALESCE($4, phone_number) WHERE user_id = $5',
            [name, email, hash, b.phone_number ? String(b.phone_number).slice(0, 30) : null, cur.user_id]);
        clearUserCache(cur.user_id);
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Owner changed own account details', 'PLATFORM', req.ip, { email_changed: email !== cur.email, password_changed: !!b.new_password });
        res.json({ message: 'Saved.', full_name: name, email });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// the owner checks that email sending works (forgot password uses it)
app.post('/api/platform/test-email', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        if (!mailConfigured()) return res.status(400).json({ error: 'Email is not set up. In Railway > Variables add SMTP_USER (your Gmail address) and SMTP_PASS (a Gmail App Password), then redeploy.' });
        const to = String((req.body || {}).to || '').trim() || (await pool.query('SELECT email FROM users WHERE user_id = $1', [req.user.user_id])).rows[0].email;
        await sendMail(to, 'KEY ARCH - test email', 'This is a test email from KEY ARCH. Email sending works.', '<p>This is a test email from <b>KEY ARCH</b>. Email sending works.</p>');
        res.json({ message: 'Test email sent to ' + to + '. Check the inbox (and Spam).' });
    } catch (err) { res.status(500).json({ error: 'Email failed: ' + (err.response || err.message) }); }
});

// run the database setup again and show the result on screen
app.post('/api/platform/setup-database', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const results = await runDatabaseSetup();
        const failed = results.filter(r => !r.ok).map(r => ({ step: r.step, error: r.error }));
        res.json({ server_version: SERVER_VERSION, total: results.length, failed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KEY ARCH SaaS Multi-Tenant Server running on port ${PORT}`);
    initDatabase();
});
