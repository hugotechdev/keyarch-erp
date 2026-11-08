// ============================================================
// FINANCE
// ============================================================
let finAccounts = [], finData = null, finTab = 'overview', finSelProps = new Set(), finSelUnits = new Set(), finUnitsAll = [], finTimer = null;
const FIN_SRC = { PAYMENT: 'Rent & invoice payments', MANUAL: 'Other income', LUKU: 'Luku sales', EXPENSE: 'Expenses' };
const INC_CATS = { RENT: 'Rent', DEPOSIT: 'Deposit', SERVICE: 'Service charge', LUKU: 'Luku', INTEREST: 'Interest', SALE: 'Sale', OTHER: 'Other income', UTILITY: 'Utility', EXTENSION: 'Extension', PENALTY: 'Penalty', REPAIR: 'Repair charge' };
function canFin() { return ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTANT'].includes(role()); }
function curName(c) { return c === 'USD' ? 'USD' : 'TZS'; }
function catName(type, c) { return type === 'EXPENSE' ? (EXP_CATS[c] || c) : (INC_CATS[c] || c); }

async function loadFinAccounts() {
    const r = await api('/api/finance/accounts');
    finAccounts = r.ok && Array.isArray(r.data) ? r.data : [];
    return finAccounts;
}
// <option> list of the open accounts in one currency
function fillAccountSelect(id, cur, selected) {
    const el = document.getElementById(id); if (!el) return;
    const list = finAccounts.filter(a => a.is_active !== false && a.currency === cur);
    el.innerHTML = '<option value="">- No account -</option>' + list.map(a => `<option value="${a.account_id}">${esc(a.name)}</option>`).join('');
    if (selected) {
        if (!list.some(a => String(a.account_id) === String(selected))) {
            const old = finAccounts.find(a => String(a.account_id) === String(selected) && a.currency === cur);
            if (old) el.insertAdjacentHTML('beforeend', `<option value="${old.account_id}">${esc(old.name)} (closed)</option>`);
        }
        el.value = String(selected);
    }
}

function setFinTab(t) {
    finTab = t;
    ['overview', 'transactions', 'accounts'].forEach(k => {
        document.getElementById('fin-tab-' + k).classList.toggle('hidden', k !== t);
        const b = document.getElementById('fin-tabbtn-' + k);
        b.className = 'fin-tabbtn px-4 py-2 rounded-xl ' + (k === t ? 'bg-blue-600 text-white' : 'bg-[#14223d] text-gray-300 border border-[#233863]');
    });
    document.getElementById('fin-filters').classList.toggle('hidden', t === 'accounts');
    if (t === 'accounts') renderFinAccounts();
}

function finQuick(k) {
    const now = new Date(), iso = d => toDateInput(d);
    let a = new Date(now), b = new Date(now);
    if (k === 'week') { const wd = (now.getDay() + 6) % 7; a.setDate(now.getDate() - wd); }
    else if (k === 'month') a = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (k === 'lastmonth') { a = new Date(now.getFullYear(), now.getMonth() - 1, 1); b = new Date(now.getFullYear(), now.getMonth(), 0); }
    else if (k === '3months') a = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    else if (k === 'year') a = new Date(now.getFullYear(), 0, 1);
    document.getElementById('fin-from').value = iso(a); document.getElementById('fin-to').value = iso(b);
    const g = document.getElementById('fin-group');
    g.value = k === 'today' || k === 'week' ? 'day' : k === 'year' ? 'month' : (k === 'month' || k === 'lastmonth') ? 'day' : 'month';
    loadFinance();
}

function finFilterChanged() {
    const cur = document.getElementById('fin-currency').value;
    const el = document.getElementById('fin-account');
    const list = finAccounts.filter(a => cur === 'ALL' || a.currency === cur);
    const v = el.value;
    el.innerHTML = '<option value="">All accounts</option>' + list.map(a => `<option value="${a.account_id}">${esc(a.name)} (${a.currency === 'USD' ? 'USD' : 'TSh'})</option>`).join('');
    if (list.some(a => String(a.account_id) === v)) el.value = v;
    loadFinance();
}

function renderFinProps() {
    const box = document.getElementById('fin-prop-list');
    box.innerHTML = '<label class="flex items-center gap-2"><input type="checkbox" onchange="finPropAll(this.checked)" ' + (finSelProps.size === 0 ? 'checked' : '') + '> <b>All properties</b></label>' +
        (propertiesData || []).map(p => `<label class="flex items-center gap-2"><input type="checkbox" value="${p.property_id}" onchange="finPropToggle(this)" ${finSelProps.has(String(p.property_id)) ? 'checked' : ''}> ${esc(p.property_name || p.title)}</label>`).join('');
    document.getElementById('fin-prop-label').innerText = finSelProps.size === 0 ? 'All properties' : finSelProps.size + ' propert' + (finSelProps.size === 1 ? 'y' : 'ies') + ' selected';
}
function finPropAll(on) { if (on) { finSelProps.clear(); finSelUnits.clear(); } renderFinProps(); loadFinUnits(); scheduleFinance(); }
function finPropToggle(cb) { cb.checked ? finSelProps.add(cb.value) : finSelProps.delete(cb.value); finSelUnits.clear(); renderFinProps(); loadFinUnits(); scheduleFinance(); }
async function loadFinUnits() {
    const box = document.getElementById('fin-unit-list');
    if (finSelProps.size === 0) { finUnitsAll = []; box.innerHTML = '<div class="text-gray-500">Choose a property first.</div>'; renderFinUnitLabel(); return; }
    const r = await api('/api/finance/units?property_ids=' + [...finSelProps].join(','));
    finUnitsAll = r.ok ? r.data : [];
    renderFinUnits();
}
function renderFinUnits() {
    const box = document.getElementById('fin-unit-list');
    box.innerHTML = '<label class="flex items-center gap-2"><input type="checkbox" onchange="finUnitAll(this.checked)" ' + (finSelUnits.size === 0 ? 'checked' : '') + '> <b>All units</b></label>' +
        finUnitsAll.map(u => `<label class="flex items-center gap-2"><input type="checkbox" value="${u.unit_id}" onchange="finUnitToggle(this)" ${finSelUnits.has(String(u.unit_id)) ? 'checked' : ''}> ${finSelProps.size > 1 ? esc(u.property_name) + ' - ' : ''}${esc(u.unit_number)}</label>`).join('');
    renderFinUnitLabel();
}
function renderFinUnitLabel() { document.getElementById('fin-unit-label').innerText = finSelUnits.size === 0 ? 'All units' : finSelUnits.size + ' unit' + (finSelUnits.size === 1 ? '' : 's') + ' selected'; }
function finUnitAll(on) { if (on) finSelUnits.clear(); renderFinUnits(); scheduleFinance(); }
function finUnitToggle(cb) { cb.checked ? finSelUnits.add(cb.value) : finSelUnits.delete(cb.value); renderFinUnits(); scheduleFinance(); }
function scheduleFinance() { clearTimeout(finTimer); finTimer = setTimeout(loadFinance, 350); }

function finQuery() {
    const q = new URLSearchParams();
    const g = id => document.getElementById(id).value;
    q.set('from', g('fin-from')); q.set('to', g('fin-to')); q.set('group', g('fin-group')); q.set('currency', g('fin-currency')); q.set('kind', g('fin-kind'));
    if (g('fin-account')) q.set('account_id', g('fin-account'));
    if (finSelProps.size) q.set('property_ids', [...finSelProps].join(','));
    if (finSelUnits.size) q.set('unit_ids', [...finSelUnits].join(','));
    if (!document.getElementById('fin-luku').checked) q.set('luku', '0');
    return q;
}

async function initFinance() {
    if (!document.getElementById('fin-from').value) { document.getElementById('fin-from').value = monthStartISO(); document.getElementById('fin-to').value = todayISO(); document.getElementById('fin-group').value = 'day'; }
    await loadFinAccounts();
    finFilterChanged();       // fills the account filter and loads the data
    renderFinProps();
    setFinTab(finTab);
}

function periodLabel(p, group) {
    if (group === 'day') return fmtDate(p);
    if (group === 'week') return 'Week of ' + fmtDate(p);
    if (group === 'year') return p;
    const [y, m] = p.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(m, 10) - 1] + ' ' + y;
}

