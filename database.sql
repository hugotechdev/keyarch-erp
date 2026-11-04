-- 1. Meza ya Watumiaji (Users & RBAC)
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20),
    role VARCHAR(20) DEFAULT 'PROPERTY_MANAGER' CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'TECHNICIAN')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Meza ya Majengo (Properties)
CREATE TABLE IF NOT EXISTS properties (
    property_id SERIAL PRIMARY KEY,
    property_name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL,
    category VARCHAR(50) DEFAULT 'RESIDENTIAL' CHECK (category IN ('RESIDENTIAL', 'COMMERCIAL', 'VACATION', 'OFFICE_SPACE')),
    total_units INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Meza ya Nyumba/Fremu (Units) - Unique per property constraint added
CREATE TABLE IF NOT EXISTS units (
    unit_id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(property_id) ON DELETE CASCADE,
    unit_number VARCHAR(50) NOT NULL,
    rent_amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'TZS',
    status VARCHAR(20) DEFAULT 'VACANT' CHECK (status IN ('VACANT', 'OCCUPIED', 'UNDER_MAINTENANCE')),
    is_furnished BOOLEAN DEFAULT FALSE,
    CONSTRAINT unique_unit_per_property UNIQUE(property_id, unit_number)
);

-- 4. Meza ya Wapangaji (Tenants)
CREATE TABLE IF NOT EXISTS tenants (
    tenant_id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    nida_passport_no VARCHAR(50) UNIQUE NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Meza ya Mikataba (Leases)
CREATE TABLE IF NOT EXISTS leases (
    lease_id SERIAL PRIMARY KEY,
    unit_id INT REFERENCES units(unit_id),
    tenant_id INT REFERENCES tenants(tenant_id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    agreed_rent DECIMAL(12,2) NOT NULL,
    payment_cycle VARCHAR(20) DEFAULT 'MONTHLY' CHECK (payment_cycle IN ('MONTHLY', 'QUARTERLY', 'BI_ANNUALLY', 'ANNUALLY')),
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'TERMINATED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Prevent two active leases on a single unit
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_unit
ON leases(unit_id)
WHERE status = 'ACTIVE';

-- 6. Meza ya Invois (Invoices)
CREATE TABLE IF NOT EXISTS invoices (
    invoice_id SERIAL PRIMARY KEY,
    lease_id INT REFERENCES leases(lease_id),
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    amount_due DECIMAL(12,2) NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'OVERDUE')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Meza ya Malipo (Payments)
CREATE TABLE IF NOT EXISTS payments (
    payment_id SERIAL PRIMARY KEY,
    invoice_id INT REFERENCES invoices(invoice_id),
    tenant_id INT REFERENCES tenants(tenant_id),
    amount_paid DECIMAL(12,2) NOT NULL,
    payment_type VARCHAR(30) DEFAULT 'RENT' CHECK (payment_type IN ('RENT', 'SERVICE_CHARGE', 'LUKU_VOUCHER', 'OTHER')),
    payment_method VARCHAR(30) DEFAULT 'MOBILE_MONEY' CHECK (payment_method IN ('BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE')),
    reference_no VARCHAR(100),
    recorded_by INT REFERENCES users(user_id),
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Mauzo ya Tokeni za Luku (Luku Vouchers)
CREATE TABLE IF NOT EXISTS luku_vouchers (
    voucher_id SERIAL PRIMARY KEY,
    meter_number VARCHAR(50) NOT NULL,
    tenant_name VARCHAR(100),
    amount DECIMAL(12,2) NOT NULL,
    token_number VARCHAR(50) UNIQUE NOT NULL,
    kwh_units DECIMAL(10,2),
    sold_by INT REFERENCES users(user_id),
    sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. Meza ya Matumizi (Expenses)
CREATE TABLE IF NOT EXISTS expenses (
    expense_id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(property_id),
    description TEXT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    category VARCHAR(50) DEFAULT 'REPAIR' CHECK (category IN ('REPAIR', 'UTILITY', 'TAX', 'SALARY', 'SUPPLIES', 'MISC')),
    recorded_by INT REFERENCES users(user_id),
    expense_date DATE DEFAULT CURRENT_DATE
);

-- 10. Meza ya Tiketi za Ukarabati (Work Orders) - Priority updated to URGENT
CREATE TABLE IF NOT EXISTS work_orders (
    ticket_id SERIAL PRIMARY KEY,
    unit_id INT REFERENCES units(unit_id),
    assigned_technician_id INT REFERENCES users(user_id),
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED')),
    estimated_cost DECIMAL(12,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. Kumbukumbu za Mfumo (Audit Logs with Metadata JSONB)
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id),
    action_performed VARCHAR(255) NOT NULL,
    module_affected VARCHAR(50) NOT NULL,
    ip_address VARCHAR(45),
    metadata JSONB DEFAULT '{}'::jsonb,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
