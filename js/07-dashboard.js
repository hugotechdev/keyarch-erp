function loadAllData() {
    loadOwners();
    loadOverview();
    refreshRequestBadge();
    loadProperties().then(() => { if (!document.getElementById('page-expenses').classList.contains('hidden')) initExpenseFilters(); });
    populateTenantPropertyDropdown();
    loadTablesData();
    if (!isTech()) loadInvoices();
    loadStaff();
    loadProfile();
    const pg = currentPage;
    if (pg === 'luku') loadLuku(); if (pg === 'maintenance') loadTickets(); if (pg === 'expenses') loadExpenses();
}

// ============================================================
// DASHBOARD OVERVIEW
// ============================================================
function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = String(value);
    if (/^(kpi-|dash-|tk-n-)/.test(id) && /\d/.test(text) && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) countUp(el, text);
    else el.innerText = value;
}
// numbers on the dashboard count up from zero (a short, soft effect)
function countUp(el, text) {
    if (el.innerText === text) return;
    const parts = text.split(/(\d[\d,]*(?:\.\d+)?)/), nums = parts.map((p, i) => i % 2 ? parseFloat(p.replace(/,/g, '')) : 0);
    const t0 = performance.now(), D = 700; el._cu = t0;
    const show = (k) => parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const dec = p.includes('.') ? p.split('.')[1].length : 0, v = nums[i] * k;
        return p.includes(',') ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec);
    }).join('');
    const frame = (now) => {
        if (el._cu !== t0) return;
        const k = Math.min(1, (now - t0) / D);
        if (k >= 1) { el.innerText = text; return; }
        el.innerText = show(1 - Math.pow(1 - k, 3)); requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

async function loadOverview() {
    try {
        const token = localStorage.getItem('keyarch_token');
        const res = await fetch('/api/dashboard/overview', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) return;
        overviewData = await res.json();
        renderOverview(overviewData);
    } catch (err) { console.error('Overview error:', err); }
}

function renderOverview(d) {
    const t = d.totals, m = d.money;

    setText('kpi-properties', t.properties);
    setText('kpi-units', `${t.occupied} / ${t.units}`);
    setText('kpi-tenants', t.tenants);
    setText('kpi-occupancy', `${t.occupancyRate}%`);
    const occBar = document.getElementById('kpi-occ-bar'); if (occBar) occBar.style.width = Math.max(0, Math.min(100, Number(t.occupancyRate) || 0)) + '%';
    setText('kpi-collected', money(m.collectedThisMonth));
    setText('kpi-outstanding', money(m.outstanding));

    ['overdue', 'week', 'month'].forEach(k => {
        setText(`due-${k}-count`, d.due[k].count);
        setText(`due-${k}-amount`, money(d.due[k].amount));
    });

    setText('lease-expiry-line',
        `Leases ending: ${d.leases.expired} already expired · ${d.leases.week} this week · ${d.leases.month} this month`);

    // PROPERTY PERFORMANCE
    const perfBody = document.getElementById('perf-body');
    if (d.properties.length === 0) {
        perfBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">No properties yet.</td></tr>';
    } else {
        perfBody.innerHTML = d.properties.map((p, i) => {
            const pct = p.collection_rate === null ? 0 : Math.min(100, p.collection_rate);
            const barColor = pct >= 80 ? 'bg-emerald-500' : (pct >= 50 ? 'bg-amber-500' : 'bg-rose-500');
            return `
            <tr class="hover:bg-[#14223d]/50">
                <td class="p-3 text-gray-500">${i + 1}</td>
                <td class="p-3 font-bold text-white">${esc(p.property_name)}${i === 0 && d.properties.length > 1 ? ' <span class="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-emerald-900/50 text-emerald-300 border border-emerald-500/30">BEST</span>' : ''}</td>
                <td class="p-3">${p.occupied}/${p.units} <span class="text-gray-500">(${p.occupancy_rate}%)</span></td>
                <td class="p-3">${money(p.collected)}<div class="text-[10px] text-gray-500">of ${money(p.billed)}</div></td>
                <td class="p-3">
                    <div class="h-1.5 rounded bg-[#14223d]"><div class="h-1.5 rounded ${barColor}" style="width:${pct}%"></div></div>
                    <div class="text-[10px] text-gray-400 mt-1">${p.collection_rate === null ? 'No invoices yet' : p.collection_rate + '% collected'}</div>
                </td>
            </tr>`;
        }).join('');
    }

    // BIGGEST BALANCES
    const deb = document.getElementById('debtors-list');
    if (d.debtors.length === 0) {
        deb.innerHTML = '<div class="p-3 text-center text-gray-500">Nobody owes money right now.</div>';
    } else {
        deb.innerHTML = d.debtors.map(x => `
            <div class="flex justify-between items-center p-3 rounded-xl bg-[#14223d]">
                <div class="min-w-0">
                    <div class="font-bold text-white truncate">${esc(x.tenant_name)}</div>
                    <div class="text-[10px] text-gray-400 truncate">${esc(x.property_name)} (${esc(x.unit_number)})</div>
                </div>
                <div class="font-black text-rose-400 ml-2 whitespace-nowrap">${money(x.balance)}</div>
            </div>
        `).join('');
    }

    // SIDEBAR TICKET BADGE
    const badge = document.getElementById('nav-badge-tickets');
    const pending = d.tickets && d.tickets.pending;
    if (pending > 0) { badge.innerText = pending; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');

    renderBell(d);
    renderDashExtras(d);
}

function renderBell(d) {
    const items = [];
    if (d.due.overdue.count > 0) items.push({ icon: 'fa-circle-exclamation text-red-400', text: `${d.due.overdue.count} overdue payment(s) · ${money(d.due.overdue.amount)}`, act: "openDueList('overdue')" });
    if (d.due.week.count > 0) items.push({ icon: 'fa-clock text-amber-400', text: `${d.due.week.count} payment(s) due this week`, act: "openDueList('week')" });
    if (d.leases.expired > 0) items.push({ icon: 'fa-file-circle-exclamation text-red-400', text: `${d.leases.expired} lease(s) expired`, act: "showPage('tenants')" });
    if (d.leases.week > 0) items.push({ icon: 'fa-calendar-xmark text-amber-400', text: `${d.leases.week} lease(s) ending this week`, act: "showPage('tenants')" });
    if (d.tickets && d.tickets.workload && canManage()) {
        d.tickets.workload.filter(w => w.unfinished >= WORKLOAD_LIMIT || w.oldest_days >= STALE_DAYS).forEach(w => items.push({
            icon: 'fa-user-gear text-red-400', text: `<b>${esc(w.technician)}</b>: ${w.unfinished} unfinished job(s)${w.oldest_days >= STALE_DAYS ? ` · oldest ${w.oldest_days} days` : ''}`, act: `openTechTickets(${Number(w.technician_id)})`
        }));
    }
    if (d.tickets && d.tickets.pending > 0) items.push({ icon: 'fa-screwdriver-wrench text-orange-400', text: `${d.tickets.pending} pending ticket(s)`, act: "showPage('maintenance')" });

    const countEl = document.getElementById('bell-count');
    if (items.length > 0) { countEl.innerText = items.length; countEl.classList.remove('hidden'); countEl.classList.add('flex'); }
    else { countEl.classList.add('hidden'); countEl.classList.remove('flex'); }

    document.getElementById('bell-list').innerHTML = items.length === 0
        ? '<div class="p-3 text-center text-gray-500">Nothing urgent</div>'
        : items.map(i => `<button onclick="${i.act}" class="w-full text-left px-3 py-2 rounded-lg hover:bg-[#1e2f52] flex items-center gap-2"><i class="fa-solid ${i.icon} w-4"></i> ${i.text}</button>`).join('');
}

// OVERDUE / DUE SOON LISTS
function openDueList(kind) {
    const titles = { overdue: 'Overdue Payments', week: 'Payments Due In 1 Week', month: 'Payments Due In 1 Month' };
    const items = (overviewData && overviewData.due[kind] && overviewData.due[kind].items) || [];
    document.getElementById('list-title').innerText = titles[kind] || 'Payments';

    document.getElementById('list-body').innerHTML = items.length === 0
        ? '<div class="p-6 text-center text-gray-500 text-xs">Nothing here.</div>'
        : items.map(i => {
            const days = Number(i.days_left);
            const when = days < 0 ? `${Math.abs(days)} day(s) late` : (days === 0 ? 'due today' : `in ${days} day(s)`);
            return `
            <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#14223d] text-xs">
                <div class="min-w-0">
                    <div class="font-bold text-white truncate">${esc(i.tenant_name)} <span class="text-gray-500 font-normal">· ${esc(i.invoice_number)}</span></div>
                    <div class="text-[11px] text-gray-400 truncate">${esc(i.property_name)} (${esc(i.unit_number)}) · ${when}</div>
                </div>
                <div class="text-right shrink-0">
                    <div class="font-black ${days < 0 ? 'text-rose-400' : 'text-amber-300'}">${money(i.balance)}</div>
                    <div class="mt-1 flex gap-1 justify-end"><button onclick="openPaymentModal(${Number(i.invoice_id)})" class="px-2 py-1 rounded bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold hover:bg-emerald-600 hover:text-white">Record Payment</button>${contactBtns(i.tenant_phone, remindText(i.tenant_name, i.balance, companyName()), true)}</div>
                </div>
            </div>`;
        }).join('');
    openModal('modal-list');
}
