// ============================================================
// LUKU
// ============================================================
let lukuData = null;
async function loadLuku() {
    if (!hasFeature('luku')) return;
    const r = await api('/api/luku/summary');
    if (!r.ok) return;
    lukuData = r.data;
    const warn = r.data.groups.filter(g => g.flag !== 'OK');
    document.getElementById('luku-alerts').innerHTML = warn.map(g => g.flag === 'OUT'
        ? `<div class="p-3 rounded-xl bg-red-900/30 border border-red-500/40 text-red-200 text-xs"><i class="fa-solid fa-circle-exclamation"></i> <b>${esc(g.unit_name)}</b> at ${money(g.price)}: tokens are FINISHED. Upload more.</div>`
        : `<div class="p-3 rounded-xl bg-amber-900/30 border border-amber-500/40 text-amber-200 text-xs"><i class="fa-solid fa-triangle-exclamation"></i> <b>${esc(g.unit_name)}</b> at ${money(g.price)}: only <b>${g.available}</b> token(s) left.</div>`).join('');
    document.getElementById('luku-stock-body').innerHTML = r.data.groups.length === 0 ? '<tr><td colspan="5" class="p-4 text-center text-gray-500">No tokens uploaded yet. Download the template, fill it, then Upload.</td></tr>' :
        r.data.groups.map(g => `<tr><td class="p-3 font-bold text-white">${esc(g.unit_name)}</td><td class="p-3">${money(g.price)}</td>
            <td class="p-3 font-bold ${g.flag === 'OUT' ? 'text-red-400' : g.flag === 'LOW' ? 'text-amber-300' : 'text-emerald-400'}">${g.available}</td><td class="p-3 text-gray-400">${g.sold}</td>
            <td class="p-3">${g.available > 0 && canManage() ? `<button onclick="deleteLukuStock('${esc(g.unit_name).replace(/'/g, "\\'")}', ${g.price})" class="text-[10px] text-red-300 hover:underline">remove unsold</button>` : ''}</td></tr>`).join('');
    const names = [...new Set(r.data.groups.filter(g => g.available > 0).map(g => g.unit_name))];
    const us = document.getElementById('luku-sell-unit'); const cur = us.value;
    us.innerHTML = names.length ? names.map(n => `<option>${esc(n)}</option>`).join('') : '<option value="">No tokens in stock</option>'; if (cur && names.includes(cur)) us.value = cur;
    fillLukuPrices();
    setText('luku-month', `This month: ${r.data.month_sales.count} token(s) sold · ${money(r.data.month_sales.total)}`);
    const s = await api('/api/luku/sales');
    document.getElementById('luku-sales-body').innerHTML = !s.ok || s.data.length === 0 ? '<tr><td colspan="5" class="p-4 text-center text-gray-500">No sales yet.</td></tr>' :
        s.data.slice(0, 50).map(x => `<tr><td class="p-3 whitespace-nowrap">${fmtDate(x.sold_at)}</td><td class="p-3">${esc(x.unit_name)}</td><td class="p-3">${esc(x.customer_name || '-')}${x.customer_phone ? `<div class="text-[10px] text-gray-500">${esc(x.customer_phone)}</div>` : ''}</td><td class="p-3 font-mono text-amber-300">${esc(x.token_number)}</td><td class="p-3 font-bold text-emerald-400">${money(x.amount)}</td></tr>`).join('');
}
function fillLukuPrices() {
    const u = document.getElementById('luku-sell-unit').value;
    const prices = lukuData ? lukuData.groups.filter(g => g.unit_name === u && g.available > 0) : [];
    document.getElementById('luku-sell-price').innerHTML = prices.map(g => `<option value="${g.price}">${money(g.price)} (${g.available} left)</option>`).join('');
}
async function uploadLuku(input) {
    const f = input.files[0]; if (!f) return;
    const buf = await f.arrayBuffer(); let bin = '';
    const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const r = await api('/api/luku/stock/upload', 'POST', { filename: f.name, data: btoa(bin) });
    input.value = '';
    if (!r.ok) return alert(r.data.error || 'Upload failed.');
    let msg = r.data.message || 'Uploaded.';
    if (r.data.rejected && r.data.rejected.length) msg += '\n\nSome rows were skipped:\n' + r.data.rejected.slice(0, 8).map(x => '• ' + (x.reason || x.error || JSON.stringify(x))).join('\n');
    alert(msg); loadLuku();
}
async function sellLuku() {
    const unit = document.getElementById('luku-sell-unit').value, price = document.getElementById('luku-sell-price').value;
    if (!unit || !price) return alert('Choose the unit and the price.');
    const r = await api('/api/luku/sell', 'POST', { unit_name: unit, price: parseFloat(price), customer_name: document.getElementById('luku-sell-name').value, customer_phone: document.getElementById('luku-sell-phone').value });
    if (!r.ok) return alert(r.data.error || 'Failed');
    const d = r.data;
    document.getElementById('res-token').innerText = d.token || d.token_number; document.getElementById('res-meter').innerText = d.unit_name || unit;
    document.getElementById('res-kwh').innerText = d.kwh || d.kwh_units || '-'; document.getElementById('res-amount').innerText = money(d.price || d.amount || price);
    document.getElementById('luku-sell-name').value = ''; document.getElementById('luku-sell-phone').value = '';
    openModal('modal-luku-result'); loadLuku();
}
async function deleteLukuStock(unit, price) {
    if (!confirm(`Remove all UNSOLD tokens of ${unit} at ${money(price)}?`)) return;
    const r = await api('/api/luku/stock', 'DELETE', { unit_name: unit, price });
    alert(r.ok ? r.data.message : (r.data.error || 'Failed')); loadLuku();
}
