// CUSTOM SEARCHABLE DROPDOWN FUNCTIONS
function toggleDropdown(listId) {
    const list = document.getElementById(listId);
    if (!list) return;

    const isHidden = list.classList.contains('hidden');

    document.getElementById('prop-dropdown-list')?.classList.add('hidden');
    document.getElementById('unit-dropdown-list')?.classList.add('hidden');

    if (isHidden) {
        list.classList.remove('hidden');
        if (listId === 'prop-dropdown-list') {
            const input = document.getElementById('prop-search-input');
            if (input) { input.value = ''; input.focus(); filterDropdownOptions('prop-search-input', 'prop-options-container'); }
        } else if (listId === 'unit-dropdown-list') {
            const input = document.getElementById('unit-search-input');
            if (input) { input.value = ''; input.focus(); filterDropdownOptions('unit-search-input', 'unit-options-container'); }
        }
    }
}

function filterDropdownOptions(inputId, containerId) {
    const filter = (document.getElementById(inputId)?.value || '').toLowerCase();
    const container = document.getElementById(containerId);
    if (!container) return;

    container.querySelectorAll('.dropdown-item').forEach(opt => {
        opt.style.display = opt.innerText.toLowerCase().includes(filter) ? 'flex' : 'none';
    });
}

function selectPropertyOption(propId, propName) {
    document.getElementById('tenant-property-id').value = propId;
    const label = document.getElementById('prop-selected-label');
    label.innerText = propName;
    label.className = 'text-white font-bold truncate';

    document.getElementById('prop-dropdown-list').classList.add('hidden');

    document.getElementById('tenant-unit-id').value = ''; onbBase = 0; onbSvcBase = 0;
    const unitLabel = document.getElementById('unit-selected-label');
    unitLabel.innerText = '-- Select Vacant Unit --';
    unitLabel.className = 'text-gray-400 truncate';

    loadPropertyUnits(propId);
}

let onbBase = 0, onbSvcBase = 0, onbUnitCur = 'TZS', onbSvcCur = 'TZS';
function selectUnitOption(unitId, unitText, rentAmount, svc, incl, ucur, scur) {
    onbBase = Number(rentAmount) || 0; onbSvcBase = Number(svc) || 0; onbUnitCur = ucur === 'USD' ? 'USD' : 'TZS'; onbSvcCur = scur === 'USD' || scur === 'TZS' ? scur : onbUnitCur;
    // a unit priced in USD starts a USD contract (and the other way round); the user may still change it
    const cs = document.getElementById('tenant-currency'); if (cs) cs.value = onbUnitCur;
    const wrap = document.getElementById('tenant-svc-wrap');
    if (wrap) {
        const on = Number(svc) > 0 && !(incl === true || incl === 'true');
        wrap.classList.toggle('hidden', !on);
        setText('tenant-svc-amount', money(onbConvSvc(svc), onbCur()));
        const pr = findProp(document.getElementById('tenant-property-id').value);
        setText('tenant-svc-label', (pr && pr.service_charge_label) || 'Service charge');
        document.getElementById('tenant-svc-paid').value = '';
    }
    document.getElementById('tenant-unit-id').value = unitId;
    const label = document.getElementById('unit-selected-label');
    label.innerText = unitText;
    label.className = 'text-white font-bold truncate';

    document.getElementById('unit-dropdown-list').classList.add('hidden');

    // Fill the rent price from the unit (user can still change it)
    onbCurrencyChanged();
}

// LOAD PROPERTIES WITH SEARCHABLE OPTIONS
async function populateTenantPropertyDropdown() {
    try {
        const token = localStorage.getItem('keyarch_token');
        const res = await fetch('/api/properties', { headers: { 'Authorization': `Bearer ${token}` } });
        const props = await res.json();

        const container = document.getElementById('prop-options-container');
        if (!container) return;

        if (!Array.isArray(props) || props.length === 0) {
            container.innerHTML = '<div class="p-2 text-xs text-gray-500 text-center">No properties found.</div>';
            return;
        }

        container.innerHTML = props.map(p => `
            <div data-id="${esc(p.property_id)}" data-name="${esc(p.property_name)}" onclick="selectPropertyOption(this.dataset.id, this.dataset.name)" class="dropdown-item p-2 hover:bg-[#1e2f52] rounded-lg cursor-pointer text-xs text-gray-200 transition flex justify-between items-center">
                <span class="font-semibold text-white">${esc(p.property_name)}</span>
                <span class="text-[10px] text-cyan-400 bg-cyan-950 px-1.5 py-0.5 rounded border border-cyan-800/40">${esc(p.category || 'Property')}</span>
            </div>
        `).join('');
    } catch (err) { console.error('Error loading properties dropdown:', err); }
}

