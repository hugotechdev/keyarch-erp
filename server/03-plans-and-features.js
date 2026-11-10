// PLANS, FEATURES AND ACCESS (Standard / Pro)
// Part of the KEY ARCH server. server.js loads the parts in number order and shares what they need through ctx.
module.exports = function (ctx) {
    const { pool } = ctx;


    // ============================================================
    // PLANS, FEATURES AND ACCESS (Standard / Pro)
    // Change the numbers below to change what each plan allows.
    // ============================================================
    const GRACE_DAYS = 0; // extra days of access after a subscription ends
    const SUPPORT = { name: 'HUGO TECH', whatsapp: '+255785799530', email: 'info@hugotech.co.tz' };

    const PLAN_DEFAULTS = {
        STANDARD: { luku: false, tickets: false, reports_advanced: false, backup_full: false, org: false, structure: false, ai: false, max_properties: 5, max_staff: 3, max_ai_questions: 100 },
        PRO:      { luku: true,  tickets: true,  reports_advanced: true,  backup_full: true,  org: true,  structure: false, ai: true,  max_properties: null, max_staff: null, max_ai_questions: 300 }
    };
    const FEATURE_KEYS = ['luku', 'tickets', 'reports_advanced', 'backup_full', 'org', 'structure', 'ai'];
    const LIMIT_KEYS = ['max_properties', 'max_staff', 'max_ai_questions'];

    // plan defaults + the special settings the Super Admin gave to one company (0 = unlimited)
    function effectiveFeatures(plan, overrides) {
        const eff = { ...(PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.STANDARD) };
        if (overrides && typeof overrides === 'object') {
            FEATURE_KEYS.forEach(k => { if (typeof overrides[k] === 'boolean') eff[k] = overrides[k]; });
            LIMIT_KEYS.forEach(k => {
                if (typeof overrides[k] === 'number') eff[k] = overrides[k] === 0 ? null : overrides[k];
            });
        }
        return eff;
    }

    function sanitizeFeatures(input) {
        const out = {};
        if (!input || typeof input !== 'object') return out;
        FEATURE_KEYS.forEach(k => { if (typeof input[k] === 'boolean') out[k] = input[k]; });
        LIMIT_KEYS.forEach(k => { const n = parseInt(input[k]); if (!isNaN(n) && n >= 0) out[k] = n; });
        return out;
    }

    const accessCache = new Map();
    function clearAccessCache(companyId) { accessCache.delete(String(companyId)); }

    async function getCompanyAccess(companyId) {
        const key = String(companyId);
        const hit = accessCache.get(key);
        if (hit && Date.now() - hit.at < 30000) return hit.data;
        try {
            const r = await pool.query(
                `SELECT company_id, company_name, is_active, plan, access_status, billing_type, features,
                        to_char(paid_until, 'YYYY-MM-DD') AS paid_until,
                        (paid_until::date - CURRENT_DATE) AS days_left,
                        (billing_type = 'SUBSCRIPTION' AND (paid_until IS NULL OR paid_until::date < CURRENT_DATE - $2::int)) AS expired
                 FROM companies WHERE company_id = $1`,
                [companyId, GRACE_DAYS]
            );
            const data = r.rows[0] || null;
            accessCache.set(key, { at: Date.now(), data });
            return data;
        } catch (err) {
            console.error('Access check warning (allowing access):', err.message);
            return null;
        }
    }

    function accessBlock(a) {
        if (!a) return null;
        if (a.is_active === false || a.access_status === 'SUSPENDED') {
            return { code: 'ACCOUNT_SUSPENDED', message: 'Your account is suspended. Please contact ' + SUPPORT.name + ' to restore access.' };
        }
        if (a.access_status === 'PENDING') {
            return { code: 'ACCOUNT_PENDING', message: 'Your company is registered but not active yet. Access starts after your payment is confirmed.' };
        }
        if (a.expired) {
            return { code: 'SUBSCRIPTION_EXPIRED', message: 'Your subscription has ended. Please renew to continue using the system.' };
        }
        return null;
    }

    function companyInfo(a) {
        const plan = a ? (a.plan || 'STANDARD') : 'PRO';
        return {
            company_id: a ? a.company_id : null,
            company_name: a ? a.company_name : null,
            plan,
            access_status: a ? a.access_status : 'ACTIVE',
            billing_type: a ? a.billing_type : null,
            paid_until: a ? a.paid_until : null,
            days_left: a && a.days_left !== null && a.days_left !== undefined ? Number(a.days_left) : null,
            features: effectiveFeatures(plan, a ? a.features : null),
            support: SUPPORT
        };
    }

    function superAdminCompanyInfo(name) {
        return {
            company_name: name, plan: 'PRO', access_status: 'ACTIVE', billing_type: 'ONE_TIME', paid_until: null, days_left: null,
            features: effectiveFeatures('PRO', {}), support: SUPPORT
        };
    }

    // use on routes that belong to Pro features:  app.get('/x', authenticateToken, requireFeature('luku'), ...)
    function requireFeature(key) {
        return async (req, res, next) => {
            if (req.user.role === 'SUPER_ADMIN') return next();
            const a = await getCompanyAccess(req.user.company_id);
            if (!effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null)[key]) {
                return res.status(403).json({ error: 'This feature is available on the Pro plan. Please contact ' + SUPPORT.name + ' to upgrade.', code: 'FEATURE_LOCKED' });
            }
            next();
        };
    }

    // returns a message when the company reached its plan limit, otherwise null
    async function checkLimit(user, limitKey, countSql, what) {
        if (user.role === 'SUPER_ADMIN') return null;
        const a = await getCompanyAccess(user.company_id);
        const limit = effectiveFeatures(a ? (a.plan || 'STANDARD') : 'PRO', a ? a.features : null)[limitKey];
        if (limit === null || limit === undefined) return null;
        const count = parseInt((await pool.query(countSql, [user.company_id])).rows[0].count);
        if (count >= limit) {
            return `Your plan allows up to ${limit} ${what}. Please contact ${SUPPORT.name} to upgrade.`;
        }
        return null;
    }
    return { GRACE_DAYS, SUPPORT, accessBlock, accessCache, checkLimit, clearAccessCache, companyInfo, effectiveFeatures, getCompanyAccess, requireFeature, sanitizeFeatures, superAdminCompanyInfo };
};
