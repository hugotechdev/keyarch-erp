// FORGOT PASSWORD: a reset link is sent to the user's email
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { ALLOWED_ID_TYPES, ALLOWED_RENT_PERIODS, addPayment, allowRoles, app, authenticateToken, bcrypt, calculatePayment, checkLimit, cleanCur, clearUserCache, companyInfo, createAuditLog, createInvoice, crypto, fmtMoney, getCompanyAccess, inScope, logLeaseEvent, monthLabel, niceDate, periodWord, pool, rateLimit, readUnitOwnerFields, scopeSql, scoped, superAdminCompanyInfo, todayStr } = ctx;


    // ============================================================
    // SERVICE CHARGES (fixed monthly amount per unit: security, garbage, water pump...)
    // ============================================================
    function monthRange(ym) {
        if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return null;
        const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(5, 7));
        if (m < 1 || m > 12) return null;
        const start = `${ym}-01`;
        const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        return { start, end };
    }

    function loadOptional(name) {
        try { return require(name); }
        catch (e) {
            const err = new Error(`The package "${name}" is not installed on the server yet. Add it to package.json (npm install ${name}) and redeploy.`);
            err.code = 'MISSING_PACKAGE';
            throw err;
        }
    }


    // ============================================================
    // FORGOT PASSWORD: a reset link is sent to the user's email
    // Needs these Railway variables (Gmail example):
    //   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_USER=youraddress@gmail.com
    //   SMTP_PASS=<Gmail "App password">   SMTP_FROM="KEY ARCH <youraddress@gmail.com>"
    //   APP_URL=https://your-app.up.railway.app   (optional, the link of your system)
    // ============================================================
    const forgotLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, max: 5,
        message: { error: 'Too many requests. Please try again after 15 minutes.' }
    });

    function mailConfigured() { return !!(process.env.SMTP_USER && process.env.SMTP_PASS); }

    async function sendMail(to, subject, text, html) {
        const nodemailer = loadOptional('nodemailer');
        const port = parseInt(process.env.SMTP_PORT) || 465;
        const transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
            auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') }
        });
        await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
    }

    app.post('/api/auth/forgot', forgotLimiter, async (req, res) => {
        // same answer whether or not the email exists, so nobody can test which emails are registered
        const generic = { message: 'If this email is registered, a password reset link has been sent. Check your inbox (and Spam). The link works for 1 hour.' };
        try {
            const email = String((req.body || {}).email || '').trim().toLowerCase();
            if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
            const u = (await pool.query('SELECT user_id, full_name, email, is_active FROM users WHERE LOWER(email) = $1', [email])).rows[0];
            if (!u || !u.is_active) return res.json(generic);
            if (!mailConfigured()) {
                console.error('Forgot password: email is not set up. Add SMTP_USER and SMTP_PASS in Railway Variables.');
                return res.status(503).json({ error: 'Email sending is not set up yet. Please contact HUGO TECH on WhatsApp +255 785 799 530 to reset your password.' });
            }
            const token = crypto.randomBytes(32).toString('hex');
            const hash = crypto.createHash('sha256').update(token).digest('hex');
            await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [u.user_id]);
            await pool.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + interval '1 hour')", [u.user_id, hash]);
            const host = String(req.headers.host || '');
            const proto = String(req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https')).split(',')[0];
            const base = (process.env.APP_URL || `${proto}://${host}`).replace(/\/+$/, '');
            const link = `${base}/?reset=${token}`;
            const text = `Habari ${u.full_name},\n\nTumepokea ombi la kubadilisha password ya KEY ARCH.\nBonyeza link hii kuweka password mpya (inafanya kazi kwa saa 1):\n${link}\n\nUsipoomba wewe, puuza ujumbe huu - password yako haitabadilika.\n\n---\nHello ${u.full_name},\nWe received a request to reset your KEY ARCH password. Open this link to choose a new one (valid for 1 hour):\n${link}\nIf you did not ask for this, ignore this email.\n\nHUGO TECH`;
            const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="color:#1d4ed8">KEY ARCH</h2><p>Habari <b>${String(u.full_name).replace(/[<>&"]/g, '')}</b>,</p><p>Tumepokea ombi la kubadilisha password yako. Bonyeza kitufe hapa chini kuweka password mpya (inafanya kazi kwa <b>saa 1</b>).</p><p style="text-align:center;margin:24px 0"><a href="${link}" style="background:#2563eb;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Weka Password Mpya</a></p><p style="font-size:12px;color:#666">Kama kitufe hakifanyi kazi, nakili link hii kwenye browser:<br>${link}</p><p style="font-size:12px;color:#666">Usipoomba wewe, puuza ujumbe huu - password yako haitabadilika.</p><hr><p style="font-size:12px;color:#666">Hello, we received a request to reset your password. If it was not you, ignore this email.<br>HUGO TECH</p></div>`;
            await sendMail(u.email, 'KEY ARCH - Password Reset / Weka Password Mpya', text, html);
            await createAuditLog(pool, null, u.user_id, 'Password reset requested', 'AUTH', req.ip, {});
            res.json(generic);
        } catch (err) {
            console.error('Forgot password error:', err.message);
            res.status(500).json({ error: err.code === 'MISSING_PACKAGE' ? 'Email sending is not installed on the server yet (add nodemailer). Contact HUGO TECH.' : 'The email could not be sent. Please try again later or contact HUGO TECH.' });
        }
    });

    app.post('/api/auth/reset', forgotLimiter, async (req, res) => {
        try {
            const { token, password } = req.body || {};
            if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return res.status(400).json({ error: 'This reset link is not valid.' });
            if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
            const row = (await pool.query('SELECT reset_id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()', [hash])).rows[0];
            if (!row) return res.status(400).json({ error: 'This reset link has expired or was already used. Please ask for a new one.' });
            const newHash = await bcrypt.hash(String(password), 10);
            await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [newHash, row.user_id]);
            await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
            clearUserCache(row.user_id);
            await createAuditLog(pool, null, row.user_id, 'Password reset completed', 'AUTH', req.ip, {});
            res.json({ message: 'Your password has been changed. You can sign in now.' });
        } catch (err) {
            console.error('Reset password error:', err.message);
            res.status(500).json({ error: 'Could not reset the password. Please try again.' });
        }
    });

    // Fresh plan / features / subscription info (the page asks for this when it opens)
    app.get('/api/me', authenticateToken, async (req, res) => {
        try {
            if (req.user.role === 'SUPER_ADMIN') {
                const c = await pool.query('SELECT company_name FROM companies WHERE company_id = $1', [req.user.company_id]);
                return res.json({ company: superAdminCompanyInfo(c.rows[0] ? c.rows[0].company_name : 'Platform') });
            }
            const access = await getCompanyAccess(req.user.company_id);
            res.json({ company: companyInfo(access), access: { scoped: scoped(req), project_ids: scoped(req) ? req.user.scope : null, can_add_staff: !!req.user.can_add_staff, department_id: req.user.department_id || null } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // PROPERTIES & UNITS FOR SELECTORS
    app.get('/api/properties', authenticateToken, async (req, res) => {
        try {
            const params = [req.user.company_id];
            const sc = scopeSql(req, 'p.property_id', params);
            const result = await pool.query(
                `SELECT p.*, COALESCE(p.property_name, p.title) as property_name, COUNT(u.unit_id) as total_units_count
                 FROM properties p
                 LEFT JOIN units u ON p.property_id = u.property_id
                 WHERE p.company_id = $1 ${sc}
                 GROUP BY p.property_id
                 ORDER BY p.created_at DESC`,
                params
            );
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/units/by-property/:property_id', authenticateToken, async (req, res) => {
        try {
            if (!inScope(req, req.params.property_id)) return res.status(403).json({ error: 'You do not have access to this project.', code: 'OUT_OF_SCOPE' });
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

        if (scoped(req) && !req.user.can_add_staff) return res.status(403).json({ error: 'You can work on your projects, but only a project manager can add a new one.', code: 'OUT_OF_SCOPE' });
        const propLimit = await checkLimit(req.user, 'max_properties', 'SELECT COUNT(*) FROM properties WHERE company_id = $1', 'properties');
        if (propLimit) return res.status(403).json({ error: propLimit, code: 'LIMIT_REACHED' });

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const propRes = await client.query(
                'INSERT INTO properties (company_id, property_name, title, address, category, total_units, service_charge_label, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
                [companyId, property_name, property_name, address, property_type, groups.reduce((n, g) => n + (parseInt(g.units_in_group) || 1), 0), String(req.body.service_charge_label || 'Service charge').slice(0, 60), req.user.user_id]
            );
            const property = propRes.rows[0];
            if (scoped(req)) {      // a project manager who opens a new project gets access to it automatically
                await client.query('INSERT INTO user_properties (user_id, property_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.user_id, property.property_id]);
                clearUserCache(req.user.user_id);
            }

            for (let gIdx = 0; gIdx < groups.length; gIdx++) {
                const grp = groups[gIdx];
                const svcAmount = Math.max(0, parseFloat(grp.service_charge) || 0);
                const svcInclusive = !!grp.service_inclusive;
                const oref = await readUnitOwnerFields(companyId, { owner_id: grp.owner_id || null, occupancy_type: grp.occupancy_type, service_currency: grp.service_currency });
                await client.query(
                    `INSERT INTO unit_groups
                     (company_id, property_id, group_name, units_in_group, bedrooms, bathrooms, rent_timeline, currency, rent_amount, payment_method, furnishing_status, service_charge, service_inclusive, owner_id, occupancy_type, service_currency)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
                    [
                        companyId, property.property_id, grp.group_name || `Group ${gIdx + 1}`, grp.units_in_group || 1, grp.bedrooms || 0, grp.bathrooms || 0,
                        grp.rent_timeline || 'Per Month', grp.currency || 'TSH', grp.rent_amount || 0, grp.payment_method || 'Cash', grp.furnishing_status || 'Unfurnished',
                        svcAmount, svcInclusive, oref.owner_id || null, oref.occupancy_type || 'LET', oref.service_currency || null
                    ]
                );

                const unitsCount = Math.min(500, Math.max(1, parseInt(grp.units_in_group || 1)));
                const cleanGrpName = (grp.group_name || `G${gIdx + 1}`).replace(/\s+/g, '-');


                for (let uIdx = 1; uIdx <= unitsCount; uIdx++) {
                    const unitNumber = `${cleanGrpName}-${uIdx}`;
                    await client.query(
                        `INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished, service_charge, service_inclusive, owner_id, occupancy_type, service_currency)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                        [companyId, property.property_id, unitNumber, grp.rent_amount || 0, grp.currency || 'TSH', 'VACANT', grp.furnishing_status === 'Furnished', svcAmount, svcInclusive, oref.owner_id || null, oref.occupancy_type || 'LET', oref.service_currency || null]
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
        if (!inScope(req, req.body && req.body.property_id)) return res.status(403).json({ error: 'You do not have access to this project.', code: 'OUT_OF_SCOPE' });
        let client;
        try {
            const { full_name, nida_passport_no, identity_type, phone_number, property_id, unit_id, start_date, end_date, discount, paid_amount, agreed_rent } = req.body;
            const leaseCurrency = cleanCur(req.body.currency);
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

            const unitCheck = await client.query(
                `SELECT u.status, u.property_id, u.service_charge, u.service_inclusive, u.service_currency, u.currency AS unit_currency, p.service_charge_label AS service_label
                 FROM units u JOIN properties p ON p.property_id = u.property_id WHERE u.unit_id = $1 AND u.company_id = $2`, [unit_id, companyId]);
            if (unitCheck.rows.length === 0) throw new Error('Unit not found.');
            const unitRow = unitCheck.rows[0];
            if (String(unitCheck.rows[0].property_id) !== String(property_id)) throw new Error('This unit does not belong to the selected property.');
            if (unitCheck.rows[0].status === 'OCCUPIED') throw new Error('This unit already has a tenant.');

            // same person (same ID number) renting again: reuse the record so the history stays together
            let tenant;
            const existingTenant = await client.query(
                'SELECT * FROM tenants WHERE company_id = $1 AND nida_passport_no = $2 ORDER BY tenant_id ASC LIMIT 1',
                [companyId, String(nida_passport_no).trim()]
            );
            if (existingTenant.rows.length > 0) {
                tenant = existingTenant.rows[0];
                await client.query('UPDATE tenants SET phone_number = $1, is_active = true WHERE tenant_id = $2', [phone_number, tenant.tenant_id]);
            } else {
                const tenantRes = await client.query(
                    'INSERT INTO tenants (company_id, full_name, identity_type, nida_passport_no, phone_number) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                    [companyId, full_name, ALLOWED_ID_TYPES.includes(identity_type) ? identity_type : 'NIDA', String(nida_passport_no).trim(), phone_number]
                );
                tenant = tenantRes.rows[0];
            }

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
            if (leaseCurrency !== 'TZS') { await client.query('UPDATE leases SET currency = $1 WHERE lease_id = $2', [leaseCurrency, lease.lease_id]); lease.currency = leaseCurrency; }

            await client.query("UPDATE units SET status = 'OCCUPIED' WHERE unit_id = $1 AND company_id = $2", [unit_id, companyId]);

            // Auto Generate Invoice & Receipt
            const invoice = await createInvoice(client, {
                companyId, leaseId: lease.lease_id, type: 'RENT', subtotal: calc.totalRent, discount: calc.discount,
                description: `Rent: ${calc.periods} ${periodWord(rent_period, calc.periods)} x ${fmtMoney(calc.price)} (${niceDate(start_date)} - ${niceDate(leaseEndDate)})`,
                issueDate: start_date, dueDate: start_date, periodStart: start_date, periodEnd: leaseEndDate, leaseCharge: true, userId: req.user.user_id,
                status: calc.amountDue === 0 ? 'PAID' : 'PENDING'
            });

            let payment = null;
            if (calc.paid > 0) {
                payment = await addPayment(client, {
                    companyId, invoiceId: invoice.invoice_id, amount: calc.paid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                    reference: req.body.payment_reference, date: start_date <= todayStr() ? start_date : todayStr(), userId: req.user.user_id, accountId: req.body.account_id
                });
            }

            // service charge of the first month (unless it is already included in the rent)
            let serviceInvoice = null;
            // the unit may be priced in the other currency: the service charge follows the same exchange rate as the rent
            const unitCur = String(unitRow.unit_currency || '').toUpperCase() === 'USD' ? 'USD' : 'TZS';
            const svcCur = unitRow.service_currency ? String(unitRow.service_currency).toUpperCase() : unitCur;   // the service charge may be in another currency than the rent
            const xr = parseFloat(req.body.exchange_rate);
            if ((unitCur !== leaseCurrency || (svcCur !== leaseCurrency && parseFloat(unitRow.service_charge || 0) > 0)) && !(xr > 0)) throw new Error('Please enter the exchange rate (TSh for 1 USD).');
            const convUnit = n => svcCur === leaseCurrency ? n : (leaseCurrency === 'USD' ? Math.round(n / xr * 100) / 100 : Math.round(n * xr));
            const svc = convUnit(parseFloat(unitRow.service_charge || 0));
            // remember the monthly service charge in the currency of the contract, and the rate used
            await client.query('UPDATE leases SET service_amount = $1, service_rate = $2 WHERE lease_id = $3', [svc, xr > 0 ? xr : null, lease.lease_id]);
            if (svc > 0 && !unitRow.service_inclusive) {
                const ym = String(start_date).slice(0, 7);
                const range = monthRange(ym);
                serviceInvoice = await createInvoice(client, {
                    companyId, leaseId: lease.lease_id, type: 'SERVICE', subtotal: svc, discount: 0,
                    description: `${unitRow.service_label || 'Service charge'} - ${monthLabel(ym)}`,
                    issueDate: start_date, dueDate: start_date, periodStart: range.start, periodEnd: range.end, leaseCharge: false, userId: req.user.user_id
                });
                const svcPaid = Math.min(svc, Math.max(0, parseFloat(req.body.service_paid) || 0));
                if (svcPaid > 0) {
                    await addPayment(client, {
                        companyId, invoiceId: serviceInvoice.invoice_id, amount: svcPaid, method: req.body.payment_method, methodDetail: req.body.payment_method,
                        reference: req.body.payment_reference, date: start_date <= todayStr() ? start_date : todayStr(), userId: req.user.user_id, accountId: req.body.account_id
                    });
                    if (svcPaid >= svc) await client.query("UPDATE invoices SET status = 'PAID' WHERE invoice_id = $1", [serviceInvoice.invoice_id]);
                }
            }

            await logLeaseEvent(client, companyId, lease.lease_id, tenant.tenant_id, 'CREATED',
                `Lease started: ${start_date} to ${leaseEndDate} (${calc.periods} ${rent_period}${calc.periods === 1 ? '' : 's'})`, calc.totalToPay, req.user.user_id);
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
                payment,
                service_invoice: serviceInvoice,
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
    return { loadOptional, mailConfigured, monthRange, sendMail };
};
