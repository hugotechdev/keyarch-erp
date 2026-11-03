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

// Auto-seed Default Super Admin on Server Startup
async function initSuperAdmin() {
    try {
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Admin@2026', 10);
            await pool.query(
                "INSERT INTO users (full_name, email, password_hash, phone_number, role) VALUES ($1, $2, $3, $4, $5)",
                ['Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN']
            );
            console.log('Default Super Admin created: admin@keyarch.co.tz / Admin@2026');
        }
    } catch (err) {
        console.error('Error seeding admin:', err.message);
    }
}
initSuperAdmin();

// Serve Main Web Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 1. AUTHENTICATION & LOGIN API
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userQuery.rows.length === 0) {
            return res.status(401).json({ error: 'Email au Password siyo sahihi!' });
        }

        const user = userQuery.rows[0];
        if (!user.is_active) {
            return res.status(403).json({ error: 'Akaunti hii imesimamishwa. Mawasiliano na Super Admin.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Email au Password siyo sahihi!' });
        }

        // Generate JWT Token
        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role, full_name: user.full_name },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        // Audit Log Entry
        await pool.query(
            'INSERT INTO audit_logs (user_id, action_performed, module_affected, ip_address) VALUES ($1, $2, $3, $4)',
            [user.user_id, `User logged in: ${user.email}`, 'AUTH', req.ip]
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                user_id: user.user_id,
                full_name: user.full_name,
                email: user.email,
                role: user.role
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Middleware for Authenticated Routes
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Huruhusiwi kuingia bila Token!' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token imeharibika au kuisha muda wake!' });
        req.user = user;
        next();
    });
}

// 2. CREATE NEW SYSTEM USER (RBAC Controlled)
app.post('/api/users', authenticateToken, async (req, res) => {
    // Super Admin pekee ndiye anayeweza kuunda watumiaji wapya
    if (req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Ni Super Admin pekee anayeweza kuongeza watumiaji.' });
    }

    const { full_name, email, password, phone_number, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (full_name, email, password_hash, phone_number, role) VALUES ($1, $2, $3, $4, $5) RETURNING user_id, full_name, email, role',
            [full_name, email, hashedPassword, phone_number, role || 'PROPERTY_MANAGER']
        );

        await pool.query(
            'INSERT INTO audit_logs (user_id, action_performed, module_affected, ip_address) VALUES ($1, $2, $3, $4)',
            [req.user.user_id, `Created User: ${email} with Role: ${role}`, 'USER_MANAGEMENT', req.ip]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. DASHBOARD SUMMARY (Protected Route)
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties');
        const totalTenants = await pool.query('SELECT COUNT(*) FROM tenants');
        const totalTickets = await pool.query("SELECT COUNT(*) FROM work_orders WHERE status IN ('OPEN', 'IN_PROGRESS')");

        const totalIncome = await pool.query('SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments');
        const totalExpenses = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses');

        const expiredLeases = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date < CURRENT_DATE AND status = 'ACTIVE'");
        const expiringThisWeek = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'");
        const expiringThisMonth = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'");

        const incomeVal = parseFloat(totalIncome.rows[0].total);
        const expenseVal = parseFloat(totalExpenses.rows[0].total);

        res.json({
            properties: parseInt(totalProperties.rows[0].count),
            tenants: parseInt(totalTenants.rows[0].count),
            open_tickets: parseInt(totalTickets.rows[0].count),
            financials: {
                total_income: incomeVal,
                total_expense: expenseVal,
                net_profit: incomeVal - expenseVal
            },
            reminders: {
                expired: parseInt(expiredLeases.rows[0].count),
                expiring_week: parseInt(expiringThisWeek.rows[0].count),
                expiring_month: parseInt(expiringThisMonth.rows[0].count)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KEY ARCH ERP Server running on port ${PORT}`);
});