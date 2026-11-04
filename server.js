require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const CATEGORIES = ['RESIDENTIAL', 'COMMERCIAL', 'VACATION', 'OFFICE_SPACE'];

app.get('/api/stats', async (req, res) => {
  try {
    const p = await pool.query('SELECT COUNT(*)::int AS n FROM properties');
    const t = await pool.query('SELECT COUNT(*)::int AS n FROM tenants');
    res.json({ properties: p.rows[0].n, tenants: t.rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/properties', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT property_id AS id, property_name AS title, address AS location,
              category, 'For Rent' AS transaction_type
       FROM properties ORDER BY property_id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/properties', async (req, res) => {
  const { title, location, category, total_units } = req.body || {};
  if (!title || !location) return res.status(400).json({ error: 'title and location required' });
  const cat = CATEGORIES.includes(String(category).toUpperCase()) ? String(category).toUpperCase() : 'RESIDENTIAL';
  try {
    const { rows } = await pool.query(
      'INSERT INTO properties (property_name, address, category, total_units) VALUES ($1,$2,$3,$4) RETURNING property_id',
      [title, location, cat, Number(total_units) || 0]
    );
    res.status(201).json({ id: rows[0].property_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/tenants', async (req, res) => {
  const { full_name, identity_number, phone_number, email } = req.body || {};
  if (!full_name || !identity_number || !phone_number) {
    return res.status(400).json({ error: 'full_name, identity_number and phone_number required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO tenants (full_name, nida_passport_no, phone_number, email) VALUES ($1,$2,$3,$4) RETURNING tenant_id',
      [full_name, identity_number, phone_number, email || null]
    );
    res.status(201).json({ id: rows[0].tenant_id });
  } catch (err) {
    console.error(err);
    res.status(err.code === '23505' ? 409 : 500).json({ error: 'Could not save tenant' });
  }
});

for (const f of ['app.js', 'style.css']) {
  app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f)));
}
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function init() {
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(fs.readFileSync(path.join(__dirname, 'database.sql'), 'utf8'));
    } catch (err) {
      console.error('Schema init failed:', err.message);
    }
  } else {
    console.warn('DATABASE_URL not set; API calls will fail');
  }
  const port = process.env.PORT || 8080;
  app.listen(port, '0.0.0.0', () => console.log(`KeyArch ERP listening on ${port}`));
}
init();
