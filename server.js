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

app.use(helmet({ contentSecurityPolicy: false }));

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

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
});

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

// ============================================================
// PAYMENT CALCULATOR (the server is the only source of truth)
// Total Rent  = Rent Price x Number of periods
// Total To Pay = Total Rent - Discount
// Balance      = Total To Pay - Amount Paid
//   Balance > 0  -> tenant still owes   (UNPAID / PARTIAL)
//   Balance = 0  -> fully paid          (PAID)
//   Balance < 0  -> tenant paid extra   (EXTRA_PAID)
// ============================================================
const ALLOWED_RENT_PERIODS = ['Day', 'Week', 'Month', 'Year'];

function calculatePayment({ rent_price, number_of_periods, discount, paid_amount }) {
    const price = parseFloat(rent_price);
    const periods = parseFloat(number_of_periods);
    const disc = parseFloat(discount || 0);
    const paid = parseFloat(paid_amount || 0);

    if (!(price > 0)) return { error: 'Rent Price must be greater than 0.' };
    if (!(periods > 0)) return { error: 'Number of periods must be greater than 0.' };
    if (isNaN(disc) || disc < 0) return { error: 'Discount must be 0 or more.' };
    if (isNaN(paid) || paid < 0) return { error: 'Amount Paid must be 0 or more.' };

    const totalRent = Math.round(price * periods);
    if (disc > totalRent) return { error: 'Discount cannot be more than the Total Rent.' };

    const totalToPay = totalRent - disc;
    const balance = Math.round((totalToPay - paid) * 100) / 100;

    let status;
    if (balance < 0) status = 'EXTRA_PAID';
    else if (balance === 0) status = 'PAID';
    else if (paid > 0) status = 'PARTIAL';
    else status = 'UNPAID';

    return {
        price,
        periods,
        discount: disc,
        paid,
        totalRent,
        totalToPay,
        amountDue: Math.max(0, balance),
        extraPaid: Math.max(0, -balance),
        status
    };
}