// quick review at the very top: this month and this year, TSh and USD side by side
async function loadFinOverview() {
    const r = await api('/api/finance/overview'); if (!r.ok) return;
    const d = r.data, yr = d.today.slice(0, 4);
    const trend = (now, before, goodUp) => {
        if (!before && !now) return '';
        if (!before) return '<div class="text-xs text-gray-400 mt-0.5">New this month</div>';
        const pct = Math.round((now - before) / before * 100);
        if (pct === 0) return '<div class="text-xs text-gray-400 mt-0.5">Same as last month</div>';
        const up = pct > 0, good = up === goodUp;
        return `<div class="text-xs font-bold mt-0.5 ${good ? 'text-emerald-400' : 'text-rose-400'}">${up ? '▲' : '▼'} ${Math.abs(pct)}% vs last month</div>`;
    };
    const cell = (label, v, cls, c, extra) => `<div class="p-3 rounded-xl bg-[#14223d] border border-[#233863]"><div class="fin-cell-label text-gray-300">${label}</div><div class="fin-cell-value ${cls} break-words">${money(v, c)}</div>${extra || ''}</div>`;
    document.getElementById('fin-top').innerHTML = ['TZS', 'USD'].map(c => { const x = d[c], usd = c === 'USD';
        const mn = x.month_income - x.month_expense, yn = x.year_income - x.year_expense;
        return `<div class="p-4 rounded-2xl bg-[#0d172d] border border-[#182848] border-l-4 ${usd ? 'border-l-amber-400' : 'border-l-sky-400'}">
            <div class="flex justify-between items-center mb-3"><div class="text-base font-black text-white tracking-wide">${usd ? 'USD account' : 'TSh account'}</div><span class="px-2.5 py-1 rounded-lg text-xs font-bold ${usd ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'}">${usd ? 'US Dollars' : 'Shillings'}</span></div>
            <div class="grid grid-cols-2 gap-2">
                ${cell('Income this month', x.month_income, 'text-emerald-400', c, trend(x.month_income, x.prev_income, true))}${cell('Expenses this month', x.month_expense, 'text-rose-400', c, trend(x.month_expense, x.prev_expense, false))}
                ${cell('Income this year', x.year_income, 'text-emerald-400', c)}${cell('Expenses this year', x.year_expense, 'text-rose-400', c)}
            </div>
            <div class="grid grid-cols-2 gap-2 mt-3 text-sm"><div class="text-gray-300">Net this month<div class="text-base font-black ${mn >= 0 ? 'text-sky-300' : 'text-rose-300'}">${money(mn, c)}</div></div><div class="text-gray-300">Net this year<div class="text-base font-black ${yn >= 0 ? 'text-sky-300' : 'text-rose-300'}">${money(yn, c)}</div></div></div></div>`; }).join('');
}

