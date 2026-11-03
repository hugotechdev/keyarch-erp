const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. DASHBOARD STATISTICS API
app.get('/api/stats', async (req, res) => {
    try {
        const propertiesCount = await pool.query('SELECT COUNT(*) FROM properties');
        const tenantsCount = await pool.query('SELECT COUNT(*) FROM tenants');
        const workOrdersCount = await pool.query("SELECT COUNT(*) FROM work_orders WHERE status = 'Pending'");
        const overdueInvoices = await pool.query("SELECT COUNT(*) FROM invoices WHERE status = 'Overdue'");

        res.json({
            properties: parseInt(propertiesCount.rows[0].count),
            tenants: parseInt(tenantsCount.rows[0].count),
            work_orders: parseInt(workOrdersCount.rows[0].count),
            overdue_invoices: parseInt(overdueInvoices.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. PROPERTY MANAGEMENT API
app.get('/api/properties', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM properties ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/properties', async (req, res) => {
    const { title, location, category, transaction_type, total_units } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO properties (title, location, category, transaction_type, total_units) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [title, location, category, transaction_type || 'For Rent', total_units || 1]
        );
        // Log Audit
        await pool.query('INSERT INTO audit_logs (action_executed) VALUES ($1)', [`Added Property: ${title}`]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. TENANT MANAGEMENT API
app.post('/api/tenants', async (req, res) => {
    const { full_name, identity_type, identity_number, phone_number, email } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO tenants (full_name, identity_type, identity_number, phone_number, email) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [full_name, identity_type || 'NIDA', identity_number, phone_number, email]
        );
        // Log Audit
        await pool.query('INSERT INTO audit_logs (action_executed) VALUES ($1)', [`Onboarded Tenant: ${full_name}`]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. MAINTENANCE TICKETS API
app.get('/api/work-orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM work_orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. AUDIT LOGS API
app.get('/api/audit-logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KEY ARCH ERP Server running on port ${PORT}`);
});