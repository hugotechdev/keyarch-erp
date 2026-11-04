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

// RATE LIMITER KWA LOGIN
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    message: { error: 'Majaribio mengi ya kuingia yameshindikana. Tafadhali jaribu tena baada ya dakika 15.' }
});

// AUDIT LOG HELPER (Multi-Tenant Support)
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

// AUTO-MIGRATIONS & MULTI-TENANT DATABASE INITIALIZATION
async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;

        console.log('🔄 Checking database connection and running Multi-Tenant migrations...');
        
        await pool.query('SELECT NOW()');

        // 1. Companies Table (SaaS Tenants)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS companies (
                company_id SERIAL PRIMARY KEY,
                company_name VARCHAR(150) NOT NULL,
                subscription_plan VARCHAR(50) DEFAULT 'STANDARD',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Add company_id to core tables
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30) DEFAULT 'COMPANY_ADMIN'");
        
        await pool.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE units ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE leases ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE luku_vouchers ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");
        await pool.query("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(company_id) ON DELETE CASCADE");

        await pool.query("CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000");

        // Seed Platform Master Owner Company (Hugo Tech)
        const companyCheck = await pool.query("SELECT * FROM companies WHERE company_name = 'Hugo Tech Platform Master'");
        let masterCompanyId;
        if (companyCheck.rows.length === 0) {
            const newComp = await pool.query("INSERT INTO companies (company_name, subscription_plan) VALUES ('Hugo Tech Platform Master', 'ENTERPRISE') RETURNING company_id");
            masterCompanyId = newComp.rows[0].company_id;
        } else {
            masterCompanyId = companyCheck.rows[0].company_id;
        }

        // Seed System Super Admin (Hugo Mlula)
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Admin@2026', 10);
            await pool.query(
                "INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                [masterCompanyId, 'Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true]
            );
            console.log('✅ SaaS Platform Super Admin Seeded Successfully: admin@keyarch.co.tz');
        }

        console.log('✅ Multi-Tenant SaaS Database Initialization Completed.');
    } catch (err) {
        console.error('❌ DB Initialization Warning/Error:', err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// MIDDLEWARES
// ==========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Huruhusiwi kuingia bila Token!' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session imekwisha. Ingia upya.' });
        req.user = user;
        next();
    });
}

function allowRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Access Denied: Huna mamlaka ya kitendo hiki.' });
        }
        next();
    };
}

// ==========================================
// 1. AUTHENTICATION & CLIENT ONBOARDING
// ==========================================

// LOGIN
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        const userQuery = await pool.query(
            `SELECT u.*, c.company_name, c.is_active as company_active 
             FROM users u 
             LEFT JOIN companies c ON u.company_id = c.company_id 
             WHERE u.email = $1`, 
            [email]
        );
        if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Email au Password siyo sahihi!' });

        const user = userQuery.rows[0];
        if (!user.is_active) return res.status(403).json({ error: 'Akaunti yako imesimamishwa.' });
        if (user.role !== 'SUPER_ADMIN' && !user.company_active) return res.status(403).json({ error: 'Kampuni yako imefungiwa huduma za mfumo.' });

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Email au Password siyo sahihi!' });

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
        res.status(500).json({ error: err.message });
    }
});

// REGISTER NEW COMPANY / SAAS CLIENT (System Super Admin or Public Client Sign-up)
app.post('/api/auth/register-company', async (req, res) => {
    const { company_name, admin_full_name, email, password, phone_number, subscription_plan } = req.body;
    const client = await pool.connect();
    
    try {
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
        if (!passwordRegex.test(password)) {
            return res.status(400).json({ error: 'Nenosiri lazima liwe na herufi 8+, herufi kubwa, ndogo, namba na alama maalum.' });
        }

        await client.query('BEGIN');

        // Create Company
        const compRes = await client.query(
            'INSERT INTO companies (company_name, subscription_plan) VALUES ($1, $2) RETURNING *',
            [company_name, subscription_plan || 'STANDARD']
        );
        const company = compRes.rows[0];

        // Create Company Admin User
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
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(400).json({ error: 'Email hii tayari imeshasajiliwa.' });
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// REGISTER STAFF ACCOUNT (Executed by COMPANY_ADMIN or SUPER_ADMIN)
app.post('/api/auth/register-staff', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), async (req, res) => {
    const { full_name, email, password, phone_number, role } = req.body;
    const companyId = req.user.role === 'SUPER_ADMIN' ? (req.body.company_id || req.user.company_id) : req.user.company_id;

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ error: 'Nenosiri lazima liwe na herufi 8+, herufi kubwa, ndogo, namba na alama maalum.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING user_id, full_name, email, role',
            [companyId, full_name, email, hashedPassword, phone_number || '', role || 'PROPERTY_MANAGER', true]
        );

        await createAuditLog(pool, companyId, req.user.user_id, `Created Staff Account (${role})`, 'USER_MGMT', req.ip, { created_email: email, role });
        res.status(201).json({ message: 'Staff member registered successfully', user: result.rows[0] });
    } catch (err) { 
        if (err.code === '23505') return res.status(400).json({ error: 'Email hii tayari ipo kwenye mfumo.' });
        res.status(500).json({ error: err.message }); 
    }
});

