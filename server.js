const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Connection via Railway DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API Routes
// 1. Fetch Overview Stats
app.get('/api/stats', async (req, res) => {
    try {
        const propertiesCount = await pool.query('SELECT COUNT(*) FROM properties');
        const tenantsCount = await pool.query('SELECT COUNT(*) FROM tenants');
        res.json({
            properties: parseInt(propertiesCount.rows[0].count),
            tenants: parseInt(tenantsCount.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Add New Property
app.post('/api/properties', async (req, res) => {
    const { title, location, category, transaction_type, total_units } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO properties (title, location, category, transaction_type, total_units) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [title, location, category, transaction_type, total_units || 1]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Get All Properties
app.get('/api/properties', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM properties ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Add New Tenant
app.post('/api/tenants', async (req, res) => {
    const { full_name, identity_type, identity_number, phone_number, email } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO tenants (full_name, identity_type, identity_number, phone_number, email) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [full_name, identity_type || 'NIDA', identity_number, phone_number, email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KeyArch ERP Server running on port ${PORT}`);
});