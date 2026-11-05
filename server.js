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

app.use(helmet({ contentSecurityPolicy: false }));

if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable missing. System cannot start securely.");
}
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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

function payStatusOf(toPay, paid) {
    const balance = Math.round((toPay - paid) * 100) / 100;
    if (balance < 0) return 'EXTRA_PAID';
    if (balance === 0) return 'PAID';
    return paid > 0 ? 'PARTIAL' : 'UNPAID';
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
    const plan = (a && a.plan) || 'STANDARD';
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
        if (!effectiveFeatures(a ? a.plan : 'STANDARD', a ? a.features : null)[key]) {
            return res.status(403).json({ error: 'This feature is available on the Pro plan. Please contact ' + SUPPORT.name + ' to upgrade.', code: 'FEATURE_LOCKED' });
        }
        next();
    };
}

// returns a message when the company reached its plan limit, otherwise null
async function checkLimit(user, limitKey, countSql, what) {
    if (user.role === 'SUPER_ADMIN') return null;
    const a = await getCompanyAccess(user.company_id);
    const limit = effectiveFeatures(a ? a.plan : 'STANDARD', a ? a.features : null)[limitKey];
    if (limit === null || limit === undefined) return null;
    const count = parseInt((await pool.query(countSql, [user.company_id])).rows[0].count);
    if (count >= limit) {
        return `Your plan allows up to ${limit} ${what}. Please contact ${SUPPORT.name} to upgrade.`;
    }
    return null;
}

