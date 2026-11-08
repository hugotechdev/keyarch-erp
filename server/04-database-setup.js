// DATABASE SETUP
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { JWT_SECRET, ROOT, accessBlock, accessCache, app, bcrypt, effectiveFeatures, getCompanyAccess, jwt, path, pool } = ctx;


    // ============================================================
    // DATABASE SETUP
    // Every step runs on its own: one problem never stops the others.
    // The Super Admin can also run it from Platform Admin > Run Database Setup.
    // ============================================================
    const SERVER_VERSION = 'v10.0 - 2026-11-08 - split into section files (js and server folders)';

    const SETUP_STEPS = [
        { name: "Base columns (leases, users)", sql: `
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
    ` },
        { name: "Lease payment columns", sql: `
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_price NUMERIC(12, 2);
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS rent_period VARCHAR(10) DEFAULT 'Month';
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS number_of_periods NUMERIC(8, 2);
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_rent NUMERIC(12, 2);
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS discount NUMERIC(12, 2) DEFAULT 0.00;
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS total_to_pay NUMERIC(12, 2);
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20);
    ` },
        { name: "Tenant form columns", sql: `
                ALTER TABLE tenants ADD COLUMN IF NOT EXISTS full_name VARCHAR(150);
                ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nida_passport_no VARCHAR(60);
                ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
                ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS start_date DATE;
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS end_date DATE;
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS duration_days INTEGER;
    ` },
        { name: "Lease property_id", sql: `
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
    ` },
        { name: "Fill old leases", sql: `
                UPDATE leases l SET property_id = u.property_id FROM units u WHERE l.unit_id = u.unit_id AND l.property_id IS NULL;
                UPDATE leases SET
                    rent_price = COALESCE(rent_price, agreed_rent),
                    rent_period = COALESCE(rent_period, 'Month'),
                    number_of_periods = COALESCE(number_of_periods, 1),
                    total_rent = COALESCE(total_rent, agreed_rent),
                    discount = COALESCE(discount, 0),
                    total_to_pay = COALESCE(total_to_pay, agreed_rent),
                    duration_days = COALESCE(duration_days, (end_date::date - start_date::date))
                WHERE total_to_pay IS NULL OR rent_price IS NULL OR duration_days IS NULL;
                UPDATE leases SET payment_status = CASE
                    WHEN COALESCE(amount_paid, 0) > total_to_pay THEN 'EXTRA_PAID'
                    WHEN COALESCE(amount_paid, 0) = total_to_pay THEN 'PAID'
                    WHEN COALESCE(amount_paid, 0) > 0 THEN 'PARTIAL'
                    ELSE 'UNPAID' END
                WHERE payment_status IS NULL AND total_to_pay IS NOT NULL;
    ` },
        { name: "Lease state (current/renewed/ended)", sql: `
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'lease_state') THEN
                        ALTER TABLE leases ADD COLUMN lease_state VARCHAR(12) DEFAULT 'CURRENT';
                        UPDATE leases SET lease_state = 'ENDED' WHERE status IS NOT NULL AND UPPER(status::text) <> 'ACTIVE';
                    END IF;
                END $$;
    ` },
        { name: "Tenant history table", sql: `
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS ended_reason VARCHAR(200);
                ALTER TABLE leases ADD COLUMN IF NOT EXISTS previous_lease_id INTEGER;
                ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
                CREATE TABLE IF NOT EXISTS lease_events (
                    event_id SERIAL PRIMARY KEY,
                    company_id INTEGER,
                    lease_id INTEGER,
                    tenant_id INTEGER,
                    event_type VARCHAR(20),
                    description TEXT,
                    amount NUMERIC(12,2),
                    created_by INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_lease_events_tenant ON lease_events (tenant_id);
                CREATE INDEX IF NOT EXISTS idx_leases_tenant ON leases (tenant_id);
    ` },
        { name: "Plans, access and platform payments", sql: `
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan VARCHAR(12) DEFAULT 'PRO';
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS access_status VARCHAR(12) DEFAULT 'ACTIVE';
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_type VARCHAR(12) DEFAULT 'ONE_TIME';
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS paid_until DATE;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'::jsonb;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
                CREATE TABLE IF NOT EXISTS platform_payments (
                    payment_id   SERIAL PRIMARY KEY,
                    company_id   INTEGER,
                    payment_type VARCHAR(20),
                    amount       NUMERIC(14,2),
                    method       VARCHAR(40),
                    reference    VARCHAR(80),
                    months       INTEGER,
                    period_until DATE,
                    notes        TEXT,
                    recorded_by  INTEGER,
                    paid_at      TIMESTAMP DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_platform_payments_company ON platform_payments (company_id);
    ` },
        { name: "Invoice number sequence", sql: `CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000` },
        { name: "Lease rule: one CURRENT lease per unit", sql: `
            DROP INDEX IF EXISTS one_active_lease_per_unit;
            CREATE UNIQUE INDEX IF NOT EXISTS one_current_lease_per_unit ON leases (unit_id) WHERE lease_state = 'CURRENT'
        ` },
        { name: "Tenant ID number is unique per company", sql: `
            ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_nida_passport_no_key;
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_id_per_company ON tenants (company_id, nida_passport_no)
        ` },

        // ---------- v6 ----------
        { name: "Company profile and financial year", sql: `
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS email VARCHAR(120);
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS tin VARCHAR(40);
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS fy_start_month INTEGER DEFAULT 1;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_instructions TEXT;
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS luku_low_threshold INTEGER DEFAULT 5
        ` },
        { name: "Company logo", sql: `
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data TEXT
        ` },
        { name: "Password reset links", sql: `
            CREATE TABLE IF NOT EXISTS password_resets (
                reset_id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets (token_hash)
        ` },
        { name: "Allow VIEWER role", sql: `
            DO $$
            DECLARE c record;
            BEGIN
                FOR c IN SELECT conname FROM pg_constraint
                         WHERE conrelid = 'public.users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
                LOOP
                    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
                END LOOP;
                ALTER TABLE users ADD CONSTRAINT users_role_check
                    CHECK (role IN ('SUPER_ADMIN','COMPANY_ADMIN','PROPERTY_MANAGER','ACCOUNTANT','TECHNICIAN','MAINTENANCE_MANAGER','VIEWER'));
            END $$;
        ` },
        { name: "Invoice details", sql: `
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type VARCHAR(20) DEFAULT 'RENT';
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description TEXT;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2);
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) DEFAULT 0;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date DATE;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_start DATE;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_end DATE;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS lease_charge BOOLEAN DEFAULT true;
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by INTEGER;
            UPDATE invoices SET issue_date = created_at::date WHERE issue_date IS NULL;
            CREATE INDEX IF NOT EXISTS idx_invoices_type_period ON invoices (lease_id, invoice_type, period_start)
        ` },
        { name: "Receipts and payment details", sql: `
            CREATE SEQUENCE IF NOT EXISTS receipt_seq START 100000;
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(40);
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS method_detail VARCHAR(40);
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS notes TEXT;
            CREATE INDEX IF NOT EXISTS idx_payments_company_date ON payments (company_id, payment_date)
        ` },
        { name: "Service charges", sql: `
            ALTER TABLE units ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12,2) DEFAULT 0;
            ALTER TABLE units ADD COLUMN IF NOT EXISTS service_inclusive BOOLEAN DEFAULT false;
            ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12,2) DEFAULT 0;
            ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS service_inclusive BOOLEAN DEFAULT false;
            ALTER TABLE properties ADD COLUMN IF NOT EXISTS service_charge_label VARCHAR(60) DEFAULT 'Service charge'
        ` },
        { name: "Expenses details", sql: `
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee VARCHAR(120);
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ticket_id INTEGER;
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
            DO $$
            DECLARE c record;
            BEGIN
                FOR c IN SELECT conname FROM pg_constraint
                         WHERE conrelid = 'public.expenses'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%category%'
                LOOP
                    EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', c.conname);
                END LOOP;
            END $$;
        ` },
        { name: "Maintenance ticket details", sql: `
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS property_id INTEGER;
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS actual_cost NUMERIC(12,2);
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by INTEGER;
            UPDATE work_orders w SET property_id = u.property_id FROM units u WHERE w.unit_id = u.unit_id AND w.property_id IS NULL
        ` },
        { name: "Luku stock", sql: `
            CREATE TABLE IF NOT EXISTS luku_stock (
                stock_id    SERIAL PRIMARY KEY,
                company_id  INTEGER NOT NULL,
                unit_name   VARCHAR(80) NOT NULL,
                token       VARCHAR(40) NOT NULL,
                price       NUMERIC(12,2) NOT NULL,
                kwh         NUMERIC(10,2),
                status      VARCHAR(10) DEFAULT 'AVAILABLE',
                batch       VARCHAR(80),
                uploaded_at TIMESTAMP DEFAULT NOW(),
                sold_at     TIMESTAMP,
                sold_to     VARCHAR(120),
                sold_by     INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_luku_token_per_company ON luku_stock (company_id, token);
            CREATE INDEX IF NOT EXISTS idx_luku_stock_lookup ON luku_stock (company_id, unit_name, price, status)
        ` },
        { name: "Make sure columns exist (older databases)", sql: `
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_by INTEGER;
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100);
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS property_id INTEGER;
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recorded_by INTEGER;
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(12,2) DEFAULT 0;
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS assigned_technician_id INTEGER;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
        ` },
        { name: "Payments: remove old type rule", sql: `
            DO $$
            DECLARE c record;
            BEGIN
                FOR c IN SELECT conname FROM pg_constraint
                         WHERE conrelid = 'public.payments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%payment_type%'
                LOOP
                    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
                END LOOP;
            END $$;
        ` },
        { name: "Luku sales table allows the same token text per company", sql: `
            ALTER TABLE luku_vouchers DROP CONSTRAINT IF EXISTS luku_vouchers_token_number_key;
            ALTER TABLE luku_vouchers ADD COLUMN IF NOT EXISTS unit_name VARCHAR(80);
            ALTER TABLE luku_vouchers ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30)
        ` },
        { name: "Staff must ask before editing tenants (one time)", sql: `
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edit_requests') THEN
                    UPDATE users SET can_edit_tenants = false WHERE role NOT IN ('COMPANY_ADMIN', 'SUPER_ADMIN');
                END IF;
            END $$;
        ` },
        { name: "Edit requests table", sql: `
            CREATE TABLE IF NOT EXISTS edit_requests (
                request_id    SERIAL PRIMARY KEY,
                company_id    INTEGER,
                entity_type   VARCHAR(20) NOT NULL,
                entity_id     INTEGER NOT NULL,
                entity_label  VARCHAR(200),
                section       VARCHAR(30) NOT NULL,
                reason        TEXT,
                requested_by  INTEGER,
                status        VARCHAR(12) DEFAULT 'PENDING',
                decided_by    INTEGER,
                decided_at    TIMESTAMP,
                decision_note TEXT,
                expires_at    TIMESTAMP,
                used_at       TIMESTAMP,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_edit_requests_company ON edit_requests (company_id, status)
        ` }
        ,{ name: "Finance: currency, accounts, income", sql: `
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
            ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_id INTEGER;
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_currency VARCHAR(3);
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_amount NUMERIC(14, 2);
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14, 4);
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS account_id INTEGER;
            CREATE TABLE IF NOT EXISTS finance_accounts (
                account_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                name VARCHAR(100) NOT NULL,
                currency VARCHAR(3) NOT NULL DEFAULT 'TZS',
                kind VARCHAR(20) DEFAULT 'CASH',
                opening_balance NUMERIC(14, 2) DEFAULT 0,
                is_active BOOLEAN DEFAULT true,
                created_by INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS finance_income (
                income_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                account_id INTEGER,
                property_id INTEGER,
                description TEXT NOT NULL,
                amount NUMERIC(14, 2) NOT NULL,
                currency VARCHAR(3) DEFAULT 'TZS',
                category VARCHAR(30) DEFAULT 'OTHER',
                income_date DATE DEFAULT CURRENT_DATE,
                payer VARCHAR(120),
                reference VARCHAR(100),
                notes TEXT,
                recorded_by INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_fin_income_company ON finance_income (company_id, income_date);
            CREATE INDEX IF NOT EXISTS idx_fin_accounts_company ON finance_accounts (company_id)
        ` }
        ,{ name: "Finance: TSh-only views", sql: `
            DROP VIEW IF EXISTS payments_tzs;
            DROP VIEW IF EXISTS invoices_tzs;
            DROP VIEW IF EXISTS expenses_tzs;
            CREATE VIEW payments_tzs AS SELECT * FROM payments WHERE COALESCE(currency, 'TZS') = 'TZS';
            CREATE VIEW invoices_tzs AS SELECT * FROM invoices WHERE COALESCE(currency, 'TZS') = 'TZS';
            CREATE VIEW expenses_tzs AS SELECT * FROM expenses WHERE COALESCE(currency, 'TZS') = 'TZS'
        ` }
        ,{ name: "Maintenance workers (no login) and role MAINTENANCE_MANAGER", sql: `
            DO $$ DECLARE c record; BEGIN
                FOR c IN SELECT conname FROM pg_constraint
                         WHERE conrelid = 'public.users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
                LOOP EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname); END LOOP;
                ALTER TABLE users ADD CONSTRAINT users_role_check
                    CHECK (role IN ('SUPER_ADMIN','COMPANY_ADMIN','PROPERTY_MANAGER','ACCOUNTANT','TECHNICIAN','MAINTENANCE_MANAGER','VIEWER'));
            END $$;
            CREATE TABLE IF NOT EXISTS maintenance_workers (
                worker_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                full_name VARCHAR(120) NOT NULL,
                phone_number VARCHAR(40),
                is_active BOOLEAN DEFAULT true,
                legacy_user_id INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_mworkers_company ON maintenance_workers(company_id);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_mworkers_legacy ON maintenance_workers(legacy_user_id) WHERE legacy_user_id IS NOT NULL;
            ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS worker_id INTEGER;
            INSERT INTO maintenance_workers (company_id, full_name, phone_number, is_active, legacy_user_id)
                SELECT u.company_id, u.full_name, u.phone_number, u.is_active, u.user_id FROM users u
                WHERE u.role = 'TECHNICIAN' AND u.company_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM maintenance_workers m WHERE m.legacy_user_id = u.user_id);
            UPDATE work_orders w SET worker_id = m.worker_id FROM maintenance_workers m
                WHERE w.worker_id IS NULL AND w.assigned_technician_id IS NOT NULL AND m.legacy_user_id = w.assigned_technician_id;
            UPDATE users SET role = 'MAINTENANCE_MANAGER' WHERE role = 'TECHNICIAN';
        ` }
        ,{ name: "Organization structure (departments, project access)", sql: `
            CREATE TABLE IF NOT EXISTS departments (
                department_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                name VARCHAR(80) NOT NULL,
                default_role VARCHAR(30) DEFAULT 'VIEWER',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_name ON departments (company_id, LOWER(name));
            CREATE TABLE IF NOT EXISTS user_properties (
                user_id INTEGER NOT NULL,
                property_id INTEGER NOT NULL,
                PRIMARY KEY (user_id, property_id)
            );
            CREATE INDEX IF NOT EXISTS idx_user_properties_prop ON user_properties (property_id);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id INTEGER;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS scope_all BOOLEAN DEFAULT true;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS can_add_staff BOOLEAN DEFAULT false;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(80);
            ALTER TABLE properties ADD COLUMN IF NOT EXISTS created_by INTEGER;
        ` }
        ,{ name: "Unit owners and service charge currency", sql: `
            CREATE TABLE IF NOT EXISTS owners (
                owner_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                full_name VARCHAR(120) NOT NULL,
                phone_number VARCHAR(30),
                email VARCHAR(120),
                notes TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            ALTER TABLE units ADD COLUMN IF NOT EXISTS owner_id INTEGER;
            ALTER TABLE units ADD COLUMN IF NOT EXISTS occupancy_type VARCHAR(20) DEFAULT 'LET';
            ALTER TABLE units ADD COLUMN IF NOT EXISTS service_currency VARCHAR(3);
            ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS owner_id INTEGER;
            ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS occupancy_type VARCHAR(20) DEFAULT 'LET';
            ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS service_currency VARCHAR(3);
            CREATE INDEX IF NOT EXISTS idx_units_owner ON units (owner_id);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS service_amount NUMERIC(14, 2);
            ALTER TABLE leases ADD COLUMN IF NOT EXISTS service_rate NUMERIC(14, 4)
        ` }
        ,{ name: "Service charge billed to owners who live in their unit", sql: `
            CREATE TABLE IF NOT EXISTS owner_charges (
                charge_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                unit_id INTEGER NOT NULL,
                owner_id INTEGER,
                period_month DATE NOT NULL,
                amount NUMERIC(14, 2) NOT NULL,
                currency VARCHAR(3) NOT NULL DEFAULT 'TZS',
                paid_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE (unit_id, period_month)
            );
            CREATE TABLE IF NOT EXISTS owner_payments (
                payment_id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                charge_id INTEGER NOT NULL,
                amount NUMERIC(14, 2) NOT NULL,
                paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
                method VARCHAR(40),
                reference_no VARCHAR(80),
                created_by INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_owner_charges_co ON owner_charges (company_id, period_month);
            CREATE INDEX IF NOT EXISTS idx_owner_payments_charge ON owner_payments (charge_id)
        ` }
    ];

    async function seedMasterAdmin() {
        // The owner of the system (SUPER_ADMIN) is created from Railway Variables, never from the code:
        //   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD  (used only when the account is created / adopted)
        //   RESET_SUPER_ADMIN_PASSWORD               (emergency: sets a new password, remove it after one deploy)
        const companyCheck = await pool.query("SELECT * FROM companies WHERE company_name = 'Hugo Tech Platform Master'");
        let masterCompanyId;
        if (companyCheck.rows.length === 0) {
            const newComp = await pool.query("INSERT INTO companies (company_name, subscription_plan) VALUES ('Hugo Tech Platform Master', 'ENTERPRISE') RETURNING company_id");
            masterCompanyId = newComp.rows[0].company_id;
        } else {
            masterCompanyId = companyCheck.rows[0].company_id;
        }

        const envEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
        const envPass = String(process.env.SUPER_ADMIN_PASSWORD || '');
        const existingAdmins = (await pool.query("SELECT user_id, email FROM users WHERE role = 'SUPER_ADMIN' ORDER BY user_id ASC")).rows;
        await pool.query("UPDATE users SET company_id = $1 WHERE role = 'SUPER_ADMIN' AND company_id IS NULL", [masterCompanyId]);

        if (envEmail && envPass.length >= 8) {
            const mine = (await pool.query('SELECT user_id, role FROM users WHERE LOWER(email) = $1', [envEmail])).rows[0];
            if (!mine) {
                const hashed = await bcrypt.hash(envPass, 10);
                if (existingAdmins.length > 0) {
                    // an older owner account exists: it takes the new email and password (once)
                    await pool.query("UPDATE users SET email = $1, password_hash = $2, is_active = true WHERE user_id = $3", [envEmail, hashed, existingAdmins[0].user_id]);
                    console.log('✅ Super Admin account moved to the email from SUPER_ADMIN_EMAIL');
                } else {
                    await pool.query(
                        "INSERT INTO users (company_id, full_name, email, password_hash, phone_number, role, is_active, can_edit_tenants) VALUES ($1, $2, $3, $4, $5, 'SUPER_ADMIN', true, true)",
                        [masterCompanyId, 'System Owner', envEmail, hashed, '']
                    );
                    console.log('✅ Super Admin created from SUPER_ADMIN_EMAIL');
                }
            } else if (mine.role !== 'SUPER_ADMIN') {
                console.error('❌ SUPER_ADMIN_EMAIL belongs to a normal user. Use another email.');
            }
            // an account that already exists is NOT touched: the owner may have changed the password on the Super Admin page
        } else if (existingAdmins.length === 0) {
            console.error('⚠️ No Super Admin exists. Add SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (min 8 characters) in Railway Variables and redeploy.');
        }

        if (process.env.RESET_SUPER_ADMIN_PASSWORD && String(process.env.RESET_SUPER_ADMIN_PASSWORD).length >= 8) {
            const target = envEmail ? (await pool.query("SELECT user_id FROM users WHERE LOWER(email) = $1 AND role = 'SUPER_ADMIN'", [envEmail])).rows[0] : null;
            const uid = target ? target.user_id : (existingAdmins[0] && existingAdmins[0].user_id);
            if (uid) {
                const hashed = await bcrypt.hash(String(process.env.RESET_SUPER_ADMIN_PASSWORD), 10);
                await pool.query("UPDATE users SET password_hash = $1, is_active = true WHERE user_id = $2", [hashed, uid]);
                console.log('✅ Super Admin password was reset from RESET_SUPER_ADMIN_PASSWORD (remove this variable now)');
            }
        }
    }

    async function runDatabaseSetup() {
        const results = [];
        const run = async (name, fn) => {
            try { await fn(); results.push({ step: name, ok: true }); }
            catch (err) {
                console.error(`❌ Setup step failed [${name}]:`, err.message);
                results.push({ step: name, ok: false, error: err.message });
            }
        };

        for (const step of SETUP_STEPS) {
            // blocks with $$ run whole; plain blocks run statement by statement
            const parts = step.sql.includes('$$') ? [step.sql] : step.sql.split(';').map(x => x.trim()).filter(Boolean);
            for (const part of parts) {
                const label = parts.length > 1 ? `${step.name}: ${part.replace(/\s+/g, ' ').slice(0, 70)}` : step.name;
                await run(label, () => pool.query(part));
            }
        }
        await run('Master admin account', seedMasterAdmin);
        accessCache.clear();
        return results;
    }

    async function initDatabase() {
        try {
            if (!process.env.DATABASE_URL) return;
            console.log('🔄 Connecting to Database & Initializing Core Setup...');
            await pool.query('SELECT NOW()');
            const results = await runDatabaseSetup();
            const failed = results.filter(r => !r.ok);
            if (failed.length === 0) console.log(`✅ Database Initialization Complete. (${results.length} steps OK)`);
            else console.error(`⚠️ Database setup finished with ${failed.length} problem(s) out of ${results.length} steps. See the lines marked ❌ above.`);
        } catch (err) {
            console.error('❌ DB Initialization Error:', err.message);
        }
    }


    app.get('/api/version', (req, res) => res.json({ server_version: SERVER_VERSION }));

    const sendHome = (req, res) => res.sendFile(path.join(ROOT, 'index.html'));
    app.get('/', sendHome);
    app.get('/admin', sendHome);
    app.get('/admin/', sendHome);

    const userCache = new Map();
    function clearUserCache(userId) { userCache.delete(String(userId)); }
    function clearAllUserCache() { userCache.clear(); }
    async function getUserState(userId) {
        const key = String(userId);
        const hit = userCache.get(key);
        if (hit && Date.now() - hit.at < 20000) return hit.data;
        try {
            const r = await pool.query('SELECT is_active, role, can_edit_tenants, COALESCE(scope_all, true) AS scope_all, COALESCE(can_add_staff, false) AS can_add_staff, department_id FROM users WHERE user_id = $1', [userId]);
            const data = r.rows[0] || null;
            if (data) {
                data.props = null;
                if (!data.scope_all) {
                    data.props = (await pool.query('SELECT property_id FROM user_properties WHERE user_id = $1', [userId])).rows.map(x => x.property_id);
                }
            }
            userCache.set(key, { at: Date.now(), data });
            return data;
        } catch (err) { return null; }
    }

    function authenticateToken(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access denied. Missing authentication token.' });

        jwt.verify(token, JWT_SECRET, async (err, user) => {
            if (err) return res.status(403).json({ error: 'Session expired or invalid token. Please log in again.' });
            try {
                req.user = user;

                // role changes and switched-off users take effect within seconds (not after 12 hours)
                if (user.role !== 'SUPER_ADMIN') {
                    const state = await getUserState(user.user_id);
                    if (state) {
                        if (state.is_active === false) return res.status(403).json({ error: 'Your account has been switched off. Please contact your administrator.', code: 'ACCOUNT_SUSPENDED' });
                        req.user.role = state.role;
                        req.user.can_edit_tenants = state.can_edit_tenants;
                    }
                    // every request checks that the company is paid and active
                    const access = await getCompanyAccess(user.company_id);
                    const block = accessBlock(access);
                    if (block) return res.status(403).json({ error: block.message, code: block.code });
                    // Pro: which projects (properties) this person may see. null = all of them.
                    req.user.scope = null; req.user.can_add_staff = false; req.user.department_id = null;
                    if (state && effectiveFeatures(access ? (access.plan || 'STANDARD') : 'PRO', access ? access.features : null).org) {
                        req.user.department_id = state.department_id || null;
                        req.user.can_add_staff = state.role !== 'COMPANY_ADMIN' && state.can_add_staff === true;
                        if (state.role !== 'COMPANY_ADMIN' && state.scope_all === false) req.user.scope = state.props || [];
                    }
                }
                next();
            } catch (e) {
                console.error('Auth error:', e.message);
                res.status(500).json({ error: 'Authentication check failed: ' + e.message });
            }
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


    // owner / who lives there / service charge currency of a unit, from a request body
    async function readUnitOwnerFields(companyId, b) {
        const out = {};
        if (b.owner_id !== undefined) {
            if (b.owner_id === null || b.owner_id === '' || b.owner_id === 'COMPANY') out.owner_id = null;
            else {
                const o = await pool.query('SELECT 1 FROM owners WHERE owner_id = $1 AND company_id = $2', [b.owner_id, companyId]);
                if (!o.rows.length) { const e = new Error('Owner not found.'); e.status = 400; throw e; }
                out.owner_id = parseInt(b.owner_id);
            }
        }
        if (b.occupancy_type !== undefined) out.occupancy_type = b.occupancy_type === 'OWNER_LIVES' ? 'OWNER_LIVES' : 'LET';
        if (b.service_currency !== undefined) out.service_currency = ['TZS', 'USD'].includes(String(b.service_currency).toUpperCase()) ? String(b.service_currency).toUpperCase() : null;
        return out;
    }
    return { SERVER_VERSION, allowRoles, authenticateToken, clearAllUserCache, clearUserCache, initDatabase, readUnitOwnerFields, runDatabaseSetup };
};
