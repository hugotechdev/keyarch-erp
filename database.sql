-- ============================================================
-- KEY ARCH ERP - DATABASE (current version, multi-company)
-- ============================================================
-- USE THIS FILE ONLY FOR A NEW, EMPTY DATABASE (a new test setup or a new server).
-- Do NOT run it on your live database: your live tables already exist and are
-- updated automatically by server.js (Platform Admin > Run Database Setup).
--
-- Safe to run twice: every command uses IF NOT EXISTS.
-- The Super Admin login (admin@keyarch.co.tz) and its company are created by
-- server.js the first time it starts, so no password is stored in this file.
-- ============================================================

-- Invoice numbers: INV-2026-100001, INV-2026-100002 ...
CREATE SEQUENCE IF NOT EXISTS invoice_seq START 100000;

-- ------------------------------------------------------------
-- 1. COMPANIES (every client business that buys KEY ARCH ERP)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    company_id        SERIAL PRIMARY KEY,
    company_name      VARCHAR(150) NOT NULL,
    subscription_plan VARCHAR(30) DEFAULT 'BASIC',       -- old column, kept for compatibility
    is_active         BOOLEAN DEFAULT TRUE,
    plan              VARCHAR(12) DEFAULT 'STANDARD',    -- STANDARD / PRO
    access_status     VARCHAR(12) DEFAULT 'PENDING',     -- PENDING (waiting payment) / ACTIVE / SUSPENDED
    billing_type      VARCHAR(12),                       -- SUBSCRIPTION / ONE_TIME
    paid_until        DATE,                              -- end of the paid subscription period
    activated_at      TIMESTAMP,
    features          JSONB DEFAULT '{}'::jsonb,         -- special access given by the Super Admin
    notes             TEXT,                              -- private notes of the Super Admin
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 2. USERS (owners and staff of each company, plus the Super Admin)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    user_id           SERIAL PRIMARY KEY,
    company_id        INTEGER REFERENCES companies(company_id),
    full_name         VARCHAR(100) NOT NULL,
    email             VARCHAR(100) UNIQUE NOT NULL,
    password_hash     VARCHAR(255) NOT NULL,
    phone_number      VARCHAR(30),
    role              VARCHAR(20) DEFAULT 'PROPERTY_MANAGER'
                      CHECK (role IN ('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'TECHNICIAN')),
    is_active         BOOLEAN DEFAULT TRUE,
    can_edit_tenants  BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 3. PROPERTIES (buildings)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties (
    property_id    SERIAL PRIMARY KEY,
    company_id     INTEGER REFERENCES companies(company_id),
    property_name  VARCHAR(150) NOT NULL,
    title          VARCHAR(150),                         -- same as property_name (old column)
    address        TEXT NOT NULL,
    category       VARCHAR(50) DEFAULT 'Apartment',      -- Apartment, House, Office, Shop, Hotel, Air-Bnb
    total_units    INTEGER DEFAULT 0,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 4. UNIT GROUPS (the groups created in the Property Wizard)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unit_groups (
    group_id           SERIAL PRIMARY KEY,
    company_id         INTEGER REFERENCES companies(company_id),
    property_id        INTEGER REFERENCES properties(property_id) ON DELETE CASCADE,
    group_name         VARCHAR(100),
    units_in_group     INTEGER DEFAULT 1,
    bedrooms           INTEGER DEFAULT 0,
    bathrooms          INTEGER DEFAULT 0,
    rent_timeline      VARCHAR(20) DEFAULT 'Per Month',
    currency           VARCHAR(10) DEFAULT 'TSH',
    rent_amount        NUMERIC(12,2) DEFAULT 0,
    payment_method     VARCHAR(30) DEFAULT 'Cash',
    furnishing_status  VARCHAR(20) DEFAULT 'Unfurnished'
);

-- ------------------------------------------------------------
-- 5. UNITS (rooms, apartments, shops, frames)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS units (
    unit_id       SERIAL PRIMARY KEY,
    company_id    INTEGER REFERENCES companies(company_id),
    property_id   INTEGER REFERENCES properties(property_id) ON DELETE CASCADE,
    unit_number   VARCHAR(50) NOT NULL,
    rent_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency      VARCHAR(10) DEFAULT 'TSH',
    status        VARCHAR(20) DEFAULT 'VACANT' CHECK (status IN ('VACANT', 'OCCUPIED', 'UNDER_MAINTENANCE')),
    is_furnished  BOOLEAN DEFAULT FALSE,
    CONSTRAINT unique_unit_per_property UNIQUE (property_id, unit_number)
);

-- ------------------------------------------------------------
-- 6. TENANTS (one record per person, even if they rent many times)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    tenant_id         SERIAL PRIMARY KEY,
    company_id        INTEGER REFERENCES companies(company_id),
    full_name         VARCHAR(100) NOT NULL,
    identity_type     VARCHAR(20) NOT NULL DEFAULT 'NIDA',   -- NIDA / PASSPORT / DRIVING_LICENSE / VOTER_ID
    nida_passport_no  VARCHAR(50) NOT NULL,
    phone_number      VARCHAR(30) NOT NULL,
    email             VARCHAR(100),
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uniq_tenant_id_per_company UNIQUE (company_id, nida_passport_no)
);

-- ------------------------------------------------------------
-- 7. LEASES (every contract; renewals create a new row, so history is kept)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leases (
    lease_id           SERIAL PRIMARY KEY,
    company_id         INTEGER REFERENCES companies(company_id),
    unit_id            INTEGER REFERENCES units(unit_id),
    tenant_id          INTEGER REFERENCES tenants(tenant_id),
    property_id        INTEGER REFERENCES properties(property_id),
    start_date         DATE NOT NULL,
    end_date           DATE NOT NULL,
    duration_days      INTEGER,
    -- money
    rent_price         NUMERIC(12,2),                      -- price for one period
    rent_period        VARCHAR(10) DEFAULT 'Month',        -- Day / Week / Month / Year
    number_of_periods  NUMERIC(8,2),
    total_rent         NUMERIC(12,2),                      -- price x periods
    discount           NUMERIC(12,2) DEFAULT 0,
    total_to_pay       NUMERIC(12,2),                      -- total rent - discount
    agreed_rent        NUMERIC(12,2) NOT NULL DEFAULT 0,   -- same as total_to_pay (old column)
    amount_paid        NUMERIC(12,2) DEFAULT 0,
    amount_due         NUMERIC(12,2) DEFAULT 0,            -- remaining balance
    payment_status     VARCHAR(20),                        -- UNPAID / PARTIAL / PAID / EXTRA_PAID
    payment_cycle      VARCHAR(20) DEFAULT 'MONTHLY' CHECK (payment_cycle IN ('MONTHLY', 'QUARTERLY', 'BI_ANNUALLY', 'ANNUALLY')),
    -- state
    status             VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'TERMINATED')),
    lease_state        VARCHAR(12) DEFAULT 'CURRENT',      -- CURRENT / RENEWED / ENDED
    ended_at           TIMESTAMP,
    ended_reason       VARCHAR(200),
    previous_lease_id  INTEGER,                            -- the lease that was renewed into this one
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A unit can have only ONE current lease at a time
CREATE UNIQUE INDEX IF NOT EXISTS one_current_lease_per_unit ON leases (unit_id) WHERE lease_state = 'CURRENT';

-- ------------------------------------------------------------
-- 8. LEASE EVENTS (tenant history: started, renewed, extended, moved out)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_events (
    event_id     SERIAL PRIMARY KEY,
    company_id   INTEGER,
    lease_id     INTEGER,
    tenant_id    INTEGER,
    event_type   VARCHAR(20),
    description  TEXT,
    amount       NUMERIC(12,2),
    created_by   INTEGER,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 9. INVOICES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
    invoice_id      SERIAL PRIMARY KEY,
    company_id      INTEGER REFERENCES companies(company_id),
    lease_id        INTEGER REFERENCES leases(lease_id),
    invoice_number  VARCHAR(50) UNIQUE NOT NULL,
    amount_due      NUMERIC(12,2) NOT NULL,               -- total of this invoice
    due_date        DATE NOT NULL,
    status          VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'OVERDUE')),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 10. PAYMENTS RECEIVED FROM TENANTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    payment_id      SERIAL PRIMARY KEY,
    company_id      INTEGER REFERENCES companies(company_id),
    invoice_id      INTEGER REFERENCES invoices(invoice_id),
    tenant_id       INTEGER REFERENCES tenants(tenant_id),
    amount_paid     NUMERIC(12,2) NOT NULL,
    payment_type    VARCHAR(30) DEFAULT 'RENT' CHECK (payment_type IN ('RENT', 'SERVICE_CHARGE', 'LUKU_VOUCHER', 'OTHER')),
    payment_method  VARCHAR(30) DEFAULT 'CASH' CHECK (payment_method IN ('BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE')),
    reference_no    VARCHAR(100),
    recorded_by     INTEGER REFERENCES users(user_id),
    payment_date    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 11. LUKU TOKENS SOLD
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS luku_vouchers (
    voucher_id    SERIAL PRIMARY KEY,
    company_id    INTEGER REFERENCES companies(company_id),
    meter_number  VARCHAR(50) NOT NULL,
    tenant_name   VARCHAR(100),
    amount        NUMERIC(12,2) NOT NULL,
    token_number  VARCHAR(50) UNIQUE NOT NULL,
    kwh_units     NUMERIC(10,2),
    sold_by       INTEGER REFERENCES users(user_id),
    sold_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 12. EXPENSES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    expense_id    SERIAL PRIMARY KEY,
    company_id    INTEGER REFERENCES companies(company_id),
    property_id   INTEGER REFERENCES properties(property_id),
    description   TEXT NOT NULL,
    amount        NUMERIC(12,2) NOT NULL,
    category      VARCHAR(50) DEFAULT 'REPAIR' CHECK (category IN ('REPAIR', 'UTILITY', 'TAX', 'SALARY', 'SUPPLIES', 'MISC')),
    recorded_by   INTEGER REFERENCES users(user_id),
    expense_date  DATE DEFAULT CURRENT_DATE
);

