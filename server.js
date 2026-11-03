<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KEY ARCH ERP — System Access & Operations</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="style.css">
</head>
<body class="min-h-screen flex flex-col justify-between bg-[#060c18] text-gray-100 font-sans">

    <!-- VIEW 1: LOGIN SCREEN -->
    <div id="view-login" class="flex-grow flex items-center justify-center p-4">
        <div class="bg-[#0a1224] border border-[#182848] w-full max-w-md rounded-2xl p-8 shadow-2xl space-y-6">
            <div class="text-center space-y-1">
                <h1 class="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-300 to-cyan-400">
                    KEY ARCH <span class="text-xs font-semibold px-2 py-0.5 rounded bg-blue-600/30 border border-blue-500/50 text-blue-300 align-middle">ERP</span>
                </h1>
                <p class="text-xs text-gray-400 uppercase tracking-widest">Internal Operations Portal</p>
            </div>

            <div id="login-error" class="hidden p-3 bg-red-900/50 border border-red-500/50 rounded-xl text-xs text-red-300 text-center"></div>

            <form id="form-login" class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold text-gray-300 mb-1">Email Address</label>
                    <input type="email" id="login-email" value="admin@keyarch.co.tz" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#233863] text-white text-sm focus:border-blue-500 outline-none" required>
                </div>
                <div>
                    <label class="block text-xs font-semibold text-gray-300 mb-1">Password</label>
                    <input type="password" id="login-password" value="Admin@2026" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#233863] text-white text-sm focus:border-blue-500 outline-none" required>
                </div>
                <button type="submit" class="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-sm shadow-lg transition">
                    Sign In to Portal &rarr;
                </button>
            </form>
            <div class="text-center text-[11px] text-gray-500">
                Default Credentials: <span class="text-gray-300 font-mono">admin@keyarch.co.tz</span> / <span class="text-gray-300 font-mono">Admin@2026</span>
            </div>
        </div>
    </div>

    <!-- VIEW 2: MAIN DASHBOARD -->
    <div id="view-app" class="hidden flex-col min-h-screen justify-between">
        <header class="bg-[#0a1224]/90 backdrop-blur-md border-b border-[#182848] px-6 py-4 sticky top-0 z-40 shadow-2xl flex justify-between items-center">
            <div class="flex items-center space-x-3">
                <span id="user-role-badge" class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-blue-900/80 border border-blue-500 text-blue-300 uppercase">SUPER_ADMIN</span>
                <span id="user-name-display" class="text-xs font-bold text-white hidden md:inline">Hugo Mlula</span>
            </div>
            
            <h1 class="text-xl md:text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-300 to-cyan-400">
                KEY ARCH <span class="text-xs font-semibold px-1.5 py-0.5 rounded bg-blue-600/30 border border-blue-500/50 text-blue-300">ERP</span>
            </h1>

            <button onclick="logout()" class="bg-red-900/40 border border-red-500/50 px-3 py-1.5 rounded-xl text-xs font-bold text-red-300 flex items-center gap-1.5">
                <i class="fa-solid fa-power-off"></i> <span class="hidden md:inline">Sign Out</span>
            </button>
        </header>

        <main class="container mx-auto p-4 md:p-6 max-w-6xl flex-grow">
            <!-- DASHBOARD SECTION -->
            <section id="sec-dashboard" class="space-y-6">
                <div class="p-5 bg-[#0d172d] border border-[#182848] rounded-2xl shadow-xl flex justify-between items-center">
                    <div>
                        <h2 class="text-lg font-bold text-white">System Operations Center</h2>
                        <p class="text-xs text-gray-400">Manage properties, tenants, and team roles securely.</p>
                    </div>
                    <!-- ADMIN REGISTER USER BUTTON -->
                    <button id="btn-admin-register" onclick="openModal('modal-register')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 shadow-lg">
                        <i class="fa-solid fa-user-plus"></i> + Register New Staff / User
                    </button>
                </div>

                <!-- METRICS -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                    <div class="p-4 bg-[#0d172d] border border-[#182848] rounded-2xl">
                        <div class="text-xs text-gray-400 uppercase">Properties</div>
                        <div id="stat-properties" class="text-2xl font-bold text-blue-400">0</div>
                    </div>
                    <div class="p-4 bg-[#0d172d] border border-[#182848] rounded-2xl">
                        <div class="text-xs text-gray-400 uppercase">Active Tenants</div>
                        <div id="stat-tenants" class="text-2xl font-bold text-emerald-400">0</div>
                    </div>
                    <div class="p-4 bg-[#0d172d] border border-[#182848] rounded-2xl">
                        <div class="text-xs text-gray-400 uppercase">Open Tickets</div>
                        <div class="text-2xl font-bold text-amber-400">0</div>
                    </div>
                    <div class="p-4 bg-[#0d172d] border border-[#182848] rounded-2xl">
                        <div class="text-xs text-gray-400 uppercase">System Status</div>
                        <div class="text-2xl font-bold text-cyan-400">ONLINE</div>
                    </div>
                </div>
            </section>
        </main>

        <nav class="bg-[#0a1224]/95 border-t border-[#182848] py-3 sticky bottom-0 z-40">
            <div class="max-w-md mx-auto flex justify-between items-center px-6 text-[10px] font-semibold text-gray-400">
                <button class="text-blue-400 flex flex-col items-center"><i class="fa-solid fa-chart-line text-base mb-1"></i>Home</button>
                <button class="hover:text-white flex flex-col items-center"><i class="fa-solid fa-building text-base mb-1"></i>Properties</button>
                <button class="hover:text-white flex flex-col items-center"><i class="fa-solid fa-users text-base mb-1"></i>Tenants</button>
                <button class="hover:text-white flex flex-col items-center"><i class="fa-solid fa-sliders text-base mb-1"></i>Settings</button>
            </div>
        </nav>
    </div>

    <!-- MODAL: ADMIN REGISTER NEW USER -->
    <div id="modal-register" class="fixed inset-0 bg-black/80 backdrop-blur-sm hidden flex items-center justify-center p-4 z-50">
        <div class="bg-[#0d172d] border border-[#182848] w-full max-w-md rounded-2xl p-6 space-y-4 relative">
            <button onclick="closeModal('modal-register')" class="absolute top-4 right-4 text-gray-400 text-xl">&times;</button>
            <h3 class="font-bold text-lg text-white">Register System User (Staff)</h3>
            <form id="form-register" class="space-y-3">
                <input type="text" id="reg-name" placeholder="Full Name *" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#1e2f52] text-white text-xs" required>
                <input type="email" id="reg-email" placeholder="Email Address *" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#1e2f52] text-white text-xs" required>
                <input type="password" id="reg-password" placeholder="Password *" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#1e2f52] text-white text-xs" required>
                <input type="tel" id="reg-phone" placeholder="Phone Number" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#1e2f52] text-white text-xs">
                <select id="reg-role" class="w-full p-3 rounded-xl bg-[#14223d] border border-[#1e2f52] text-white text-xs">
                    <option value="PROPERTY_MANAGER">Property Manager</option>
                    <option value="ACCOUNTANT">Accountant</option>
                    <option value="TECHNICIAN">Technician / Maintenance</option>
                    <option value="SUPER_ADMIN">Super Admin</option>
                </select>
                <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 py-3 rounded-xl text-white font-bold text-xs">Register Staff Member</button>
            </form>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            if (localStorage.getItem('keyarch_token')) {
                showAppView();
            }

            document.getElementById('form-login').addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = document.getElementById('login-email').value;
                const password = document.getElementById('login-password').value;
                
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();

                if (res.ok) {
                    localStorage.setItem('keyarch_token', data.token);
                    localStorage.setItem('keyarch_user', JSON.stringify(data.user));
                    showAppView();
                } else {
                    alert(data.error || 'Login Failed!');
                }
            });

            // ADMIN REGISTER USER SUBMIT
            document.getElementById('form-register').addEventListener('submit', async (e) => {
                e.preventDefault();
                const token = localStorage.getItem('keyarch_token');
                const userData = {
                    full_name: document.getElementById('reg-name').value,
                    email: document.getElementById('reg-email').value,
                    password: document.getElementById('reg-password').value,
                    phone_number: document.getElementById('reg-phone').value,
                    role: document.getElementById('reg-role').value
                };

                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(userData)
                });

                if (res.ok) {
                    alert('Mtumiaji mpya amesajiliwa kikamilifu!');
                    closeModal('modal-register');
                } else {
                    const err = await res.json();
                    alert(err.error || 'Usajili umeshindikana!');
                }
            });
        });

        function showAppView() {
            document.getElementById('view-login').classList.add('hidden');
            document.getElementById('view-app').classList.remove('hidden');
            document.getElementById('view-app').classList.add('flex');

            const user = JSON.parse(localStorage.getItem('keyarch_user') || '{}');
            document.getElementById('user-role-badge').innerText = user.role || 'SUPER_ADMIN';
            document.getElementById('user-name-display').innerText = user.full_name || 'Hugo Mlula';

            // Hide Register Button if Not Super Admin
            if (user.role !== 'SUPER_ADMIN') {
                document.getElementById('btn-admin-register').classList.add('hidden');
            }

            loadDashboardSummary();
        }

        async function loadDashboardSummary() {
            const token = localStorage.getItem('keyarch_token');
            const res = await fetch('/api/dashboard/summary', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                document.getElementById('stat-properties').innerText = data.properties;
                document.getElementById('stat-tenants').innerText = data.tenants;
            }
        }

        function logout() {
            localStorage.removeItem('keyarch_token');
            localStorage.removeItem('keyarch_user');
            window.location.reload();
        }

        function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
        function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
    </script>
</body>
</html>