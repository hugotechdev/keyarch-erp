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

app.use(
    helmet({
        contentSecurityPolicy: false,
    })
);

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

async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;

        console.log('🔄 Initializing Database Schema & Multi-Tenant Migrations...');
        await pool.query('SELECT NOW()');

        // 1. CREATE BASE TABLES IF NOT EXIST
        await pool.query(`
            CREATE TABLE IF NOT EXISTS companies (
                company_id SERIAL PRIMARY KEY,
                company_name VARCHAR(150) NOT NULL,
                subscription_plan VARCHAR(50) DEFAULT 'STANDARD',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                full_name VARCHAR(150) NOT NULL,
                email VARCHAR(150) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                phone_number VARCHAR(50),
                role VARCHAR(30) DEFAULT 'COMPANY_ADMIN',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS properties (
                property_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                property_name VARCHAR(150),
                address TEXT,
                category VARCHAR(50) DEFAULT 'RESIDENTIAL',
                total_units INT DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS unit_groups (
                group_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                property_id INT REFERENCES properties(property_id) ON DELETE CASCADE,
                group_name VARCHAR(150) NOT NULL,
                units_in_group INT NOT NULL,
                bedrooms INT DEFAULT 0,
                bathrooms INT DEFAULT 0,
                rent_timeline VARCHAR(30) DEFAULT 'Per Month',
                currency VARCHAR(10) DEFAULT 'TSH',
                rent_amount NUMERIC(12, 2) NOT NULL,
                payment_method VARCHAR(50) DEFAULT 'Cash',
                furnishing_status VARCHAR(30) DEFAULT 'Unfurnished',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS units (
                unit_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                property_id INT REFERENCES properties(property_id) ON DELETE CASCADE,
                unit_number VARCHAR(50) NOT NULL,
                rent_amount NUMERIC(12, 2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'TZS',
                status VARCHAR(20) DEFAULT 'VACANT',
                is_furnished BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_unit_per_property UNIQUE(property_id, unit_number)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenants (
                tenant_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                full_name VARCHAR(150) NOT NULL,
                nida_passport_no VARCHAR(100),
                phone_number VARCHAR(50),
                email VARCHAR(150),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS leases (
                lease_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                unit_id INT REFERENCES units(unit_id) ON DELETE CASCADE,
                tenant_id INT REFERENCES tenants(tenant_id) ON DELETE CASCADE,
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                agreed_rent NUMERIC(12, 2) NOT NULL,
                payment_cycle VARCHAR(30) DEFAULT 'MONTHLY',
                status VARCHAR(20) DEFAULT 'ACTIVE',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS invoices (
                invoice_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                lease_id INT REFERENCES leases(lease_id) ON DELETE CASCADE,
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                amount_due NUMERIC(12, 2) NOT NULL,
                due_date DATE NOT NULL,
                status VARCHAR(20) DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS payments (
                payment_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                invoice_id INT REFERENCES invoices(invoice_id) ON DELETE CASCADE,
                amount_paid NUMERIC(12, 2) NOT NULL,
                payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                payment_method VARCHAR(50) DEFAULT 'BANK'
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                expense_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                property_id INT REFERENCES properties(property_id) ON DELETE CASCADE,
                description TEXT NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                category VARCHAR(50) DEFAULT 'MISC',
                recorded_by INT REFERENCES users(user_id) ON DELETE SET NULL,
                expense_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS work_orders (
                ticket_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                unit_id INT REFERENCES units(unit_id) ON DELETE CASCADE,
                assigned_technician_id INT REFERENCES users(user_id) ON DELETE SET NULL,
                title VARCHAR(200) NOT NULL,
                description TEXT,
                priority VARCHAR(20) DEFAULT 'MEDIUM',
                status VARCHAR(20) DEFAULT 'OPEN',
                estimated_cost NUMERIC(12, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS luku_vouchers (
                voucher_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                meter_number VARCHAR(100) NOT NULL,
                tenant_name VARCHAR(150) NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                token_number VARCHAR(100) NOT NULL,
                kwh_units NUMERIC(10, 2) NOT NULL,
                sold_by INT REFERENCES users(user_id) ON DELETE SET NULL,
                sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                log_id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(company_id) ON DELETE CASCADE,
                user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
                action_performed VARCHAR(255) NOT NULL,
                module_affected VARCHAR(100) NOT NULL,
                ip_address VARCHAR(50),
                metadata JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. SCHEMA RECONCILIATION & COLUMN MIGRATION (INAHAKIKISHA COLUMNS ZOTE ZIPO KWENYE TABLE YA PROPERTIES)
        await pool.query(`
            DO $$ 
            BEGIN 
                -- If old table used 'name' instead of 'property_name'
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='name') 
                   AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='property_name') THEN 
                    ALTER TABLE properties RENAME COLUMN name TO property_name;
                END IF;

                -- Ensure property_name exists
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='property_name') THEN 
                    ALTER TABLE properties ADD COLUMN property_name VARCHAR(150);
                END IF;

                -- Ensure company_id exists
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='company_id') THEN 
                    ALTER TABLE properties ADD COLUMN company_id INT REFERENCES companies(company_id) ON DELETE CASCADE;
                END IF;

                -- Ensure category exists
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='category') THEN 
                    ALTER TABLE properties ADD COLUMN category VARCHAR(50) DEFAULT 'RESIDENTIAL';
                END IF;

                -- Ensure total_units exists
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='total_units') THEN 
                    ALTER TABLE properties ADD COLUMN total_units INT DEFAULT 1;
                END IF;
            END $$;
        `);

        // Ensure company_id across all related tables
        const tablesToUpdate = ['units', 'tenants', 'leases', 'invoices', 'payments', 'expenses', 'work_orders', 'luku_vouchers', 'audit_logs'];
        for (const tbl of tablesToUpdate) {
            await pool.query(`
                DO $$ 
                BEGIN 
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='${tbl}' AND column_name='company_id'
                    ) THEN 
                        ALTER TABLE ${tbl} ADD COLUMN company_id INT REFERENCES companies(company_id) ON DELETE CASCADE;
                    END IF;
                END $$;
            `);
        }

        await pool.query("CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000");

        // 3. SEED MASTER PLATFORM OWNER COMPANY
        const companyCheck = await pool.query("SELECT * FROM companies WHERE company_name = 'Hugo Tech Platform Master'");
        let masterCompanyId;
        if (companyCheck.rows.length === 0) {
            const newComp = await pool.query("INSERT INTO companies (company_name, subscription_plan) VALUES ('Hugo Tech Platform Master', 'ENTERPRISE') RETURNING company_id");
            masterCompanyId = newComp.rows[0].company_id;
        } else {
            masterCompanyId = companyCheck.rows[0].company_id;
        }

        // 4. SEED SUPER ADMIN USER
        const masterPassword = process.env.MASTER_ADMIN_PASSWORD || 'Admin@2026';
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash(masterPassword, 10);
            await pool.query(
                "INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                [masterCompanyId, 'Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true]
            );
            console.log('✅ Platform Master Super Admin Seeded: admin@keyarch.co.tz');
        } else {
            await pool.query("UPDATE users SET company_id = $1 WHERE email = 'admin@keyarch.co.tz' AND company_id IS NULL", [masterCompanyId]);
        }

        console.log('✅ Database Schema Initialized & Migrations Completed Successfully.');
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

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired or invalid token. Please log in again.' });
        req.user = user;
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

// 1. AUTHENTICATION & COMPANY REGISTRATION
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and Password are required.' });

    try {
        const userQuery = await pool.query(
            `SELECT u.*, c.company_name, c.is_active as company_active 
             FROM users u 
             LEFT JOIN companies c ON u.company_id = c.company_id 
             WHERE u.email = $1`, 
            [email]
        );
        if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Invalid Email or Password.' });

        const user = userQuery.rows[0];
        if (!user.is_active) return res.status(403).json({ error: 'Account suspended.' });
        if (user.role !== 'SUPER_ADMIN' && user.company_active === false) {
            return res.status(403).json({ error: 'Company account is inactive or suspended.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Invalid Email or Password.' });

        const token = jwt.sign(
            { user_id: user.user_id, company_id: user.company_id, email: user.email, role: user.role, full_name: user.full_name },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        await createAuditLog(pool, user.company_id, user.user_id, `User Logged In`, 'AUTH', req.ip, { email: user.email });

        res.json({ 
            message: 'Login successful', 
            token, 
            user: { user_id: user.user_id, company_id: user.company_id, company_name: user.company_name, full_name: user.full_name, email: user.email, role: user.role } 
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Server error during login: ' + err.message });
    }
});

app.post('/api/auth/register-company', async (req, res) => {
    const { company_name, admin_full_name, email, password, phone_number } = req.body;
    
    if (!company_name || !admin_full_name || !email || !password) {
        return res.status(400).json({ error: 'Please provide all required fields.' });
    }

    let client;
    try {
        const existingUser = await pool.query('SELECT user_id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'This email address is already registered.' });
        }

        client = await pool.connect();
        await client.query('BEGIN');

        const compRes = await client.query(
            'INSERT INTO companies (company_name, subscription_plan) VALUES ($1, $2) RETURNING *',
            [company_name, 'STANDARD']
        );
        const company = compRes.rows[0];

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRes = await client.query(
            'INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING user_id, full_name, email, role',
            [company.company_id, admin_full_name, email, hashedPassword, phone_number || '', 'COMPANY_ADMIN', true]
        );
        const user = userRes.rows[0];

        await createAuditLog(client, company.company_id, user.user_id, `Registered Company Account`, 'COMPANY_ONBOARDING', req.ip, { company_name, email });
        await client.query('COMMIT');

        res.status(201).json({ message: 'Company onboarded successfully', company, admin_user: user });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Registration error: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

// 2. PROPERTIES & UNITS APIs
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, COUNT(u.unit_id) as total_units_count 
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

// WIZARD API: ADVANCED PROPERTY CREATION WITH UNLIMITED GROUPS & AUTO-UNITS
app.post('/api/properties/wizard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_name, address, property_type, number_of_units, groups } = req.body;
    const companyId = req.user.company_id;

    if (!property_name || !address || !property_type || !groups || !Array.isArray(groups)) {
        return res.status(400).json({ error: 'Please provide valid property details and group array.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Insert Property Record
        const propRes = await client.query(
            'INSERT INTO properties (company_id, property_name, address, category, total_units) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [companyId, property_name, address, property_type, number_of_units || 1]
        );
        const property = propRes.rows[0];

        // 2. Loop Through All Dynamic Groups & Auto Generate Units
        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
            const grp = groups[gIdx];

            await client.query(
                `INSERT INTO unit_groups 
                 (company_id, property_id, group_name, units_in_group, bedrooms, bathrooms, rent_timeline, currency, rent_amount, payment_method, furnishing_status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    companyId,
                    property.property_id,
                    grp.group_name || `Group ${gIdx + 1}`,
                    grp.units_in_group || 1,
                    grp.bedrooms || 0,
                    grp.bathrooms || 0,
                    grp.rent_timeline || 'Per Month',
                    grp.currency || 'TSH',
                    grp.rent_amount || 0,
                    grp.payment_method || 'Cash',
                    grp.furnishing_status || 'Unfurnished'
                ]
            );

            // Generate units for this specific group
            const unitsCount = parseInt(grp.units_in_group || 1);
            const cleanGrpName = (grp.group_name || `G${gIdx + 1}`).replace(/\s+/g, '-');

            for (let uIdx = 1; uIdx <= unitsCount; uIdx++) {
                const unitNumber = `${cleanGrpName}-${uIdx}`;

                await client.query(
                    `INSERT INTO units 
                     (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        companyId,
                        property.property_id,
                        unitNumber,
                        grp.rent_amount || 0,
                        grp.currency || 'TSH',
                        'VACANT',
                        grp.furnishing_status === 'Furnished'
                    ]
                );
            }
        }

        await createAuditLog(client, companyId, req.user.user_id, 'Created Multi-Group Property Wizard', 'PROPERTIES', req.ip, { property_id: property.property_id, total_groups: groups.length });
        await client.query('COMMIT');

        res.status(201).json({ message: 'Property, Groups, and Units created successfully', property });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Property Wizard Error:', err);
        res.status(500).json({ error: 'Failed to create property: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/units', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.*, p.property_name 
             FROM units u 
             JOIN properties p ON u.property_id = p.property_id 
             WHERE u.company_id = $1 
             ORDER BY u.unit_id DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/units', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_id, unit_number, rent_amount, currency, is_furnished } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', 
            [req.user.company_id, property_id, unit_number, rent_amount, currency || 'TZS', 'VACANT', is_furnished || false]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Created Unit`, 'UNITS', req.ip, { unit_id: result.rows[0].unit_id, property_id, unit_number });
        res.status(201).json(result.rows[0]);
    } catch (err) { 
        if (err.code === '23505') return res.status(400).json({ error: `Unit ${unit_number} already exists for this property.` });
        res.status(500).json({ error: err.message }); 
    }
});

