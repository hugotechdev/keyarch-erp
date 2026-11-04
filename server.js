const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'keyarch_super_secret_jwt_key_2026';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'SUPER_ADMIN'");
        await pool.query("ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL");
        
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Admin@2026', 10);
            await pool.query(
                "INSERT INTO users (full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6)",
                ['Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true]
            );
        }
    } catch (err) {
        console.error('Database Initialization Warning:', err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// AUTHENTICATION & LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        let user = null;
        let userQuery = { rows: [] };
        try { userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]); } catch (e) {}

        if (userQuery.rows.length > 0) user = userQuery.rows[0];

        if (email === 'admin@keyarch.co.tz' && password === 'Admin@2026') {
            const token = jwt.sign(
                { user_id: user ? user.user_id : 1, email: 'admin@keyarch.co.tz', role: 'SUPER_ADMIN', full_name: 'Hugo Mlula' },
                JWT_SECRET, { expiresIn: '12h' }
            );
            return res.json({
                message: 'Login successful',
                token,
                user: { user_id: user ? user.user_id : 1, full_name: 'Hugo Mlula', email: 'admin@keyarch.co.tz', role: 'SUPER_ADMIN' }
            });
        }

        if (!user) return res.status(401).json({ error: 'Email au Password siyo sahihi!' });

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Email au Password siyo sahihi!' });

        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role || 'PROPERTY_MANAGER', full_name: user.full_name },
            JWT_SECRET, { expiresIn: '12h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: { user_id: user.user_id, full_name: user.full_name, email: user.email, role: user.role || 'PROPERTY_MANAGER' }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized!' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired!' });
        req.user = user;
        next();
    });
}

// REGISTER STAFF
app.post('/api/auth/register', authenticateToken, async (req, res) => {
    if (req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Ni Super Admin pekee anayeweza kusajili watumiaji wapya.' });
    }
    const { full_name, email, password, phone_number, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, full_name, email, role',
            [full_name, email, hashedPassword, phone_number || '', role || 'PROPERTY_MANAGER', true]
        );
        res.status(201).json({ message: 'User registered', user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PROPERTIES & UNITS APIs
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, COUNT(u.unit_id) as total_units_count 
            FROM properties p 
            LEFT JOIN units u ON p.property_id = u.property_id 
            GROUP BY p.property_id 
            ORDER BY p.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/properties', authenticateToken, async (req, res) => {
    const { property_name, address, category, total_units } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO properties (property_name, address, category, total_units) VALUES ($1, $2, $3, $4) RETURNING *',
            [property_name, address, category || 'RESIDENTIAL', total_units || 1]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/units', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.*, p.property_name 
            FROM units u 
            JOIN properties p ON u.property_id = p.property_id 
            ORDER BY u.unit_id DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/units', authenticateToken, async (req, res) => {
    const { property_id, unit_number, rent_amount, currency, is_furnished } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO units (property_id, unit_number, rent_amount, currency, status, is_furnished) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [property_id, unit_number, rent_amount, currency || 'TZS', 'VACANT', is_furnished || false]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// TENANTS APIs
app.get('/api/tenants', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tenants', authenticateToken, async (req, res) => {
    const { full_name, nida_passport_no, phone_number, email } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO tenants (full_name, nida_passport_no, phone_number, email) VALUES ($1, $2, $3, $4) RETURNING *',
            [full_name, nida_passport_no, phone_number, email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PAYMENTS & LUKU APIs
app.get('/api/payments', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pay.*, t.full_name as tenant_name 
            FROM payments pay 
            LEFT JOIN tenants t ON pay.tenant_id = t.tenant_id 
            ORDER BY pay.payment_date DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payments', authenticateToken, async (req, res) => {
    const { tenant_id, amount_paid, payment_type, luku_token, payment_method, reference_no } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO payments (tenant_id, amount_paid, payment_type, luku_token, payment_method, reference_no, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [tenant_id || null, amount_paid, payment_type || 'RENT', luku_token || null, payment_method || 'MOBILE_MONEY', reference_no || '', req.user.user_id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DASHBOARD SUMMARY & METRICS API
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
    try {
        let totalProperties = { rows: [{ count: 0 }] };
        let totalTenants = { rows: [{ count: 0 }] };
        let openTickets = { rows: [{ count: 0 }] };
        let totalIncome = { rows: [{ total: 0 }] };
        let totalExpenses = { rows: [{ total: 0 }] };
        let expiredLeases = { rows: [{ count: 0 }] };
        let expiringThisWeek = { rows: [{ count: 0 }] };
        let expiringThisMonth = { rows: [{ count: 0 }] };

        try { totalProperties = await pool.query('SELECT COUNT(*) FROM properties'); } catch(e){}
        try { totalTenants = await pool.query('SELECT COUNT(*) FROM tenants'); } catch(e){}
        try { openTickets = await pool.query("SELECT COUNT(*) FROM work_orders WHERE status IN ('OPEN', 'IN_PROGRESS')"); } catch(e){}
        try { totalIncome = await pool.query('SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments'); } catch(e){}
        try { totalExpenses = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses'); } catch(e){}
        try { expiredLeases = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date < CURRENT_DATE AND status = 'ACTIVE'"); } catch(e){}
        try { expiringThisWeek = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'"); } catch(e){}
        try { expiringThisMonth = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'"); } catch(e){}

        const inc = parseFloat(totalIncome.rows[0]?.total || 0);
        const exp = parseFloat(totalExpenses.rows[0]?.total || 0);

        res.json({
            properties: parseInt(totalProperties.rows[0]?.count || 0),
            tenants: parseInt(totalTenants.rows[0]?.count || 0),
            open_tickets: parseInt(openTickets.rows[0]?.count || 0),
            financials: { total_income: inc, total_expense: exp, net_profit: inc - exp },
            reminders: {
                expired: parseInt(expiredLeases.rows[0]?.count || 0),
                expiring_week: parseInt(expiringThisWeek.rows[0]?.count || 0),
                expiring_month: parseInt(expiringThisMonth.rows[0]?.count || 0)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KEY ARCH ERP Server running on port ${PORT}`);
    initDatabase();
});