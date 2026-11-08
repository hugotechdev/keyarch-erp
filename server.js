// KEY ARCH server - entry file.
// The server code is split into small parts in the "server" folder (one per area: tenants, invoices, finance ...).
// They are loaded here in number order. Each part receives "ctx" (what earlier parts share) and returns what later parts need.
const ctx = { ROOT: __dirname };
const PARTS = [
    '00-setup',
    '01-payment-calculator',
    '02-shared-helpers',
    '03-plans-and-features',
    '04-database-setup',
    '05-project-access',
    '06-login-and-passwords',
    '07-tenants-list',
    '08-tenant-edits-and-onboarding',
    '09-registration',
    '10-units',
    '11-properties',
    '12-deleting',
    '13-service-charges',
    '14-invoices-and-payments',
    '15-dashboard',
    '16-company-profile',
    '18-users',
    '19-owners',
    '20-expenses',
    '21-maintenance',
    '22-luku',
    '23-reports',
    '24-finance',
    '25-backup',
    '26-platform-admin'
];
for (const name of PARTS) Object.assign(ctx, require('./server/' + name)(ctx));
