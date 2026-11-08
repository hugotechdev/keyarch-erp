// ============================================================
// REPORTS
// ============================================================
let reportTypes = [], lastReport = null, companyProfile = null;
async function initReports() {
    if (!reportTypes.length) {
        const r = await api('/api/reports/types'); if (!r.ok) return;
        reportTypes = r.data;
        document.getElementById('rp-type').innerHTML = reportTypes.map(t => `<option value="${t.key}">${esc(REPORT_NAMES[t.key] || t.label)}${t.locked ? '  (PRO)' : ''}</option>`).join('');
        buildReportChips();
    }
    document.getElementById('rp-prop').innerHTML = propOptions(isScoped() ? '' : 'All properties');
    await loadProfile();
    buildPresets(); onReportType();
    const f = document.getElementById('rp-from'); if (!f.value) applyPreset();
}
const REPORT_NAMES = { summary: 'Income & expenses', outstanding: 'Debts (unpaid)', service: 'Service charge', maintenance: 'Maintenance', property_income: 'Property income', profit: 'Profit by property' };
const REPORT_CHIPS = [['service', 'fa-hand-holding-dollar', 'Service charge'], ['outstanding', 'fa-file-circle-exclamation', 'Debts'], ['maintenance', 'fa-screwdriver-wrench', 'Maintenance'], ['property_income', 'fa-building', 'Property income'], ['summary', 'fa-scale-balanced', 'Income & expenses']];
function buildReportChips() {
    const box = document.getElementById('rp-chips'); if (!box) return;
    box.innerHTML = REPORT_CHIPS.filter(c => reportTypes.some(t => t.key === c[0])).map(c => {
        const locked = (reportTypes.find(t => t.key === c[0]) || {}).locked;
        return `<button type="button" data-rp="${c[0]}" onclick="pickReport('${c[0]}')" class="rp-chip"><span class="rp-ico"><i class="fa-solid ${c[1]}"></i></span><span class="rp-txt">${c[2]}</span>${locked ? '<span class="rp-pro">PRO</span>' : ''}</button>`;
    }).join('');
}
function pickReport(key) {
    const sel = document.getElementById('rp-type'); if (!sel) return;
    sel.value = key; onReportType();
}
function onReportType() {
    const cur = document.getElementById('rp-type').value;
    document.querySelectorAll('.rp-chip').forEach(b => b.classList.toggle('rp-on', b.dataset.rp === cur));
    const t = reportTypes.find(x => x.key === cur);
    document.getElementById('rp-desc').innerHTML = t ? esc(t.description || '') + (t.locked ? ' <span>— Pro plan only.</span>' : '') : '';
}
function fyStartMonth() { return (companyProfile && Number(companyProfile.fy_start_month)) || 1; }
function fyRange(offset) {
    const now = new Date(), sm = fyStartMonth() - 1;
    let startYear = now.getMonth() >= sm ? now.getFullYear() : now.getFullYear() - 1;
    startYear += offset;
    const s = new Date(startYear, sm, 1), e = new Date(startYear + 1, sm, 0);
    return [toDateInput(s), toDateInput(e)];
}
function buildPresets() {
    const sel = document.getElementById('rp-preset'); if (sel.options.length) { fyLine(); return; }
    sel.innerHTML = ['This month', 'Last month', 'This quarter', 'This financial year', 'Last financial year', 'This calendar year', 'Last 30 days', 'Today', 'Custom dates']
        .map((l, i) => `<option value="${i}">${l}</option>`).join('');
    fyLine();
}
function fyLine() { const r = fyRange(0); document.getElementById('rp-fy').innerHTML = `<span>Your financial year:</span> ${esc(fmtDate(r[0]))} <span>to</span> ${esc(fmtDate(r[1]))} <span>(change it in Settings).</span>`; }
function applyPreset() {
    const i = Number(document.getElementById('rp-preset').value), now = new Date(), y = now.getFullYear(), m = now.getMonth();
    let a, b;
    if (i === 0) { a = new Date(y, m, 1); b = now; }
    else if (i === 1) { a = new Date(y, m - 1, 1); b = new Date(y, m, 0); }
    else if (i === 2) { const q = Math.floor(m / 3) * 3; a = new Date(y, q, 1); b = now; }
    else if (i === 3) { const r = fyRange(0); a = new Date(r[0] + 'T00:00:00'); b = new Date(Math.min(new Date(r[1] + 'T00:00:00'), now)); }
    else if (i === 4) { const r = fyRange(-1); a = new Date(r[0] + 'T00:00:00'); b = new Date(r[1] + 'T00:00:00'); }
    else if (i === 5) { a = new Date(y, 0, 1); b = now; }
    else if (i === 6) { b = now; a = new Date(); a.setDate(a.getDate() - 30); }
    else if (i === 7) { a = now; b = now; }
    else return;
    document.getElementById('rp-from').value = toDateInput(a); document.getElementById('rp-to').value = toDateInput(b);
}
function reportQuery() {
    const q = new URLSearchParams({ type: document.getElementById('rp-type').value, from: document.getElementById('rp-from').value, to: document.getElementById('rp-to').value });
    const p = document.getElementById('rp-prop').value; if (p) q.set('property_id', p);
    return q.toString();
}
function cellText(v, type) {
    if (v === null || v === undefined || v === '') return '';
    if (type === 'money') return fmtN(v); if (type === 'int') return fmtN(v);
    if (type === 'pct') return v + '%'; if (type === 'date') return fmtDate(v);
    return String(v);
}
async function runReport() {
    const box = document.getElementById('report-area');
    box.innerHTML = '<div class="text-xs text-gray-500">Loading...</div>';
    const r = await api('/api/reports/run?' + reportQuery());
    if (!r.ok) { box.innerHTML = `<div class="p-4 rounded-xl bg-red-900/30 border border-red-500/40 text-red-200 text-xs">${esc(r.data.error || 'Could not build the report.')}</div>`; return; }
    const d = lastReport = r.data;
    const num = c => c.type === 'money' || c.type === 'int' || c.type === 'pct';
    const total = (c, i) => i === 0 ? 'TOTAL' : (c.total ? cellText(d.rows.reduce((s, x) => s + (parseFloat(x[c.key]) || 0), 0), c.type) : '');
    box.innerHTML = `
        <div><div class="text-lg font-black text-white">${esc(d.title)}</div><div class="text-xs text-gray-400">${esc(d.company_name)} · ${String(d.period || '').split(' to ').map(esc).join(' <span>to</span> ')} · <span>${esc(d.property)}</span></div></div>
        ${d.summary && d.summary.length ? `<div class="grid grid-cols-2 md:grid-cols-4 gap-3">${d.summary.map(s => `<div class="p-3 rounded-xl border border-[#182848]"><div class="text-gray-400 uppercase text-[10px]">${esc(s.label)}</div><div class="text-base font-black text-white">${s.type === 'money' ? money(s.value) : (s.type === 'pct' ? s.value + '%' : esc(s.value))}</div></div>`).join('')}</div>` : ''}
        <div class="overflow-x-auto"><table class="w-full text-left text-xs text-gray-300">
            <thead class="uppercase font-bold text-gray-400 border-b border-[#182848]"><tr>${d.columns.map(c => `<th class="py-2 pr-3 ${num(c) ? 'text-right' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
            <tbody class="divide-y divide-[#182848]">${d.rows.length ? d.rows.slice(0, 500).map(row => `<tr>${d.columns.map(c => `<td class="py-2 pr-3 ${num(c) ? 'text-right' : ''}">${esc(cellText(row[c.key], c.type))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${d.columns.length}" class="py-6 text-center text-gray-500">No records for this period.</td></tr>`}
            ${d.rows.length && d.columns.some(c => c.total) ? `<tr class="font-black text-white border-t border-[#233863]">${d.columns.map((c, i) => `<td class="py-2 pr-3 ${num(c) ? 'text-right' : ''}">${esc(total(c, i))}</td>`).join('')}</tr>` : ''}</tbody></table></div>
        ${d.rows.length > 500 ? `<div class="text-[11px] text-gray-500">Showing the first 500 of ${d.rows.length} rows. Download Excel to see all.</div>` : ''}`;
}
function exportReport(fmt) {
    const d = document.getElementById('rp-from').value;
    downloadFile(`/api/reports/export?${reportQuery()}&format=${fmt}`, `${document.getElementById('rp-type').value}-${d}.${fmt}`);
}
