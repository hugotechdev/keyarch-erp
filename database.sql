-- 1. Roles Table (RBAC)
CREATE TABLE IF NOT EXISTS roles (
    role_id SERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users Table (System Access)
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
    transaction_type VARCHAR(20) NOT NULL,
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

-- 6. Leases Table (Lease Contracts)
CREATE TABLE IF NOT EXISTS leases (
    lease_id SERIAL PRIMARY KEY,
    unit_id INT NOT NULL,
    tenant_id INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    billing_cycle VARCHAR(20) NOT NULL,
    security_deposit DECIMAL(12,2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'Active',
    FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

-- 7. Invoices Table (Invoice Generation)
CREATE TABLE IF NOT EXISTS invoices (
    invoice_id SERIAL PRIMARY KEY,
    lease_id INT NOT NULL,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    due_date DATE NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'Unpaid',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
);

-- 8. Payments Table (Payment Tracking)
CREATE TABLE IF NOT EXISTS payments (
    payment_id SERIAL PRIMARY KEY,
    invoice_id INT NOT NULL,
    amount_paid DECIMAL(12,2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    reference_code VARCHAR(100) UNIQUE,
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    recorded_by INT,
    FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id)
);

-- 9. Work Orders Table (Maintenance Tickets)
CREATE TABLE IF NOT EXISTS work_orders (
    work_order_id SERIAL PRIMARY KEY,
    unit_id INT NOT NULL,
    assigned_technician_id INT,
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    material_cost DECIMAL(10,2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (unit_id) REFERENCES units(unit_id)
);

-- 10. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id SERIAL PRIMARY KEY,
    user_id INT,
    action_executed VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert Default Roles
INSERT INTO roles (role_name, description) 
VALUES 
('Super Admin', 'Full system access'),
('Property Manager', 'Operational & Portfolio management'),
('Accountant', 'Financial operations and invoices'),
('Technician', 'Maintenance dispatch')
ON CONFLICT (role_name) DO NOTHING;