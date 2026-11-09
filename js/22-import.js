// IMPORT FROM EXCEL: download a template, upload a filled file, check it, then save
let IMP_FILE = null, IMP_CHECKED = false;
const IMP_CSS = 'w-full bg-[#14223d] border border-[#233863] rounded-xl px-3 py-2 text-xs text-white';

function openImport() {
    IMP_FILE = null; IMP_CHECKED = false;
    const f = document.getElementById('imp-file'); if (f) f.value = '';
    document.getElementById('imp-result').innerHTML = '';
    document.getElementById('imp-go').classList.add('hidden');
    document.getElementById('imp-check').classList.remove('hidden');
    openModal('modal-import');
}

async function impTemplate(type) {
    try {
        const res = await fetch('/api/import/template?type=' + type, { headers: { Authorization: 'Bearer ' + localStorage.getItem('keyarch_token') } });
        if (!res.ok) throw new Error('x');
        const blob = await res.blob(), a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'KEY-ARCH-template-' + (type === 'form' ? 'forms' : 'simple') + '.xlsx';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { alert('The template could not be downloaded. Please try again.'); }
}

function impPicked(inp) {
    IMP_FILE = inp.files && inp.files[0] ? inp.files[0] : null; IMP_CHECKED = false;
    document.getElementById('imp-result').innerHTML = '';
    document.getElementById('imp-go').classList.add('hidden');
    document.getElementById('imp-check').classList.remove('hidden');
}

function impEsc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function impRun(dry) {
    const box = document.getElementById('imp-result');
    if (!IMP_FILE) { box.innerHTML = '<div class="text-xs rounded-xl p-3 bg-red-900/30 border border-red-500/40 text-red-200"><span>Please choose an Excel file first.</span></div>'; return; }
    const q = new URLSearchParams({
        dry_run: dry ? '1' : '0',
        property_name: document.getElementById('imp-prop').value.trim(),
        property_type: document.getElementById('imp-ptype').value,
        amount_mode: document.getElementById('imp-mode').value,
        payment_method: 'Cash'
    });
    const btn = document.getElementById(dry ? 'imp-check' : 'imp-go'); btn.disabled = true;
    box.innerHTML = '<div class="text-xs text-gray-400 p-3"><span>Please wait...</span></div>';
    try {
        const buf = await IMP_FILE.arrayBuffer();
        const res = await fetch('/api/import/excel?' + q.toString(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('keyarch_token') }, body: buf });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { box.innerHTML = '<div class="text-xs rounded-xl p-3 bg-red-900/30 border border-red-500/40 text-red-200">' + impEsc(d.error || 'Import failed') + '</div>'; btn.disabled = false; return; }
        impShow(d, dry);
        if (dry) { IMP_CHECKED = true; document.getElementById('imp-go').classList.remove('hidden'); document.getElementById('imp-go').disabled = !(d.created.units || d.created.leases || d.created.expenses || d.created.properties); }
        else { document.getElementById('imp-go').classList.add('hidden'); document.getElementById('imp-check').classList.add('hidden'); if (typeof loadAllData === 'function') loadAllData(); }
    } catch (e) { box.innerHTML = '<div class="text-xs rounded-xl p-3 bg-red-900/30 border border-red-500/40 text-red-200"><span>No connection. Please try again.</span></div>'; }
    btn.disabled = false;
}

function impShow(d, dry) {
    const c = d.created, tot = c.properties + c.units + c.tenants + c.expenses;
    const chip = (n, label) => n ? '<div class="rounded-xl bg-[#14223d] border border-[#233863] p-2 text-center"><div class="text-lg font-black text-white">' + n + '</div><div class="text-[10px] text-gray-400">' + label + '</div></div>' : '';
    let h = '<div class="text-xs font-bold ' + (dry ? 'text-amber-300' : 'text-emerald-300') + ' mb-2">' + (dry ? '<span>Check result (nothing is saved yet)</span>' : '<span>Import done. Everything was saved.</span>') + '</div>';
    h += '<div class="grid grid-cols-3 gap-2 mb-3">' + chip(c.properties, '<span>Properties</span>') + chip(c.units, '<span>Units</span>') + chip(c.owners, '<span>Owners</span>') + chip(c.tenants, '<span>Tenants</span>') + chip(c.leases, '<span>Leases</span>') + chip(c.expenses, '<span>Expenses</span>') + '</div>';
    if (!tot) h += '<div class="text-xs rounded-xl p-3 bg-amber-900/30 border border-amber-500/40 text-amber-200 mb-2"><span>Nothing to import was found in this file.</span></div>';
    if (d.errors.length) {
        h += '<div class="text-xs font-bold text-red-300 mt-2 mb-1"><span>Rows with problems (these rows are skipped)</span> (' + d.errors.length + ')</div><div class="max-h-40 overflow-y-auto space-y-1">';
        d.errors.slice(0, 60).forEach(e => { h += '<div class="text-[11px] rounded-lg p-2 bg-red-900/20 border border-red-500/30 text-red-200">' + impEsc(e.sheet) + ' · #' + e.row + ': ' + impEsc(e.message) + '</div>'; });
        h += '</div>';
    }
    if (d.warnings.length) {
        h += '<div class="text-xs font-bold text-amber-300 mt-2 mb-1"><span>Notes</span> (' + d.warnings.length + ')</div><div class="max-h-28 overflow-y-auto space-y-1">';
        d.warnings.slice(0, 40).forEach(e => { h += '<div class="text-[11px] rounded-lg p-2 bg-amber-900/20 border border-amber-500/30 text-amber-200">' + impEsc(e.sheet) + ' · #' + e.row + ': ' + impEsc(e.message) + '</div>'; });
        h += '</div>';
    }
    if (d.ignored.length) h += '<div class="text-[11px] text-gray-400 mt-2"><span>Columns not used:</span> ' + d.ignored.map(impEsc).join(', ') + '</div>';
    if (dry && d.preview.length) {
        h += '<div class="text-xs font-bold text-gray-300 mt-3 mb-1"><span>First rows</span></div><div class="max-h-44 overflow-y-auto space-y-1">';
        d.preview.forEach(p => {
            const money = p.amount ? ' · ' + Number(p.amount).toLocaleString() + ' ' + (p.currency || '') : '';
            const more = p.period ? ' · ' + impEsc(p.period) + ' · ' + impEsc(p.start) + ' → ' + impEsc(p.end) : (p.date ? ' · ' + impEsc(p.date) : '');
            const owed = p.owed ? ' · <span class="text-red-300">' + Number(p.owed).toLocaleString() + '</span>' : '';
            h += '<div class="text-[11px] rounded-lg p-2 bg-[#14223d] border border-[#233863] text-gray-200"><b>' + impEsc(p.what) + '</b> ' + impEsc(p.text) + money + more + owed + '</div>';
        });
        h += '</div>';
    }
    document.getElementById('imp-result').innerHTML = h;
}
