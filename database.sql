-- 1. Meza ya Watumiaji na Majukumu (Users & RBAC)
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20),
    role VARCHAR(20) CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'TECHNICIAN')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Meza ya Majengo (Properties)
CREATE TABLE IF NOT EXISTS properties (
    property_id SERIAL PRIMARY KEY,
    property_name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL,
    category VARCHAR(50) CHECK (category IN ('RESIDENTIAL', 'COMMERCIAL', 'VACATION', 'OFFICE_SPACE')),
    total_units INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Meza ya Nyumba/Fremu (Units)
CREATE TABLE IF NOT EXISTS units (
    unit_id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(property_id) ON DELETE CASCADE,
    unit_number VARCHAR(50) NOT NULL,
    rent_amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'TZS',
    status VARCHAR(20) CHECK (status IN ('VACANT', 'OCCUPIED', 'UNDER_MAINTENANCE')),
    is_furnished BOOLEAN DEFAULT FALSE
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

-- 5. Meza ya Mikataba ya Pango (Lease Contracts)
CREATE TABLE IF NOT EXISTS leases (
    lease_id SERIAL PRIMARY KEY,
    unit_id INT REFERENCES units(unit_id),
    tenant_id INT REFERENCES tenants(tenant_id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    agreed_rent DECIMAL(12,2) NOT NULL,
    payment_cycle VARCHAR(20) CHECK (payment_cycle IN ('MONTHLY', 'QUARTERLY', 'BI_ANNUALLY', 'ANNUALLY')),
    status VARCHAR(20) CHECK (status IN ('ACTIVE', 'EXPIRED', 'TERMINATED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Meza ya Invois (Invoices)
CREATE TABLE IF NOT EXISTS invoices (
    invoice_id SERIAL PRIMARY KEY,
    lease_id INT REFERENCES leases(lease_id),
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    amount_due DECIMAL(12,2) NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(20) CHECK (status IN ('PENDING', 'PAID', 'OVERDUE')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Meza ya Malipo na Mauzo ya Luku (Payments & Luku Sales)
CREATE TABLE IF NOT EXISTS payments (
    payment_id SERIAL PRIMARY KEY,
    invoice_id INT REFERENCES invoices(invoice_id),
    tenant_id INT REFERENCES tenants(tenant_id),
    amount_paid DECIMAL(12,2) NOT NULL,
    payment_type VARCHAR(30) CHECK (payment_type IN ('RENT', 'SERVICE_CHARGE', 'LUKU_VOUCHER', 'OTHER')),
    luku_token VARCHAR(50),
    payment_method VARCHAR(30) CHECK (payment_method IN ('BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE')),
    reference_no VARCHAR(100),
    recorded_by INT REFERENCES users(user_id),
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Meza ya Matumizi (Expenses)
CREATE TABLE IF NOT EXISTS expenses (
    expense_id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(property_id),
    description TEXT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    category VARCHAR(50) CHECK (category IN ('REPAIR', 'UTILITY', 'TAX', 'SALARY', 'SUPPLIES', 'MISC')),
    recorded_by INT REFERENCES users(user_id),
    expense_date DATE DEFAULT CURRENT_DATE
);

-- 9. Meza ya Tiketi za Matengenezo (Work Orders / Maintenance Tickets)
CREATE TABLE IF NOT EXISTS work_orders (
    ticket_id SERIAL PRIMARY KEY,
    unit_id INT REFERENCES units(unit_id),
    assigned_technician_id INT REFERENCES users(user_id),
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    priority VARCHAR(20) CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'EMERGENCY')),
    status VARCHAR(20) CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED')),
    estimated_cost DECIMAL(12,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. Meza ya Kumbukumbu za Mfumo (Immutable Audit Logs)
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id),
    action_performed VARCHAR(255) NOT NULL,
    module_affected VARCHAR(50) NOT NULL,
    ip_address VARCHAR(45),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);