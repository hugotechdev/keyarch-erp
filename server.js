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

// 1. DASHBOARD & CONTRACT REMINDERS API
app.get('/api/dashboard/summary', async (req, res) => {
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties');
        const totalTenants = await pool.query('SELECT COUNT(*) FROM tenants');
        
        // Income & Expense Totals
        const totalIncome = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM income_ledger');
        const totalExpense = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM expense_ledger');
        const maintenanceCosts = await pool.query('SELECT COALESCE(SUM(total_cost), 0) AS total FROM work_orders');

        // Contract Expiration Reminders
        const expiredLeases = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date < CURRENT_DATE AND status = 'Active'");
        const expiringThisWeek = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'");
        const expiringThisMonth = await pool.query("SELECT COUNT(*) FROM leases WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'");

        res.json({
            properties: parseInt(totalProperties.rows[0].count),
            tenants: parseInt(totalTenants.rows[0].count),
            financials: {
                total_income: parseFloat(totalIncome.rows[0].total),
                total_expense: parseFloat(totalExpense.rows[0].total),
                net_profit: parseFloat(totalIncome.rows[0].total) - parseFloat(totalExpense.rows[0].total),
                maintenance_cost: parseFloat(maintenanceCosts.rows[0].total)
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

// 2. RECORD INCOME (Rent, Luku Vouchers, Service Charges, Sales)
app.post('/api/accounting/income', async (req, res) => {
    const { property_id, tenant_id, account_id, source_type, amount, payment_method, reference_no, description } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO income_ledger (property_id, tenant_id, account_id, source_type, amount, payment_method, reference_no, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [property_id, tenant_id, account_id, source_type, amount, payment_method, reference_no, description]
        );
        // Log Audit
        await pool.query('INSERT INTO audit_logs (action_executed) VALUES ($1)', [`Recorded Income: ${source_type} - TSH ${amount}`]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. RECORD EXPENSE (Maintenance, Utilities, Operational Costs)
app.post('/api/accounting/expense', async (req, res) => {
    const { property_id, account_id, category, amount, paid_to, payment_method, description } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO expense_ledger (property_id, account_id, category, amount, paid_to, payment_method, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [property_id, account_id, category, amount, paid_to, payment_method, description]
        );
        // Log Audit
        await pool.query('INSERT INTO audit_logs (action_executed) VALUES ($1)', [`Recorded Expense: ${category} - TSH ${amount}`]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. FETCH FINANCIAL REPORT (Accounts Overview)
app.get('/api/accounting/report', async (req, res) => {
    try {
        const incomeBySource = await pool.query('SELECT source_type, SUM(amount) as total FROM income_ledger GROUP BY source_type');
        const expensesByCategory = await pool.query('SELECT category, SUM(amount) as total FROM expense_ledger GROUP BY category');
        res.json({
            income_breakdown: incomeBySource.rows,
            expense_breakdown: expensesByCategory.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`KEY ARCH ERP Accounting Server running on port ${PORT}`);
});