// ============================================================
// EXPENSES
// ============================================================
const EXP_CATS = { REPAIR: 'Repairs', UTILITY: 'Utilities', TAX: 'Taxes & licences', SALARY: 'Salaries', SUPPLIES: 'Supplies', SECURITY: 'Security', CLEANING: 'Cleaning', INSURANCE: 'Insurance', MARKETING: 'Marketing', MISC: 'Other' };
let expensesData = [];
function propOptions(first) { return (first ? `<option value="">${first}</option>` : '') + propertiesData.map(p => `<option value="${esc(p.property_id)}">${esc(p.property_name)}</option>`).join(''); }
function initExpenseFilters() {
    const ep = document.getElementById('ex-prop'), ec = document.getElementById('ex-cat');
    if (ec && !ec.options.length) ec.innerHTML = '<option value="">All categories</option>' + Object.keys(EXP_CATS).map(k => `<option value="${k}">${EXP_CATS[k]}</option>`).join('');
    if (ep) { const v = ep.value; ep.innerHTML = propOptions('All properties'); ep.value = v; }
    const f = document.getElementById('ex-from'); if (f && !f.value) { f.value = monthStartISO(); document.getElementById('ex-to').value = todayISO(); }
}
async function loadExpenses() {
    initExpenseFilters();
    const q = new URLSearchParams();
    ['from', 'to'].forEach(k => { const v = document.getElementById('ex-' + k).value; if (v) q.set(k, v); });
    const p = document.getElementById('ex-prop').value, c = document.getElementById('ex-cat').value;
    if (p) q.set('property_id', p); if (c) q.set('category', c);
    const r = await api('/api/expenses?' + q.toString());
    if (!r.ok) return;
    expensesData = r.data.rows;
    document.getElementById('ex-summary').innerHTML = `<div class="px-4 py-2 rounded-xl bg-red-900/30 border border-red-500/30"><span class="text-gray-400">Total (TSh)</span> <b class="text-red-300 text-sm">${money(r.data.total)}</b></div>` + (r.data.total_usd > 0 ? `<div class="px-4 py-2 rounded-xl bg-amber-900/30 border border-amber-500/30"><span class="text-gray-400">Total (USD)</span> <b class="text-amber-300 text-sm">${money(r.data.total_usd, 'USD')}</b></div>` : '') +
        Object.keys(r.data.byCategory).map(k => `<div class="px-3 py-2 rounded-xl bg-[#14223d] border border-[#233863]"><span class="text-gray-400">${EXP_CATS[k] || k}</span> <b class="text-white">${money(r.data.byCategory[k])}</b></div>`).join('');
    document.getElementById('table-expenses-body').innerHTML = expensesData.length === 0 ? '<tr><td colspan="7" class="p-4 text-center text-gray-500">No expenses in this period.</td></tr>' :
        expensesData.map(e => `<tr class="hover:bg-[#14223d]/50"><td class="p-3 whitespace-nowrap">${fmtDate(e.expense_date)}</td>
            <td class="p-3 font-bold text-white">${esc(e.description)}${e.ticket_id ? ' <span class="text-[10px] text-orange-300">(ticket)</span>' : ''}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-[#14223d] border border-[#233863]">${EXP_CATS[e.category] || esc(e.category)}</span></td>
            <td class="p-3 text-gray-400">${esc(e.property_name || '-')}</td><td class="p-3 text-gray-400">${esc(e.payee || '-')}</td>
            <td class="p-3 font-bold text-red-300 whitespace-nowrap">${money(e.amount, e.currency)}${e.account_name ? `<div class="text-[10px] text-gray-500 font-normal">${esc(e.account_name)}</div>` : ''}</td>
            <td class="p-3 whitespace-nowrap">${canMoney() ? `<button onclick="openExpenseModal(${Number(e.expense_id)})" class="w-7 h-7 rounded-lg bg-amber-600/30 text-amber-300 border border-amber-500/40"><i class="fa-solid fa-pen text-[10px]"></i></button> <button onclick="deleteExpense(${Number(e.expense_id)})" class="w-7 h-7 rounded-lg bg-red-600/20 text-red-300 border border-red-500/40"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : ''}</td></tr>`).join('');
}
async function openExpenseModal(id, obj) {
    if (!finAccounts.length) await loadFinAccounts();
    const e = obj || (id ? expensesData.find(x => Number(x.expense_id) === Number(id)) : null);
    document.getElementById('exp-category').innerHTML = Object.keys(EXP_CATS).map(k => `<option value="${k}">${EXP_CATS[k]}</option>`).join('');
    document.getElementById('exp-prop').innerHTML = propOptions('— Whole company —');
    document.getElementById('ex-title').innerText = e ? 'Edit Expense' : 'Record Expense';
    document.getElementById('exp-id').value = e ? e.expense_id : '';
    document.getElementById('exp-category').value = e ? e.category : 'REPAIR';
    const d = document.getElementById('exp-date'); d.max = todayISO(); d.value = e ? String(e.expense_date).slice(0, 10) : todayISO();
    document.getElementById('exp-desc').value = e ? e.description : '';
    document.getElementById('exp-amount').value = e ? formatMoney(e.amount) : '';
    document.getElementById('exp-prop').value = e && e.property_id ? e.property_id : '';
    document.getElementById('exp-payee').value = e ? (e.payee || '') : ''; document.getElementById('exp-notes').value = e ? (e.notes || '') : '';
    document.getElementById('exp-currency').value = e && e.currency === 'USD' ? 'USD' : 'TZS';
    fillAccountSelect('exp-account', document.getElementById('exp-currency').value, e ? e.account_id : '');
    openModal('modal-expense');
}
async function saveExpense(ev) {
    ev.preventDefault();
    const id = document.getElementById('exp-id').value;
    const body = { category: document.getElementById('exp-category').value, expense_date: document.getElementById('exp-date').value, description: document.getElementById('exp-desc').value,
        amount: parseMoney(document.getElementById('exp-amount').value), property_id: document.getElementById('exp-prop').value || null, payee: document.getElementById('exp-payee').value, notes: document.getElementById('exp-notes').value,
        currency: document.getElementById('exp-currency').value, account_id: document.getElementById('exp-account').value || null };
    const r = await api(id ? `/api/expenses/${id}` : '/api/expenses', id ? 'PUT' : 'POST', body);
    if (r.ok) { closeModal('modal-expense'); loadExpenses(); loadOverview(); if (currentPage === 'finance') { loadFinance(); loadFinAccounts(); } } else alert(r.data.error || 'Failed');
}
async function deleteExpense(id) {
    if (!confirm('Delete this expense?')) return;
    const r = await api(`/api/expenses/${id}`, 'DELETE');
    if (r.ok) { loadExpenses(); loadOverview(); if (currentPage === 'finance') { loadFinance(); loadFinAccounts(); } } else alert(r.data.error || 'Failed');
}