function finToggleAdv() { document.getElementById('fin-adv').classList.toggle('hidden'); }

async function loadFinance() {
    loadFinOverview();
    const r = await api('/api/finance/ledger?' + finQuery().toString());
    if (!r.ok) { document.getElementById('fin-cards').innerHTML = `<div class="text-rose-300 text-xs">${esc(r.data.error || 'Could not load.')}</div>`; return; }
    finData = r.data; renderFinance();
}

function renderFinance() {
    const d = finData; if (!d) return;
    const curs = Object.keys(d.totals).sort();
    const act = [];
    if (document.getElementById('fin-currency').value !== 'ALL') act.push('one currency');
    if (document.getElementById('fin-account').value) act.push('one account');
    if (document.getElementById('fin-kind').value !== 'all') act.push('income or expenses only');
    if (finSelProps.size) act.push(finSelProps.size + ' propert' + (finSelProps.size === 1 ? 'y' : 'ies'));
    if (finSelUnits.size) act.push(finSelUnits.size + ' unit' + (finSelUnits.size === 1 ? '' : 's'));
    document.getElementById('fin-range-label').innerText = fmtDate(d.from) + ' - ' + fmtDate(d.to) + (act.length ? '  ·  ' + act.join(', ') : '');
    document.getElementById('fin-cards').innerHTML = curs.length === 0 ? '<div class="text-gray-400 text-sm p-4">No money records in this period.</div>' :
        `<div class="p-4 rounded-2xl bg-[#0d172d] border border-[#182848]"><div class="text-base font-black text-white mb-2">Totals for the selected period</div><div class="space-y-1.5">` + curs.map(c => { const t = d.totals[c]; return `<div class="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-sm"><b class="${c === 'USD' ? 'text-amber-300' : 'text-sky-300'}">${c === 'USD' ? 'USD' : 'TSh'}</b><span class="text-gray-300">Income <b class="text-emerald-400">${money(t.income, c)}</b></span><span class="text-gray-300">Expenses <b class="text-rose-400">${money(t.expense, c)}</b></span><span class="text-gray-300">Net <b class="${t.net >= 0 ? 'text-sky-300' : 'text-rose-300'}">${money(t.net, c)}</b></span></div>`; }).join('') + `</div></div>`;

    // bars per period, one block per currency
    document.getElementById('fin-chart').innerHTML = curs.map(c => {
        const rows = d.series.filter(s => s.currency === c);
        if (rows.length < 2) return '';
        const max = Math.max(1, ...rows.map(s => Math.max(s.income, s.expense)));
        return `<div class="p-4 rounded-2xl bg-[#0d172d] border border-[#182848]"><div class="text-base font-black text-white mb-3">${c === 'USD' ? 'USD' : 'TSh'} by ${esc({ day: 'day', week: 'week', month: 'month', year: 'year' }[d.group])}</div>
            <div class="space-y-2">${rows.map(s => `<div class="text-[11px]">
                <div class="flex justify-between text-gray-400"><span>${esc(periodLabel(s.period, d.group))}</span><span><span class="text-emerald-400">${money(s.income, c)}</span> · <span class="text-rose-400">${money(s.expense, c)}</span></span></div>
                <div class="h-2 rounded bg-[#14223d] overflow-hidden mt-1"><div class="h-2 bg-emerald-500" style="width:${(s.income / max * 100).toFixed(1)}%"></div></div>
                <div class="h-2 rounded bg-[#14223d] overflow-hidden mt-0.5"><div class="h-2 bg-rose-500" style="width:${(s.expense / max * 100).toFixed(1)}%"></div></div></div>`).join('') || '<div class="text-gray-500 text-xs">No records.</div>'}</div></div>`;
    }).join('');

    const block = (title, rows) => !rows ? '' : `<div class="p-4 rounded-2xl bg-[#0d172d] border border-[#182848]"><div class="text-base font-black text-white mb-2">${title}</div><div class="space-y-1.5 text-sm">${rows}</div></div>`;
    const line = (name, val, cls) => `<div class="flex justify-between gap-2"><span class="text-gray-300">${name}</span><b class="${cls} whitespace-nowrap">${val}</b></div>`;
    const inc = d.by_category.filter(x => x.type === 'INCOME').sort((a, b) => b.total - a.total), exp = d.by_category.filter(x => x.type === 'EXPENSE').sort((a, b) => b.total - a.total);
    document.getElementById('fin-breakdown').innerHTML =
        block('Income by type', inc.map(x => line(esc(catName('INCOME', x.category)), money(x.total, x.currency), 'text-emerald-400')).join('')) +
        block('Expenses by category', exp.map(x => line(esc(catName('EXPENSE', x.category)), money(x.total, x.currency), 'text-rose-400')).join('')) +
        block('By account', d.by_account.map(x => `<div class="flex justify-between gap-2"><span class="text-gray-300">${esc(x.account)} <span class="text-gray-500">(${x.currency === 'USD' ? 'USD' : 'TSh'})</span></span><span class="whitespace-nowrap"><span class="text-emerald-400">+${money(x.income, x.currency)}</span> <span class="text-rose-400">-${money(x.expense, x.currency)}</span></span></div>`).join('')) +
        block('Where the money came from', d.by_source.filter(x => x.source !== 'EXPENSE').map(x => line(esc(FIN_SRC[x.source] || x.source), money(x.total, x.currency), 'text-emerald-400')).join(''));

    // transactions
    document.getElementById('fin-tx-note').innerText = `${d.row_count} record${d.row_count === 1 ? '' : 's'}${d.truncated ? ' (showing the newest 5000)' : ''}`;
    const rows = d.rows.slice(0, 400);
    document.getElementById('fin-tx-body').innerHTML = rows.length === 0 ? '<tr><td colspan="6" class="p-4 text-center text-gray-500">No records.</td></tr>' : rows.map((x, i) => {
        const inn = x.type === 'INCOME';
        let act = '';
        if (x.source === 'PAYMENT') act = `<button onclick="showReceipt(${x.payment_id})" class="px-2 py-1 rounded bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 text-[10px] font-bold">Receipt</button>`;
        else if (canFin() && x.source === 'MANUAL') act = `<button onclick="openIncomeModal(${x.income_id})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40"><i class="fa-solid fa-pen text-[10px]"></i></button> <button onclick="deleteIncome(${x.income_id})" class="w-7 h-7 rounded-lg bg-red-600/30 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash text-[10px]"></i></button>`;
        else if (canFin() && x.source === 'EXPENSE') act = `<button onclick="openExpenseFromFinance(${i})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40"><i class="fa-solid fa-pen text-[10px]"></i></button> <button onclick="deleteExpense(${x.expense_id})" class="w-7 h-7 rounded-lg bg-red-600/30 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash text-[10px]"></i></button>`;
        return `<tr class="hover:bg-[#14223d]/50"><td class="p-3 whitespace-nowrap">${fmtDate(x.date)}</td>
            <td class="p-3"><div class="font-bold text-white">${esc(x.description)}</div><div class="text-[10px] text-gray-500"><span class="px-1.5 py-0.5 rounded bg-[#14223d] border border-[#233863]">${esc(catName(x.type, x.category))}</span> ${esc(x.property || '')}${x.unit ? ' (' + esc(x.unit) + ')' : ''}</div></td>
            <td class="p-3 text-gray-400">${esc(x.account || '-')}</td>
            <td class="p-3 text-right font-bold text-emerald-400 whitespace-nowrap">${inn ? money(x.amount, x.currency) : ''}</td>
            <td class="p-3 text-right font-bold text-rose-400 whitespace-nowrap">${inn ? '' : money(x.amount, x.currency)}</td>
            <td class="p-3 whitespace-nowrap">${act}</td></tr>`; }).join('');
    if (finTab === 'accounts') renderFinAccounts();
}

