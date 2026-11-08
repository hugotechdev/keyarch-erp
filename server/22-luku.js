// LUKU (Pro): the company uploads its own tokens, the system sells them
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { R_MANAGE, R_MONEY, R_VIEW_MONEY, allowRoles, app, authenticateToken, companyWide, createAuditLog, isDateStr, loadOptional, pool, requireFeature, wrapAsync } = ctx;


    // ============================================================
    // LUKU (Pro): the company uploads its own tokens, the system sells them
    // File columns: unit name, token, price, kWh (optional)
    // ============================================================
    function parseCsvText(text) {
        text = String(text || '').replace(/^﻿/, '');
        const firstLine = text.split(/\r?\n/)[0] || '';
        const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
        const rows = [];
        let row = [], cur = '', inQ = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQ) {
                if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
                else if (ch === '"') inQ = false;
                else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === delim) { row.push(cur); cur = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(cur); cur = '';
                if (row.some(c => String(c).trim() !== '')) rows.push(row);
                row = [];
            } else cur += ch;
        }
        row.push(cur);
        if (row.some(c => String(c).trim() !== '')) rows.push(row);
        return rows.map(r => r.map(v => ({ v: String(v).trim(), num: false })));
    }

    async function parseXlsxBuffer(buf) {
        const ExcelJS = loadOptional('exceljs');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        if (!ws) return [];
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
            const cells = [];
            for (let c = 1; c <= row.cellCount; c++) {
                let v = row.getCell(c).value;
                let num = false;
                if (v && typeof v === 'object' && !(v instanceof Date)) v = v.text !== undefined ? v.text : (v.result !== undefined ? v.result : (v.richText ? v.richText.map(x => x.text).join('') : ''));
                if (typeof v === 'number') num = true;
                cells.push({ v: v === null || v === undefined ? '' : String(v).trim(), num });
            }
            if (cells.some(c => c.v !== '')) rows.push(cells);
        });
        return rows;
    }

    const LUKU_ALIASES = {
        unit_name: ['unit', 'unit name', 'unit_name', 'unitname', 'house', 'room', 'meter', 'meter name', 'nyumba', 'chumba'],
        token: ['token', 'token number', 'token_number', 'tokens', 'voucher', 'luku token', 'namba ya token'],
        price: ['price', 'amount', 'bei', 'value', 'cost', 'tsh'],
        kwh: ['kwh', 'units', 'kw', 'kwh units', 'kwh_units']
    };
    function lukuColumnIndex(header) {
        const idx = {};
        header.forEach((cell, i) => {
            const h = cell.v.toLowerCase().replace(/[^a-z0-9_ ]/g, '').trim();
            Object.keys(LUKU_ALIASES).forEach(k => { if (idx[k] === undefined && LUKU_ALIASES[k].includes(h)) idx[k] = i; });
        });
        return idx;
    }

    function lukuLowFlag(available, threshold) {
        if (available === 0) return 'OUT';
        if (available <= threshold) return 'LOW';
        return 'OK';
    }

    app.get('/api/luku/summary', authenticateToken, companyWide, requireFeature('luku'), allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const cId = req.user.company_id;
        const thr = parseInt((await pool.query('SELECT COALESCE(luku_low_threshold, 5) AS t FROM companies WHERE company_id = $1', [cId])).rows[0].t);
        const groups = (await pool.query(
            `SELECT unit_name, price, COUNT(*) FILTER (WHERE status = 'AVAILABLE') AS available, COUNT(*) FILTER (WHERE status = 'SOLD') AS sold
             FROM luku_stock WHERE company_id = $1 GROUP BY unit_name, price ORDER BY unit_name, price`, [cId]
        )).rows.map(g => ({ unit_name: g.unit_name, price: parseFloat(g.price), available: parseInt(g.available), sold: parseInt(g.sold), flag: lukuLowFlag(parseInt(g.available), thr) }));
        const sales = (await pool.query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM luku_vouchers WHERE company_id = $1 AND sold_at >= date_trunc('month', CURRENT_DATE)`, [cId]
        )).rows[0];
        res.json({ threshold: thr, groups, low_count: groups.filter(g => g.flag !== 'OK').length, month_sales: { count: parseInt(sales.n), total: parseFloat(sales.total) } });
    }));

    app.post('/api/luku/stock/upload', authenticateToken, companyWide, requireFeature('luku'), allowRoles(...R_MANAGE), async (req, res) => {
        const { filename, data } = req.body;
        if (!data) return res.status(400).json({ error: 'Please choose a file.' });
        const cId = req.user.company_id;
        let client;
        try {
            const name = String(filename || 'upload').toLowerCase();
            const buf = Buffer.from(String(data), 'base64');
            if (buf.length === 0) return res.status(400).json({ error: 'The file is empty.' });
            let rows;
            if (name.endsWith('.xlsx')) rows = await parseXlsxBuffer(buf);
            else if (name.endsWith('.csv') || name.endsWith('.txt')) rows = parseCsvText(buf.toString('utf8'));
            else return res.status(400).json({ error: 'Please upload an .xlsx or .csv file.' });
            if (rows.length < 2) return res.status(400).json({ error: 'The file has no data rows.' });
            if (rows.length > 20001) return res.status(400).json({ error: 'Too many rows. Upload at most 20,000 tokens at a time.' });

            const idx = lukuColumnIndex(rows[0]);
            if (idx.unit_name === undefined || idx.token === undefined || idx.price === undefined) {
                return res.status(400).json({ error: 'The first row must have the headings: unit name, token, price (and optionally kWh). Download the template to see an example.' });
            }

            const accepted = [], rejected = [];
            const seen = new Set();
            let duplicatesInFile = 0;
            for (let i = 1; i < rows.length; i++) {
                const r = rows[i];
                const line = i + 1;
                const unit = (r[idx.unit_name] || { v: '' }).v;
                const tokCell = r[idx.token] || { v: '', num: false };
                const priceRaw = (r[idx.price] || { v: '' }).v.replace(/[,\s]/g, '');
                const kwhRaw = idx.kwh !== undefined ? (r[idx.kwh] || { v: '' }).v.replace(/[,\s]/g, '') : '';
                const token = tokCell.v.replace(/[\s-]/g, '');
                const price = parseFloat(priceRaw);

                if (!unit) { rejected.push({ line, reason: 'Unit name is empty' }); continue; }
                if (!(price > 0)) { rejected.push({ line, reason: 'Price is missing or not a number' }); continue; }
                if (/e[+-]?\d+/i.test(token)) { rejected.push({ line, reason: 'Token is written like 1.23E+19. Excel rounded it. Format the token column as Text and paste the tokens again.' }); continue; }
                if (!/^\d{8,30}$/.test(token)) { rejected.push({ line, reason: 'Token must be numbers only (8 to 30 digits)' }); continue; }
                if (tokCell.num && token.length >= 16) { rejected.push({ line, reason: 'Token was saved as a number, so Excel may have changed its last digits. Format the token column as Text.' }); continue; }
                if (token.length >= 16 && /0{4,}$/.test(token)) { rejected.push({ line, reason: 'Token ends with many zeros - Excel probably rounded it. Format the token column as Text and try again.' }); continue; }
                if (seen.has(token)) { duplicatesInFile++; continue; }
                seen.add(token);
                const kwh = parseFloat(kwhRaw);
                accepted.push({ unit: unit.slice(0, 80), token, price, kwh: kwh > 0 ? kwh : null });
            }

            // if Excel damaged tokens it usually damages many: refuse the whole file instead of loading bad tokens
            if (accepted.length === 0) {
                return res.status(400).json({ error: 'No valid tokens found in the file.', rejected: rejected.slice(0, 20), rejected_count: rejected.length });
            }

            client = await pool.connect();
            await client.query('BEGIN');
            const batch = `${String(filename || 'upload').slice(0, 50)} ${new Date().toISOString().slice(0, 10)}`;
            let inserted = 0;
            for (let i = 0; i < accepted.length; i += 1000) {
                const chunk = accepted.slice(i, i + 1000);
                const r = await client.query(
                    `INSERT INTO luku_stock (company_id, unit_name, token, price, kwh, batch)
                     SELECT $1, u, t, p, k, $6 FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[]) AS x(u, t, p, k)
                     ON CONFLICT (company_id, token) DO NOTHING RETURNING stock_id`,
                    [cId, chunk.map(c => c.unit), chunk.map(c => c.token), chunk.map(c => c.price), chunk.map(c => c.kwh), batch]
                );
                inserted += r.rows.length;
            }
            await createAuditLog(client, cId, req.user.user_id, 'Uploaded Luku stock', 'LUKU', req.ip, { inserted, rejected: rejected.length });
            await client.query('COMMIT');
            res.status(201).json({
                message: `${inserted} token(s) added.`, inserted,
                already_in_system: accepted.length - inserted, duplicates_in_file: duplicatesInFile,
                rejected_count: rejected.length, rejected: rejected.slice(0, 20)
            });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(err.code === 'MISSING_PACKAGE' ? 501 : 400).json({ error: err.message });
        } finally { if (client) client.release(); }
    });

    app.post('/api/luku/sell', authenticateToken, companyWide, requireFeature('luku'), allowRoles(...R_MONEY), async (req, res) => {
        const { unit_name, price, customer_name, customer_phone } = req.body;
        const amount = parseFloat(price);
        if (!unit_name || !(amount > 0)) return res.status(400).json({ error: 'Choose the unit and the price.' });
        const cId = req.user.company_id;
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const tok = (await client.query(
                `SELECT stock_id, token, kwh FROM luku_stock
                 WHERE company_id = $1 AND unit_name = $2 AND price = $3 AND status = 'AVAILABLE'
                 ORDER BY stock_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [cId, unit_name, amount]
            )).rows[0];
            if (!tok) throw new Error('No token is left for this unit at this price. Upload more tokens first.');

            await client.query(
                "UPDATE luku_stock SET status = 'SOLD', sold_at = NOW(), sold_to = $1, sold_by = $2 WHERE stock_id = $3",
                [String(customer_name || '').trim() || null, req.user.user_id, tok.stock_id]
            );
            const sale = (await client.query(
                `INSERT INTO luku_vouchers (company_id, meter_number, tenant_name, amount, token_number, kwh_units, sold_by, unit_name, customer_phone)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $2, $8) RETURNING voucher_id, sold_at`,
                [cId, String(unit_name).slice(0, 50), String(customer_name || '').trim() || null, amount, tok.token, tok.kwh, req.user.user_id, String(customer_phone || '').trim() || null]
            )).rows[0];
            const left = parseInt((await client.query(
                "SELECT COUNT(*) AS c FROM luku_stock WHERE company_id = $1 AND unit_name = $2 AND price = $3 AND status = 'AVAILABLE'", [cId, unit_name, amount]
            )).rows[0].c);
            const thr = parseInt((await client.query('SELECT COALESCE(luku_low_threshold, 5) AS t FROM companies WHERE company_id = $1', [cId])).rows[0].t);
            await createAuditLog(client, cId, req.user.user_id, 'Sold Luku token', 'LUKU', req.ip, { unit_name, amount });
            await client.query('COMMIT');
            res.status(201).json({
                token: tok.token, kwh: tok.kwh, amount, unit_name, voucher_id: sale.voucher_id, sold_at: sale.sold_at,
                remaining: left, flag: lukuLowFlag(left, thr)
            });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { if (client) client.release(); }
    });

    app.get('/api/luku/sales', authenticateToken, companyWide, requireFeature('luku'), allowRoles(...R_VIEW_MONEY), wrapAsync(async (req, res) => {
        const params = [req.user.company_id];
        let where = '';
        if (isDateStr(req.query.from)) { params.push(req.query.from); where += ` AND v.sold_at::date >= $${params.length}`; }
        if (isDateStr(req.query.to)) { params.push(req.query.to); where += ` AND v.sold_at::date <= $${params.length}`; }
        const rows = (await pool.query(
            `SELECT v.voucher_id, v.sold_at, COALESCE(v.unit_name, v.meter_number) AS unit_name, v.tenant_name AS customer_name, v.customer_phone, v.amount, v.token_number, v.kwh_units, u.full_name AS sold_by_name
             FROM luku_vouchers v LEFT JOIN users u ON u.user_id = v.sold_by
             WHERE v.company_id = $1 ${where} ORDER BY v.sold_at DESC LIMIT 500`, params
        )).rows;
        res.json(rows);
    }));

    // remove unsold tokens uploaded by mistake
    app.delete('/api/luku/stock', authenticateToken, companyWide, requireFeature('luku'), allowRoles(...R_MANAGE), wrapAsync(async (req, res) => {
        const { unit_name, price } = req.query;
        if (!unit_name || !(parseFloat(price) > 0)) return res.status(400).json({ error: 'Unit and price are required.' });
        const r = await pool.query("DELETE FROM luku_stock WHERE company_id = $1 AND unit_name = $2 AND price = $3 AND status = 'AVAILABLE' RETURNING stock_id", [req.user.company_id, unit_name, parseFloat(price)]);
        res.json({ message: `${r.rows.length} unsold token(s) removed.` });
    }));

    app.get('/api/luku/template', authenticateToken, companyWide, requireFeature('luku'), async (req, res) => {
        // Excel version keeps the token column as Text, so Excel can never round the long numbers
        try {
            const ExcelJS = loadOptional('exceljs');
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Tokens');
            ws.columns = [
                { header: 'unit name', key: 'u', width: 18 }, { header: 'token', key: 't', width: 28, style: { numFmt: '@' } },
                { header: 'price', key: 'p', width: 14 }, { header: 'kWh', key: 'k', width: 10 }
            ];
            ws.getRow(1).font = { bold: true };
            ws.addRow({ u: 'A-1', t: '12345678901234567890', p: 5000, k: 18.5 });
            ws.addRow({ u: 'A-1', t: '09876543210987654321', p: 5000, k: 18.5 });
            ws.addRow({ u: 'A-2', t: '11112222333344445555', p: 10000, k: 37 });
            ws.getColumn(2).eachCell(c => { c.numFmt = '@'; });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="luku-tokens-template.xlsx"');
            await wb.xlsx.write(res);
            res.end();
        } catch (err) {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="luku-tokens-template.csv"');
            res.send('unit name,token,price,kwh\r\nA-1,12345678901234567890,5000,18.5\r\nA-1,09876543210987654321,5000,18.5\r\nA-2,11112222333344445555,10000,37\r\n');
        }
    });
    return {};
};