async function initDatabase() {
    try {
        if (!process.env.DATABASE_URL) return;
        console.log('🔄 Connecting to Database & Initializing Core Setup...');
        await pool.query('SELECT NOW()');

        // Automatic Schema Patching for Tenants & Leases
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leases' AND column_name='amount_paid') THEN
                    ALTER TABLE leases ADD COLUMN amount_paid NUMERIC(12, 2) DEFAULT 0.00;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leases' AND column_name='amount_due') THEN
                    ALTER TABLE leases ADD COLUMN amount_due NUMERIC(12, 2) DEFAULT 0.00;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='can_edit_tenants') THEN
                    ALTER TABLE users ADD COLUMN can_edit_tenants BOOLEAN DEFAULT true;
                END IF;
            END $$;
        `);

        // NEW: payment breakdown columns on leases
        await pool.query(`
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_price NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_period VARCHAR(10) DEFAULT 'Month';
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS number_of_periods NUMERIC(8, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_rent NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS discount NUMERIC(12, 2) DEFAULT 0.00;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_to_pay NUMERIC(12, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20);
        `);

        // NEW: every field of the Tenant Onboarding form has its own column
        await pool.query(`
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS full_name VARCHAR(150);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nida_passport_no VARCHAR(60);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS start_date DATE;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS end_date DATE;
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS duration_days INTEGER;
        `);
        await pool.query(`
            DO $$
            DECLARE pid_type text;
            BEGIN
                SELECT format_type(a.atttypid, a.atttypmod) INTO pid_type
                FROM pg_attribute a
                WHERE a.attrelid = 'public.properties'::regclass AND a.attname = 'property_id' AND NOT a.attisdropped;

                IF pid_type IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'property_id'
                ) THEN
                    EXECUTE format('ALTER TABLE leases ADD COLUMN property_id %s', pid_type);
                END IF;
            END $$;
        `);
        // Old leases: fill the new columns so old tenants display correctly
        await pool.query(`
            UPDATE leases l SET property_id = u.property_id FROM units u WHERE l.unit_id = u.unit_id AND l.property_id IS NULL;
            UPDATE leases SET
                rent_price = COALESCE(rent_price, agreed_rent),
                rent_period = COALESCE(rent_period, 'Month'),
                number_of_periods = COALESCE(number_of_periods, 1),
                total_rent = COALESCE(total_rent, agreed_rent),
                discount = COALESCE(discount, 0),
                total_to_pay = COALESCE(total_to_pay, agreed_rent),
                duration_days = COALESCE(duration_days, (end_date - start_date))
            WHERE total_to_pay IS NULL OR rent_price IS NULL OR duration_days IS NULL;
            UPDATE leases SET payment_status = CASE
                WHEN COALESCE(amount_paid, 0) > total_to_pay THEN 'EXTRA_PAID'
                WHEN COALESCE(amount_paid, 0) = total_to_pay THEN 'PAID'
                WHEN COALESCE(amount_paid, 0) > 0 THEN 'PARTIAL'
                ELSE 'UNPAID' END
            WHERE payment_status IS NULL AND total_to_pay IS NOT NULL;
        `);

        await pool.query("CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000");

        // Seed Master Admin
        const companyCheck = await pool.query("SELECT * FROM companies WHERE company_name = 'Hugo Tech Platform Master'");
        let masterCompanyId;
        if (companyCheck.rows.length === 0) {
            const newComp = await pool.query("INSERT INTO companies (company_name, subscription_plan) VALUES ('Hugo Tech Platform Master', 'ENTERPRISE') RETURNING company_id");
            masterCompanyId = newComp.rows[0].company_id;
        } else {
            masterCompanyId = companyCheck.rows[0].company_id;
        }

        const masterPassword = process.env.MASTER_ADMIN_PASSWORD || 'Admin@2026';
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@keyarch.co.tz'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash(masterPassword, 10);
            await pool.query(
                "INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                [masterCompanyId, 'Hugo Mlula', 'admin@keyarch.co.tz', hashedPassword, '+255700000000', 'SUPER_ADMIN', true, true]
            );
            console.log('✅ Master Admin Seeded: admin@keyarch.co.tz');
        } else {
            await pool.query("UPDATE users SET company_id = $1 WHERE email = 'admin@keyarch.co.tz' AND company_id IS NULL", [masterCompanyId]);
        }

        console.log('✅ Database Initialization Complete.');
    } catch (err) {
        console.error('❌ DB Initialization Error:', err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. Missing authentication token.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired or invalid token. Please log in again.' });
        req.user = user;
        next();
    });
}

function allowRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Access Denied: Unauthorized role permission.' });
        }
        next();
    };
}

// 1. AUTHENTICATION
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and Password are required.' });

    try {
        const userQuery = await pool.query(
            `SELECT u.*, c.company_name, c.is_active as company_active
             FROM users u
             LEFT JOIN companies c ON u.company_id = c.company_id
             WHERE u.email = $1`,
            [email]
        );
        if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Invalid Email or Password.' });

        const user = userQuery.rows[0];
        if (!user.is_active) return res.status(403).json({ error: 'Account suspended.' });
        if (user.role !== 'SUPER_ADMIN' && user.company_active === false) {
            return res.status(403).json({ error: 'Company account is inactive or suspended.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ error: 'Invalid Email or Password.' });

        const token = jwt.sign(
            { user_id: user.user_id, company_id: user.company_id, email: user.email, role: user.role, full_name: user.full_name, can_edit_tenants: user.can_edit_tenants },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        await createAuditLog(pool, user.company_id, user.user_id, `User Logged In`, 'AUTH', req.ip, { email: user.email });

        res.json({
            message: 'Login successful',
            token,
            user: { user_id: user.user_id, company_id: user.company_id, company_name: user.company_name, full_name: user.full_name, email: user.email, role: user.role, can_edit_tenants: user.can_edit_tenants }
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Server error during login: ' + err.message });
    }
});

// PROPERTIES & UNITS FOR SELECTORS
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, COALESCE(p.property_name, p.title) as property_name, COUNT(u.unit_id) as total_units_count
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

app.get('/api/units/by-property/:property_id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM units WHERE property_id = $1 AND company_id = $2 AND status = 'VACANT' ORDER BY unit_number ASC",
            [req.params.property_id, req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// WIZARD API FOR PROPERTY
app.post('/api/properties/wizard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { property_name, address, property_type, number_of_units, groups } = req.body;
    const companyId = req.user.company_id;

    if (!property_name || !address || !property_type || !groups || !Array.isArray(groups)) {
        return res.status(400).json({ error: 'Please provide valid property details and group array.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const propRes = await client.query(
            'INSERT INTO properties (company_id, property_name, title, address, category, total_units) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [companyId, property_name, property_name, address, property_type, number_of_units || 1]
        );
        const property = propRes.rows[0];

        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
            const grp = groups[gIdx];
            await client.query(
                `INSERT INTO unit_groups
                 (company_id, property_id, group_name, units_in_group, bedrooms, bathrooms, rent_timeline, currency, rent_amount, payment_method, furnishing_status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    companyId, property.property_id, grp.group_name || `Group ${gIdx + 1}`, grp.units_in_group || 1, grp.bedrooms || 0, grp.bathrooms || 0,
                    grp.rent_timeline || 'Per Month', grp.currency || 'TSH', grp.rent_amount || 0, grp.payment_method || 'Cash', grp.furnishing_status || 'Unfurnished'
                ]
            );

            const unitsCount = parseInt(grp.units_in_group || 1);
            const cleanGrpName = (grp.group_name || `G${gIdx + 1}`).replace(/\s+/g, '-');

            for (let uIdx = 1; uIdx <= unitsCount; uIdx++) {
                const unitNumber = `${cleanGrpName}-${uIdx}`;
                await client.query(
                    `INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [companyId, property.property_id, unitNumber, grp.rent_amount || 0, grp.currency || 'TSH', 'VACANT', grp.furnishing_status === 'Furnished']
                );
            }
        }

        await createAuditLog(client, companyId, req.user.user_id, 'Created Multi-Group Property Wizard', 'PROPERTIES', req.ip, { property_id: property.property_id });
        await client.query('COMMIT');
        res.status(201).json({ message: 'Property created successfully', property });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to create property: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

// TENANT ONBOARDING WITH AUTO-INVOICE GENERATION
app.post('/api/tenants/onboard', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    let client;
    try {
        const { full_name, nida_passport_no, phone_number, property_id, unit_id, start_date, end_date, discount, paid_amount, agreed_rent } = req.body;
        let { rent_price, rent_period, number_of_periods } = req.body;
        const companyId = req.user.company_id;

        // Old frontend compatibility: only "agreed_rent" sent = one period
        if (rent_price === undefined && agreed_rent !== undefined) {
            rent_price = agreed_rent;
            number_of_periods = number_of_periods ?? 1;
            rent_period = rent_period || 'Month';
        }
        rent_period = rent_period || 'Month';

        if (!full_name || !nida_passport_no || !phone_number || !property_id || !unit_id || !start_date || !rent_price) {
            return res.status(400).json({ error: 'Please fill in all required fields (*).' });
        }
        if (!ALLOWED_RENT_PERIODS.includes(rent_period)) {
            return res.status(400).json({ error: 'Invalid rent period. Use Day, Week, Month or Year.' });
        }

        // The server calculates everything again. Browser figures are never trusted.
        const calc = calculatePayment({ rent_price, number_of_periods, discount, paid_amount });
        if (calc.error) return res.status(400).json({ error: calc.error });

        client = await pool.connect();
        await client.query('BEGIN');

        const unitCheck = await client.query('SELECT status, property_id FROM units WHERE unit_id = $1 AND company_id = $2', [unit_id, companyId]);
        if (unitCheck.rows.length === 0) throw new Error('Unit not found.');
        if (String(unitCheck.rows[0].property_id) !== String(property_id)) throw new Error('This unit does not belong to the selected property.');
        if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('This unit already has a tenant.');

        const tenantRes = await client.query(
            'INSERT INTO tenants (company_id, full_name, nida_passport_no, phone_number) VALUES ($1, $2, $3, $4) RETURNING *',
            [companyId, full_name, nida_passport_no, phone_number]
        );
        const tenant = tenantRes.rows[0];

        const leaseEndDate = end_date || new Date(new Date(start_date).setFullYear(new Date(start_date).getFullYear() + 1)).toISOString().split('T')[0];

        const durationDays = Math.max(0, Math.round((new Date(leaseEndDate) - new Date(start_date)) / 86400000));

        // agreed_rent keeps the "Total To Pay" so older reports that use it still work
        const leaseRes = await client.query(
            `INSERT INTO leases
             (company_id, unit_id, tenant_id, property_id, start_date, end_date, duration_days, agreed_rent, amount_paid, amount_due, payment_cycle, status,
              rent_price, rent_period, number_of_periods, total_rent, discount, total_to_pay, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
            [
                companyId, unit_id, tenant.tenant_id, property_id, start_date, leaseEndDate, durationDays, calc.totalToPay, calc.paid, calc.amountDue, 'MONTHLY', 'ACTIVE',
                calc.price, rent_period, calc.periods, calc.totalRent, calc.discount, calc.totalToPay, calc.status
            ]
        );
        const lease = leaseRes.rows[0];

        await client.query("UPDATE units SET status = 'OCCUPIED' WHERE unit_id = $1 AND company_id = $2", [unit_id, companyId]);

        // Auto Generate Invoice & Receipt
        const currentYear = new Date().getFullYear();
        const seqRes = await client.query("SELECT nextval('invoice_seq')");
        const autoInvoiceNum = `INV-${currentYear}-${seqRes.rows[0].nextval}`;

        // Invoice status stays PAID / PARTIAL / PENDING (extra paid is shown by the numbers)
        const invStatus = calc.amountDue === 0 ? 'PAID' : (calc.paid > 0 ? 'PARTIAL' : 'PENDING');
        const invRes = await client.query(
            'INSERT INTO invoices (company_id, lease_id, invoice_number, amount_due, due_date, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [companyId, lease.lease_id, autoInvoiceNum, calc.totalToPay, start_date, invStatus]
        );
        const invoice = invRes.rows[0];

        let payment = null;
        if (calc.paid > 0) {
            const payRes = await client.query(
                'INSERT INTO payments (company_id, invoice_id, amount_paid, payment_date, payment_method) VALUES ($1, $2, $3, NOW(), $4) RETURNING *',
                [companyId, invoice.invoice_id, calc.paid, 'CASH/TRANSFER']
            );
            payment = payRes.rows[0];
        }

        await createAuditLog(client, companyId, req.user.user_id, `Onboarded Tenant & Auto-Generated Invoice`, 'TENANTS', req.ip, {
            tenant_id: tenant.tenant_id,
            invoice_id: invoice.invoice_id,
            total_rent: calc.totalRent,
            discount: calc.discount,
            total_to_pay: calc.totalToPay,
            paid: calc.paid,
            payment_status: calc.status
        });
        await client.query('COMMIT');

        res.status(201).json({
            message: 'Tenant onboarded successfully',
            tenant,
            lease,
            payment_status: calc.status,
            invoice: {
                ...invoice,
                paid_amount: calc.paid,
                amount_due: calc.amountDue,
                extra_paid: calc.extraPaid,
                agreed_rent: calc.totalToPay,
                total_rent: calc.totalRent,
                discount: calc.discount,
                total_to_pay: calc.totalToPay
            }
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Onboarding Failed: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

// GET ALL TENANTS WITH PROPERTY DETAILS & FINANCIAL STATUS
app.get('/api/tenants', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT t.*, l.lease_id, l.start_date, l.end_date, l.agreed_rent,
                    l.rent_price, l.rent_period, l.number_of_periods, l.total_rent, COALESCE(l.discount, 0) as discount,
                    COALESCE(l.total_to_pay, l.agreed_rent) as total_to_pay, l.payment_status,
                    COALESCE(l.amount_paid, 0) as amount_paid, COALESCE(l.amount_due, l.agreed_rent) as amount_due,
                    u.unit_number, COALESCE(p.property_name, p.title) as property_name, c.company_name
             FROM tenants t
             JOIN leases l ON t.tenant_id = l.tenant_id
             JOIN units u ON l.unit_id = u.unit_id
             JOIN properties p ON u.property_id = p.property_id
             JOIN companies c ON t.company_id = c.company_id
             WHERE t.company_id = $1
             ORDER BY t.created_at DESC`,
            [req.user.company_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE TENANT
app.put('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER'), async (req, res) => {
    const { full_name, nida_passport_no, phone_number, rent_price, rent_period, number_of_periods, discount, amount_paid, agreed_rent } = req.body;
    const tenantId = req.params.id;

    if (!req.user.can_edit_tenants && req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'COMPANY_ADMIN') {
        return res.status(403).json({ error: 'You do not have permission to edit tenant details.' });
    }

    // Work out the new payment figures first (only if payment fields were sent)
    let calc = null;
    const priceSent = rent_price !== undefined ? rent_price : agreed_rent;
    if (priceSent !== undefined) {
        calc = calculatePayment({
            rent_price: priceSent,
            number_of_periods: number_of_periods !== undefined ? number_of_periods : 1,
            discount,
            paid_amount: amount_paid
        });
        if (calc.error) return res.status(400).json({ error: calc.error });
        if (rent_period !== undefined && !ALLOWED_RENT_PERIODS.includes(rent_period)) {
            return res.status(400).json({ error: 'Invalid rent period. Use Day, Week, Month or Year.' });
        }
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        await client.query(
            'UPDATE tenants SET full_name = $1, nida_passport_no = $2, phone_number = $3 WHERE tenant_id = $4 AND company_id = $5',
            [full_name, nida_passport_no, phone_number, tenantId, req.user.company_id]
        );

        if (calc) {
            await client.query(
                `UPDATE leases SET
                    rent_price = $1, rent_period = COALESCE($2, rent_period), number_of_periods = $3, total_rent = $4, discount = $5,
                    total_to_pay = $6, agreed_rent = $6, amount_paid = $7, amount_due = $8, payment_status = $9
                 WHERE tenant_id = $10 AND company_id = $11 AND status = 'ACTIVE'`,
                [
                    calc.price, rent_period || null, calc.periods, calc.totalRent, calc.discount,
                    calc.totalToPay, calc.paid, calc.amountDue, calc.status,
                    tenantId, req.user.company_id
                ]
            );
        }

        await createAuditLog(client, req.user.company_id, req.user.user_id, 'Updated Tenant Details', 'TENANTS', req.ip, { tenant_id: tenantId });
        await client.query('COMMIT');
        res.json({ message: 'Tenant updated successfully' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// GET FULL INVOICE DETAILS FOR PRINTING
app.get('/api/invoices/:id/print', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT inv.*, l.start_date, l.end_date, l.agreed_rent,
                    l.rent_price, l.rent_period, l.number_of_periods, l.total_rent, COALESCE(l.discount, 0) as discount,
                    COALESCE(l.total_to_pay, l.agreed_rent) as total_to_pay,
                    COALESCE(l.amount_paid, 0) as paid_amount, COALESCE(l.amount_due, 0) as remaining_due,
                    t.full_name as tenant_name, t.phone_number as tenant_phone, t.nida_passport_no,
                    u.unit_number, COALESCE(p.property_name, p.title) as property_name, p.address as property_address,
                    c.company_name
             FROM invoices inv
             JOIN leases l ON inv.lease_id = l.lease_id
             JOIN tenants t ON l.tenant_id = t.tenant_id
             JOIN units u ON l.unit_id = u.unit_id
             JOIN properties p ON u.property_id = p.property_id
             JOIN companies c ON inv.company_id = c.company_id
             WHERE inv.invoice_id = $1 AND inv.company_id = $2`,
            [req.params.id, req.user.company_id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found.' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DASHBOARD METRICS
app.get('/api/dashboard/metrics', authenticateToken, async (req, res) => {
    const cId = req.user.company_id;
    try {
        const totalProperties = await pool.query('SELECT COUNT(*) FROM properties WHERE company_id = $1', [cId]);
        const totalUnits = await pool.query('SELECT COUNT(*) FROM units WHERE company_id = $1', [cId]);
        const occupiedUnits = await pool.query("SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'OCCUPIED'", [cId]);
        const vacantUnits = await pool.query("SELECT COUNT(*) FROM units WHERE company_id = $1 AND status = 'VACANT'", [cId]);
        const activeTenants = await pool.query("SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE company_id = $1 AND status = 'ACTIVE'", [cId]);

        const unitsTotal = parseInt(totalUnits.rows[0]?.count || 0);
        const unitsOccupied = parseInt(occupiedUnits.rows[0]?.count || 0);

        res.json({
            totalProperties: parseInt(totalProperties.rows[0]?.count || 0),
            totalUnits: unitsTotal,
            occupiedUnits: unitsOccupied,
            vacantUnits: parseInt(vacantUnits.rows[0]?.count || 0),
            occupancyRate: unitsTotal > 0 ? Math.round((unitsOccupied / unitsTotal) * 100) : 0,
            activeTenants: parseInt(activeTenants.rows[0]?.count || 0)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KEY ARCH SaaS Multi-Tenant Server running on port ${PORT}`);
    initDatabase();
});