function renderFinAccounts() {
    const box = document.getElementById('fin-accounts-list');
    if (!finAccounts.length) { box.innerHTML = '<div class="text-gray-500 text-xs p-4">No accounts yet. Press "New account" to make your first one (for example CRDB Main, Petty Cash or Dollar Safe).</div>'; return; }
    const KIND = { CASH: 'Cash', BANK: 'Bank', MOBILE: 'Mobile money', OTHER: 'Other' };
    box.innerHTML = finAccounts.map(a => `<div class="p-4 rounded-2xl bg-[#0d172d] border border-[#182848] ${a.is_active === false ? 'opacity-60' : ''}">
        <div class="flex justify-between items-start gap-2"><div><div class="font-bold text-white">${esc(a.name)}</div><div class="text-[10px] text-gray-500">${esc(KIND[a.kind] || a.kind)} · ${a.currency === 'USD' ? 'USD' : 'TSh'}${a.is_active === false ? ' · Closed' : ''}</div></div>
            ${canFin() ? `<div class="flex gap-1"><button onclick="openAccountModal(${a.account_id})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40"><i class="fa-solid fa-pen text-[10px]"></i></button><button onclick="deleteAccount(${a.account_id})" class="w-7 h-7 rounded-lg bg-red-600/30 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash text-[10px]"></i></button></div>` : ''}</div>
        ${a.balance === undefined ? '' : `<div class="text-xl font-black mt-2 ${a.balance >= 0 ? 'text-sky-300' : 'text-rose-300'}">${money(a.balance, a.currency)}</div>
        <div class="text-[10px] text-gray-500 mt-1">In ${money(a.money_in, a.currency)} · Out ${money(a.money_out, a.currency)} · Opening ${money(a.opening_balance, a.currency)}</div>`}</div>`).join('');
}

