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

// 1. DASHBOARD & CONTRACT REMINDERS ANALYTICS
app.get('/api/dashboard/summary', async (req, res) => {
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties');
        const totalTenants = await pool.query('SELECT COUNT(*) FROM tenants');
        const totalTickets = await pool.query("SELECT COUNT(*) FROM work_orders WHERE status IN ('OPEN', 'IN_PROGRESS')");

        // Financial Totals
        const totalIncome = await pool.query('SELECT COALESCE(SUM(amount_paid), 0) AS total FROM payments');
        const totalExpenses = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses');

        // Contract Expiration Alerts
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

// 2. PROPERTY REGISTRATION
app.post('/api/properties', async (req, res) => {
    const { property_name, address, category, total_units } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO properties (property_name, address, category, total_units) VALUES ($1, $2, $3, $4) RETURNING *',
            [property_name, address, category || 'RESIDENTIAL', total_units || 1]
        );
        await pool.query('INSERT INTO audit_logs (action_performed, module_affected) VALUES ($1, $2)', [`Registered Property: ${property_name}`, 'PROPERTIES']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. TENANT ONBOARDING
app.post('/api/tenants', async (req, res) => {
    const { full_name, nida_passport_no, phone_number, email } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO tenants (full_name, nida_passport_no, phone_number, email) VALUES ($1, $2, $3, $4) RETURNING *',
            [full_name, nida_passport_no, phone_number, email]
        );
        await pool.query('INSERT INTO audit_logs (action_performed, module_affected) VALUES ($1, $2)', [`Onboarded Tenant: ${full_name}`, 'TENANTS']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. PAYMENTS & LUKU VOUCHER SALES
app.post('/api/payments', async (req, res) => {
    const { tenant_id, amount_paid, payment_type, luku_token, payment_method, reference_no } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO payments (tenant_id, amount_paid, payment_type, luku_token, payment_method, reference_no) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [tenant_id || null, amount_paid, payment_type || 'RENT', luku_token || null, payment_method || 'CASH', reference_no || '']
        );
        await pool.query('INSERT INTO audit_logs (action_performed, module_affected) VALUES ($1, $2)', [`Recorded Payment: ${payment_type} - TZS ${amount_paid}`, 'PAYMENTS']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. EXPENSE RECORDING
app.post('/api/expenses', async (req, res) => {
    const { property_id, description, amount, category } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO expenses (property_id, description, amount, category) VALUES ($1, $2, $3, $4) RETURNING *',
            [property_id || null, description, amount, category || 'MISC']
        );
        await pool.query('INSERT INTO audit_logs (action_performed, module_affected) VALUES ($1, $2)', [`Recorded Expense: ${description} - TZS ${amount}`, 'EXPENSES']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. WORK ORDERS / TICKETS
app.post('/api/work-orders', async (req, res) => {
    const { unit_id, title, description, priority, estimated_cost } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO work_orders (unit_id, title, description, priority, estimated_cost) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [unit_id || null, title, description, priority || 'MEDIUM', estimated_cost || 0.00]
        );
        await pool.query('INSERT INTO audit_logs (action_performed, module_affected) VALUES ($1, $2)', [`Created Work Order: ${title}`, 'MAINTENANCE']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KEY ARCH ERP Server running on port ${PORT}`);
});