// LOAD UNITS WITH SEARCHABLE OPTIONS
async function loadPropertyUnits(propertyId) {
    const container = document.getElementById('unit-options-container');
    if (!container) return;

    if (!propertyId) {
        container.innerHTML = '<div class="p-2 text-xs text-gray-500 text-center">Select property first</div>';
        return;
    }

    try {
        const token = localStorage.getItem('keyarch_token');
        const res = await fetch(`/api/units/by-property/${encodeURIComponent(propertyId)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const units = await res.json();

        if (!Array.isArray(units) || units.length === 0) {
            container.innerHTML = '<div class="p-2 text-xs text-rose-400 text-center">No vacant units available</div>';
            return;
        }

        container.innerHTML = units.map(u => {
            const ucur = String(u.currency || '').toUpperCase() === 'USD' ? 'USD' : 'TZS';
            const displayText = `${u.unit_number} (${ucur} ${parseFloat(u.rent_amount).toLocaleString('en-US')})`;
            return `
                <div data-id="${esc(u.unit_id)}" data-text="${esc(displayText)}" data-rent="${esc(u.rent_amount)}" data-svc="${esc(u.service_charge || 0)}" data-incl="${u.service_inclusive ? 'true' : 'false'}" data-cur="${ucur}" data-scur="${esc(u.service_currency || '')}" onclick="selectUnitOption(this.dataset.id, this.dataset.text, parseFloat(this.dataset.rent), parseFloat(this.dataset.svc), this.dataset.incl, this.dataset.cur, this.dataset.scur)" class="dropdown-item p-2 hover:bg-[#1e2f52] rounded-lg cursor-pointer text-xs text-gray-200 transition flex justify-between items-center">
                    <span class="font-semibold text-white">Unit ${esc(u.unit_number)}</span>
                    <span class="text-[11px] text-emerald-400 font-bold">${ucur} ${parseFloat(u.rent_amount).toLocaleString('en-US')}</span>
                </div>
            `;
        }).join('');
    } catch (err) { console.error('Error loading units dropdown:', err); }
}

// LEASE DURATION DISPLAY
function calculateLeasePeriod() {
    const startDateVal = document.getElementById('tenant-start-date').value;
    const endDateVal = document.getElementById('tenant-end-date').value;
    const displayElement = document.getElementById('tenant-period-display');

    // dates changed, so the number of months/weeks/days is calculated again
    document.getElementById('tenant-periods').dataset.manual = '';

    if (!startDateVal || !endDateVal) {
        displayElement.innerText = !startDateVal ? '-- Select Dates --' : 'No end date (1 period charged)';
        displayElement.className = 'font-bold text-gray-400';
        autoFillPeriods();
        return;
    }

    const start = new Date(startDateVal);
    const end = new Date(endDateVal);

    if (end < start) {
        displayElement.innerText = 'End date cannot be before start date!';
        displayElement.className = 'font-bold text-rose-400';
        autoFillPeriods();
        return;
    }

    const totalDays = Math.ceil(Math.abs(end - start) / (1000 * 60 * 60 * 24));

    let years = end.getFullYear() - start.getFullYear();
    let months = end.getMonth() - start.getMonth();
    let days = end.getDate() - start.getDate();

    if (days < 0) {
        months -= 1;
        const prevMonth = new Date(end.getFullYear(), end.getMonth(), 0);
        days += prevMonth.getDate();
    }
    if (months < 0) {
        years -= 1;
        months += 12;
    }

    const durationText = [];
    if (years > 0) durationText.push(`${years} ${years === 1 ? 'Year' : 'Years'}`);
    if (months > 0) durationText.push(`${months} ${months === 1 ? 'Month' : 'Months'}`);
    if (days > 0) durationText.push(`${days} ${days === 1 ? 'Day' : 'Days'}`);
    if (durationText.length === 0) durationText.push('1 Day');

    displayElement.innerText = `${durationText.join(', ')} (${totalDays} Days total)`;
    displayElement.className = 'font-extrabold text-cyan-300';

    autoFillPeriods();
}

// HOW MANY MONTHS / WEEKS / DAYS / YEARS IS THE LEASE
function countPeriods(startVal, endVal, period) {
    if (!startVal) return 0;
    if (!endVal) return 1; // no end date = charge one period
    const start = new Date(startVal);
    const end = new Date(endVal);
    if (end < start) return 0;

    const totalDays = Math.ceil((end - start) / 86400000);
    let result;

    if (period === 'Day') result = totalDays;
    else if (period === 'Week') result = totalDays / 7;
    else if (period === 'Year') result = totalDays / 365;
    else {
        let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
        let days = end.getDate() - start.getDate();
        if (days < 0) {
            months -= 1;
            days += new Date(end.getFullYear(), end.getMonth(), 0).getDate();
        }
        result = months + days / 30; // extra days are charged as part of a month
    }
    return Math.round(result * 100) / 100;
}

function autoFillPeriods() {
    const period = document.getElementById('tenant-rent-period').value;
    document.getElementById('tenant-periods-label').innerText = `Number of ${period === 'Day' ? 'Days' : period + 's'}`;

    const input = document.getElementById('tenant-periods');
    if (input.dataset.manual !== '1') {
        input.value = countPeriods(
            document.getElementById('tenant-start-date').value,
            document.getElementById('tenant-end-date').value,
            period
        ) || '';
    }
    calculateAmountDue();
}

// user typed the number himself, so dates must not overwrite it
function onPeriodsEdited() {
    document.getElementById('tenant-periods').dataset.manual = '1';
    calculateAmountDue();
}

function getPaymentFigures() {
    const rate = parseMoney(document.getElementById('tenant-rent').value);
    const periods = parseFloat(document.getElementById('tenant-periods').value) || 0;
    const totalRent = Math.round(rate * periods);
    const discount = Math.min(Math.max(parseMoney(document.getElementById('tenant-discount').value), 0), totalRent);
    const totalToPay = totalRent - discount;
    const paid = parseMoney(document.getElementById('tenant-paid').value);
    return { rate, periods, totalRent, discount, totalToPay, paid, balance: totalToPay - paid };
}

function onbCur() { const el = document.getElementById('tenant-currency'); return el && el.value === 'USD' ? 'USD' : 'TZS'; }
function onbMoney(n) { return money(n, onbCur()); }
function onbRate() { const el = document.getElementById('tenant-rate'); return el ? parseMoney(el.value) : 0; }
// convert an amount listed in the unit's currency into the contract currency
function onbConv(n) {
    const c = onbCur(), r = onbRate();
    if (c === onbUnitCur) return n;
    if (!(r > 0)) return 0;
    return c === 'USD' ? Math.round(n / r * 100) / 100 : Math.round(n * r);
}
// the service charge may be listed in another currency than the rent
function onbConvSvc(n) {
    const c = onbCur(), r = onbRate();
    if (c === onbSvcCur) return n;
    if (!(r > 0)) return 0;
    return c === 'USD' ? Math.round(n / r * 100) / 100 : Math.round(n * r);
}
function onbConvert() {
    const diff = onbCur() !== onbUnitCur || (onbSvcBase > 0 && onbCur() !== onbSvcCur);
    document.getElementById('tenant-rate-wrap').classList.toggle('hidden', !diff);
    const rentInput = document.getElementById('tenant-rent');
    if (onbBase > 0) rentInput.value = (diff && !(onbRate() > 0)) ? '' : formatMoney(onbConv(onbBase));
    document.getElementById('tenant-rate-note').innerText = diff ? `${onbSvcBase > 0 && onbSvcCur !== onbUnitCur ? 'The service charge is listed in ' + (onbSvcCur === 'USD' ? 'USD' : 'TSh') + ' (' + money(onbSvcBase, onbSvcCur) + '). ' : ''}The unit is priced in ${onbUnitCur === 'USD' ? 'USD' : 'TSh'}: ${money(onbBase, onbUnitCur)}. Enter the rate and the rent is converted.` : '';
    setText('tenant-svc-amount', money(onbConvSvc(onbSvcBase), onbCur()));
    calculateAmountDue();
}
async function onbCurrencyChanged() {
    if (!finAccounts.length) await loadFinAccounts();
    document.querySelectorAll('.onb-lbl').forEach(el => el.innerText = el.dataset.pre + onbCur() + el.dataset.post);
    fillAccountSelect('tenant-account', onbCur(), document.getElementById('tenant-account').value);
    onbConvert();
}
function calculateAmountDue() {
    const f = getPaymentFigures();

    document.getElementById('sum-total').innerText = onbMoney(f.totalRent);
    document.getElementById('sum-discount').innerText = '- ' + onbMoney(f.discount);
    document.getElementById('sum-topay').innerText = onbMoney(f.totalToPay);
    document.getElementById('sum-paid').innerText = onbMoney(f.paid);

    const label = document.getElementById('sum-result-label');
    const value = document.getElementById('sum-result-value');

    if (f.totalToPay === 0) {
        label.innerText = 'Remaining Balance';
        value.innerText = onbMoney(0);
        value.className = 'text-sm font-black text-gray-400';
    } else if (f.balance > 0) {
        label.innerText = 'Remaining Balance';
        value.innerText = onbMoney(f.balance);
        value.className = 'text-sm font-black text-rose-400';
    } else if (f.balance === 0) {
        label.innerText = 'Fully Paid';
        value.innerText = '✔ ' + onbMoney(0) + ' left';
        value.className = 'text-sm font-black text-emerald-400';
    } else {
        label.innerText = 'Extra Paid (tenant paid more)';
        value.innerText = onbMoney(Math.abs(f.balance));
        value.className = 'text-sm font-black text-sky-400';
    }
}

// TENANT SUBMISSION & AUTO INVOICE
async function handleTenantSubmit(e) {
    e.preventDefault();

    const propId = document.getElementById('tenant-property-id').value;
    const unitId = document.getElementById('tenant-unit-id').value;

    if (!propId || !unitId) {
        alert('Please select a Property and a Unit before saving.');
        return;
    }

    const f = getPaymentFigures();
    if (f.rate <= 0 || f.periods <= 0) {
        alert('Please enter the Rent Price and make sure the lease dates / number of periods are correct.');
        return;
    }

    const payload = {
        full_name: document.getElementById('tenant-full-name').value,
        nida_passport_no: document.getElementById('tenant-nida').value,
        identity_type: document.getElementById('tenant-id-type').value,
        phone_number: document.getElementById('tenant-phone').value,
        property_id: propId,
        unit_id: unitId,
        start_date: document.getElementById('tenant-start-date').value,
        end_date: document.getElementById('tenant-end-date').value,
        rent_price: f.rate,
        rent_period: document.getElementById('tenant-rent-period').value,
        number_of_periods: f.periods,
        discount: f.discount,
        paid_amount: f.paid,
        payment_method: document.getElementById('tenant-pay-method').value,
        payment_reference: document.getElementById('tenant-pay-ref').value,
        service_paid: parseMoney(document.getElementById('tenant-svc-paid').value),
        currency: document.getElementById('tenant-currency').value, exchange_rate: onbRate() || undefined, account_id: document.getElementById('tenant-account').value || undefined
        // the server calculates total_rent, total_to_pay, balance and status again
    };

    try {
        const token = localStorage.getItem('keyarch_token');
        const res = await fetch('/api/tenants/onboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        closeModal('modal-tenant');
        document.getElementById('form-tenant-onboard').reset();

        document.getElementById('tenant-property-id').value = '';
        document.getElementById('tenant-unit-id').value = ''; onbBase = 0; onbSvcBase = 0;
        document.getElementById('prop-selected-label').innerText = '-- Select Property --';
        document.getElementById('prop-selected-label').className = 'text-gray-400 truncate';
        document.getElementById('unit-selected-label').innerText = '-- Select Property First --';
        document.getElementById('unit-selected-label').className = 'text-gray-400 truncate';
        document.getElementById('tenant-periods').dataset.manual = '';

        calculateLeasePeriod();
        loadAllData();

        document.getElementById('tenant-svc-wrap').classList.add('hidden');
        if (data.invoice) {
            showInvoiceModal(data.invoice.invoice_id);
        }
    } catch (err) {
        alert('Onboarding Error: ' + err.message);
    }
}
