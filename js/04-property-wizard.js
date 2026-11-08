                        function addGroupCard() {
    groupCounter++;
    const container = document.getElementById('groups-container');
    const cardId = `group-card-${groupCounter}`;

    const cardHTML = `
        <div id="${cardId}" class="group-card bg-[#0e1930] border border-[#1d325c] rounded-2xl p-4 space-y-3 relative" data-group-id="${groupCounter}">
            <div class="flex justify-between items-center border-b border-[#182848] pb-2">
                <h4 class="text-xs font-bold text-white uppercase tracking-wider group-title">${selectedPropertyType} Group ${groupCounter}</h4>
                ${groupCounter > 1 ? `<button type="button" onclick="removeGroupCard('${cardId}')" class="text-red-400 hover:text-red-300 text-xs flex items-center gap-1"><i class="fa-solid fa-trash-can"></i> Remove Group</button>` : ''}
            </div>
            <div class="space-y-3">
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Group Name *</label>
                    <input type="text" class="grp-name w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none focus:border-blue-500" value="Group ${groupCounter}" required>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Units in Group *</label>
                    <input type="number" class="grp-units w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none focus:border-blue-500" value="1" min="1" required>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[11px] font-semibold text-gray-300 mb-1">Bedrooms</label>
                        <input type="number" class="grp-bedrooms w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none focus:border-blue-500" value="1" min="0">
                    </div>
                    <div>
                        <label class="block text-[11px] font-semibold text-gray-300 mb-1">Bathrooms</label>
                        <input type="number" class="grp-bathrooms w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none focus:border-blue-500" value="1" min="0">
                    </div>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Rent Timeline *</label>
                    <div class="grid grid-cols-4 gap-1.5 grp-timeline-btn-group">
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Per Day" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Per Day</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Per Week" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Per Week</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Per Month" class="badge-btn active-badge py-2 text-[10px] font-bold rounded-xl bg-blue-600 text-white border border-blue-500">Per Month</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Per Year" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Per Year</button>
                    </div>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Currency *</label>
                    <div class="grid grid-cols-4 gap-1.5 grp-currency-btn-group">
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="USD" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">USD</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="TSH" class="badge-btn active-badge py-2 text-[10px] font-bold rounded-xl bg-blue-600 text-white border border-blue-500">TSH</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Euro" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Euro</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Pound" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Pound</button>
                    </div>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Rent Amount *</label>
                    <input type="text" inputmode="decimal" autocomplete="off" class="money-input grp-rent-amount w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none focus:border-blue-500" placeholder="0" required>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[11px] font-semibold text-gray-300 mb-1">Service charge / month</label>
                        <input type="text" inputmode="decimal" autocomplete="off" class="money-input grp-svc w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none focus:border-blue-500" placeholder="0 (none)">
                    </div>
                    <div class="flex items-end"><label class="flex items-center gap-2 text-[11px] text-gray-300 pb-2.5"><input type="checkbox" class="grp-incl"> Included in rent (hotel / Air-Bnb)</label></div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-xl border border-dashed border-[#2a4375]">
                    <div><label class="block text-[11px] font-semibold text-gray-300 mb-1">Service charge currency</label>
                        <select class="grp-svccur w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none"><option value="">Same as rent</option><option value="TZS">TSh</option><option value="USD">USD</option></select></div>
                    <div class="org-only"><label class="block text-[11px] font-semibold text-gray-300 mb-1">Owner of these units</label>
                        <select class="grp-owner owner-select w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none" onchange="onOwnerSelect(this)"></select></div>
                    <div class="org-only"><label class="block text-[11px] font-semibold text-gray-300 mb-1">Who uses them</label>
                        <select class="grp-occ w-full p-2.5 rounded-xl bg-[#14223d] border border-[#233863] text-white text-xs outline-none"><option value="LET">Rented to tenants</option><option value="OWNER_LIVES">The owner lives there</option></select></div>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Payment Method *</label>
                    <div class="grid grid-cols-3 gap-2 grp-payment-btn-group">
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Mobile Money" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Mobile Money</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Bank" class="badge-btn py-2 text-[10px] font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863]">Bank</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Cash" class="badge-btn active-badge py-2 text-[10px] font-bold rounded-xl bg-blue-600 text-white border border-blue-500">Cash</button>
                    </div>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-gray-300 mb-1">Furnishing Status</label>
                    <div class="grid grid-cols-2 gap-2 grp-furnishing-btn-group">
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Unfurnished" class="badge-btn active-badge py-2.5 text-xs font-bold rounded-xl bg-blue-600 text-white border border-blue-500 flex items-center justify-center gap-1.5"><i class="fa-solid fa-house"></i> Unfurnished</button>
                        <button type="button" onclick="selectBadgeInCard(this)" data-val="Furnished" class="badge-btn py-2.5 text-xs font-bold rounded-xl bg-[#14223d] text-gray-400 border border-[#233863] flex items-center justify-center gap-1.5"><i class="fa-solid fa-couch"></i> Furnished</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    container.insertAdjacentHTML('beforeend', cardHTML);
    fillOwnerSelects();
}

function removeGroupCard(cardId) {
    const card = document.getElementById(cardId);
    if (card) card.remove();
}

function selectType(type, btn) {
    selectedPropertyType = type;
    document.querySelectorAll('#wiz-prop-type-group .type-btn').forEach(b => {
        b.classList.remove('bg-blue-600', 'text-white', 'border-blue-500');
        b.classList.add('bg-[#14223d]', 'text-gray-400', 'border-[#233863]');
    });
    if (btn) {
        btn.classList.remove('bg-[#14223d]', 'text-gray-400', 'border-[#233863]');
        btn.classList.add('bg-blue-600', 'text-white', 'border-blue-500');
    }

    document.querySelectorAll('.group-title').forEach((title, idx) => {
        title.innerText = `${type} Group ${idx + 1}`;
    });
}

function selectBadgeInCard(element) {
    const parentGroup = element.parentElement;
    parentGroup.querySelectorAll('.badge-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-500', 'active-badge');
        btn.classList.add('bg-[#14223d]', 'text-gray-400', 'border-[#233863]');
    });
    element.classList.remove('bg-[#14223d]', 'text-gray-400', 'border-[#233863]');
    element.classList.add('bg-blue-600', 'text-white', 'border-blue-500', 'active-badge');
}

async function collectAndSubmitWizard(e) {
    e.preventDefault();

    const groupCards = document.querySelectorAll('.group-card');
    const collectedGroups = [];
    let calculatedTotalUnits = 0;

    groupCards.forEach(card => {
        const name = card.querySelector('.grp-name').value;
        const units = parseInt(card.querySelector('.grp-units').value) || 1;
        const bedrooms = parseInt(card.querySelector('.grp-bedrooms').value) || 0;
        const bathrooms = parseInt(card.querySelector('.grp-bathrooms').value) || 0;
        const rentAmount = parseMoney(card.querySelector('.grp-rent-amount').value);

        const timeline = card.querySelector('.grp-timeline-btn-group .active-badge')?.getAttribute('data-val') || 'Per Month';
        const currency = card.querySelector('.grp-currency-btn-group .active-badge')?.getAttribute('data-val') || 'TSH';
        const payment = card.querySelector('.grp-payment-btn-group .active-badge')?.getAttribute('data-val') || 'Cash';
        const furnishing = card.querySelector('.grp-furnishing-btn-group .active-badge')?.getAttribute('data-val') || 'Unfurnished';

        calculatedTotalUnits += units;

        collectedGroups.push({
            group_name: name,
            units_in_group: units,
            bedrooms: bedrooms,
            bathrooms: bathrooms,
            rent_timeline: timeline,
            currency: currency,
            rent_amount: rentAmount,
            payment_method: payment,
            service_charge: parseMoney(card.querySelector('.grp-svc').value),
            service_inclusive: card.querySelector('.grp-incl').checked,
            service_currency: card.querySelector('.grp-svccur').value || undefined,
            owner_id: orgOn() ? (card.querySelector('.grp-owner').value || 'COMPANY') : undefined,
            occupancy_type: orgOn() ? card.querySelector('.grp-occ').value : undefined,
            furnishing_status: furnishing
        });
    });

    const payload = {
        property_name: document.getElementById('wiz-prop-name').value,
        address: document.getElementById('wiz-address').value,
        property_type: selectedPropertyType,
        service_charge_label: document.getElementById('wiz-svc-label').value,
        number_of_units: calculatedTotalUnits,
        groups: collectedGroups
    };

    const token = localStorage.getItem('keyarch_token');
    const res = await fetch('/api/properties/wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
    });

    if (res.ok) {
        alert(`Property "${payload.property_name}" and all ${calculatedTotalUnits} units saved successfully!`);
        expandedProps.clear(); showPage('properties');
        closeModal('modal-property-wizard');
        document.getElementById('form-property-wizard').reset();
        document.getElementById('groups-container').innerHTML = '';
        groupCounter = 0;
        addGroupCard();
        loadAllData();
    } else {
        const data = await res.json();
        alert('Failed: ' + (data.error || 'Server error'));
    }
}
