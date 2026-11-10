// IMPORT FROM EXCEL: rent lists and expenses, with a template and a "check first" step
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
// The .xlsx file is read here without any extra package (an .xlsx is a zip file of xml files).
const zlib = require('zlib');
const express = require('express');

module.exports = function (ctx) {
    const { ALLOWED_RENT_PERIODS, R_MONEY, addPayment, allowRoles, app, authenticateToken, calculatePayment, checkLimit, cleanCur, clearUserCache, createAuditLog, createInvoice, effectiveFeatures, getCompanyAccess, inScope, onboardTenantCore, pool, scoped, todayStr, wrapAsync } = ctx;

    // ---------- read an .xlsx file ----------
    function unzip(buf) {
        let eocd = -1;
        for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
        if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file. Please save it as .xlsx and try again.');
        const total = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
        const files = {};
        for (let n = 0; n < total; n++) {
            if (buf.readUInt32LE(p) !== 0x02014b50) break;
            const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
            const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
            const name = buf.toString('utf8', p + 46, p + 46 + nlen);
            const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
            const raw = buf.slice(dataStart, dataStart + csize);
            files[name] = { method, raw };
            p += 46 + nlen + elen + clen;
        }
        return (name) => { const f = files[name]; if (!f) return null; return (f.method === 0 ? f.raw : zlib.inflateRawSync(f.raw)).toString('utf8'); };
    }
    const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
    const attr = (tag, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag); return m ? unxml(m[1]) : null; };
    const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

    function readXlsx(buf) {
        const get = unzip(buf);
        const wbXml = get('xl/workbook.xml'); if (!wbXml) throw new Error('This is not an Excel (.xlsx) file. Please save it as .xlsx and try again.');
        const rels = {}; (get('xl/_rels/workbook.xml.rels') || '').replace(/<Relationship\b[^>]*>/g, (t) => { rels[attr(t, 'Id')] = attr(t, 'Target'); });
        const shared = []; (get('xl/sharedStrings.xml') || '').replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (_, inner) => { let s = ''; inner.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (_2, t) => { s += unxml(t); }); shared.push(s); });
        // which cell styles are dates
        const styles = get('xl/styles.xml') || ''; const dateFmt = {};
        (styles.match(/<numFmt\b[^>]*>/g) || []).forEach(t => { const code = (attr(t, 'formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''); dateFmt[attr(t, 'numFmtId')] = /[dmyhs]/i.test(code) && !/^[#0,.%\s]*$/.test(code); });
        const builtin = (id) => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
        const xfDate = []; const cx = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
        if (cx) (cx[1].match(/<xf\b[^>]*>/g) || []).forEach(t => { const id = attr(t, 'numFmtId'); xfDate.push(dateFmt[id] !== undefined ? dateFmt[id] : builtin(parseInt(id))); });
        const sheets = [];
        (wbXml.match(/<sheet\b[^>]*>/g) || []).forEach(t => {
            const name = attr(t, 'name'), rid = attr(t, 'r:id'); let target = rels[rid]; if (!target) return;
            target = target.replace(/^\//, ''); if (!target.startsWith('xl/')) target = 'xl/' + target;
            const xml = get(target); if (!xml) return;
            const rows = [];
            xml.replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (_, rtag, inner) => {
                const rn = parseInt(attr('<r ' + rtag + '>', 'r')) || (rows.length + 1);
                const cells = [];
                (inner || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (_2, ctag, cin) => {
                    const ref = attr('<c ' + ctag + '>', 'r'); if (!ref) return;
                    const type = attr('<c ' + ctag + '>', 't'), st = parseInt(attr('<c ' + ctag + '>', 's')) || 0;
                    let v = null; const vm = /<v>([\s\S]*?)<\/v>/.exec(cin || '');
                    if (type === 'inlineStr') { let s = ''; (cin || '').replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (_3, t) => { s += unxml(t); }); v = s; }
                    else if (vm) {
                        if (type === 's') v = shared[parseInt(vm[1])]; else if (type === 'str' || type === 'e') v = unxml(vm[1]);
                        else if (type === 'b') v = vm[1] === '1'; else { v = parseFloat(vm[1]); if (xfDate[st]) v = { date: v }; }
                    }
                    if (v !== null && v !== undefined && v !== '') cells[colIndex(ref)] = v;
                });
                rows[rn - 1] = cells;
            });
            sheets.push({ name, rows });
        });
        return sheets;
    }

    // ---------- understand the cells ----------
    const pad = (n) => String(n).padStart(2, '0');
    function serialToIso(n) { const d = new Date(Math.round((n - 25569) * 86400000)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    function toDate(v) {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'object' && v.date !== undefined) return serialToIso(v.date);
        if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToIso(v) : null;
        const s = String(v).trim(); let m;
        if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return valid(+m[1], +m[2], +m[3]);
        if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) return valid(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);   // day first, as written in Tanzania
        if ((m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,.-]+(\d{2,4})$/.exec(s)) && MONTHS[m[2].slice(0, 4).toLowerCase()] || (m && MONTHS[m[2].slice(0, 3).toLowerCase()])) return valid(+m[3] < 100 ? 2000 + +m[3] : +m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
        return null;
    }
    function valid(y, mo, d) { if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null; const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCMonth() === mo - 1 ? y + '-' + pad(mo) + '-' + pad(d) : null; }
    function toNum(v) {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number') return v;
        if (typeof v === 'object') return null;
        const s = String(v).replace(/[,\s]|tsh|tzs|usd|\$/gi, ''); if (!/^-?\d+(\.\d+)?$/.test(s)) return null; return parseFloat(s);
    }
    const toText = (v) => v === null || v === undefined ? '' : (typeof v === 'object' ? '' : String(v).replace(/\s+/g, ' ').trim());
    const norm = (s) => String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/[.:_*\/\\()\-]+/g, ' ').replace(/\s+/g, ' ').trim();

    // ---------- column names (English and Swahili, as people write them in their own files) ----------
    const COLS = {
        property: ['property name', 'property', 'building', 'project', 'jengo', 'mradi', 'jina la jengo'],
        ptype: ['property type', 'type', 'aina', 'aina ya jengo'],
        address: ['address', 'location', 'anwani', 'mahali'],
        unit: ['unit no', 'unit', 'unit number', 'flat no', 'flat', 'flat number', 'apt no', 'apt', 'apartment', 'apartment no', 'shop no', 'shop', 'room no', 'room', 'room number', 'house no', 'house', 'office no', 'office', 'namba', 'namba ya nyumba', 'chumba', 'fremu', 'plot no', 'unit flat', 'flat room', 'room no', 'rm no', 'no'],
        owner: ['owner', 'owner name', 'name of owner', 'landlord', 'mmiliki', 'jina la mmiliki'],
        owner_phone: ['owner phone', 'owner phone no', 'owner contact', 'simu ya mmiliki'],
        rent_tzs: ['amount tsh', 'amount tzs', 'rent tsh', 'rent tzs', 'tsh', 'tzs', 'rent amount tsh', 'kodi tsh'],
        rent_usd: ['amount usd', 'rent usd', 'usd', 'rent amount usd', 'kodi usd'],
        rent: ['rent', 'rent amount', 'amount', 'monthly rent', 'rent price', 'kodi', 'kiasi'],
        currency: ['currency', 'sarafu'],
        svc: ['service charge', 'service', 'svc charge', 'service charge month'],
        tenant: ['name of tenant', 'tenant s name', 'tenants s name', 'name', 'names', 'full name', 'occupant', 'lessee', 'client', 'customer', 'mteja', 'jina la mpangaji ', 'tenant', 'tenant name', 'tenants name', 'mpangaji', 'jina la mpangaji', 'jina'],
        phone: ['tenant phone', 'phone', 'phone no', 'phone number', 'mobile', 'contact', 'tel', 'simu', 'namba ya simu'],
        idno: ['nida', 'id no', 'id number', 'nida passport', 'nida no', 'passport', 'passport no', 'tenant id', 'kitambulisho', 'nida passport no'],
        start: ['start date', 'start', 'lease start', 'from', 'commencement', 'tarehe ya kuanza', 'anza', 'date from'],
        end: ['ending date', 'end date', 'end', 'lease end', 'expiry', 'expiry date', 'to', 'tarehe ya kuisha', 'mwisho', 'date to'],
        period: ['rental period', 'rent period', 'period', 'duration', 'muda', 'muda wa kupanga'],
        deposit: ['deposit', 'amana', 'security deposit'],
        balance: ['balance', 'balance owed', 'opening balance', 'arrears', 'outstanding', 'deni', 'amount owed', 'balance due'],
        idtype: ['id type', 'identity type', 'aina ya kitambulisho'],
        paymethod: ['mtc banked', 'banked', 'payment method', 'method', 'paid via', 'paid by', 'aina ya malipo', 'njia ya malipo'],
        discount: ['discount', 'punguzo'],
        paid: ['amount paid', 'paid', 'paid amount', 'alicholipa', 'malipo'],
        date: ['date', 'expense date', 'tarehe'],
        category: ['category', 'expense category', 'aina ya gharama', 'kundi'],
        description: ['description', 'details', 'expense', 'maelezo', 'gharama'],
        eamount: ['amount', 'expense amount', 'kiasi', 'cost', 'gharama'],
        payee: ['payee', 'paid to', 'vendor', 'supplier', 'alilipwa'],
        notes: ['notes', 'note', 'remarks', 'maelezo ya ziada']
    };
    function findHeader(rows) {
        let best = null;
        for (let i = 0; i < Math.min(rows.length, 15); i++) {
            const row = rows[i]; if (!row) continue;
            const map = {}; let hits = 0;
            row.forEach((c, ci) => {
                const h = norm(toText(c)); if (!h) return;
                for (const key of Object.keys(COLS)) { if (map[key] === undefined && COLS[key].includes(h)) { map[key] = ci; hits++; break; } }
            });
            if (hits >= 2 && (!best || hits > best.hits)) best = { index: i, map, hits, headers: row.map(c => toText(c)) };
        }
        return best;
    }
    // "1 YEAR", "6 MONTHS", "monthly", "quarterly" -> { unit: 'Month', n: 6 }
    function readPeriod(s) {
        const t = String(s || '').toLowerCase(); if (!t.trim()) return null;
        const num = (/(\d+(?:\.\d+)?)/.exec(t) || [])[1];
        if (/quarter/.test(t)) return { unit: 'Month', n: 3 };
        if (/(half|semi)/.test(t)) return { unit: 'Month', n: 6 };
        if (/year|annual|mwaka|yr/.test(t)) return { unit: 'Year', n: num ? parseFloat(num) : 1 };
        if (/month|mwezi|miezi|mo\b/.test(t)) return { unit: 'Month', n: num ? parseFloat(num) : 1 };
        if (/week|wiki/.test(t)) return { unit: 'Week', n: num ? parseFloat(num) : 1 };
        if (/day|siku/.test(t)) return { unit: 'Day', n: num ? parseFloat(num) : 1 };
        return null;
    }
    const PTYPES = { apartment: 'Apartment', apartments: 'Apartment', flat: 'Apartment', flats: 'Apartment', house: 'House', houses: 'House', nyumba: 'House', office: 'Office', offices: 'Office', ofisi: 'Office', shop: 'Shop', shops: 'Shop', duka: 'Shop', hotel: 'Hotel', 'air-bnb': 'Air-Bnb', airbnb: 'Air-Bnb', 'air bnb': 'Air-Bnb' };
    const EXP_CATS = { repair: 'REPAIR', repairs: 'REPAIR', maintenance: 'REPAIR', matengenezo: 'REPAIR', utility: 'UTILITY', utilities: 'UTILITY', water: 'UTILITY', electricity: 'UTILITY', luku: 'UTILITY', umeme: 'UTILITY', maji: 'UTILITY', tax: 'TAX', taxes: 'TAX', kodi: 'TAX', salary: 'SALARY', salaries: 'SALARY', wages: 'SALARY', mshahara: 'SALARY', mishahara: 'SALARY', supplies: 'SUPPLIES', vifaa: 'SUPPLIES', security: 'SECURITY', ulinzi: 'SECURITY', cleaning: 'CLEANING', usafi: 'CLEANING', insurance: 'INSURANCE', bima: 'INSURANCE', marketing: 'MARKETING', matangazo: 'MARKETING', misc: 'MISC', other: 'MISC', others: 'MISC', miscellaneous: 'MISC', mengineyo: 'MISC' };
    const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + Math.round(n), d)); if (dt.getUTCDate() !== d) dt.setUTCDate(0); return dt.toISOString().slice(0, 10); };
    const addDays = (iso, n) => { const dt = new Date(iso + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };
    function monthsBetween(a, b) { const A = new Date(a + 'T00:00:00Z'), B = new Date(b + 'T00:00:00Z'); return Math.max(0, (B.getUTCFullYear() - A.getUTCFullYear()) * 12 + (B.getUTCMonth() - A.getUTCMonth()) + (B.getUTCDate() - A.getUTCDate()) / 30); }

    // ---------- the import itself ----------
    async function runImport(client, req, sheets, opt) {
        const companyId = req.user.company_id, cleanName = (s) => toText(s);
        const rep = { rows: 0, notes: 0, created: { properties: 0, units: 0, owners: 0, tenants: 0, leases: 0, expenses: 0 }, skipped: 0, errors: [], warnings: [], ignored: [], preview: [], sheets: [] };
        const acc = await getCompanyAccess(companyId);
        const orgOn = effectiveFeatures(acc ? (acc.plan || 'STANDARD') : 'PRO', acc ? acc.features : null).org !== false;
        const canMoney = R_MONEY.includes(req.user.role);
        const propCache = {}, ownerCache = {};
        const err = (sheet, row, msg) => { rep.errors.push({ sheet, row, message: msg }); rep.skipped++; };
        const warn = (sheet, row, msg) => rep.warnings.push({ sheet, row, message: msg });
        const prev = (o) => { if (rep.preview.length < 40) rep.preview.push(o); };

        async function getProperty(name, ptype, address, sheet, row) {
            const key = name.toLowerCase(); if (propCache[key]) return propCache[key];
            const f = await client.query('SELECT property_id, category, property_name FROM properties WHERE company_id = $1 AND lower(property_name) = $2 LIMIT 1', [companyId, key]);
            if (f.rows[0]) {
                if (scoped(req) && !inScope(req, f.rows[0].property_id)) throw new Error('You do not have access to the property "' + name + '".');
                return (propCache[key] = f.rows[0].property_id);
            }
            if (scoped(req) && !req.user.can_add_staff) throw new Error('Only a project manager can add a new property. Choose one of your properties.');
            const lim = await checkLimit(req.user, 'max_properties', 'SELECT COUNT(*) FROM properties WHERE company_id = $1', 'properties');
            if (lim) throw new Error(lim);
            if (req.user.role !== 'SUPER_ADMIN') {
                const fx = effectiveFeatures(acc ? (acc.plan || 'STANDARD') : 'PRO', acc ? acc.features : null).max_properties;
                if (fx !== null && fx !== undefined) {
                    const cnt = parseInt((await client.query('SELECT COUNT(*) FROM properties WHERE company_id = $1', [companyId])).rows[0].count);
                    if (cnt >= fx) throw new Error('Your plan allows up to ' + fx + ' properties. Please contact support to upgrade.');
                }
            }
            const r = await client.query('INSERT INTO properties (company_id, property_name, title, address, category, total_units, service_charge_label, created_by) VALUES ($1, $2, $2, $3, $4, 0, $5, $6) RETURNING property_id',
                [companyId, name, address || opt.address || 'Not set', ptype, 'Service charge', req.user.user_id]);
            if (scoped(req)) { await client.query('INSERT INTO user_properties (user_id, property_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.user_id, r.rows[0].property_id]); clearUserCache(req.user.user_id); }
            rep.created.properties++;
            return (propCache[key] = r.rows[0].property_id);
        }
        async function getOwner(name, phone) {
            const key = name; if (ownerCache[key]) return ownerCache[key];
            const f = await client.query('SELECT owner_id FROM owners WHERE company_id = $1 AND full_name = $2 LIMIT 1', [companyId, key]);
            if (f.rows[0]) return (ownerCache[key] = f.rows[0].owner_id);
            const r = await client.query('INSERT INTO owners (company_id, full_name, phone_number) VALUES ($1, $2, $3) RETURNING owner_id', [companyId, name, phone || null]);
            rep.created.owners++;
            return (ownerCache[key] = r.rows[0].owner_id);
        }

        for (const sh of sheets) {
            const hd = findHeader(sh.rows);
            if (!hd) { rep.sheets.push({ name: sh.name, kind: 'skipped', note: 'No column titles found' }); continue; }
            const m = hd.map;
            if (m.unit === undefined && m.rent !== undefined && m.eamount === undefined) { m.eamount = m.rent; delete m.rent; }
            const isRent = m.unit !== undefined;
            const isExp = !isRent && m.eamount !== undefined && (m.description !== undefined || m.category !== undefined);
            const isProp = !isRent && !isExp && m.property !== undefined && (m.address !== undefined || m.ptype !== undefined);
            if (!isRent && !isExp && !isProp) { rep.sheets.push({ name: sh.name, kind: 'skipped', note: 'Not a rent list or an expense list' }); continue; }
            const used = new Set(Object.values(m));
            hd.headers.forEach((h, i) => { if (h && !used.has(i)) rep.ignored.push(sh.name + ': ' + h); });
            rep.sheets.push({ name: sh.name, kind: isRent ? 'rent' : isExp ? 'expenses' : 'properties', header_row: hd.index + 1 });
            const cell = (row, key) => (m[key] === undefined ? undefined : row[m[key]]);
            let count = 0;
            for (let ri = hd.index + 1; ri < sh.rows.length; ri++) {
                const row = sh.rows[ri]; if (!row || !row.some(c => c !== undefined && c !== null && c !== '')) continue;
                const rn = ri + 1; rep.rows++;
                if (++count > 2000) { err(sh.name, rn, 'More than 2000 rows. Please split the file.'); break; }
                await client.query('SAVEPOINT r');
                const snap = { c: Object.assign({}, rep.created), pc: Object.assign({}, propCache), oc: Object.assign({}, ownerCache) };
                try {
                    if (isProp) {
                        const pn = cleanName(cell(row, 'property')); if (!pn) throw new Error('Property name is missing.');
                        const before = rep.created.properties;
                        await getProperty(pn, PTYPES[norm(toText(cell(row, 'ptype')))] || 'Apartment', toText(cell(row, 'address')), sh.name, rn);
                        if (rep.created.properties === before) warn(sh.name, rn, pn + ' already exists.'); else prev({ sheet: sh.name, row: rn, what: 'Property', text: pn });
                        await client.query('RELEASE SAVEPOINT r'); continue;
                    }
                    if (isExp) {
                        if (!canMoney) throw new Error('Your role cannot record expenses.');
                        const amount = toNum(cell(row, 'eamount')); const desc = toText(cell(row, 'description')) || toText(cell(row, 'category'));
                        if (!(amount > 0)) throw new Error('Amount is missing or not a number.');
                        if (!desc) throw new Error('Description is missing.');
                        const date = toDate(cell(row, 'date')) || todayStr(); if (date > todayStr()) throw new Error('Expense date is in the future.');
                        const cat = EXP_CATS[norm(toText(cell(row, 'category')))] || 'MISC';
                        let pid = null; const pn = cleanName(cell(row, 'property'));
                        if (pn) { const f = await client.query('SELECT property_id FROM properties WHERE company_id = $1 AND lower(property_name) = $2', [companyId, pn.toLowerCase()]); if (!f.rows[0]) throw new Error('Property "' + pn + '" was not found.'); pid = f.rows[0].property_id; if (scoped(req) && !inScope(req, pid)) throw new Error('No access to that property.'); }
                        else if (scoped(req)) throw new Error('Please write the property name.');
                        const cur = /usd|\$/i.test(toText(cell(row, 'currency'))) ? 'USD' : 'TZS';
                        await client.query('INSERT INTO expenses (company_id, property_id, description, amount, category, recorded_by, expense_date, payee, notes, currency) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                            [companyId, pid, desc.slice(0, 500), amount, cat, req.user.user_id, date, toText(cell(row, 'payee')).slice(0, 120) || null, toText(cell(row, 'notes')).slice(0, 500) || null, cur]);
                        rep.created.expenses++; prev({ sheet: sh.name, row: rn, what: 'Expense', text: desc.slice(0, 40), amount: amount, currency: cur, date });
                        await client.query('RELEASE SAVEPOINT r'); continue;
                    }
                    // ----- rent list row: one unit, maybe with a tenant -----
                    const unitNo = toText(cell(row, 'unit')); if (!unitNo) throw new Error('Unit number is missing.');
                    const propName = cleanName(cell(row, 'property')) || opt.property_name || sh.name;
                    const ptRaw = norm(toText(cell(row, 'ptype'))); const ptype = PTYPES[ptRaw] || PTYPES[norm(opt.property_type)] || 'Apartment';
                    const rentTzs = toNum(cell(row, 'rent_tzs')), rentUsd = toNum(cell(row, 'rent_usd')), rentAny = toNum(cell(row, 'rent'));
                    let cur = 'TZS', amount = null;
                    const curTxt = toText(cell(row, 'currency'));
                    if (rentUsd > 0 && !(rentTzs > 0)) { cur = 'USD'; amount = rentUsd; }
                    else if (rentTzs > 0) { amount = rentTzs; if (rentUsd > 0) warn(sh.name, rn, 'Both TSh and USD amounts were filled. TSh was used.'); }
                    else if (rentAny > 0) { amount = rentAny; if (/usd|\$|dollar/i.test(curTxt)) cur = 'USD'; }
                    const pid = await getProperty(propName, ptype, toText(cell(row, 'address')), sh.name, rn);
                    // owner (Pro plan only)
                    let ownerId = null; let on = cleanName(cell(row, 'owner'));
                    if (on && /^(company|developer|kampuni|-)$/i.test(on) === false) { if (orgOn) ownerId = await getOwner(on, toText(cell(row, 'owner_phone'))); else if (!rep.ownerNote) { rep.ownerNote = true; warn(sh.name, rn, 'Owners are part of the Pro plan, so the owner names were not imported.'); } }
                    const svc = toNum(cell(row, 'svc')) || 0;
                    let unit = (await client.query('SELECT unit_id, status, currency, rent_amount FROM units WHERE property_id = $1 AND company_id = $2 AND lower(unit_number) = $3', [pid, companyId, unitNo.toLowerCase()])).rows[0];
                    let tenantName = cleanName(cell(row, 'tenant')); let noteText = '';
                    // a note such as "staff" or "vacant" in the tenant column, with no dates: keep the unit, no tenant
                    const rawEmpty = (v) => v === undefined || v === null || String(typeof v === 'object' ? 'x' : v).trim() === '';
                    if (tenantName && !toDate(cell(row, 'start')) && !toDate(cell(row, 'end'))) { noteText = tenantName; tenantName = ''; rep.notes++; warn(sh.name, rn, 'Unit ' + unitNo + ': "' + noteText.slice(0, 40) + '" has no dates, so it was kept as a note. The unit was added without a tenant.'); }
                    if (!unit) {
                        const ins = await client.query(`INSERT INTO units (company_id, property_id, unit_number, rent_amount, currency, status, is_furnished, service_charge, service_inclusive, owner_id, occupancy_type)
                            VALUES ($1, $2, $3, $4, $5, 'VACANT', false, $6, false, $7, 'LET') RETURNING unit_id, status, currency, rent_amount`, [companyId, pid, unitNo.slice(0, 60), amount || 0, cur === 'USD' ? 'USD' : 'TSH', svc, ownerId]);
                        unit = ins.rows[0]; rep.created.units++;
                        await client.query('UPDATE properties SET total_units = COALESCE(total_units, 0) + 1 WHERE property_id = $1', [pid]);
                    } else if (!tenantName) { if (!noteText) warn(sh.name, rn, 'Unit ' + unitNo + ' already exists. Nothing to add.'); rep.skipped++; await client.query('RELEASE SAVEPOINT r'); continue; }
                    if (!tenantName) { prev({ sheet: sh.name, row: rn, what: 'Unit', text: propName + ' · ' + unitNo + (noteText ? ' [note: ' + noteText.slice(0, 30) + ']' : '') + (ownerId ? ' (owner: ' + on + ')' : ''), amount, currency: cur }); await client.query('RELEASE SAVEPOINT r'); continue; }
                    // ----- tenant and lease -----
                    if (unit.status === 'OCCUPIED') {
                        const cur0 = (await client.query("SELECT t.full_name FROM leases l JOIN tenants t ON t.tenant_id = l.tenant_id WHERE l.unit_id = $1 AND l.lease_state = 'CURRENT' ORDER BY l.lease_id DESC LIMIT 1", [unit.unit_id])).rows[0];
                        if (cur0 && cur0.full_name.toLowerCase() === tenantName.toLowerCase()) { warn(sh.name, rn, 'Unit ' + unitNo + ': ' + tenantName + ' is already in the system, so this row was skipped.'); rep.skipped++; await client.query('RELEASE SAVEPOINT r'); continue; }
                        throw new Error('Unit ' + unitNo + ' already has a tenant' + (cur0 ? ' (' + cur0.full_name + ')' : '') + '.');
                    }
                    let start = toDate(cell(row, 'start')); if (!start) throw new Error('Start date "' + toText(cell(row, 'start')).slice(0, 20) + '" is not a valid date (use day/month/year).');
                    let end = toDate(cell(row, 'end'));
                    if (!end && !rawEmpty(cell(row, 'end'))) throw new Error('Ending date "' + toText(cell(row, 'end')).slice(0, 20) + '" is not a valid date (check the year).');
                    if (end && end <= start) {
                        // Excel often swaps day and month (03/06 read as 6 March): try reading both dates the other way round
                        const sw = (iso) => { const [y, m, d] = iso.split('-'); return +d <= 12 ? valid(+y, +d, +m) : null; };
                        const s2 = sw(start), e2 = sw(end);
                        if (s2 && e2 && e2 > s2) { rep.swapped = (rep.swapped || 0) + 1; start = s2; end = e2; }
                    }
                    if (end && end <= start) throw new Error('Ending date (' + end + ') must be after the start date (' + start + ').');
                    const pr = readPeriod(toText(cell(row, 'period')));
                    if (!(amount > 0)) { amount = parseFloat(unit.rent_amount) || 0; if (String(unit.currency).toUpperCase() === 'USD') cur = 'USD'; }
                    if (!(amount > 0) && opt.default_rent > 0) { amount = opt.default_rent; cur = opt.default_cur; rep.usedDefault = (rep.usedDefault || 0) + 1; }
                    if (!(amount > 0)) throw new Error('Rent is empty. Write it in the file, or type a default rent in the box above.');
                    // how many periods, and the rent for one period
                    let unitName = 'Month', n = 1;
                    if (pr) { unitName = pr.unit; n = pr.n; } else if (end) { const mo = monthsBetween(start, end); if (mo >= 11.5 && Math.abs(mo / 12 - Math.round(mo / 12)) < 0.05) { unitName = 'Year'; n = Math.round(mo / 12); } else { unitName = 'Month'; n = Math.max(1, Math.round(mo)); } }
                    if (!end) end = unitName === 'Year' ? addMonths(start, n * 12) : unitName === 'Month' ? addMonths(start, n) : unitName === 'Week' ? addDays(start, n * 7) : addDays(start, n);
                    let price = amount; if (opt.amount_mode === 'total' && n > 1) price = Math.round(amount / n * 100) / 100;
                    if (!ALLOWED_RENT_PERIODS.includes(unitName)) unitName = 'Month';
                    const totalRent = Math.round(price * n);
                    const bal = toNum(cell(row, 'balance')); const disc = Math.min(toNum(cell(row, 'discount')) || 0, totalRent);
                    const toPay = totalRent - disc; const paidCol = toNum(cell(row, 'paid'));
                    const owed = paidCol !== null ? Math.max(0, toPay - paidCol) : (bal > 0 ? Math.min(bal, toPay) : 0);
                    const paid = paidCol !== null ? Math.min(Math.max(paidCol, 0), toPay) : toPay - owed;
                    const dep = toNum(cell(row, 'deposit')) || 0;
                    const phone = toText(cell(row, 'phone')).slice(0, 30), idn = toText(cell(row, 'idno')).slice(0, 60);
                    if (!phone) rep.noPhone = (rep.noPhone || 0) + 1;
                    // the unit follows the currency of the contract
                    if ((String(unit.currency || '').toUpperCase() === 'USD') !== (cur === 'USD')) {
                        await client.query('UPDATE units SET currency = $1, rent_amount = $2 WHERE unit_id = $3', [cur === 'USD' ? 'USD' : 'TSH', price, unit.unit_id]);
                    }
                    const calc = calculatePayment({ rent_price: price, number_of_periods: n, discount: disc, paid_amount: paid });
                    if (calc.error) throw new Error(calc.error);
                    const pmRaw = toText(cell(row, 'paymethod')).toLowerCase();
                    const pm = /bank|nmb|crdb|nbc|cheque|transfer/.test(pmRaw) ? 'Bank' : /mpesa|m-pesa|tigo|airtel|halo|mtc|mobile|simu/.test(pmRaw) ? 'Mobile Money' : (opt.payment_method || 'Cash');
                    const body = { full_name: tenantName.slice(0, 120), nida_passport_no: idn || 'NOID-' + require('crypto').createHash('md5').update(tenantName + '|' + phone).digest('hex').slice(0, 12), identity_type: (({ nida: 'NIDA', passport: 'PASSPORT', 'driving licence': 'DRIVING_LICENSE', 'driving license': 'DRIVING_LICENSE', voter: 'VOTER_ID' })[norm(toText(cell(row, 'idtype')))] || 'NIDA'), phone_number: phone,
                        property_id: pid, unit_id: unit.unit_id, start_date: start, end_date: end, rent_period: unitName, payment_method: pm, payment_reference: 'Excel import' };
                    const out = await onboardTenantCore(client, req, body, calc, cur, { skipService: true });
                    rep.created.tenants++; rep.created.leases++;
                    if (dep > 0) {
                        const di = await createInvoice(client, { companyId, leaseId: out.lease.lease_id, type: 'DEPOSIT', subtotal: dep, discount: 0, description: 'Deposit', issueDate: start, dueDate: start, periodStart: start, periodEnd: start, leaseCharge: false, userId: req.user.user_id, status: 'PAID' });
                        await addPayment(client, { companyId, invoiceId: di.invoice_id, amount: dep, method: opt.payment_method || 'Cash', methodDetail: opt.payment_method || 'Cash', reference: 'Excel import', date: start <= todayStr() ? start : todayStr(), userId: req.user.user_id });
                    }
                    prev({ sheet: sh.name, row: rn, what: 'Lease', text: tenantName + ' · ' + propName + ' ' + unitNo, amount: totalRent, currency: cur, period: n + ' ' + unitName + (n > 1 ? 's' : ''), start, end, owed, deposit: dep });
                } catch (e) {
                    await client.query('ROLLBACK TO SAVEPOINT r');
                    Object.assign(rep.created, snap.c); for (const k of Object.keys(propCache)) if (!(k in snap.pc)) delete propCache[k]; for (const k of Object.keys(ownerCache)) if (!(k in snap.oc)) delete ownerCache[k];
                    err(sh.name, rn, e.message);
                }
                await client.query('RELEASE SAVEPOINT r').catch(() => {});
            }
        }
        if (rep.noPhone) warn('', 0, rep.noPhone + ' tenant(s) have no phone number. Add the numbers later.');
        if (rep.swapped) warn('', 0, rep.swapped + ' row(s) had day and month swapped by Excel. They were read the other way round so that the end date comes after the start date. Please check them.');
        if (rep.usedDefault) warn('', 0, 'The default rent was used for ' + rep.usedDefault + ' row(s) that had no rent.');
        rep.ignored = [...new Set(rep.ignored)];
        return rep;
    }

    app.post('/api/import/excel', authenticateToken, allowRoles('SUPER_ADMIN', 'COMPANY_ADMIN', 'PROPERTY_MANAGER', 'ACCOUNTANT'), express.raw({ type: '*/*', limit: '15mb' }), wrapAsync(async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'Please choose an Excel (.xlsx) file.' });
        // a real .xlsx is a zip file: it must start with the letters PK
        if (req.body[0] !== 0x50 || req.body[1] !== 0x4b) return res.status(400).json({ error: 'This is not an Excel (.xlsx) file. Please save it as .xlsx and try again.' });
        let sheets;
        try { sheets = readXlsx(req.body); } catch (e) { return res.status(400).json({ error: e.message || 'The file could not be read. Please save it as .xlsx.' }); }
        const q = req.query;
        const opt = { property_name: toText(q.property_name), property_type: toText(q.property_type), address: toText(q.address), amount_mode: q.amount_mode === 'total' ? 'total' : 'per_period', default_rent: parseFloat(String(q.default_rent || '').replace(/,/g, '')) || 0, default_cur: q.default_cur === 'USD' ? 'USD' : 'TZS', payment_method: ['Cash', 'Bank', 'Mobile Money'].includes(q.payment_method) ? q.payment_method : 'Cash' };
        const dry = q.dry_run === '1';
        let client;
        try {
            client = await pool.connect(); await client.query('BEGIN');
            const rep = await runImport(client, req, sheets, opt);
            if (dry || (!rep.created.units && !rep.created.leases && !rep.created.expenses && !rep.created.properties)) await client.query('ROLLBACK');
            else { await createAuditLog(client, req.user.company_id, req.user.user_id, 'Imported from Excel', 'IMPORT', req.ip, rep.created); await client.query('COMMIT'); }
            rep.dry_run = dry;
            res.json(rep);
        } catch (e) { if (client) await client.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: 'Import failed: ' + e.message }); }
        finally { if (client) client.release(); }
    }));

    app.get('/api/import/template', authenticateToken, (req, res) => {
        const all = require('./27-import-template.js'); const form = req.query.type === 'form';
        const b64 = form ? all.form : all.simple;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="KEY-ARCH-template-' + (form ? 'forms' : 'simple') + '.xlsx"');
        res.send(Buffer.from(b64, 'base64'));
    });
    return { readXlsx };
};
