document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadProperties();

    // Property Form Submit
    document.getElementById('form-property').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            title: document.getElementById('prop-title').value,
            location: document.getElementById('prop-location').value,
            category: document.getElementById('prop-category').value,
            transaction_type: 'For Rent',
            total_units: 1
        };

        const res = await fetch('/api/properties', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            alert('Jengo limesajiliwa kikamilifu kwenye PostgreSQL Database!');
            closeModal('modal-property');
            loadStats();
            loadProperties();
        }
    });

    // Tenant Form Submit
    document.getElementById('form-tenant').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            full_name: document.getElementById('tenant-name').value,
            identity_number: document.getElementById('tenant-nida').value,
            phone_number: document.getElementById('tenant-phone').value,
            email: document.getElementById('tenant-email').value
        };

        const res = await fetch('/api/tenants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            alert('Mpangaji amehifadhiwa kikamilifu!');
            closeModal('modal-tenant');
            loadStats();
        }
    });
});

async function loadStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('stat-properties').innerText = data.properties || 0;
        document.getElementById('stat-tenants').innerText = data.tenants || 0;
    } catch (err) {
        console.error(err);
    }
}

async function loadProperties() {
    try {
        const res = await fetch('/api/properties');
        const properties = await res.json();
        const container = document.getElementById('property-list');
        container.innerHTML = '';

        if (properties.length === 0) {
            container.innerHTML = '<p class="text-xs text-gray-400">Hakuna majengo yaliyosajiliwa bado.</p>';
            return;
        }

        properties.forEach(p => {
            const item = document.createElement('div');
            item.className = 'bg-[#172447] p-4 rounded-xl flex justify-between items-center';
            item.innerHTML = `
                <div>
                    <div class="font-semibold text-white">${p.title}</div>
                    <div class="text-xs text-gray-400">${p.location} • ${p.category}</div>
                </div>
                <span class="text-xs bg-blue-900/60 text-blue-300 border border-blue-700 px-3 py-1 rounded-full">${p.transaction_type}</span>
            `;
            container.appendChild(item);
        });
    } catch (err) {
        console.error(err);
    }
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