async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;
        console.log('🔄 Connecting to Database & Initializing Core Setup...');
        await pool.query('SELECT NOW()');

        // Automatic Schema Patching for Tenants & Leases
        await pool.query(`
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
        `);

        // NEW: payment breakdown columns on leases
        await pool.query(`
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_price NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_period VARCHAR(10) DEFAULT 'Month';
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS number_of_periods NUMERIC(8, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_rent NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS discount NUMERIC(12, 2) DEFAULT 0.00;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_to_pay NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20);
        `);

        // NEW: every field of the Tenant Onboarding form has its own column
        await pool.query(`
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS full_name VARCHAR(150);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nida_passport_no VARCHAR(60);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS start_date DATE;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS end_date DATE;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS duration_days INTEGER;
        `);
        await pool.query(`
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
        `);
        // Old leases: fill the new columns so old tenants display correctly
        await pool.query(`
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
        `);

        // NEW: lease history (renew / extend / move out) and tenant status
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'lease_state') THEN
                    ALTER TABLE leases ADD COLUMN lease_state VARCHAR(12) DEFAULT 'CURRENT';
                    UPDATE leases SET lease_state = 'ENDED' WHERE status IS NOT NULL AND UPPER(status::text) <> 'ACTIVE';
                END IF;
            END $$;
        `);
        await pool.query(`
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
        `);

        // NEW: plans, access control and platform payments (Super Admin panel)
        await pool.query(`
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
        `);

        await pool.query("CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000");

        // Seed Master Admin
        const companyCheck = await pool.query("SELECT * FROM companies WHERE company_name = 'Hugo Tech Platform Master'");
        let masterCompanyId;
        if (companyCheck.rows.length === 0) {
            const newComp = await pool.query("INSERT INTO companies (company_name, subscription_plan) VALUES ('Hugo Tech Platform Master', 'ENTERPRISE') RETURNING company_id");
            masterCompanyId = newComp.rows[0].company_id;
        } else {
            masterCompanyId = companyCheck.rows[0].company_id;
        }

        const masterPassword = process.env.MASTER_ADMIN_PASSWORD || 'Admin@2026';
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash(masterPassword, 10);
            await pool.query(
                "INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                [masterCompanyId, 'Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true, true]
            );
            console.log('✅ Master Admin Seeded: admin@keyarch.co.tz');
        } else {
            await pool.query("UPDATE users SET company_id = $1 WHERE email = 'admin@keyarch.co.tz' AND company_id IS NULL", [masterCompanyId]);
        }

        console.log('✅ Database Initialization Complete.');
    } catch (err) {
        console.error('❌ DB Initialization Error:', err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. Missing authentication token.' });

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired or invalid token. Please log in again.' });
        req.user = user;

        // every request checks that the company is paid and active
        if (user.role !== 'SUPER_ADMIN') {
            const access = await getCompanyAccess(user.company_id);
            const block = accessBlock(access);
            if (block) return res.status(403).json({ error: block.message, code: block.code });
        }
        next();
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
app.post('/api/auth/login', loginLimiter, async (req, res) => {
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
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Invalid Email or Password.' });

        if (!user.is_active) return res.status(403).json({ error: 'Account suspended.', code: 'ACCOUNT_SUSPENDED' });

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
            'INSERT INTO properties (company_id, property_name, title, address, category, total_units) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [companyId, property_name, property_name, address, property_type, number_of_units || 1]
        );
        const property = propRes.rows[0];

        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
            const grp = groups[gIdx];
            await client.query(
                `INSERT INTO unit_groups
                 (company_id, property_id, group_name, units_in_group, bedrooms, bathrooms, rent_timeline, currency, rent_amount, payment_method, furnishing_status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    companyId, property.property_id, grp.group_name || `Group ${gIdx + 1}`, grp.units_in_group || 1, grp.bedrooms || 0, grp.bathrooms || 0,
                    grp.rent_timeline || 'Per Month', grp.currency || 'TSH', grp.rent_amount || 0, grp.payment_method || 'Cash', grp.furnishing_status || 'Unfurnished'
                ]
            );

            const unitsCount = parseInt(grp.units_in_group || 1);
            const cleanGrpName = (grp.group_name || `G${gIdx + 1}`).replace(/\s+/g, '-');

            for (let uIdx = 1; uIdx <= unitsCount; uIdx++) {
                const unitNumber = `${cleanGrpName}-${uIdx}`;
                await client.query(
                    `INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [companyId, property.property_id, unitNumber, grp.rent_amount || 0, grp.currency || 'TSH', 'VACANT', grp.furnishing_status === 'Furnished']
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

        const unitCheck = await client.query('SELECT status, property_id FROM units WHERE unit_id = $1 AND company_id = $2', [unit_id, companyId]);
        if (unitCheck.rows.length === 0) throw new Error('Unit not found.');
        if (String(unitCheck.rows[0].property_id) !== String(property_id)) throw new Error('This unit does not belong to the selected property.');
        if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('This unit already has a tenant.');

        const tenantRes = await client.query(
            'INSERT INTO tenants (company_id, full_name, identity_type, nida_passport_no, phone_number) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [companyId, full_name, ALLOWED_ID_TYPES.includes(identity_type) ? identity_type : 'NIDA', nida_passport_no, phone_number]
        );
        const tenant = tenantRes.rows[0];

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

        await client.query("UPDATE units SET status = 'OCCUPIED' WHERE unit_id = $1 AND company_id = $2", [unit_id, companyId]);

        // Auto Generate Invoice & Receipt
        const currentYear = new Date().getFullYear();
        const seqRes = await client.query("SELECT nextval('invoice_seq')");
        const autoInvoiceNum = `INV-${currentYear}-${seqRes.rows[0].nextval}`;

        // Invoice status stays PAID / PARTIAL / PENDING (extra paid is shown by the numbers)
        const invStatus = calc.amountDue === 0 ? 'PAID' : (calc.paid > 0 ? 'PARTIAL' : 'PENDING');
        const invRes = await client.query(
            'INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [companyId, lease.lease_id, autoInvoiceNum, calc.totalToPay, start_date, invStatus]
        );
        const invoice = invRes.rows[0];

        let payment = null;
        if (calc.paid > 0) {
            const payRes = await client.query(
                'INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method) VALUES ($1, $2, $3, NOW(), $4) RETURNING *',
                [companyId, invoice.invoice_id, calc.paid, 'CASH/TRANSFER']
            );
            payment = payRes.rows[0];
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

app.get('/api/tenants', authenticateToken, async (req, res) => {
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
                       u.unit_id, u.unit_number, p.property_id, COALESCE(p.property_name, p.title) AS property_name,
                       (SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0)
                          FROM invoices inv JOIN leases l2 ON inv.lease_id = l2.lease_id
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
app.get('/api/tenants/:id/history', authenticateToken, async (req, res) => {
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
            `SELECT inv.invoice_id, inv.invoice_number, inv.amount_due, inv.due_date, inv.lease_id, COALESCE(pay.paid, 0) AS paid
             FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id
             LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments GROUP BY invoice_id) pay ON pay.invoice_id = inv.invoice_id
             WHERE l.tenant_id = $1 AND inv.company_id = $2 ORDER BY inv.invoice_id DESC`,
            [tenantId, cId]
        )).rows;

        const payments = (await pool.query(
            `SELECT pay.amount_paid, pay.payment_date, pay.payment_method, inv.invoice_number
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
app.put('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { full_name, nida_passport_no, identity_type, phone_number, end_date, lease_id } = req.body;
    const tenantId = req.params.id;

    if (!req.user.can_edit_tenants && req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'COMPANY_ADMIN') {
        return res.status(403).json({ error: 'You do not have permission to edit tenant details.' });
    }
    if (!full_name || !phone_number || !nida_passport_no) {
        return res.status(400).json({ error: 'Name, phone and ID number are required.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

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

        await createAuditLog(client, req.user.company_id, req.user.user_id, 'Updated Tenant Details', 'TENANTS', req.ip, { tenant_id: tenantId });
        await client.query('COMMIT');
        res.json({ message: 'Tenant updated successfully' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

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

        const seq = await client.query("SELECT nextval('invoice_seq')");
        const invNumber = `INV-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
        const invStatus = calc.amountDue === 0 ? 'PAID' : (calc.paid > 0 ? 'PARTIAL' : 'PENDING');
        const invoice = (await client.query(
            'INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [companyId, lease.lease_id, invNumber, calc.totalToPay, start_date, invStatus]
        )).rows[0];

        if (calc.paid > 0) {
            await client.query(
                'INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method) VALUES ($1, $2, $3, NOW(), $4)',
                [companyId, invoice.invoice_id, calc.paid, 'CASH/TRANSFER']
            );
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

        const seq = await client.query("SELECT nextval('invoice_seq')");
        const invNumber = `INV-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
        const invStatus = calc.amountDue === 0 ? 'PAID' : (calc.paid > 0 ? 'PARTIAL' : 'PENDING');
        const invoice = (await client.query(
            'INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, CURRENT_DATE, $5) RETURNING *',
            [companyId, lease.lease_id, invNumber, calc.totalToPay, invStatus]
        )).rows[0];

        if (calc.paid > 0) {
            await client.query(
                'INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method) VALUES ($1, $2, $3, NOW(), $4)',
                [companyId, invoice.invoice_id, calc.paid, 'CASH/TRANSFER']
            );
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
        await client.query(
            `UPDATE tenants SET is_active = EXISTS (SELECT 1 FROM leases WHERE tenant_id = $1 AND company_id = $2 AND lease_state = 'CURRENT')
             WHERE tenant_id = $1 AND company_id = $2`,
            [lease.tenant_id, companyId]
        );

        const owed = (await client.query(
            `SELECT COALESCE(SUM(GREATEST(inv.amount_due - COALESCE((SELECT SUM(py.amount_paid) FROM payments py WHERE py.invoice_id = inv.invoice_id), 0), 0)), 0) AS owed
             FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id WHERE l.tenant_id = $1 AND inv.company_id = $2`,
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
app.delete('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), async (req, res) => {
    const companyId = req.user.company_id;
    const tenantId = req.params.id;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const t = (await client.query('SELECT tenant_id FROM tenants WHERE tenant_id = $1 AND company_id = $2 FOR UPDATE', [tenantId, companyId])).rows[0];
        if (!t) throw new Error('Tenant not found.');

        const pays = (await client.query(
            `SELECT COUNT(*) AS c FROM payments pay JOIN invoices inv ON pay.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
             WHERE l.tenant_id = $1 AND pay.company_id = $2`, [tenantId, companyId]
        )).rows[0].c;
        if (parseInt(pays) > 0) throw new Error('This tenant has payment records, so it cannot be deleted. Use "Move Out" to keep the history.');

        // free the units of current leases
        await client.query(
            "UPDATE units SET status = 'VACANT' WHERE company_id = $2 AND unit_id IN (SELECT unit_id FROM leases WHERE tenant_id = $1 AND company_id = $2 AND lease_state = 'CURRENT')",
            [tenantId, companyId]
        );
        await client.query('DELETE FROM invoices WHERE company_id = $2 AND lease_id IN (SELECT lease_id FROM leases WHERE tenant_id = $1 AND company_id = $2)', [tenantId, companyId]);
        try { await client.query('SAVEPOINT del_events'); await client.query('DELETE FROM lease_events WHERE tenant_id = $1 AND company_id = $2', [tenantId, companyId]); await client.query('RELEASE SAVEPOINT del_events'); }
        catch (e) { await client.query('ROLLBACK TO SAVEPOINT del_events'); }
        await client.query('DELETE FROM leases WHERE tenant_id = $1 AND company_id = $2', [tenantId, companyId]);
        await client.query('DELETE FROM tenants WHERE tenant_id = $1 AND company_id = $2', [tenantId, companyId]);

        await createAuditLog(client, companyId, req.user.user_id, 'Deleted Tenant', 'TENANTS', req.ip, { tenant_id: tenantId });
        await client.query('COMMIT');
        res.json({ message: 'Tenant deleted.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// GET FULL INVOICE DETAILS FOR PRINTING
app.get('/api/invoices/:id/print', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT inv.*, l.start_date, l.end_date, l.agreed_rent,
                    l.rent_price, l.rent_period, l.number_of_periods, l.total_rent, COALESCE(l.discount, 0) as discount,
                    COALESCE(l.total_to_pay, l.agreed_rent) as total_to_pay,
                    COALESCE(l.amount_paid, 0) as paid_amount, COALESCE(l.amount_due, 0) as remaining_due,
                    t.full_name as tenant_name, t.phone_number as tenant_phone, t.nida_passport_no, t.identity_type,
                    u.unit_number, COALESCE(p.property_name, p.title) as property_name, p.address as property_address,
                    c.company_name
             FROM invoices inv
             JOIN leases l ON inv.lease_id = l.lease_id
             JOIN tenants t ON l.tenant_id = t.tenant_id
             JOIN units u ON l.unit_id = u.unit_id
             JOIN properties p ON u.property_id = p.property_id
             JOIN companies c ON inv.company_id = c.company_id
             WHERE inv.invoice_id = $1 AND inv.company_id = $2`,
            [req.params.id, req.user.company_id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found.' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DASHBOARD METRICS
app.get('/api/dashboard/metrics', authenticateToken, async (req, res) => {
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
    const allowed = ['PROPERTY_MANAGER', 'ACCOUNTANT', 'TECHNICIAN'];
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
            [req.user.company_id, String(full_name).trim(), cleanEmail, hashed, role, true, role === 'PROPERTY_MANAGER']
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

app.post('/api/units', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_id, unit_number, rent_amount } = req.body;
    if (!property_id || !unit_number || !(parseFloat(rent_amount) >= 0)) {
        return res.status(400).json({ error: 'Property, unit number and rent amount are required.' });
    }
    try {
        const prop = await pool.query('SELECT 1 FROM properties WHERE property_id = $1 AND company_id = $2', [property_id, req.user.company_id]);
        if (prop.rows.length === 0) return res.status(404).json({ error: 'Property not found.' });

        await pool.query(
            "INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished) VALUES ($1, $2, $3, $4, 'TSH', 'VACANT', false)",
            [req.user.company_id, property_id, String(unit_number).trim(), parseFloat(rent_amount)]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Added Unit', 'UNITS', req.ip, { property_id, unit_number });
        res.status(201).json({ message: 'Unit saved.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leases', authenticateToken, async (req, res) => {
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
// INVOICES, PAYMENTS
// balance = invoice total - sum of its payments
// ============================================================
const INVOICE_BALANCES_SQL = `
    SELECT inv.invoice_id, inv.invoice_number, inv.status, inv.due_date, inv.amount_due,
           COALESCE(pay.paid, 0) AS paid,
           inv.amount_due - COALESCE(pay.paid, 0) AS balance,
           (inv.due_date::date - CURRENT_DATE) AS days_left,
           l.lease_id, t.full_name AS tenant_name, t.phone_number AS tenant_phone,
           u.unit_number, p.property_id, COALESCE(p.property_name, p.title) AS property_name
    FROM invoices inv
    JOIN leases l ON inv.lease_id = l.lease_id
    JOIN tenants t ON l.tenant_id = t.tenant_id
    JOIN units u ON l.unit_id = u.unit_id
    JOIN properties p ON u.property_id = p.property_id
    LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay
           ON pay.invoice_id = inv.invoice_id
    WHERE inv.company_id = $1`;

app.get('/api/invoices', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`${INVOICE_BALANCES_SQL} ORDER BY inv.invoice_id DESC`, [req.user.company_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices/issue', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { lease_id, amount_due, due_date } = req.body;
    const amount = parseFloat(amount_due);
    if (!lease_id || !(amount > 0) || !due_date) return res.status(400).json({ error: 'Lease, amount and due date are required.' });

    try {
        const lease = await pool.query('SELECT 1 FROM leases WHERE lease_id = $1 AND company_id = $2', [lease_id, req.user.company_id]);
        if (lease.rows.length === 0) return res.status(404).json({ error: 'Lease not found.' });

        const seq = await pool.query("SELECT nextval('invoice_seq')");
        const number = `INV-${new Date().getFullYear()}-${seq.rows[0].nextval}`;
        const inv = await pool.query(
            "INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5, 'PENDING') RETURNING *",
            [req.user.company_id, lease_id, number, amount, due_date]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, 'Issued Invoice', 'INVOICES', req.ip, { invoice_id: inv.rows[0].invoice_id });
        res.status(201).json(inv.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// RECORD A PAYMENT AGAINST AN INVOICE (updates invoice, lease balance and status)
app.post('/api/payments/record', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { invoice_id, amount, payment_method } = req.body;
    const amt = Math.round(parseFloat(amount) * 100) / 100;
    if (!invoice_id || !(amt > 0)) return res.status(400).json({ error: 'Invoice and a valid amount are required.' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const companyId = req.user.company_id;

        const invRes = await client.query(
            'SELECT invoice_id, lease_id, amount_due FROM invoices WHERE invoice_id = $1 AND company_id = $2 FOR UPDATE',
            [invoice_id, companyId]
        );
        if (invRes.rows.length === 0) throw new Error('Invoice not found.');
        const inv = invRes.rows[0];

        await client.query(
            'INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method) VALUES ($1, $2, $3, NOW(), $4)',
            [companyId, invoice_id, amt, payment_method || 'Cash']
        );

        const sum = await client.query('SELECT COALESCE(SUM(amount_paid), 0) AS paid FROM payments WHERE invoice_id = $1 AND company_id = $2', [invoice_id, companyId]);
        const paidOnInvoice = parseFloat(sum.rows[0].paid);
        const invStatus = paidOnInvoice >= parseFloat(inv.amount_due) ? 'PAID' : 'PARTIAL';
        await client.query('UPDATE invoices SET status = $1 WHERE invoice_id = $2 AND company_id = $3', [invStatus, invoice_id, companyId]);

        // keep the lease totals in step with the payment
        const leaseRes = await client.query(
            `UPDATE leases SET amount_paid = COALESCE(amount_paid, 0) + $1
             WHERE lease_id = $2 AND company_id = $3
             RETURNING COALESCE(total_to_pay, agreed_rent) AS to_pay, amount_paid`,
            [amt, inv.lease_id, companyId]
        );
        let leaseStatus = null;
        if (leaseRes.rows.length > 0) {
            const toPay = parseFloat(leaseRes.rows[0].to_pay || 0);
            const paid = parseFloat(leaseRes.rows[0].amount_paid || 0);
            const balance = Math.round((toPay - paid) * 100) / 100;
            leaseStatus = balance < 0 ? 'EXTRA_PAID' : (balance === 0 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID'));
            await client.query(
                'UPDATE leases SET amount_due = $1, payment_status = $2 WHERE lease_id = $3 AND company_id = $4',
                [Math.max(0, balance), leaseStatus, inv.lease_id, companyId]
            );
        }

        await createAuditLog(client, companyId, req.user.user_id, 'Recorded Payment', 'PAYMENTS', req.ip, { invoice_id, amount: amt });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Payment recorded.', invoice_status: invStatus, payment_status: leaseStatus });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
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

app.get('/api/dashboard/overview', authenticateToken, async (req, res) => {
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
        )).rows;

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
            "SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments WHERE company_id = $1 AND payment_date >= date_trunc('month', CURRENT_DATE)",
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
                 FROM invoices inv
                 JOIN leases l ON inv.lease_id = l.lease_id
                 JOIN units u ON l.unit_id = u.unit_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount_paid) AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id) pay
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
        const ticketRows = await safeRows(
            "SELECT COUNT(*) AS c FROM work_orders WHERE company_id = $1 AND UPPER(status) NOT IN ('COMPLETED','CLOSED','RESOLVED','DONE','CANCELLED')",
            [cId]
        );
        const expenseRows = await safeRows(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE company_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)",
            [cId]
        );
        const expensesThisMonth = expenseRows ? parseFloat(expenseRows[0].total) : null;

        res.json({
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
            tickets: { pending: ticketRows ? parseInt(ticketRows[0].c) : null }
        });
    } catch (err) {
        console.error('Overview Error:', err);
        res.status(500).json({ error: err.message });
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
            `UPDATE companies SET plan = $1, access_status = $2, billing_type = $3, paid_until = $4,
                    features = $5::jsonb, notes = $6,
                    activated_at = CASE WHEN $2 = 'ACTIVE' AND activated_at IS NULL THEN NOW() ELSE activated_at END
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KEY ARCH SaaS Multi-Tenant Server running on port ${PORT}`);
    initDatabase();
});
