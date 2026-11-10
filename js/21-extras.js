// ============================================================
// DASHBOARD EXTRAS (vacant, ending soon, money, chart, service)
// ============================================================
function renderDashExtras(d) {
    const m = d.money;
    setText('dash-expenses', m.expensesThisMonth === null ? '-' : money(m.expensesThisMonth));
    const pe = document.getElementById('dash-profit'); if (pe) { pe.innerText = m.profit === null ? '-' : money(m.profit); pe.className = 'text-lg font-black mt-1 ' + (m.profit !== null && m.profit < 0 ? 'text-rose-400' : 'text-emerald-400'); }
    const sv = d.service;
    document.getElementById('dash-service').innerHTML = !sv || sv.units + sv.inclusive === 0
        ? '<div class="p-3 text-center text-gray-500">No service charges set. Add one on a unit.</div>'
        : `<div class="grid grid-cols-3 gap-2 text-center"><div class="p-2 rounded-lg bg-[#14223d]"><div class="text-lg font-black text-emerald-400">${sv.paid}</div><div class="text-[10px] text-gray-500">paid</div></div>
            <div class="p-2 rounded-lg bg-[#14223d]"><div class="text-lg font-black text-rose-400">${sv.not_paid_total}</div><div class="text-[10px] text-gray-500">NOT paid</div></div>
            <div class="p-2 rounded-lg bg-[#14223d]"><div class="text-lg font-black text-sky-300">${sv.inclusive}</div><div class="text-[10px] text-gray-500">inclusive</div></div></div>
            <button onclick="showPage('invoices'); openServiceGen()" class="mt-2 w-full py-2 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40 font-bold text-[11px]">See who has not paid</button>`;
    const v = d.vacantList || [];
    setText('dash-vacant-count', `${d.totals.vacant} vacant`);
    document.getElementById('dash-vacant').innerHTML = v.length === 0 ? '<div class="p-3 text-center text-gray-500">No vacant units.</div>' :
        v.slice(0, 8).map(u => `<div class="flex justify-between p-2.5 rounded-lg bg-[#14223d]"><span class="text-white font-semibold">${esc(u.property_name)} <span class="text-gray-400">(${esc(u.unit_number)})</span></span><span class="text-emerald-400 font-bold">${money(u.rent_amount)}</span></div>`).join('') + (v.length > 8 ? `<button onclick="showPage('properties')" class="w-full text-center text-[11px] text-blue-300 py-1">See all in Properties</button>` : '');
    const ex = d.expiring || [];
    document.getElementById('dash-expiring').innerHTML = ex.length === 0 ? '<div class="p-3 text-center text-gray-500">No contracts ending within 30 days.</div>' :
        ex.slice(0, 8).map(x => { const dl = Number(x.days_left); return `<div class="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#14223d]"><div class="min-w-0"><div class="text-white font-semibold truncate">${esc(x.tenant_name)}</div><div class="text-[10px] text-gray-500 truncate">${esc(x.property_name)} (${esc(x.unit_number)}) · ${dl < 0 ? Math.abs(dl) + 'd ago' : (dl === 0 ? 'today' : 'in ' + dl + 'd')}</div></div>
            <div class="whitespace-nowrap">${contactBtns(x.tenant_phone, `Habari ${x.tenant_name}, mkataba wako unaisha ${fmtDate(x.end_date)}. Tafadhali tuwasiliane kuhusu kuhuisha. Asante.`, true)}</div></div>`; }).join('');
    drawChart(d.monthly || []);
}
// 6-month bars: collected (blue) vs expenses (orange). Palette slots 1 and 2, dark-surface steps.
function drawChart(data) {
    const box = document.getElementById('dash-chart'); if (!box) return;
    if (!data.length) { box.innerHTML = ''; return; }
    const W = 560, H = 190, L = 44, B = 24, T = 8, innerW = W - L - 6, innerH = H - B - T;
    const max = Math.max(1, ...data.flatMap(x => [x.collected, x.expenses]));
    const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
    const top = nice(max), short = n => n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? (n / 1e3) + 'K' : String(n);
    const gw = innerW / data.length, bw = Math.min(26, gw / 2 - 3);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="Rent collected and expenses, last 6 months">`;
    for (let i = 0; i <= 4; i++) { const y = T + innerH - (innerH * i / 4); s += `<line x1="${L}" x2="${W - 6}" y1="${y}" y2="${y}" stroke="#233863" stroke-width="1" ${i ? 'opacity=".5"' : ''}/><text x="${L - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#9aa4b8">${short(top * i / 4)}</text>`; }
    data.forEach((x, i) => {
        const cx = L + gw * i + gw / 2, h1 = innerH * x.collected / top, h2 = innerH * x.expenses / top, label = MON[parseInt(x.month.slice(5, 7)) - 1];
        s += `<g><title>${label} ${x.month.slice(0, 4)}: collected ${money(x.collected)} · expenses ${money(x.expenses)}</title>
            <rect class="ka-bar" style="animation-delay:${i * 70}ms" x="${cx - bw - 1}" y="${T + innerH - h1}" width="${bw}" height="${Math.max(h1, 0)}" rx="3" fill="#3987e5"/>
            <rect class="ka-bar" style="animation-delay:${i * 70 + 35}ms" x="${cx + 1}" y="${T + innerH - h2}" width="${bw}" height="${Math.max(h2, 0)}" rx="3" fill="#d95926"/>
            <text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#c3c2b7">${label}</text></g>`;
    });
    s += '</svg>';
    const table = data.map(x => `<tr><td class="pr-3">${MON[parseInt(x.month.slice(5, 7)) - 1]} ${x.month.slice(0, 4)}</td><td class="pr-3 text-right">${fmtN(x.collected)}</td><td class="text-right">${fmtN(x.expenses)}</td></tr>`).join('');
    box.innerHTML = `<div class="flex gap-4 text-[11px] text-gray-300 mb-1"><span><span class="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style="background:#3987e5"></span>Collected</span><span><span class="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style="background:#d95926"></span>Expenses</span></div>${s}
        <details class="text-[11px] text-gray-400 mt-1"><summary class="cursor-pointer">Show numbers</summary><table class="mt-1"><thead><tr class="text-gray-500"><th class="text-left pr-3">Month</th><th class="text-right pr-3">Collected</th><th class="text-right">Expenses</th></tr></thead><tbody>${table}</tbody></table></details>`;
}

