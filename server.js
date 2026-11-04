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
app.use(express.static(__dirname));

// RATE LIMITER KWA LOGIN
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    message: { error: 'Majaribio mengi ya kuingia yameshindikana. Tafadhali jaribu tena baada ya dakika 15.' }
});

// AUDIT LOG HELPER
async function createAuditLog(clientOrPool, userId, action, moduleAffected, ipAddress, metadata = {}) {
    try {
        await clientOrPool.query(
            'INSERT INTO audit_logs (user_id, action_performed, module_affected, ip_address, metadata) VALUES ($1, $2, $3, $4, $5)',
            [userId || null, action, moduleAffected, ipAddress || '127.0.0.1', JSON.stringify(metadata)]
        );
    } catch (err) {
        console.error('Audit Log Warning:', err.message);
    }
}

// AUTO-MIGRATIONS & SEEDING (Safe Startup Guard)
async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;

        console.log('🔄 Checking database connection and running migrations...');
        
        await pool.query('SELECT NOW()');

        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'PROPERTY_MANAGER'");
        await pool.query("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb");
        await pool.query("CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000");

        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Admin@2026', 10);
            await pool.query(
                "INSERT INTO users (full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6)",
                ['Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true]
            );
            console.log('✅ Super Admin Seeded Successfully: admin@keyarch.co.tz');
        }
        console.log('✅ Database Initialization Completed.');
    } catch (err) {
        console.error('❌ DB Initialization Warning/Error (App will still run):', err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 1. AUTHENTICATION & LOGIN API
// ==========================================
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Email au Password siyo sahihi!' });

        const user = userQuery.rows[0];
        if (!user.is_active) return res.status(403).json({ error: 'Akaunti imesimamishwa.' });

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Email au Password siyo sahihi!' });

        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role, full_name: user.full_name },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        await createAuditLog(pool, user.user_id, `User Logged In`, 'AUTH', req.ip, { email: user.email });

        res.json({ message: 'Login successful', token, user: { user_id: user.user_id, full_name: user.full_name, email: user.email, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
            return res.status(403).json({ error: 'Access Denied: Huna mamlaka.' });
        }
        next();
    };
}

app.post('/api/auth/register', authenticateToken, allowRoles('SUPER_ADMIN'), async (req, res) => {
    const { full_name, email, password, phone_number, role } = req.body;
    
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ error: 'Nenosiri lazima liwe na herufi 8+, herufi kubwa, ndogo, namba na alama maalum.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, full_name, email, role',
            [full_name, email, hashedPassword, phone_number || '', role || 'PROPERTY_MANAGER', true]
        );

        await createAuditLog(pool, req.user.user_id, `Created Staff Account`, 'USER_MGMT', req.ip, { created_email: email, role });
        res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 2. PROPERTIES & UNITS APIs
// ==========================================
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT p.*, COUNT(u.unit_id) as total_units_count FROM properties p LEFT JOIN units u ON p.property_id = u.property_id GROUP BY p.property_id ORDER BY p.created_at DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/properties', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_name, address, category, total_units } = req.body;
    try {
        const result = await pool.query('INSERT INTO properties (property_name, address, category, total_units) VALUES ($1, $2, $3, $4) RETURNING *', [property_name, address, category || 'RESIDENTIAL', total_units || 1]);
        await createAuditLog(pool, req.user.user_id, `Created Property`, 'PROPERTIES', req.ip, { property_id: result.rows[0].property_id, property_name });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/units', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT u.*, p.property_name FROM units u JOIN properties p ON u.property_id = p.property_id ORDER BY u.unit_id DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/units', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_id, unit_number, rent_amount, currency, is_furnished } = req.body;
    try {
        const result = await pool.query('INSERT INTO units (property_id, unit_number, rent_amount, currency, status, is_furnished) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [property_id, unit_number, rent_amount, currency || 'TZS', 'VACANT', is_furnished || false]);
        await createAuditLog(pool, req.user.user_id, `Created Unit`, 'UNITS', req.ip, { unit_id: result.rows[0].unit_id, property_id, unit_number });
        res.status(201).json(result.rows[0]);
    } catch (err) { 
        if (err.code === '23505') return res.status(400).json({ error: `Unit ${unit_number} tayari ipo kwenye jengo hili!` });
        res.status(500).json({ error: err.message }); 
    }
});

// ==========================================
// 3. TENANT ONBOARDING TRANSACTION
// ==========================================
app.post('/api/tenants/onboard', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { full_name, nida_passport_no, phone_number, email, unit_id, start_date, end_date, agreed_rent, payment_cycle, generate_initial_invoice } = req.body;

        await client.query('BEGIN');

        const unitCheck = await client.query('SELECT status FROM units WHERE unit_id = $1', [unit_id]);
        if (unitCheck.rows.length === 0) throw new Error('Unit iliyochaguliwa haipatikani.');
        if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('Unit hii tayari ina mpangaji mwingine active.');

        const tenantRes = await client.query('INSERT INTO tenants (full_name, nida_passport_no, phone_number, email) VALUES ($1, $2, $3, $4) RETURNING *', [full_name, nida_passport_no, phone_number, email]);
        const tenant = tenantRes.rows[0];

        const leaseRes = await client.query('INSERT INTO leases (unit_id, tenant_id, start_date, end_date, agreed_rent, payment_cycle, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [unit_id, tenant.tenant_id, start_date, end_date, agreed_rent, payment_cycle || 'MONTHLY', 'ACTIVE']);
        const lease = leaseRes.rows[0];

        await client.query("UPDATE units SET status = 'OCCUPIED' WHERE unit_id = $1", [unit_id]);

        let invoice = null;
        if (generate_initial_invoice) {
            const currentYear = new Date().getFullYear();
            const seqRes = await client.query("SELECT nextval('invoice_seq')");
            const autoInvoiceNum = `INV-${currentYear}-${seqRes.rows[0].nextval}`;

            const invRes = await client.query('INSERT INTO invoices (lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING *', [lease.lease_id, autoInvoiceNum, agreed_rent, start_date, 'PENDING']);
            invoice = invRes.rows[0];
        }

        await createAuditLog(client, req.user.user_id, `Onboarded Tenant`, 'TENANT_ONBOARDING', req.ip, { tenant_id: tenant.tenant_id, lease_id: lease.lease_id, unit_id, invoice_number: invoice ? invoice.invoice_number : null });
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
        const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 4. LEASES & INVOICES APIs
// ==========================================
app.get('/api/leases', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT l.*, t.full_name as tenant_name, u.unit_number, p.property_name FROM leases l JOIN tenants t ON l.tenant_id = t.tenant_id JOIN units u ON l.unit_id = u.unit_id JOIN properties p ON u.property_id = p.property_id ORDER BY l.created_at DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT inv.*, l.agreed_rent, t.full_name as tenant_name FROM invoices inv JOIN leases l ON inv.lease_id = l.lease_id JOIN tenants t ON l.tenant_id = t.tenant_id ORDER BY inv.created_at DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices/issue', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { lease_id, amount_due, due_date } = req.body;
    try {
        const currentYear = new Date().getFullYear();
        const seqRes = await pool.query("SELECT nextval('invoice_seq')");
        const autoInvoiceNum = `INV-${currentYear}-${seqRes.rows[0].nextval}`;

        const result = await pool.query('INSERT INTO invoices (lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING *', [lease_id, autoInvoiceNum, amount_due, due_date, 'PENDING']);
        await createAuditLog(pool, req.user.user_id, `Issued Invoice`, 'INVOICES', req.ip, { invoice_number: autoInvoiceNum, lease_id, amount_due });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 5. WORK ORDERS / TICKETS APIs
// ==========================================
app.get('/api/tickets', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT w.*, u.unit_number, tech.full_name as technician_name FROM work_orders w LEFT JOIN units u ON w.unit_id = u.unit_id LEFT JOIN users tech ON w.assigned_technician_id = tech.user_id ORDER BY w.created_at DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/create', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER', 'TECHNICIAN'), async (req, res) => {
    const { unit_id, title, description, priority, estimated_cost, assigned_technician_id } = req.body;
    try {
        const result = await pool.query('INSERT INTO work_orders (unit_id, assigned_technician_id, title, description, priority, status, estimated_cost) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [unit_id || null, assigned_technician_id || null, title, description, priority || 'MEDIUM', 'OPEN', estimated_cost || 0.00]);
        await createAuditLog(pool, req.user.user_id, `Created Maintenance Ticket`, 'WORK_ORDERS', req.ip, { ticket_id: result.rows[0].ticket_id, title, priority });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/tickets/:id/status', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER', 'TECHNICIAN'), async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const ticketRes = await pool.query('SELECT * FROM work_orders WHERE ticket_id = $1', [id]);
        if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        
        if (req.user.role === 'TECHNICIAN' && ticketRes.rows[0].assigned_technician_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Access denied: Hii sio tiketi uliyopangiwa.' });
        }

        const result = await pool.query('UPDATE work_orders SET status = $1 WHERE ticket_id = $2 RETURNING *', [status, id]);
        await createAuditLog(pool, req.user.user_id, `Updated Ticket Status`, 'WORK_ORDERS', req.ip, { ticket_id: id, new_status: status });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 6. FINANCE: PAYMENTS, EXPENSES & LUKU VENDING
// ==========================================
app.get('/api/payments', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT pay.*, t.full_name as tenant_name FROM payments pay LEFT JOIN tenants t ON pay.tenant_id = t.tenant_id ORDER BY pay.payment_date DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payments', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { invoice_id, tenant_id, amount_paid, payment_type, payment_method, reference_no } = req.body;
    try {
        const result = await pool.query('INSERT INTO payments (invoice_id, tenant_id, amount_paid, payment_type, payment_method, reference_no, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [invoice_id || null, tenant_id || null, amount_paid, payment_type || 'RENT', payment_method || 'MOBILE_MONEY', reference_no || '', req.user.user_id]);
        if (invoice_id) await pool.query("UPDATE invoices SET status = 'PAID' WHERE invoice_id = $1", [invoice_id]);
        await createAuditLog(pool, req.user.user_id, `Recorded Payment`, 'PAYMENTS', req.ip, { payment_id: result.rows[0].payment_id, amount_paid, payment_type });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT e.*, p.property_name, u.full_name as recorded_by_name FROM expenses e LEFT JOIN properties p ON e.property_id = p.property_id LEFT JOIN users u ON e.recorded_by = u.user_id ORDER BY e.expense_date DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/expenses', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { property_id, description, amount, category } = req.body;
    try {
        const result = await pool.query('INSERT INTO expenses (property_id, description, amount, category, recorded_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [property_id || null, description, amount, category || 'MISC', req.user.user_id]);
        await createAuditLog(pool, req.user.user_id, `Recorded Expense`, 'EXPENSES', req.ip, { expense_id: result.rows[0].expense_id, amount, category });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/luku', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM luku_vouchers ORDER BY sold_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/luku/vend', authenticateToken, allowRoles('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
    const { meter_number, tenant_name, amount } = req.body;
    try {
        const ratePerKwh = 350; 
        const kwh_units = (amount / ratePerKwh).toFixed(2);
        const token_number = Array.from({length:4}, () => Math.floor(1000 + Math.random()*9000)).join('-');

        const result = await pool.query('INSERT INTO luku_vouchers (meter_number, tenant_name, amount, token_number, kwh_units, sold_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [meter_number, tenant_name, amount, token_number, kwh_units, req.user.user_id]);
        await createAuditLog(pool, req.user.user_id, `Vended Luku Token`, 'FINANCE_LUKU', req.ip, { voucher_id: result.rows[0].voucher_id, meter_number, token_number, amount, kwh_units });
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. DASHBOARD METRICS & REMINDERS APIs
// ==========================================
app.get('/api/dashboard/metrics', authenticateToken, async (req, res) => {
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties');
        const totalUnits = await pool.query('SELECT COUNT(*) FROM units');
        const occupiedUnits = await pool.query("SELECT COUNT(*) FROM units WHERE status = 'OCCUPIED'");
        const vacantUnits = await pool.query("SELECT COUNT(*) FROM units WHERE status = 'VACANT'");
        const activeTenants = await pool.query("SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE status = 'ACTIVE'");
        const pendingTickets = await pool.query("SELECT COUNT(*) FROM work_orders WHERE status IN ('OPEN', 'IN_PROGRESS')");

        const monthlyIncomeQuery = await pool.query("SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments WHERE payment_date >= DATE_TRUNC('month', CURRENT_DATE)");
        const lukuIncomeQuery = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM luku_vouchers WHERE sold_at >= DATE_TRUNC('month', CURRENT_DATE)");
        const monthlyExpensesQuery = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date >= DATE_TRUNC('month', CURRENT_DATE)");

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
    try {
        const expiredLeases = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date < CURRENT_DATE AND status = 'ACTIVE'");
        const expiringThisWeek = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND status = 'ACTIVE'");
        const expiringThisMonth = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' AND status = 'ACTIVE'");

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
    console.log(`KEY ARCH ERP Server running on port ${PORT}`);
    initDatabase();
});