// ---- accounts
function openAccountModal(id) {
    const a = id ? finAccounts.find(x => x.account_id === id) : null;
    document.getElementById('fa-title').innerText = a ? 'Edit Account' : 'New Account';
    document.getElementById('fa-id').value = a ? a.account_id : '';
    document.getElementById('fa-name').value = a ? a.name : '';
    document.getElementById('fa-currency').value = a ? a.currency : 'TZS';
    document.getElementById('fa-kind').value = a ? a.kind : 'CASH';
    document.getElementById('fa-opening').value = a && a.opening_balance ? formatMoney(a.opening_balance) : '';
    document.getElementById('fa-active').checked = a ? a.is_active !== false : true;
    openModal('modal-fin-account');
}
async function saveAccount(ev) {
    ev.preventDefault();
    const id = document.getElementById('fa-id').value;
    const body = { name: document.getElementById('fa-name').value, currency: document.getElementById('fa-currency').value, kind: document.getElementById('fa-kind').value,
        opening_balance: parseMoney(document.getElementById('fa-opening').value), is_active: document.getElementById('fa-active').checked };
    const r = await api(id ? `/api/finance/accounts/${id}` : '/api/finance/accounts', id ? 'PUT' : 'POST', body);
    if (!r.ok) return alert(r.data.error || 'Failed');
    closeModal('modal-fin-account'); await loadFinAccounts(); finFilterChanged(); renderFinAccounts();
}
async function deleteAccount(id) {
    if (!confirm('Delete this account? If it already has records, it will be closed instead.')) return;
    const r = await api(`/api/finance/accounts/${id}`, 'DELETE');
    if (!r.ok) return alert(r.data.error || 'Failed');
    if (r.data.closed) alert(r.data.message);
    await loadFinAccounts(); finFilterChanged(); renderFinAccounts();
}