// ---- forgot / reset password ----
function showMsg(id, ok, text) { const el = document.getElementById(id); el.className = 'text-xs rounded-xl p-3 ' + (ok ? 'bg-emerald-900/30 border border-emerald-500/40 text-emerald-200' : 'bg-red-900/30 border border-red-500/40 text-red-200'); el.innerText = text; }
function openForgot() { document.getElementById('fg-msg').className = 'hidden'; document.getElementById('fg-email').value = document.getElementById('login-email').value || ''; document.getElementById('fg-btn').disabled = false; openModal('modal-forgot'); }
async function submitForgot(e) {
    e.preventDefault();
    const btn = document.getElementById('fg-btn'); btn.disabled = true; btn.innerText = 'Sending...';
    try {
        const res = await nativeFetch('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('fg-email').value }) });
        const d = await res.json();
        showMsg('fg-msg', res.ok, res.ok ? d.message : (d.error || 'Failed'));
        if (!res.ok) btn.disabled = false;
    } catch (err) { showMsg('fg-msg', false, 'No connection. Please try again.'); btn.disabled = false; }
    btn.innerText = 'Send Reset Link';
}
const RESET_TOKEN = new URLSearchParams(location.search).get('reset');
document.addEventListener('DOMContentLoaded', () => { if (RESET_TOKEN) { localStorage.removeItem('keyarch_token'); localStorage.removeItem('keyarch_user'); document.getElementById('view-login').style.display = 'flex'; document.getElementById('view-app').style.display = 'none'; openModal('modal-reset'); } });
async function submitReset(e) {
    e.preventDefault();
    const a = document.getElementById('rs-pass').value, b = document.getElementById('rs-pass2').value;
    if (a !== b) return showMsg('rs-msg', false, 'The two passwords are not the same.');
    const res = await nativeFetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: RESET_TOKEN, password: a }) });
    const d = await res.json();
    if (!res.ok) return showMsg('rs-msg', false, d.error || 'Failed');
    showMsg('rs-msg', true, d.message);
    setTimeout(() => { history.replaceState(null, '', location.pathname); closeModal('modal-reset'); switchAuthTab('login'); }, 1800);
}

function logout() {
    localStorage.removeItem('keyarch_token');
    localStorage.removeItem('keyarch_user');
    window.location.reload();
}

// ============================================================
// THEME (light / dark), logo, sharing helpers
// ============================================================
const THEMES = ['light', 'dark', 'coffee'], THEME_NAMES = { light: 'Light', dark: 'Dark', coffee: 'Coffee & Gold' }, THEME_ICONS = { light: 'fa-moon', dark: 'fa-mug-hot', coffee: 'fa-sun' };
function currentTheme() { const t = document.documentElement.getAttribute('data-theme'); return THEMES.includes(t) ? t : 'light'; }
function paintThemeIcons() {
    const cur = currentTheme(), next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    document.querySelectorAll('.theme-icon-el').forEach(i => { i.className = 'fa-solid theme-icon-el ' + THEME_ICONS[cur]; if (i.parentElement) i.parentElement.title = `Style: ${THEME_NAMES[cur]} (tap for ${THEME_NAMES[next]})`; });
}
function toggleTheme() {
    const t = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('keyarch_theme', t); } catch (e) { }
    paintThemeIcons();
}
document.addEventListener('DOMContentLoaded', paintThemeIcons);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

