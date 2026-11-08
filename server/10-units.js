// UNITS & LEASES (selectors)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { app, authenticateToken, pool, scopeSql } = ctx;


    // ============================================================
    // UNITS & LEASES (selectors)
    // ============================================================
    app.get('/api/units', authenticateToken, async (req, res) => {
        try {
            const params = [req.user.company_id];
            const sc = scopeSql(req, 'u.property_id', params);
            const result = await pool.query(
                `SELECT u.*, COALESCE(p.property_name, p.title) AS property_name, ow.full_name AS owner_name
                 FROM units u JOIN properties p ON u.property_id = p.property_id LEFT JOIN owners ow ON ow.owner_id = u.owner_id
                 WHERE u.company_id = $1 ${sc} ORDER BY p.property_id, u.unit_number`,
                params
            );
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    return {};
};