// ==========================================
// 2. PROPERTIES & UNITS APIs (Tenant-Isolated)
// ==========================================
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

app.post('/api/properties', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_name, address, category, total_units } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO properties (company_id, property_name, address, category, total_units) VALUES ($1, $2, $3, $4, $5) RETURNING *', 
            [req.user.company_id, property_name, address, category || 'RESIDENTIAL', total_units || 1]
        );
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Created Property`, 'PROPERTIES', req.ip, { property_id: result.rows[0].property_id, property_name });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        if (err.code === '23505') return res.status(400).json({ error: `Unit ${unit_number} tayari ipo kwenye jengo hili!` });
        res.status(500).json({ error: err.message }); 
    }
});

// ==========================================
// 3. TENANT ONBOARDING TRANSACTION
// ==========================================
app.post('/api/tenants/onboard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { full_name, nida_passport_no, phone_number, email, unit_id, start_date, end_date, agreed_rent, payment_cycle, generate_initial_invoice } = req.body;
        const companyId = req.user.company_id;

        await client.query('BEGIN');

        const unitCheck = await client.query('SELECT status FROM units WHERE unit_id = $1 AND company_id = $2', [unit_id, companyId]);
        if (unitCheck.rows.length === 0) throw new Error('Unit iliyochaguliwa haipatikani.');
        if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('Unit hii tayari ina mpangaji mwingine active.');

        const tenantRes = await client.query(
            'INSERT INTO tenants (company_id, full_name, nida_passport_no, phone_number, email) VALUES ($1, $2, $3, $4, $5) RETURNING *', 
            [companyId, full_name, nida_passport_no, phone_number, email]
        );
        const tenant = tenantRes.rows[0];

        const leaseRes = await client.query(
            'INSERT INTO leases (company_id, unit_id, tenant_id, start_date, end_date, agreed_rent, payment_cycle, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', 
            [companyId, unit_id, tenant.tenant_id, start_date, end_date, agreed_rent, payment_cycle || 'MONTHLY', 'ACTIVE']
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

        await createAuditLog(client, companyId, req.user.user_id, `Onboarded Tenant`, 'TENANT_ONBOARDING', req.ip, { tenant_id: tenant.tenant_id, lease_id: lease.lease_id, unit_id, invoice_number: invoice ? invoice.invoice_number : null });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Tenant onboarded successfully', tenant, lease, invoice });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Onboarding Failed: ' + err.message });
    } finally {
        client.release();
    }
});

app.get('/api/tenants', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tenants WHERE company_id = $1 ORDER BY created_at DESC', [req.user.company_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 4. LEASES & INVOICES APIs
// ==========================================
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
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Issued Invoice`, 'INVOICES', req.ip, { invoice_number: autoInvoiceNum, lease_id, amount_due });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 5. WORK ORDERS / TICKETS APIs
// ==========================================
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
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Created Maintenance Ticket`, 'WORK_ORDERS', req.ip, { ticket_id: result.rows[0].ticket_id, title, priority });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 6. FINANCE: EXPENSES & LUKU VENDING
// ==========================================
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
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Recorded Expense`, 'EXPENSES', req.ip, { expense_id: result.rows[0].expense_id, amount, category });
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
        await createAuditLog(pool, req.user.company_id, req.user.user_id, `Vended Luku Token`, 'FINANCE_LUKU', req.ip, { voucher_id: result.rows[0].voucher_id, meter_number, token_number, amount, kwh_units });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. DASHBOARD METRICS & REMINDERS APIs (Company Filtered)
// ==========================================
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