// ---- company logo: shrink in the browser, send as a small PNG/JPG ----
let regLogo = null, cpLogoPending;          // cpLogoPending: undefined = not changed, null = removed, text = new picture
function shrinkImage(file, maxSide) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('Could not read the picture.'));
        fr.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('This picture cannot be opened. Use a PNG or JPG.'));
            img.onload = () => {
                const k = Math.min(1, maxSide / Math.max(img.width, img.height));
                const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                resolve(file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88));
            };
            img.src = fr.result;
        };
        fr.readAsDataURL(file);
    });
}
async function pickLogo(input, where) {
    const f = input.files[0]; if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { input.value = ''; return alert('Please choose a PNG or JPG picture.'); }
    try {
        let data = await shrinkImage(f, 400);
        if (data.length > 450000) data = await shrinkImage(f, 220);
        if (data.length > 550000) { input.value = ''; return alert('This picture is too big. Please use a smaller one.'); }
        if (where === 'reg') regLogo = data; else cpLogoPending = data;
        showLogoPreview(where, data);
    } catch (e) { alert(e.message); }
    input.value = '';
}
function clearLogo(where) {
    if (where === 'reg') regLogo = null; else cpLogoPending = null;
    showLogoPreview(where, null);
}
function showLogoPreview(where, data) {
    const img = document.getElementById(where + '-logo-preview'), clr = document.getElementById(where + '-logo-clear'), empty = document.getElementById(where + '-logo-empty');
    if (img) { if (data) { img.src = data; img.classList.remove('hidden'); } else { img.removeAttribute('src'); img.classList.add('hidden'); } }
    if (clr) clr.classList.toggle('hidden', !data);
    if (empty) empty.classList.toggle('hidden', !!data);
}
function applyLogo() {
    const logo = companyProfile && companyProfile.logo_data;
    const el = document.getElementById('sidebar-logo'); if (!el) return;
    if (logo) { el.src = logo; el.classList.remove('hidden'); } else { el.removeAttribute('src'); el.classList.add('hidden'); }
}

// ---- invoice / receipt: PDF download and WhatsApp share ----
let lastInvoiceData = null, lastReceiptData = null;
function downloadInvoicePdf() { if (lastInvoiceData) downloadFile(`/api/invoices/${lastInvoiceData.invoice.invoice_id}/pdf`, `${lastInvoiceData.invoice.invoice_number}.pdf`); }
function downloadReceiptPdf() { if (lastReceiptData) downloadFile(`/api/payments/${lastReceiptData.payment_id}/receipt-pdf`, `${lastReceiptData.receipt_number}.pdf`); }
async function shareFileWA(pdfUrl, filename, text, phone) {
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const popup = touch ? null : window.open('about:blank', '_blank');   // opened now so the browser does not block it later
    try {
        const res = await fetch(pdfUrl, { headers: { 'Authorization': `Bearer ${localStorage.getItem('keyarch_token')}` } });
        if (!res.ok) { let d = {}; try { d = await res.json(); } catch (e) { } throw new Error(d.error || 'Could not make the PDF.'); }
        const blob = await res.blob();
        const file = new File([blob], filename, { type: 'application/pdf' });
        if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file], text, title: filename }); } catch (e) { if (e.name !== 'AbortError') throw e; }
            return;
        }
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        const link = waUrl(phone, text) || `https://wa.me/?text=${encodeURIComponent(text)}`;
        if (popup) popup.location = link; else window.open(link, '_blank');
        if (!touch) alert('The PDF was downloaded. In WhatsApp, attach it with the paper-clip button and send.');
    } catch (e) { if (popup) popup.close(); alert(e.message || 'Could not share.'); }
}
function shareInvoiceWA() {
    const d = lastInvoiceData; if (!d) return; const inv = d.invoice;
    const text = `Habari ${d.tenant.name}, hii ni invoice ${inv.invoice_number} (${d.property_name}, ${d.unit_number}). Jumla: ${money(inv.total)}. Imelipwa: ${money(inv.paid)}. ${inv.balance > 0 ? 'Salio: ' + money(inv.balance) + '. Tarehe ya mwisho: ' + fmtDate(inv.due_date) + '. ' : 'Imelipwa yote. '}- ${(d.company && d.company.company_name) || ''}`;
    shareFileWA(`/api/invoices/${inv.invoice_id}/pdf`, `${inv.invoice_number}.pdf`, text, d.tenant.phone);
}
function shareReceiptWA() {
    const d = lastReceiptData; if (!d) return;
    const text = `Habari ${d.tenant_name}, tumepokea malipo yako ya ${money(d.amount_paid)} (Risiti ${d.receipt_number}, ${fmtDate(d.payment_date)}). ${d.balance_after > 0 ? 'Salio: ' + money(d.balance_after) + '. ' : ''}Asante! - ${(d.company && d.company.company_name) || ''}`;
    shareFileWA(`/api/payments/${d.payment_id}/receipt-pdf`, `${d.receipt_number}.pdf`, text, d.tenant_phone);
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; if (id === 'modal-tenant') onbCurrencyChanged(); }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    
