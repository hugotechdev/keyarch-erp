// ============================================================
// MAINTENANCE TICKETS
// ============================================================
let ticketsData = [], techList = [], unitsAll = [];
const PRIO_CLS = { LOW: 'bg-gray-800 text-gray-300 border-gray-600/40', MEDIUM: 'bg-blue-900/40 text-blue-300 border-blue-500/30', HIGH: 'bg-orange-900/40 text-orange-300 border-orange-500/30', URGENT: 'bg-red-900/40 text-red-300 border-red-500/30' };
const TSTAT_CLS = { OPEN: 'bg-amber-900/40 text-amber-300 border-amber-500/30', IN_PROGRESS: 'bg-blue-900/40 text-blue-300 border-blue-500/30', RESOLVED: 'bg-emerald-900/40 text-emerald-300 border-emerald-500/30', CANCELLED: 'bg-gray-800 text-gray-400 border-gray-600/40' };
async function loadTickets() {
    if (!hasFeature('tickets')) return;
    const r = await api('/api/tickets');
    if (!r.ok) return;
    ticketsData = r.data; renderTickets();
}
const WORKLOAD_LIMIT = 3, STALE_DAYS = 7;            // a worker with 3+ unfinished jobs, or a job older than 7 days, is flagged
let tktStatus = 'ACTIVE', pendingTechFilter = null;
function daysSince(d) { const t = new Date(d); return isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t.getTime()) / 86400000)); }
function setTktStatus(s) { tktStatus = (tktStatus === s && s !== 'ALL') ? 'ACTIVE' : s; renderTickets(); }
function clearTktFilters() { tktStatus = 'ACTIVE'; ['tkt-search', 'tkt-prop-f', 'tkt-tech-f'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; }); renderTickets(); }
function openTechTickets(id) { pendingTechFilter = String(id); tktStatus = 'ACTIVE'; showPage('maintenance'); if (ticketsData.length) renderTickets(); }
function openMaintReport() { showPage('reports'); setTimeout(async () => { await initReports(); document.getElementById('rp-preset').value = '5'; applyPreset(); pickReport('maintenance'); runReport(); }, 50); }
function fillTktFilters() {
    const pSel = document.getElementById('tkt-prop-f'), tSel = document.getElementById('tkt-tech-f'); if (!pSel || !tSel) return;
    const pv = pSel.value, tv = tSel.value;
    const props = [...new Map(ticketsData.filter(t => t.property_id).map(t => [String(t.property_id), t.property_name || 'Property'])).entries()];
    const techs = [...new Map(ticketsData.filter(t => t.assigned_technician_id).map(t => [String(t.assigned_technician_id), t.technician_name || 'Worker'])).entries()];
    pSel.innerHTML = '<option value="">All houses / apartments</option>' + props.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    tSel.innerHTML = '<option value="">All workers</option><option value="none">Not assigned</option>' + techs.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    pSel.value = props.some(x => x[0] === pv) ? pv : '';
    tSel.value = (tv === 'none' || techs.some(x => x[0] === tv)) ? tv : '';
    tSel.style.display = canManage() ? '' : 'none';
}
function renderWorkload() {
    const box = document.getElementById('tkt-workload'); if (!box) return;
    if (!canManage()) { box.classList.add('hidden'); return; }
    const by = {};
    ticketsData.filter(t => t.assigned_technician_id).forEach(t => {
        const k = String(t.assigned_technician_id); const w = by[k] || (by[k] = { id: k, name: t.technician_name || 'Worker', open: 0, oldest: 0, done: 0 });
        if (['OPEN', 'IN_PROGRESS'].includes(t.status)) { w.open++; w.oldest = Math.max(w.oldest, daysSince(t.created_at)); } else if (t.status === 'RESOLVED') w.done++;
    });
    const list = Object.values(by).sort((a, b) => b.open - a.open);
    if (!list.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `<div class="text-[11px] font-bold text-gray-400 uppercase tracking-wider"><i class="fa-solid fa-user-gear"></i> Workers: unfinished jobs</div>
        <div class="flex flex-wrap gap-2">${list.map(w => {
            const warn = w.open >= WORKLOAD_LIMIT || w.oldest >= STALE_DAYS;
            return `<button type="button" onclick="document.getElementById('tkt-tech-f').value='${esc(w.id)}'; tktStatus='ACTIVE'; renderTickets()" class="px-3 py-2 rounded-xl border text-xs text-left ${warn ? 'bg-red-600/15 border-red-500/50 text-red-300' : 'bg-[#14223d] border-[#233863] text-gray-300'}">
                <div class="font-bold">${warn ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ''}${esc(w.name)}</div>
                <div class="text-[10px] opacity-80">${w.open} unfinished${w.open ? ` · oldest ${w.oldest} day(s)` : ''} · ${w.done} resolved</div></button>`;
        }).join('')}</div>`;
}
function renderTickets() {
    const tb = document.getElementById('table-tickets-body'); if (!tb) return;
    fillTktFilters();
    if (pendingTechFilter) { document.getElementById('tkt-tech-f').value = pendingTechFilter; pendingTechFilter = null; }
    const n = s => ticketsData.filter(t => t.status === s).length;
    setText('tk-n-ALL', ticketsData.length); setText('tk-n-OPEN', n('OPEN')); setText('tk-n-IN_PROGRESS', n('IN_PROGRESS')); setText('tk-n-RESOLVED', n('RESOLVED'));
    document.querySelectorAll('.tk-kpi').forEach(b => b.classList.toggle('ka-kpi-on', b.dataset.tk === tktStatus));
    const q = (document.getElementById('tkt-search').value || '').trim().toLowerCase();
    const pf = document.getElementById('tkt-prop-f').value, tf = document.getElementById('tkt-tech-f').value;
    const rows = ticketsData.filter(t => {
        if (tktStatus === 'ACTIVE' ? !['OPEN', 'IN_PROGRESS'].includes(t.status) : (tktStatus !== 'ALL' && t.status !== tktStatus)) return false;
        if (pf && String(t.property_id) !== pf) return false;
        if (tf === 'none' ? t.assigned_technician_id : (tf && String(t.assigned_technician_id) !== tf)) return false;
        if (q && ![t.title, t.description, t.property_name, t.unit_number, t.technician_name, t.notes, t.priority].some(v => String(v || '').toLowerCase().includes(q))) return false;
        return true;
    });
    const names = { ACTIVE: 'Showing unfinished tickets (open and in progress)', ALL: 'Showing all tickets', OPEN: 'Showing open tickets', IN_PROGRESS: 'Showing tickets in progress', RESOLVED: 'Showing resolved tickets' };
    setText('tkt-showing', `${names[tktStatus]} · ${rows.length} found`);
    renderWorkload();
    tb.innerHTML = rows.length === 0 ? '<tr><td colspan="7" class="p-4 text-center text-gray-500">No tickets here.</td></tr>' : rows.map(t => {
        const unfinished = ['OPEN', 'IN_PROGRESS'].includes(t.status), age = daysSince(t.created_at);
        return `<tr class="hover:bg-[#14223d]/50"><td class="p-3 font-bold text-white">${esc(t.title)}<div class="text-[10px] text-gray-500 font-normal">${fmtDate(t.created_at)}${unfinished ? ` · <span class="${age >= STALE_DAYS ? 'text-red-400 font-bold' : ''}">${age} day(s) open</span>` : (t.resolved_at ? ' · resolved ' + fmtDate(t.resolved_at) : '')}${t.description ? ' · ' + esc(String(t.description).slice(0, 60)) : ''}</div></td>
            <td class="p-3">${esc(t.property_name || '-')}${t.unit_number ? ` <span class="text-gray-400">(${esc(t.unit_number)})</span>` : ''}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] border ${PRIO_CLS[t.priority] || ''}">${esc(t.priority)}</span></td>
            <td class="p-3 text-gray-400">${esc(t.technician_name || 'Unassigned')}</td>
            <td class="p-3 whitespace-nowrap">${Number(t.actual_cost) > 0 ? money(t.actual_cost) : (Number(t.estimated_cost) > 0 ? '~' + money(t.estimated_cost) : '-')}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] border ${TSTAT_CLS[t.status] || ''}">${esc(String(t.status).replace('_', ' '))}</span></td>
            <td class="p-3 whitespace-nowrap"><button onclick="openTicketModal(${Number(t.ticket_id)})" class="px-2.5 py-1 bg-amber-600/30 text-amber-300 border border-amber-500/50 rounded font-bold hover:bg-amber-600 hover:text-white">${isTech() ? 'Update' : 'Open'}</button>
            ${isAdminRole() ? ` <button onclick="deleteTicket(${Number(t.ticket_id)})" class="w-7 h-7 rounded-lg bg-red-600/20 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : ''}</td></tr>`;
    }).join('');
}
async function openTicketModal(id) {
    if (!requireFeature('tickets')) return;
    const t = id ? ticketsData.find(x => Number(x.ticket_id) === Number(id)) : null;
    if (canManage() || isTech()) { const r = await api('/api/workers'); techList = r.ok ? r.data : []; }
    const ur = await api('/api/units'); unitsAll = ur.ok ? ur.data : [];
    document.getElementById('tkt-prop').innerHTML = propOptions();
    document.getElementById('tkt-tech').innerHTML = '<option value="">Unassigned</option>' + techList.map(x => `<option value="${esc(x.worker_id)}">${esc(x.full_name)}</option>`).join('');
    document.getElementById('tkt-id').value = t ? t.ticket_id : '';
    document.getElementById('tk-title').innerText = t ? 'Ticket' : 'New Ticket';
    document.getElementById('tkt-prop').value = t ? t.property_id : (propertiesData[0] ? propertiesData[0].property_id : '');
    fillTicketUnits(); document.getElementById('tkt-unit-id').value = t && t.unit_id ? t.unit_id : '';
    document.getElementById('tkt-title').value = t ? t.title : ''; document.getElementById('tkt-desc').value = t ? (t.description || '') : '';
    document.getElementById('tkt-priority').value = t ? t.priority : 'MEDIUM'; document.getElementById('tkt-tech').value = t && t.assigned_technician_id ? t.assigned_technician_id : '';
    document.getElementById('tkt-est').value = t ? formatMoney(t.estimated_cost) : '';
    document.getElementById('tk-edit').classList.toggle('hidden', !t);
    if (t) {
        document.getElementById('tkt-status').value = t.status; document.getElementById('tkt-actual').value = formatMoney(t.actual_cost); document.getElementById('tkt-notes').value = t.notes || ''; document.getElementById('tkt-addexp').checked = false;
    }
    const tech = false;   // the Maintenance Manager edits every field of a ticket
    ['tk-where', 'tk-text', 'tk-est'].forEach(i => { const el = document.getElementById(i); el.style.display = (tech && t) ? 'none' : ''; });
    document.getElementById('tk-tech').style.display = (canManage() || isTech()) ? '' : 'none';
    document.getElementById('tkt-priority').parentElement.style.display = (tech && t) ? 'none' : '';
    document.getElementById('tk-addexp-wrap').style.display = canManage() ? '' : 'none';
    openModal('modal-ticket');
}
function fillTicketUnits() {
    const pid = document.getElementById('tkt-prop').value;
    document.getElementById('tkt-unit-id').innerHTML = '<option value="">— Whole property / common area —</option>' + unitsAll.filter(u => String(u.property_id) === String(pid)).map(u => `<option value="${esc(u.unit_id)}">${esc(u.unit_number)}</option>`).join('');
}
// ---------- workers (fundi): names only, no login ----------
async function openWorkers() { openModal('modal-workers'); await loadWorkers(); }
async function loadWorkers() {
    const r = await api('/api/workers?all=1'); const list = r.ok ? r.data : [];
    const box = document.getElementById('wk-list');
    box.innerHTML = list.length ? list.map(w => `<div class="flex items-center justify-between gap-2 bg-[#14223d] border border-[#233863] rounded-xl px-3 py-2 ${w.is_active ? '' : 'opacity-50'}">
        <div class="min-w-0"><div class="font-bold text-white text-sm truncate">${esc(w.full_name)}</div><div class="text-[11px] text-gray-400">${esc(w.phone_number || '')}${w.open_jobs ? ' · ' + Number(w.open_jobs) + ' open job(s)' : ''}${w.is_active ? '' : ' · switched off'}</div></div>
        <div class="flex gap-1 shrink-0"><button type="button" onclick="renameWorker(${Number(w.worker_id)})" class="px-2 py-1 rounded-lg bg-[#1e2f52] text-gray-200 text-[11px] font-bold">Edit</button>
        <button type="button" onclick="removeWorker(${Number(w.worker_id)})" class="px-2 py-1 rounded-lg bg-red-600/30 text-red-300 text-[11px] font-bold">Remove</button></div></div>`).join('')
        : '<div class="text-center text-xs text-gray-400 py-3">No workers yet. Add the first one above.</div>';
    workersCache = list;
}
let workersCache = [];
async function addWorker() {
    const name = document.getElementById('wk-name').value.trim();
    if (!name) return alert('Please type the worker name.');
    const r = await api('/api/workers', 'POST', { full_name: name, phone_number: document.getElementById('wk-phone').value });
    if (!r.ok) return alert(r.data.error || 'Failed');
    document.getElementById('wk-name').value = ''; document.getElementById('wk-phone').value = '';
    await loadWorkers(); await refreshWorkerSelect(r.data.worker_id);
}
async function renameWorker(id) {
    const w = workersCache.find(x => Number(x.worker_id) === Number(id)); if (!w) return;
    const name = prompt('Worker name', w.full_name); if (name === null) return;
    const phone = prompt('Phone (optional)', w.phone_number || ''); if (phone === null) return;
    const r = await api('/api/workers/' + id, 'PUT', { full_name: name, phone_number: phone, is_active: true });
    if (!r.ok) return alert(r.data.error || 'Failed');
    await loadWorkers(); await refreshWorkerSelect(); loadTickets();
}
async function removeWorker(id) {
    if (!confirm('Remove this worker?')) return;
    const r = await api('/api/workers/' + id, 'DELETE');
    if (!r.ok) return alert(r.data.error || 'Failed');
    if (r.data.deactivated) alert(r.data.message);
    await loadWorkers(); await refreshWorkerSelect();
}
async function refreshWorkerSelect(select) {
    const sel = document.getElementById('tkt-tech'); const keep = select || sel.value;
    const r = await api('/api/workers'); techList = r.ok ? r.data : [];
    sel.innerHTML = '<option value="">Unassigned</option>' + techList.map(x => `<option value="${esc(x.worker_id)}">${esc(x.full_name)}</option>`).join('');
    sel.value = keep || '';
}
async function saveTicket(e) {
    e.preventDefault();
    const id = document.getElementById('tkt-id').value;
    const body = { title: document.getElementById('tkt-title').value, description: document.getElementById('tkt-desc').value, priority: document.getElementById('tkt-priority').value,
        property_id: document.getElementById('tkt-prop').value || undefined, unit_id: document.getElementById('tkt-unit-id').value || undefined,
        assigned_technician_id: document.getElementById('tkt-tech').value || null, estimated_cost: parseMoney(document.getElementById('tkt-est').value) };
    if (id) { Object.assign(body, { status: document.getElementById('tkt-status').value, actual_cost: parseMoney(document.getElementById('tkt-actual').value), notes: document.getElementById('tkt-notes').value, add_to_expenses: document.getElementById('tkt-addexp').checked }); }
    else if (!String(body.title).trim()) return alert('Please type the problem.');
    const r = await api(id ? `/api/tickets/${id}` : '/api/tickets', id ? 'PUT' : 'POST', body);
    if (r.ok) { closeModal('modal-ticket'); loadTickets(); loadOverview(); if (r.data.expense_added) loadExpenses(); } else alert(r.data.error || 'Failed');
}
async function deleteTicket(id) {
    if (!confirm('Delete this ticket?')) return;
    const r = await api(`/api/tickets/${id}`, 'DELETE');
    if (r.ok) loadTickets(); else alert(r.data.error || 'Failed');
}
