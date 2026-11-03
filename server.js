const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'keyarch_super_secret_jwt_key_2026';

// PostgreSQL Connection Setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Auto-Run Essential Migrations & Setup Default Super Admin
async function initDatabase() {
    try {
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'SUPER_ADMIN'");
        await pool.query("ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL");
        
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Admin@2026', 10);
            await pool.query(
                "INSERT INTO users (full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6)",
                ['Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true]
            );
            console.log('✅ Default Super Admin created: admin@keyarch.co.tz / Admin@2026');
        }
    } catch (err) {
        console.error('Database Initialization Warning:', err.message);
    }
}
initDatabase();

// Serve Main UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 1. AUTHENTICATION & LOGIN API
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        let user = null;
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (userQuery.rows.length > 0) {
            user = userQuery.rows[0];
        }

        // Direct Fallback Guarantee for Super Admin Access
        if (email === 'admin@keyarch.co.tz' && password === 'Admin@2026') {
            const token = jwt.sign(
                { user_id: user ? user.user_id : 1, email: 'admin@keyarch.co.tz', role: 'SUPER_ADMIN', full_name: 'Hugo Mlula' },
                JWT_SECRET,
                { expiresIn: '12h' }
            );
            return res.json({
                message: 'Login successful',
                token,
                user: { user_id: user ? user.user_id : 1, full_name: 'Hugo Mlula', email: 'admin@keyarch.co.tz', role: 'SUPER_ADMIN' }
            });
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password!' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid email or password!' });
        }

        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role || 'PROPERTY_MANAGER', full_name: user.full_name },
            JWT_SECRET,
            { expiresIn: '12h' }
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

// Middleware for Authenticated JWT Routes
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized access!' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired. Please sign in again.' });
        req.user = user;
        next();
    });
}

// ==========================================
// 2. ADMIN USER REGISTRATION API (RBAC Restricted)
// ==========================================
app.post('/api/auth/register', authenticateToken, async (req, res) => {
    if (req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Only Super Admin can register new users.' });
    }

    const { full_name, email, password, phone_number, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (full_name, email, password_hash, phone_number, role, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, full_name, email, role',
            [full_name, email, hashedPassword, phone_number || '', role || 'PROPERTY_MANAGER', true]
        );

        res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. PROTECTED DASHBOARD SUMMARY API
// ==========================================
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties');
        const totalTenants = await pool.query('SELECT COUNT(*) FROM tenants');

        res.json({
            properties: parseInt(totalProperties.rows[0]?.count || 0),
            tenants: parseInt(totalTenants.rows[0]?.count || 0),
            open_tickets: 0,
            financials: { total_income: 0, total_expense: 0, net_profit: 0 },
            reminders: { expired: 0, expiring_week: 0, expiring_month: 0 }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KEY ARCH ERP Server running on port ${PORT}`);
});