-- ------------------------------------------------------------
-- 13. MAINTENANCE TICKETS (work orders)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_orders (
    ticket_id               SERIAL PRIMARY KEY,
    company_id              INTEGER REFERENCES companies(company_id),
    unit_id                 INTEGER REFERENCES units(unit_id),
    assigned_technician_id  INTEGER REFERENCES users(user_id),
    title                   VARCHAR(150) NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    priority                VARCHAR(20) DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    status                  VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED')),
    estimated_cost          NUMERIC(12,2) DEFAULT 0,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 14. PAYMENTS RECEIVED BY HUGO TECH FROM CLIENT COMPANIES (Super Admin panel)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_payments (
    payment_id    SERIAL PRIMARY KEY,
    company_id    INTEGER,
    payment_type  VARCHAR(20),                           -- SUBSCRIPTION / ONE_TIME / MAINTENANCE / FEATURE
    amount        NUMERIC(14,2),
    method        VARCHAR(40),
    reference     VARCHAR(80),
    months        INTEGER,
    period_until  DATE,
    notes         TEXT,
    recorded_by   INTEGER,
    paid_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 15. AUDIT LOG (who did what)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id            SERIAL PRIMARY KEY,
    company_id        INTEGER,
    user_id           INTEGER,
    action_performed  VARCHAR(255) NOT NULL,
    module_affected   VARCHAR(50) NOT NULL,
    ip_address        VARCHAR(45),
    metadata          JSONB DEFAULT '{}'::jsonb,
    timestamp         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 16. SPEED
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_company            ON users (company_id);
CREATE INDEX IF NOT EXISTS idx_properties_company       ON properties (company_id);
CREATE INDEX IF NOT EXISTS idx_units_company            ON units (company_id);
CREATE INDEX IF NOT EXISTS idx_units_property           ON units (property_id);
CREATE INDEX IF NOT EXISTS idx_tenants_company          ON tenants (company_id);
CREATE INDEX IF NOT EXISTS idx_leases_company           ON leases (company_id);
CREATE INDEX IF NOT EXISTS idx_leases_tenant            ON leases (tenant_id);
CREATE INDEX IF NOT EXISTS idx_leases_unit              ON leases (unit_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company         ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_lease           ON invoices (lease_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice         ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_lease_events_tenant      ON lease_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_platform_payments_company ON platform_payments (company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company       ON audit_logs (company_id);