// TENANT ONBOARDING
app.post('/api/tenants/onboard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    let client;
    try {
        const { full_name, nida_passport_no, phone_number, email, unit_id, start_date, end_date, agreed_rent, generate_initial_invoice } = req.body;
        const companyId = req.user.company_id;

        client = await pool.connect();
        await client.query('BEGIN');

        const unitCheck = await client.query('SELECT status FROM units WHERE unit_id = $1 AND company_id = $2', [unit_id, companyId]);
        if (unitCheck.rows.length === 0) throw new Error('Selected unit was not found.');
        if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('Selected unit is already occupied.');

        const tenantRes = await client.query(
            'INSERT INTO tenants (company_id, full_name, nida_passport_no, phone_number, email) VALUES ($1, $2, $3, $4, $5) RETURNING *', 
            [companyId, full_name, nida_passport_no, phone_number, email]
        );
        const tenant = tenantRes.rows[0];

        const leaseRes = await client.query(
            'INSERT INTO leases (company_id, unit_id, tenant_id, start_date, end_date, agreed_rent, payment_cycle, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', 
            [companyId, unit_id, tenant.tenant_id, start_date, end_date, agreed_rent, 'MONTHLY', 'ACTIVE']
        );
        const lease = leaseRes.rows[0];

        await client.query("UPDATE units SET status = 'OCCUPIED' WHERE unit_id = $1 AND company_id = $2", [unit_id, companyId]);

        let invoice = null;
        if (generate_initial_invoice) {
            const currentYear = new Date().getFullYear();
            const seqRes = await client.query("SELECT nextval('invoice_seq')");
            const autoInvoiceNum = `INV-${currentYear}-${seqRes.rows[0].nextval}`;

            const invRes = await client.query(
                'INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', 
                [companyId, lease.lease_id, autoInvoiceNum, agreed_rent, start_date, 'PENDING']
            );
            invoice = invRes.rows[0];
        }

        await createAuditLog(client, companyId, req.user.user_id, `Onboarded Tenant`, 'TENANT_ONBOARDING', req.ip, { tenant_id: tenant.tenant_id, lease_id: lease.lease_id });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Tenant onboarded successfully', tenant, lease, invoice });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Onboarding Failed: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/tenants', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tenants WHERE company_id = $1 ORDER BY created_at DESC', [req.user.company_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// LEASES & INVOICES
app.get('/api/leases', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT l.*, t.full_name as tenant_name, u.unit_number, p.property_name 
             FROM leases l 
             JOIN tenants t ON l.tenant_id = t.tenant_id 
             JOIN units u ON l.unit_id = u.unit_id 
             JOIN properties p ON u.property_id = p.property_id 
             WHERE l.company_id = $1 
             ORDER BY l.created_at DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT inv.*, l.agreed_rent, t.full_name as tenant_name 
             FROM invoices inv 
             JOIN leases l ON inv.lease_id = l.lease_id 
             JOIN tenants t ON l.tenant_id = t.tenant_id 
             WHERE inv.company_id = $1 
             ORDER BY inv.created_at DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices/issue', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { lease_id, amount_due, due_date } = req.body;
    try {
        const currentYear = new Date().getFullYear();
        const seqRes = await pool.query("SELECT nextval('invoice_seq')");
        const autoInvoiceNum = `INV-${currentYear}-${seqRes.rows[0].nextval}`;

        const result = await pool.query(
            'INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', 
            [req.user.company_id, lease_id, autoInvoiceNum, amount_due, due_date, 'PENDING']
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Issued Invoice`, 'INVOICES', req.ip, { invoice_number: autoInvoiceNum });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// TICKETS
app.get('/api/tickets', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT w.*, u.unit_number, tech.full_name as technician_name 
             FROM work_orders w 
             LEFT JOIN units u ON w.unit_id = u.unit_id 
             LEFT JOIN users tech ON w.assigned_technician_id = tech.user_id 
             WHERE w.company_id = $1 
             ORDER BY w.created_at DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/create', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'TECHNICIAN'), async (req, res) => {
    const { unit_id, title, description, priority, estimated_cost, assigned_technician_id } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO work_orders (company_id, unit_id, assigned_technician_id, title, description, priority, status, estimated_cost) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', 
            [req.user.company_id, unit_id || null, assigned_technician_id || null, title, description, priority || 'MEDIUM', 'OPEN', estimated_cost || 0.00]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Created Maintenance Ticket`, 'WORK_ORDERS', req.ip, { ticket_id: result.rows[0].ticket_id });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPENSES & LUKU
app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT e.*, p.property_name, u.full_name as recorded_by_name 
             FROM expenses e 
             LEFT JOIN properties p ON e.property_id = p.property_id 
             LEFT JOIN users u ON e.recorded_by = u.user_id 
             WHERE e.company_id = $1 
             ORDER BY e.expense_date DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/expenses', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { property_id, description, amount, category } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO expenses (company_id, property_id, description, amount, category, recorded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', 
            [req.user.company_id, property_id || null, description, amount, category || 'MISC', req.user.user_id]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Recorded Expense`, 'EXPENSES', req.ip, { expense_id: result.rows[0].expense_id });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/luku/vend', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { meter_number, tenant_name, amount } = req.body;
    try {
        const ratePerKwh = 350; 
        const kwh_units = (amount / ratePerKwh).toFixed(2);
        const token_number = Array.from({length:4}, () => Math.floor(1000 + Math.random()*9000)).join('-');

        const result = await pool.query(
            'INSERT INTO luku_vouchers (company_id, meter_number, tenant_name, amount, token_number, kwh_units, sold_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', 
            [req.user.company_id, meter_number, tenant_name, amount, token_number, kwh_units, req.user.user_id]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Vended Luku Token`, 'FINANCE_LUKU', req.ip, { voucher_id: result.rows[0].voucher_id });
        res.status(201).json(result.rows[0]);
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
        const activeTenants = await pool.query("SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE company_id = $1 AND status = 'ACTIVE'", [cId]);
        const pendingTickets = await pool.query("SELECT COUNT(*) FROM work_orders WHERE company_id = $1 AND status IN ('OPEN', 'IN_PROGRESS')", [cId]);

        const monthlyIncomeQuery = await pool.query("SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments WHERE company_id = $1 AND payment_date >= DATE_TRUNC('month', CURRENT_DATE)", [cId]);
        const lukuIncomeQuery = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM luku_vouchers WHERE company_id = $1 AND sold_at >= DATE_TRUNC('month', CURRENT_DATE)", [cId]);
        const monthlyExpensesQuery = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE company_id = $1 AND expense_date >= DATE_TRUNC('month', CURRENT_DATE)", [cId]);

        const tUnits = parseInt(totalUnits.rows[0]?.count || 0);
        const occUnits = parseInt(occupiedUnits.rows[0]?.count || 0);
        const occupancyRate = tUnits > 0 ? ((occUnits / tUnits) * 100).toFixed(2) : 0;

        const rentInc = parseFloat(monthlyIncomeQuery.rows[0]?.total || 0);
        const lukuInc = parseFloat(lukuIncomeQuery.rows[0]?.total || 0);
        const expenses = parseFloat(monthlyExpensesQuery.rows[0]?.total || 0);
        const income = rentInc + lukuInc;

        res.json({
            totalProperties: parseInt(totalProperties.rows[0]?.count || 0),
            totalUnits: tUnits,
            occupiedUnits: occUnits,
            vacantUnits: parseInt(vacantUnits.rows[0]?.count || 0),
            occupancyRate: occupancyRate,
            activeTenants: parseInt(activeTenants.rows[0]?.count || 0),
            pendingTickets: parseInt(pendingTickets.rows[0]?.count || 0),
            monthlyIncome: income,
            monthlyExpenses: expenses,
            netProfit: income - expenses
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/reminders', authenticateToken, async (req, res) => {
    const cId = req.user.company_id;
    try {
        const expiredLeases = await pool.query("SELECT COUNT(*) FROM leases WHERE company_id = $1 AND end_date < CURRENT_DATE AND status = 'ACTIVE'", [cId]);
        const expiringThisWeek = await pool.query("SELECT COUNT(*) FROM leases WHERE company_id = $1 AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND status = 'ACTIVE'", [cId]);
        const expiringThisMonth = await pool.query("SELECT COUNT(*) FROM leases WHERE company_id = $1 AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' AND status = 'ACTIVE'", [cId]);

        res.json({
            expired: parseInt(expiredLeases.rows[0]?.count || 0),
            dueThisWeek: parseInt(expiringThisWeek.rows[0]?.count || 0),
            dueThisMonth: parseInt(expiringThisMonth.rows[0]?.count || 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KEY ARCH SaaS Multi-Tenant Server running on port ${PORT}`);
    initDatabase();
});