// ---- other income
async function openIncomeModal(id) {
    if (!finAccounts.length) await loadFinAccounts();
    let x = null;
    if (id && finData) x = finData.rows.find(r => r.income_id === id);
    document.getElementById('fi-title').innerText = x ? 'Edit Income' : 'Record Income';
    document.getElementById('fi-id').value = x ? x.income_id : '';
    document.getElementById('fi-desc').value = x ? x.raw : '';
    document.getElementById('fi-currency').value = x ? x.currency : 'TZS';
    fillAccountSelect('fi-account', x ? x.currency : 'TZS', x ? x.account_id : '');
    document.getElementById('fi-amount').value = x ? formatMoney(x.amount) : '';
    const d = document.getElementById('fi-date'); d.max = todayISO(); d.value = x ? x.date : todayISO();
    document.getElementById('fi-category').value = x && INC_CATS[x.category] ? x.category : 'OTHER';
    document.getElementById('fi-prop').innerHTML = propOptions('- Whole company -');
    document.getElementById('fi-prop').value = x && x.property_id ? x.property_id : '';
    document.getElementById('fi-payer').value = x ? x.party : ''; document.getElementById('fi-ref').value = x ? (x.reference || '') : ''; document.getElementById('fi-notes').value = x ? x.notes : '';
    openModal('modal-fin-income');
}
async function saveIncome(ev) {
    ev.preventDefault();
    const id = document.getElementById('fi-id').value;
    const body = { description: document.getElementById('fi-desc').value, currency: document.getElementById('fi-currency').value, account_id: document.getElementById('fi-account').value || null,
        amount: parseMoney(document.getElementById('fi-amount').value), income_date: document.getElementById('fi-date').value, category: document.getElementById('fi-category').value,
        property_id: document.getElementById('fi-prop').value || null, payer: document.getElementById('fi-payer').value, reference: document.getElementById('fi-ref').value, notes: document.getElementById('fi-notes').value };
    const r = await api(id ? `/api/finance/income/${id}` : '/api/finance/income', id ? 'PUT' : 'POST', body);
    if (!r.ok) return alert(r.data.error || 'Failed');
    closeModal('modal-fin-income'); loadFinance(); loadFinAccounts();
}
async function deleteIncome(id) {
    if (!confirm('Delete this income record?')) return;
    const r = await api(`/api/finance/income/${id}`, 'DELETE');
    if (r.ok) { loadFinance(); loadFinAccounts(); } else alert(r.data.error || 'Failed');
}
function openExpenseFromFinance(i) {
    const x = finData.rows[i]; if (!x) return;
    openExpenseModal(x.expense_id, { expense_id: x.expense_id, category: x.category, expense_date: x.date, description: x.raw, amount: x.amount, property_id: x.property_id, payee: x.party, notes: x.notes, currency: x.currency, account_id: x.account_id });
}

async function finExport(format) {
    const q = finQuery(); q.set('format', format); q.set('view', document.getElementById('fin-report').value);
    const name = `finance-${q.get('view')}-${q.get('from')}-to-${q.get('to')}.${format}`;
    await downloadFile('/api/finance/export?' + q.toString(), name);
}
