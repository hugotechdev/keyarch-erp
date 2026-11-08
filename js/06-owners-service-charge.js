// ============================================================
// UNIT OWNERS + SERVICE CHARGE (Pro)
// ============================================================

let SO_UNITS = {};
function billOwners() { document.getElementById('bo-year').innerText = document.getElementById('so-year').value; document.querySelector('input[name="bo-mode"][value="1"]').checked = true; openModal('modal-bill-owners'); }
async function runBillOwners(e) {
    e.preventDefault();
    const yr = document.getElementById('so-year').value;
    const mode = document.querySelector('input[name="bo-mode"]:checked').value;
    const d = new Date(); const mo = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const r = await api('/api/owner-charges/generate', 'POST', mode === '1' ? { month: mo } : { year: Number(yr) });
    closeModal('modal-bill-owners');
    alert(r.ok ? r.data.message : (r.data.error || 'Failed'));
    if (r.ok) loadSvcOwners();
}
function openOwnerPay(unitId) {
    const u = SO_UNITS[unitId]; if (!u) return;
    const open = (u.charges || []).filter(c => c.amount - c.paid > 0.001);
    if (!open.length) return alert('Nothing is owed on this unit.');
    document.getElementById('op-unit').innerText = `${u.property_name} · ${u.unit_number}`;
    document.getElementById('op-charge').innerHTML = open.map(c => `<option value="${c.charge_id}" data-left="${c.amount - c.paid}">${esc(c.period)} · owes ${money(c.amount - c.paid, u.currency)}</option>`).join('');
    document.getElementById('op-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('op-ref').value = '';
    opPick(); openModal('modal-owner-pay');
}
function opPick() {
    const o = document.getElementById('op-charge').selectedOptions[0];
    document.getElementById('op-amount').value = o ? formatMoney(o.dataset.left) : '';
}
async function saveOwnerPay(e) {
    e.preventDefault();
    const id = document.getElementById('op-charge').value;
    const r = await api(`/api/owner-charges/${id}/pay`, 'POST', {
        amount: parseMoney(document.getElementById('op-amount').value), method: document.getElementById('op-method').value,
        paid_on: document.getElementById('op-date').value, reference_no: document.getElementById('op-ref').value
    });
    if (r.ok) { closeModal('modal-owner-pay'); await loadSvcOwners(); if (SO_UNIT_OPEN && document.getElementById('modal-so-unit').style.display === 'flex') soUnit(SO_UNIT_OPEN); } else alert(r.data.error || 'Failed');
}
let ownersData = [];
function orgOn() { return hasFeature('org') && role() !== 'SUPER_ADMIN'; }
function applyOrgOnly() { document.querySelectorAll('.org-only').forEach(el => el.style.display = orgOn() ? '' : 'none'); }
function companyLabel() { const u = currentUserInfo(); return (u.company && u.company.company_name) || u.company_name || 'Company'; }
async function loadOwners() {
    if (!orgOn()) return;
    const r = await api('/api/owners'); if (r.ok) ownersData = r.data;
    fillOwnerSelects();
}
// keepEmpty: bulk modal has a "No change" first option
function fillOwnerSelects(bulk) {
    applyOrgOnly();
    const opts = (bulk ? '<option value="">No change</option>' : '') +
        `<option value="${bulk ? 'COMPANY' : ''}">${esc(companyLabel())} (developer)</option>` +
        ownersData.map(o => `<option value="${o.owner_id}">${esc(o.full_name)}</option>`).join('') +
        '<option value="__NEW__">+ New owner...</option>';
    document.querySelectorAll('select.owner-select').forEach(sel => {
        const keep = sel.value; const isBulk = sel.id === 'bk-owner';
        sel.innerHTML = isBulk ? opts : opts.replace('<option value="">No change</option>', '').replace('value="COMPANY"', 'value=""');
        if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    });
}
let SO_SEL = null;
function onOwnerSelect(sel) { if (sel.value !== '__NEW__') return; openOwnerForm(null, sel); }
let OF_UNITS = [], OF_CHECK = {};
async function openOwnerForm(id, sel) {
    SO_SEL = sel || null;
    const o = id ? ownersData.find(x => String(x.owner_id) === String(id)) : null;
    document.getElementById('of-title').innerText = o ? 'Edit owner' : 'New owner';
    document.getElementById('of-id').value = o ? o.owner_id : '';
    document.getElementById('of-name').value = o ? o.full_name : '';
    document.getElementById('of-phone').value = o ? (o.phone_number || '') : '';
    document.getElementById('of-email').value = o ? (o.email || '') : '';
    document.getElementById('of-svc').value = ''; document.getElementById('of-q').value = ''; document.getElementById('of-show').value = 'avail';
    OF_CHECK = {}; OF_UNITS = [];
    document.getElementById('of-units').innerHTML = '<div class="text-xs text-gray-500 p-3">' + sp('Loading...') + '</div>';
    openModal('modal-owner-form');
    const r = await api('/api/units'); if (!r.ok) return;
    OF_UNITS = r.data;
    OF_UNITS.forEach(u => { if (o && String(u.owner_id) === String(o.owner_id)) OF_CHECK[u.unit_id] = u.occupancy_type === 'OWNER_LIVES' ? 'OWNER_LIVES' : 'LET'; });
    const props = {}; OF_UNITS.forEach(u => props[u.property_id] = u.property_name);
    document.getElementById('of-prop').innerHTML = '<option value="">All projects</option>' + Object.keys(props).map(k => `<option value="${k}">${esc(props[k])}</option>`).join('');
    ofRender();
}
function ofToggle(id, on) { if (on) OF_CHECK[id] = OF_CHECK[id] || 'LET'; else delete OF_CHECK[id]; ofRender(); }
function ofOcc(id, v) { OF_CHECK[id] = v; }
function ofShown() {
    const q = document.getElementById('of-q').value.trim().toLowerCase(), pf = document.getElementById('of-prop').value, mode = document.getElementById('of-show').value;
    const me = document.getElementById('of-id').value;
    return OF_UNITS.filter(u => (!pf || String(u.property_id) === pf) && (!q || (u.property_name + ' ' + u.unit_number).toLowerCase().includes(q))
        && (mode === 'all' || (mode === 'sel' ? OF_CHECK[u.unit_id] !== undefined : (!u.owner_id || String(u.owner_id) === String(me)))));
}
function ofBulk(pid, on) {
    ofShown().filter(u => pid === 0 || u.property_id === pid).forEach(u => { if (on) OF_CHECK[u.unit_id] = OF_CHECK[u.unit_id] || 'LET'; else delete OF_CHECK[u.unit_id]; });
    ofRender();
}
function ofRender() {
    const me = document.getElementById('of-id').value, LIMIT = 150;
    const all = ofShown(), list = all.slice(0, LIMIT);
    const box = document.getElementById('of-units'), top = box.scrollTop;
    let html = '', last = null;
    list.forEach(u => {
        if (u.property_id !== last) {
            last = u.property_id;
            const inP = all.filter(x => x.property_id === u.property_id), nSel = inP.filter(x => OF_CHECK[x.unit_id] !== undefined).length;
            html += `<div class="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#0d172d] text-[11px] font-bold text-indigo-300 sticky top-0"><span>${esc(u.property_name)} <span class="text-gray-500 font-normal">(${nSel}/${inP.length})</span></span><span><button type="button" onclick="ofBulk(${u.property_id}, true)" class="underline">${sp('Select all')}</button> · <button type="button" onclick="ofBulk(${u.property_id}, false)" class="underline">${sp('Clear')}</button></span></div>`;
        }
        const on = OF_CHECK[u.unit_id] !== undefined, rented = u.status === 'OCCUPIED';
        const other = u.owner_id && String(u.owner_id) !== String(me) ? `<span class="text-[10px] text-amber-300"> · <span>Owner</span>: ${esc(u.owner_name || '')}</span>` : '';
        const tag = rented ? '<span class="text-[10px] text-emerald-300">' + sp('Rented') + '</span>' : '<span class="text-[10px] text-amber-300">' + sp('Vacant') + '</span>';
        const occ = on && !rented ? `<select onchange="ofOcc(${u.unit_id}, this.value)" class="inp" style="width:auto;padding:2px 6px;font-size:11px"><option value="LET" ${OF_CHECK[u.unit_id] === 'LET' ? 'selected' : ''}>Let out</option><option value="OWNER_LIVES" ${OF_CHECK[u.unit_id] === 'OWNER_LIVES' ? 'selected' : ''}>Owner lives here</option></select>` : '';
        html += `<label class="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-[#182848] text-xs text-gray-200 cursor-pointer"><span class="flex items-center gap-2"><input type="checkbox" ${on ? 'checked' : ''} onchange="ofToggle(${u.unit_id}, this.checked)"> <span>${esc(u.unit_number)}</span> ${tag}${other}</span>${occ}</label>`;
    });
    if (all.length > LIMIT) html += `<div class="p-3 text-[11px] text-amber-300 border-t border-[#182848]">${LIMIT} / ${all.length} · ${sp('Too many to show. Pick a project or search to see the rest.')}</div>`;
    box.innerHTML = html || '<div class="text-xs text-gray-500 p-3">' + sp('No units to show.') + '</div>';
    box.scrollTop = top;
    document.getElementById('of-count').innerText = Object.keys(OF_CHECK).length;
}
function closeOwnerForm() { closeModal('modal-owner-form'); if (SO_SEL) { SO_SEL.value = ''; SO_SEL = null; } }
async function saveOwnerForm(e) {
    e.preventDefault();
    const id = document.getElementById('of-id').value;
    const body = { full_name: document.getElementById('of-name').value.trim(), phone_number: document.getElementById('of-phone').value.trim(), email: document.getElementById('of-email').value.trim() };
    if (!body.full_name) return;
    if (OF_UNITS.length) {
        body.units = Object.keys(OF_CHECK).map(k => ({ unit_id: Number(k), occupancy_type: OF_CHECK[k] }));
        const sv = parseMoney(document.getElementById('of-svc').value);
        if (sv > 0) { body.service_charge = sv; body.service_currency = document.getElementById('of-cur').value; }
    }
    const r = id ? await api('/api/owners/' + id, 'PUT', body) : await api('/api/owners', 'POST', body);
    if (!r.ok) return alert(r.data.error || 'Failed');
    if (r.data.warning) alert(r.data.message);
    await loadOwners();
    if (SO_SEL) { SO_SEL.value = (r.data && r.data.owner_id) || (ownersData.find(o => o.full_name === body.full_name) || {}).owner_id || ''; SO_SEL = null; }
    closeModal('modal-owner-form');
    if (currentPage === 'svcowners') loadSvcOwners();
    if (currentPage === 'properties' && typeof loadProperties === 'function') loadProperties();
}
async function removeOwner(id) {
    if (!confirm('Delete this owner?')) return;
    const r = await api('/api/owners/' + id, 'DELETE');
    if (!r.ok) return alert(r.data.error || 'Failed');
    closeModal('modal-owner-detail'); SO_OPEN = null;
    await loadOwners(); loadSvcOwners();
}
function initSvcYear() {
    const sel = document.getElementById('so-year'); if (sel.options.length) return;
    const y = new Date().getFullYear();
    for (let i = y; i >= y - 3; i--) sel.insertAdjacentHTML('beforeend', `<option value="${i}">${i}</option>`);
}
const SO_STATE = { TENANT: ['Rented', 'text-emerald-300 bg-emerald-900/30'], VACANT: ['Vacant', 'text-amber-300 bg-amber-900/30'], OWNER_LIVES: ['Owner lives here', 'text-blue-300 bg-blue-900/30'] };
let SO_GROUPS = [], SO_TAB = 'owners', SO_FILTER = 'all', SO_OPEN = null;
const sp = (t) => `<span>${t}</span>`;
function soCur(totals, key) {
    const out = ['TZS', 'USD'].filter(c => totals[c] && totals[c][key] > 0.001).map(c => money(totals[c][key], c));
    return out.length ? out.join(' + ') : money(0, 'TZS');
}
function soTile(label, value, cls, sub) {
    return `<div class="p-3 rounded-xl bg-[#0d172d] border border-[#182848]"><div class="text-[10px] uppercase text-gray-500">${sp(label)}</div><div class="text-sm font-black ${cls || 'text-white'} mt-0.5">${value}</div>${sub ? `<div class="text-[10px] text-gray-500 mt-0.5">${sub}</div>` : ''}</div>`;
}
function soChips(c) {
    return `<span class="px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-300">${c.let || 0} ${sp('rented')}</span><span class="px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-300">${c.vacant || 0} ${sp('vacant')}</span><span class="px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-300">${c.lives || 0} ${sp('lives')}</span>`;
}
function soTab(t) { SO_TAB = t; SO_FILTER = 'all'; const q = document.getElementById('so-q'); if (q) q.value = ''; soPaint(); }
function soFilter(f) { SO_FILTER = f; soPaint(); }
function soGroupName(g) { return g.owner_id ? g.owner_name : companyLabel(); }
function soUnitStatus(u, g) {
    if (u.state === 'VACANT') return [g.owner_id ? '<span class="text-gray-400">' + sp('Not recorded') + '</span>' : '<span class="text-gray-400">' + sp('Company cost (info)') + '</span>', 'none'];
    if (u.inclusive) return ['<span class="text-gray-400">' + sp('Included in rent') + '</span>', 'none'];
    if (u.state === 'OWNER_LIVES' && !(u.charges || []).length) return ['<span class="text-amber-300">' + sp('Not billed yet') + '</span>', 'owing'];
    if (u.owed > 0.001) {
        let h = `<span class="text-rose-300">${sp('Owes')} ${money(u.owed, u.invoice_currency || u.currency)}</span>`;
        if (u.state === 'OWNER_LIVES') h += ` <button onclick="event.stopPropagation(); openOwnerPay(${u.unit_id})" class="can-money ml-1 px-2 py-0.5 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-bold">${sp('Receive')}</button>`;
        return [h, 'owing'];
    }
    if (u.invoiced > 0.001) return ['<span class="text-emerald-300">' + sp('Paid') + '</span>', 'paid'];
    return ['<span class="text-gray-400">' + sp('Up to date') + '</span>', 'paid'];
}
function soUnitRows(g) {
    return g.units.map(u => {
        const st = SO_STATE[u.state] || SO_STATE.VACANT; SO_UNITS[u.unit_id] = u;
        const who = u.state === 'TENANT' && u.tenant_name ? ` · ${esc(u.tenant_name)}` : '';
        return `<tr onclick="soUnit(${u.unit_id})" class="border-t border-[#182848] cursor-pointer hover:bg-white/5"><td class="py-1.5 pr-2 text-white">${esc(u.property_name)} · ${esc(u.unit_number)}<span class="text-gray-500">${who}</span></td><td class="py-1.5 pr-2 whitespace-nowrap">${money(u.service_charge, u.currency)}</td><td class="py-1.5 pr-2"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${st[1]}">${sp(st[0])}</span></td><td class="py-1.5 text-right whitespace-nowrap">${soUnitStatus(u, g)[0]}</td></tr>`;
    }).join('');
}
function soPaint() {
    const box = document.getElementById('so-list'), sum = document.getElementById('so-summary'), bar = document.getElementById('so-bar');
    if (!box) return;
    document.querySelectorAll('.so-tab').forEach(b => { const on = b.dataset.t === SO_TAB; b.className = 'so-tab border px-4 py-2 rounded-xl text-xs font-bold ' + (on ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-[#14223d] text-gray-300 border-[#233863]'); });
    const q = ((document.getElementById('so-q') || {}).value || '').trim().toLowerCase();
    const owners = SO_GROUPS.filter(g => g.owner_id), comp = SO_GROUPS.find(g => !g.owner_id) || { units: [], totals: {}, counts: {} };
    const emptyMsg = (t) => `<div class="text-xs text-gray-500 p-4">${sp(t)}</div>`;
    if (SO_TAB === 'owners') {
        const unitsOwners = owners.reduce((n, g) => n + g.units.length, 0);
        const owedAll = {}; owners.forEach(g => ['TZS', 'USD'].forEach(c => { if (g.totals[c]) { owedAll[c] = owedAll[c] || { owed: 0 }; owedAll[c].owed += g.totals[c].owed; } }));
        sum.innerHTML = soTile('Owners', owners.length) + soTile('Units sold to owners', unitsOwners) + soTile('Company units', comp.units.length) + soTile('Owed by owners', soCur(owedAll, 'owed'), 'text-rose-400');
        bar.innerHTML = `<input id="so-q" oninput="soPaint()" value="${esc(q)}" class="inp" placeholder="Search owner or phone...">`;
        const list = owners.filter(g => !q || (g.owner_name || '').toLowerCase().includes(q) || (g.owner_phone || '').toLowerCase().includes(q));
        const left = list.length ? list.map(g => `<button onclick="soDetail('${g.owner_id}')" class="w-full text-left bg-[#0d172d] border border-[#182848] hover:border-indigo-500/50 rounded-2xl p-3 flex flex-wrap items-center justify-between gap-2">
            <div><div class="text-sm font-black text-white">${esc(g.owner_name)}</div><div class="text-[11px] text-gray-500">${esc(g.owner_phone || '')}</div></div>
            <div class="flex flex-wrap items-center gap-1.5 text-[10px] font-bold"><span class="px-2 py-0.5 rounded-full bg-indigo-900/40 text-indigo-300">${g.units.length} ${sp('units')}</span>${soChips(g.counts)}</div>
            <div class="text-right"><div class="text-[10px] uppercase text-gray-500">${sp('Owes')}</div><div class="text-xs font-black ${soCur(g.totals, 'owed') !== money(0, 'TZS') ? 'text-rose-400' : 'text-gray-300'}">${soCur(g.totals, 'owed')}</div></div></button>`).join('') : emptyMsg(owners.length ? 'No owner matches your search.' : 'No owners yet. Tap "Add owner" to start.');
        box.innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-3 gap-4"><div class="lg:col-span-2 space-y-2">${left}</div>
            <div class="bg-[#0d172d] border border-[#182848] rounded-2xl p-4 space-y-3 h-fit"><div><div class="text-[10px] uppercase text-gray-500">${sp('Company units')}</div><div class="text-sm font-black text-white">${esc(companyLabel())}</div><div class="text-[11px] text-gray-500">${sp('Developer units not sold.')}</div></div>
            <div class="text-2xl font-black text-white">${comp.units.length} <span class="text-xs font-bold text-gray-500">${sp('units')}</span></div>
            <div class="flex flex-wrap gap-1.5 text-[10px] font-bold">${soChips(comp.counts || {})}</div>
            <button onclick="soDetail('COMPANY')" class="w-full bg-[#14223d] border border-[#233863] text-gray-200 text-xs font-bold py-2 rounded-xl">${sp('View units')}</button></div></div>`;
    } else {
        const all = []; SO_GROUPS.forEach(g => g.units.forEach(u => { const st = soUnitStatus(u, g); all.push({ g, u, st }); }));
        const tot = {}; SO_GROUPS.forEach(g => ['TZS', 'USD'].forEach(c => { if (g.totals[c]) { tot[c] = tot[c] || { invoiced: 0, paid: 0, owed: 0 }; ['invoiced', 'paid', 'owed'].forEach(k => tot[c][k] += g.totals[c][k]); } }));
        const nOwing = all.filter(x => x.st[1] === 'owing').length, nPaid = all.filter(x => x.st[1] === 'paid').length;
        sum.innerHTML = soTile('Invoiced', soCur(tot, 'invoiced')) + soTile('Collected', soCur(tot, 'paid'), 'text-emerald-400') + soTile('Owed', soCur(tot, 'owed'), 'text-rose-400') + soTile('Units paid', nPaid, 'text-emerald-400', `${nOwing} <span>owing</span>`);
        const chip = (f, l) => `<button onclick="soFilter('${f}')" class="px-3 py-1.5 rounded-full text-[11px] font-bold border ${SO_FILTER === f ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-[#14223d] text-gray-300 border-[#233863]'}">${sp(l)}</button>`;
        bar.innerHTML = `<div class="flex flex-wrap items-center gap-2"><input id="so-q" oninput="soPaint()" value="${esc(q)}" class="inp" style="max-width:260px" placeholder="Search unit or owner...">${chip('all', 'All')}${chip('owing', 'Owing')}${chip('paid', 'Paid')}</div>`;
        const rows = all.filter(x => (SO_FILTER === 'all' || x.st[1] === SO_FILTER) && (!q || (x.u.property_name + ' ' + x.u.unit_number + ' ' + soGroupName(x.g) + ' ' + (x.u.tenant_name || '')).toLowerCase().includes(q)));
        box.innerHTML = rows.length ? `<div class="bg-[#0d172d] border border-[#182848] rounded-2xl p-4 overflow-x-auto"><table class="w-full text-[11px] text-gray-300"><thead><tr class="text-gray-500 text-left"><th class="pb-1">${sp('Unit')}</th><th class="pb-1">${sp('Owner')}</th><th class="pb-1">${sp('Service charge')}</th><th class="pb-1">${sp('Collected')}</th><th class="pb-1 text-right">${sp('Status')}</th></tr></thead><tbody>` +
            rows.map(({ g, u, st }) => { SO_UNITS[u.unit_id] = u; const cc = u.state === 'OWNER_LIVES' ? u.invoice_currency : (u.invoice_currency || u.currency);
                return `<tr onclick="soUnit(${u.unit_id})" class="border-t border-[#182848] cursor-pointer hover:bg-white/5"><td class="py-1.5 pr-2 text-white">${esc(u.property_name)} · ${esc(u.unit_number)}</td><td class="py-1.5 pr-2">${esc(soGroupName(g))}</td><td class="py-1.5 pr-2 whitespace-nowrap">${money(u.service_charge, u.currency)}</td><td class="py-1.5 pr-2 whitespace-nowrap">${money(u.paid, cc)}</td><td class="py-1.5 text-right whitespace-nowrap">${st[0]}</td></tr>`; }).join('') + '</tbody></table></div>' : emptyMsg('No units to show.');
    }
    applyRoleUI();
}
function soDetail(id) {
    SO_OPEN = id; const g = SO_GROUPS.find(x => id === 'COMPANY' ? !x.owner_id : String(x.owner_id) === String(id));
    if (!g) { closeModal('modal-owner-detail'); return; }
    document.getElementById('od-name').innerText = soGroupName(g);
    document.getElementById('od-phone').innerHTML = g.owner_id ? esc(g.owner_phone || '') : sp('Developer / company');
    document.getElementById('od-actions').innerHTML = g.owner_id ? `<button onclick="openOwnerForm(${g.owner_id})" class="can-manage text-indigo-300 px-2"><i class="fa-solid fa-pen"></i></button><button onclick="removeOwner(${g.owner_id})" class="can-manage text-rose-400 px-2"><i class="fa-solid fa-trash"></i></button>` : '';
    document.getElementById('od-tiles').innerHTML = soTile('Units', g.units.length, '', `<span class="flex flex-wrap gap-1 mt-1 font-bold">${soChips(g.counts)}</span>`) + soTile('Invoiced', soCur(g.totals, 'invoiced')) + soTile('Collected', soCur(g.totals, 'paid'), 'text-emerald-400') + soTile('Owed', soCur(g.totals, 'owed'), 'text-rose-400');
    document.getElementById('od-units').innerHTML = g.units.length ? soUnitRows(g) : `<tr><td class="py-3 text-gray-500">${sp('No units yet.')}</td></tr>`;
    openModal('modal-owner-detail'); applyRoleUI();
}
async function loadSvcOwners() {
    if (!orgOn()) return;
    initSvcYear();
    await loadOwners();
    const yr = document.getElementById('so-year').value || new Date().getFullYear();
    const box = document.getElementById('so-list');
    const r = await api('/api/service-owners?year=' + yr);
    if (!r.ok) { box.innerHTML = `<div class="text-xs text-rose-300">${esc(r.data.error || 'Failed')}</div>`; return; }
    SO_GROUPS = (r.data.owners || []).slice();
    ownersData.forEach(o => { if (!SO_GROUPS.some(g => String(g.owner_id) === String(o.owner_id))) SO_GROUPS.push({ owner_id: o.owner_id, owner_name: o.full_name, owner_phone: o.phone_number, units: [], totals: {}, counts: { let: 0, vacant: 0, lives: 0 } }); });
    SO_GROUPS.sort((a, b) => (a.owner_name || '').localeCompare(b.owner_name || ''));
    soPaint();
    if (SO_OPEN && document.getElementById('modal-owner-detail').style.display === 'flex') soDetail(SO_OPEN);
}

let SO_UNIT_OPEN = null;
function soUnit(unitId) {
    const u = SO_UNITS[unitId]; if (!u) return;
    SO_UNIT_OPEN = unitId;
    const g = SO_GROUPS.find(x => x.units.some(y => y.unit_id === unitId)) || {};
    const yr = document.getElementById('so-year').value;
    const cur = u.state === 'OWNER_LIVES' ? u.currency : (u.invoice_currency || u.currency);
    document.getElementById('su-title').innerText = `${u.property_name} · ${u.unit_number}`;
    const st = SO_STATE[u.state] || SO_STATE.VACANT;
    document.getElementById('su-sub').innerHTML = `<span>Owner</span>: ${esc(soGroupName(g))} · <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${st[1]}">${sp(st[0])}</span>${u.tenant_name ? ' · ' + esc(u.tenant_name) : ''}`;
    document.getElementById('su-tiles').innerHTML = soTile('Service charge', money(u.service_charge, u.currency) + ' <span class="text-[10px] text-gray-500">/ ' + sp('month') + '</span>') + soTile('Invoiced', money(u.invoiced, cur)) + soTile('Collected', money(u.paid, cur), 'text-emerald-400') + soTile('Owed', money(u.owed, cur), u.owed > 0.001 ? 'text-rose-400' : 'text-gray-300');
    let rows = '';
    if (u.state === 'OWNER_LIVES') {
        rows = (u.charges || []).map(c => { const left = c.amount - c.paid; return `<tr class="border-t border-[#182848]"><td class="py-1.5">${esc(c.period)}</td><td>${money(c.amount, u.currency)}</td><td class="text-emerald-300">${money(c.paid, u.currency)}</td><td class="${left > 0.001 ? 'text-rose-300' : 'text-gray-400'}">${money(left, u.currency)}</td><td class="text-right">${left > 0.001 ? `<button onclick="openOwnerPay(${u.unit_id})" class="can-money px-2 py-0.5 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-bold">${sp('Receive')}</button>` : '<span class="text-emerald-300">' + sp('Paid') + '</span>'}</td></tr>`; }).join('');
    } else {
        const inv = (currentInvoices || []).filter(i => i.unit_id === unitId && i.invoice_type === 'SERVICE' && String(i.issue_date || i.due_date || '').slice(0, 4) === String(yr));
        rows = inv.map(i => { const left = Number(i.balance) || 0; return `<tr class="border-t border-[#182848]"><td class="py-1.5">${esc(i.invoice_number)}<div class="text-[10px] text-gray-500">${esc(String(i.due_date || '').slice(0, 10))}</div></td><td>${money(i.amount_due, i.currency)}</td><td class="text-emerald-300">${money(i.paid, i.currency)}</td><td class="${left > 0.001 ? 'text-rose-300' : 'text-gray-400'}">${money(left, i.currency)}</td><td class="text-right">${left > 0.001 ? `<button onclick="closeModal('modal-so-unit'); openPaymentModal(${i.invoice_id})" class="can-money px-2 py-0.5 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-bold">${sp('Receive')}</button>` : '<span class="text-emerald-300">' + sp('Paid') + '</span>'}</td></tr>`; }).join('');
    }
    document.getElementById('su-rows').innerHTML = rows || `<tr><td colspan="5" class="py-4 text-gray-500">${sp('No service charge bills for this unit in this year.')}</td></tr>`;
    openModal('modal-so-unit'); applyRoleUI();
}
