// DELETING (tenants, units, properties) - normal delete keeps history safe,
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_ADMIN, R_MANAGE, allowRoles, app, authenticateToken, createAuditLog, guard, inScope, pool, propertiesOf, scoped } = ctx;



    // ============================================================
    // DELETING (tenants, units, properties) - normal delete keeps history safe,
    // "force" (owner/admin + typed confirmation) removes the history too
    // ============================================================
    // some databases have no tenant_id column on payments: only touch it when it exists
    let payHasTenant = null;
    async function clearPaymentTenant(client, tenantIds) {
        if (payHasTenant === null) {
            payHasTenant = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'tenant_id' LIMIT 1")).rows.length > 0;
        }
        if (payHasTenant && tenantIds.length) await client.query('UPDATE payments SET tenant_id = NULL WHERE tenant_id = ANY($1::int[])', [tenantIds]);
    }
    async function wipeLeases(client, cId, leaseIds) {
        if (!leaseIds.length) return;
        await client.query('DELETE FROM payments WHERE company_id = $2 AND invoice_id IN (SELECT invoice_id FROM invoices WHERE company_id = $2 AND lease_id = ANY($1::int[]))', [leaseIds, cId]);
        await client.query('DELETE FROM invoices WHERE company_id = $2 AND lease_id = ANY($1::int[])', [leaseIds, cId]);
        try { await client.query('SAVEPOINT wipe_events'); await client.query('DELETE FROM lease_events WHERE company_id = $2 AND lease_id = ANY($1::int[])', [leaseIds, cId]); await client.query('RELEASE SAVEPOINT wipe_events'); }
        catch (e) { await client.query('ROLLBACK TO SAVEPOINT wipe_events'); }
        await client.query('DELETE FROM leases WHERE company_id = $2 AND lease_id = ANY($1::int[])', [leaseIds, cId]);
    }
    async function dropOrphanTenants(client, cId, tenantIds) {
        if (!tenantIds.length) return;
        await clearPaymentTenant(client, tenantIds);
        await client.query('DELETE FROM tenants t WHERE t.company_id = $2 AND t.tenant_id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = t.tenant_id)', [tenantIds, cId]);
    }
    function wantsForce(req) {
        const b = req.body || {}, q = req.query || {};
        const force = String(b.force || q.force || '') === '1' || b.force === true;
        const confirm = String(b.confirm || q.confirm || '');
        return force && confirm === 'DELETE' && ['COMPANY_ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
    }
    async function removeTenant(client, cId, userId, ip, tenantId, force) {
        const t = (await client.query('SELECT tenant_id, full_name FROM tenants WHERE tenant_id = $1 AND company_id = $2 FOR UPDATE', [tenantId, cId])).rows[0];
        if (!t) throw new Error('Tenant not found.');
        const pays = (await client.query(
            `SELECT COUNT(*) AS c FROM payments pay JOIN invoices inv ON pay.invoice_id = inv.invoice_id JOIN leases l ON inv.lease_id = l.lease_id
             WHERE l.tenant_id = $1 AND pay.company_id = $2`, [tenantId, cId])).rows[0].c;
        if (parseInt(pays) > 0 && !force) throw new Error(t.full_name + ' has payment records, so it cannot be deleted. Use "Move Out" to keep the history, or delete everything with the history option.');
        await client.query(
            "UPDATE units SET status = 'VACANT' WHERE company_id = $2 AND unit_id IN (SELECT unit_id FROM leases WHERE tenant_id = $1 AND company_id = $2 AND lease_state = 'CURRENT')", [tenantId, cId]);
        const leaseIds = (await client.query('SELECT lease_id FROM leases WHERE tenant_id = $1 AND company_id = $2', [tenantId, cId])).rows.map(r => r.lease_id);
        await wipeLeases(client, cId, leaseIds);
        await clearPaymentTenant(client, [tenantId]);
        await client.query('DELETE FROM tenants WHERE tenant_id = $1 AND company_id = $2', [tenantId, cId]);
        await createAuditLog(client, cId, userId, force ? 'Deleted Tenant with all history' : 'Deleted Tenant', 'TENANTS', ip, { tenant_id: tenantId, name: t.full_name });
    }
    async function removeUnit(client, cId, userId, ip, unitId, force) {
        const u = (await client.query('SELECT unit_id, unit_number, property_id, status FROM units WHERE unit_id = $1 AND company_id = $2 FOR UPDATE', [unitId, cId])).rows[0];
        if (!u) throw new Error('Unit not found.');
        const used = (await client.query('SELECT (SELECT COUNT(*) FROM leases WHERE unit_id = $1) AS leases, (SELECT COUNT(*) FROM work_orders WHERE unit_id = $1) AS tickets', [u.unit_id])).rows[0];
        if (!force) {
            if (u.status === 'OCCUPIED') throw new Error('Unit ' + u.unit_number + ' has a tenant. Move the tenant out first, or delete with the history option.');
            if (parseInt(used.leases) > 0 || parseInt(used.tickets) > 0) throw new Error('Unit ' + u.unit_number + ' has history (tenants or tickets), so it cannot be deleted. You can set it to "Under maintenance", or delete with the history option.');
        } else {
            const leaseRows = (await client.query('SELECT lease_id, tenant_id FROM leases WHERE unit_id = $1 AND company_id = $2', [u.unit_id, cId])).rows;
            await wipeLeases(client, cId, leaseRows.map(r => r.lease_id));
            await dropOrphanTenants(client, cId, [...new Set(leaseRows.map(r => r.tenant_id))]);
            await client.query('DELETE FROM work_orders WHERE unit_id = $1 AND company_id = $2', [u.unit_id, cId]);
        }
        await client.query('DELETE FROM units WHERE unit_id = $1 AND company_id = $2', [u.unit_id, cId]);
        await client.query('UPDATE properties SET total_units = (SELECT COUNT(*) FROM units WHERE property_id = $1) WHERE property_id = $1', [u.property_id]);
        await createAuditLog(client, cId, userId, force ? 'Deleted Unit with all history' : 'Deleted Unit', 'UNITS', ip, { unit_id: u.unit_id, unit: u.unit_number });
    }
    async function removeProperty(client, cId, userId, ip, propertyId, force) {
        const pr = (await client.query('SELECT property_id, COALESCE(property_name, title) AS name FROM properties WHERE property_id = $1 AND company_id = $2 FOR UPDATE', [propertyId, cId])).rows[0];
        if (!pr) throw new Error('Property not found.');
        const used = (await client.query(
            'SELECT (SELECT COUNT(*) FROM leases WHERE property_id = $1 AND company_id = $2) AS leases, (SELECT COUNT(*) FROM work_orders w JOIN units u ON w.unit_id = u.unit_id WHERE u.property_id = $1 AND w.company_id = $2) AS tickets', [propertyId, cId])).rows[0];
        if (!force) {
            if (parseInt(used.leases) > 0) throw new Error(pr.name + ' has tenant history, so it cannot be deleted. Delete with the history option if you really want it gone.');
            if (parseInt(used.tickets) > 0) throw new Error(pr.name + ' has maintenance tickets, so it cannot be deleted. Delete with the history option if you really want it gone.');
        } else {
            const leaseRows = (await client.query('SELECT lease_id, tenant_id FROM leases WHERE property_id = $1 AND company_id = $2', [propertyId, cId])).rows;
            await wipeLeases(client, cId, leaseRows.map(r => r.lease_id));
            await dropOrphanTenants(client, cId, [...new Set(leaseRows.map(r => r.tenant_id))]);
            await client.query('DELETE FROM work_orders WHERE company_id = $2 AND unit_id IN (SELECT unit_id FROM units WHERE property_id = $1)', [propertyId, cId]);
        }
        await client.query('UPDATE expenses SET property_id = NULL WHERE property_id = $1 AND company_id = $2', [propertyId, cId]);
        await client.query('DELETE FROM user_properties WHERE property_id = $1', [propertyId]);
        await client.query('DELETE FROM units WHERE property_id = $1 AND company_id = $2', [propertyId, cId]);
        await client.query('DELETE FROM properties WHERE property_id = $1 AND company_id = $2', [propertyId, cId]);
        await createAuditLog(client, cId, userId, force ? 'Deleted Property with all history' : 'Deleted Property', 'PROPERTIES', ip, { property_id: propertyId, name: pr.name });
    }
    // runs one delete in its own transaction
    async function inTx(fn) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
        catch (e) { try { await client.query('ROLLBACK'); } catch (x) { } throw e; }
        finally { client.release(); }
    }
    function makeDeleter(kind, remover, roles) {
        const gk = kind === 'Unit' ? 'unit' : null;      // people limited to some projects can only delete inside them
        // single delete
        return {
            one: async (req, res) => {
                if (gk && !(await guard(req, res, gk, req.params.id))) return;
                try {
                    await inTx(c => remover(c, req.user.company_id, req.user.user_id, req.ip, parseInt(req.params.id), wantsForce(req)));
                    res.json({ message: kind + ' deleted.' });
                } catch (err) { res.status(400).json({ error: err.message }); }
            },
            many: async (req, res) => {
                const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(x => parseInt(x)).filter(x => x > 0).slice(0, 200) : [];
                if (!ids.length) return res.status(400).json({ error: 'Nothing selected.' });
                const force = wantsForce(req); const failed = []; let deleted = 0;
                for (const id of ids) {
                    if (gk && scoped(req)) {
                        const pids = await propertiesOf(gk, id, req.user.company_id);
                        if (!pids.length || !pids.every(x => inScope(req, x))) { failed.push({ id, error: 'You do not have access to this project.' }); continue; }
                    }
                    try { await inTx(c => remover(c, req.user.company_id, req.user.user_id, req.ip, id, force)); deleted++; }
                    catch (err) { failed.push({ id, error: err.message }); }
                }
                res.json({ message: deleted + ' deleted' + (failed.length ? ', ' + failed.length + ' could not be deleted.' : '.'), deleted, failed });
            }
        };
    }
    const delTenant = makeDeleter('Tenant', removeTenant), delUnit = makeDeleter('Unit', removeUnit), delProp = makeDeleter('Property', removeProperty);
    app.delete('/api/tenants/:id', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), delTenant.one);
    app.post('/api/tenants/bulk-delete', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN'), delTenant.many);
    app.delete('/api/units/:id', authenticateToken, allowRoles(...R_MANAGE), delUnit.one);
    app.post('/api/units/bulk-delete', authenticateToken, allowRoles(...R_MANAGE), delUnit.many);
    app.delete('/api/properties/:id', authenticateToken, allowRoles(...R_ADMIN), delProp.one);
    app.post('/api/properties/bulk-delete', authenticateToken, allowRoles(...R_ADMIN), delProp.many);
    return {};
};
