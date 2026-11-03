-- 1. Roles Table
CREATE TABLE IF NOT EXISTS roles (
    role_id SERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role_id INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
);

-- 3. Properties Table
CREATE TABLE IF NOT EXISTS properties (
    property_id SERIAL PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    location VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    transaction_type VARCHAR(20) NOT NULL, -- For Rent / For Sale
    total_units INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Units Table
CREATE TABLE IF NOT EXISTS units (
    unit_id SERIAL PRIMARY KEY,
    property_id INT NOT NULL,
    unit_number VARCHAR(50) NOT NULL,
    rental_rate DECIMAL(12,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'TSH',
    furnishing_status VARCHAR(20) NOT NULL,
    is_occupied BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (property_id) REFERENCES properties(property_id) ON DELETE CASCADE
);

-- 5. Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
    tenant_id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    identity_type VARCHAR(20) NOT NULL,
    identity_number VARCHAR(100) UNIQUE NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Leases Table (Contract Management & Reminders)
CREATE TABLE IF NOT EXISTS leases (
    lease_id SERIAL PRIMARY KEY,
    unit_id INT NOT NULL,
    tenant_id INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    billing_cycle VARCHAR(20) NOT NULL,
    rent_amount DECIMAL(12,2) NOT NULL,
    security_deposit DECIMAL(12,2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'Active', -- Active, Expired, Terminated
    FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

-- 7. Accounts / Financial Sources Table
CREATE TABLE IF NOT EXISTS financial_accounts (
    account_id SERIAL PRIMARY KEY,
    account_name VARCHAR(100) NOT NULL, -- Rent Revenue, Luku/Voucher Sales, Service Charge, Maintenance Fund
    account_type VARCHAR(20) NOT NULL, -- Income / Expense
    balance DECIMAL(12,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Income Ledger (Mapato)
CREATE TABLE IF NOT EXISTS income_ledger (
    income_id SERIAL PRIMARY KEY,
    property_id INT,
    tenant_id INT,
    account_id INT NOT NULL,
    source_type VARCHAR(50) NOT NULL, -- Rent, Luku Voucher, Service Charge, Property Sale
    amount DECIMAL(12,2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL, -- Mobile Money, Bank, Cash
    reference_no VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(property_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    FOREIGN KEY (account_id) REFERENCES financial_accounts(account_id)
);

-- 9. Expense Ledger (Matumizi)
CREATE TABLE IF NOT EXISTS expense_ledger (
    expense_id SERIAL PRIMARY KEY,
    property_id INT,
    account_id INT NOT NULL,
    category VARCHAR(50) NOT NULL, -- Maintenance, Sub-meter Power Purchase, Salaries, Taxes, Operations
    amount DECIMAL(12,2) NOT NULL,
    paid_to VARCHAR(100),
    payment_method VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(property_id),
    FOREIGN KEY (account_id) REFERENCES financial_accounts(account_id)
);

-- 10. Work Orders (Maintenance Tickets & Costs)
CREATE TABLE IF NOT EXISTS work_orders (
    work_order_id SERIAL PRIMARY KEY,
    unit_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    material_cost DECIMAL(12,2) DEFAULT 0.00,
    labor_cost DECIMAL(12,2) DEFAULT 0.00,
    total_cost DECIMAL(12,2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (unit_id) REFERENCES units(unit_id)
);

-- 11. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id SERIAL PRIMARY KEY,
    user_id INT,
    action_executed VARCHAR(255) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert Accounts Defaults
INSERT INTO financial_accounts (account_name, account_type) VALUES 
('Rent Revenue Account', 'Income'),
('Luku / Voucher Sales', 'Income'),
('Service Charge Collection', 'Income'),
('Property Sale Account', 'Income'),
('Maintenance & Repairs Fund', 'Expense'),
('Utility Bulk Purchase', 'Expense')
ON CONFLICT DO NOTHING;