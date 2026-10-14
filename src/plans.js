// Plans: fixed server sizes (vCPU, memory, disk, optionally a GPU) with a monthly
// price. Customers create servers from a plan; with billing on and a price set,
// the first period is paid from the wallet before the server is set up (billing.js),
// and a server can later move up to a larger plan for the difference.
//
// Settings: whether customers may still choose their own size next to the plans.

import { db } from './db.js';

const KEY = 'plans';
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const DEFAULTS = { requirePlan: false };

export function planSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}

export function savePlanSettings(input) {
  const s = planSettings();
  if (typeof input.requirePlan === 'boolean') s.requirePlan = input.requirePlan;
  if (s.requirePlan && !db.prepare('SELECT 1 FROM plans WHERE active = 1').get()) {
    throw fail(400, 'Add at least one active plan before requiring plans');
  }
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(s));
  return s;
}

const view = (p) => p && ({
  id: p.id, name: p.name, description: p.description, cores: p.cores, memoryMb: p.memory_mb, diskGb: p.disk_gb,
  gpuProfileId: p.gpu_profile_id, gpuName: p.gpu_name ?? null, priceMonthly: p.price_monthly, active: !!p.active, sort: p.sort,
});

const SELECT = `SELECT p.*, g.name AS gpu_name FROM plans p LEFT JOIN gpu_profiles g ON g.id = p.gpu_profile_id`;

export const planRow = (id) => db.prepare(`${SELECT} WHERE p.id = ?`).get(id);
export const getPlan = (id) => view(planRow(id));

/** All plans for the admin portal, with how many servers use each. */
export function listPlans() {
  const used = new Map(db.prepare('SELECT plan_id, COUNT(*) AS n FROM vms WHERE plan_id IS NOT NULL GROUP BY plan_id').all().map((r) => [r.plan_id, r.n]));
  return db.prepare(`${SELECT} ORDER BY p.sort, p.id`).all().map((p) => ({ ...view(p), servers: used.get(p.id) ?? 0 }));
}

/** Active plans this customer can use: GPU plans only when one of their resource pools offers the GPU. */
export function plansFor(gpuProfileIds) {
  const allowed = new Set(gpuProfileIds);
  return db.prepare(`${SELECT} WHERE p.active = 1 ORDER BY p.sort, p.id`).all()
    .filter((p) => !p.gpu_profile_id || allowed.has(p.gpu_profile_id)).map(view);
}

function int(v, min, max, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${what}: a whole number from ${min} to ${max}`);
  return n;
}

function clean(input, current = null) {
  const pick = (k, fallback) => (input[k] !== undefined ? input[k] : fallback);
  const name = String(pick('name', current?.name ?? '')).trim();
  if (!name || name.length > 60) throw fail(400, 'Name: 1 to 60 characters');
  const description = String(pick('description', current?.description ?? '')).trim().slice(0, 200);
  const cores = int(pick('cores', current?.cores), 1, 128, 'vCPU');
  const memoryMb = int(pick('memoryMb', current?.memory_mb), 512, 1024 * 1024, 'Memory (MB)');
  if (memoryMb % 256) throw fail(400, 'Memory: a multiple of 256 MB');
  const diskGb = int(pick('diskGb', current?.disk_gb), 1, 64 * 1024, 'Disk (GB)');
  const gpu = pick('gpuProfileId', current?.gpu_profile_id ?? null);
  const gpuProfileId = gpu == null || gpu === '' ? null : int(gpu, 1, 1e9, 'GPU profile');
  if (gpuProfileId && !db.prepare('SELECT 1 FROM gpu_profiles WHERE id = ?').get(gpuProfileId)) throw fail(400, 'That GPU profile does not exist');
  const price = pick('priceMonthly', current?.price_monthly ?? null);
  const priceMonthly = price == null || price === '' ? null : int(price, 0, 1_000_000_000, 'Price per month');
  const active = typeof input.active === 'boolean' ? input.active : current ? !!current.active : true;
  const sort = int(pick('sort', current?.sort ?? 0), -1000, 1000, 'Order');
  return { name, description, cores, memoryMb, diskGb, gpuProfileId, priceMonthly, active, sort };
}

export function createPlan(input) {
  const p = clean(input);
  const id = Number(db.prepare(`INSERT INTO plans (name, description, cores, memory_mb, disk_gb, gpu_profile_id, price_monthly, active, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.name, p.description, p.cores, p.memoryMb, p.diskGb, p.gpuProfileId, p.priceMonthly, p.active ? 1 : 0, p.sort).lastInsertRowid);
  return getPlan(id);
}

/**
 * Changing a plan applies to new servers and upgrades. Servers already on it keep
 * their size; a new price applies from their next renewal.
 */
export function updatePlan(id, input) {
  const cur = planRow(id);
  if (!cur) throw fail(404, 'Plan not found');
  const p = clean(input, cur);
  const used = db.prepare('SELECT COUNT(*) AS n FROM vms WHERE plan_id = ?').get(id).n;
  if (used && (p.cores !== cur.cores || p.memoryMb !== cur.memory_mb || p.diskGb !== cur.disk_gb || p.gpuProfileId !== cur.gpu_profile_id)) {
    throw fail(409, `${used} server${used === 1 ? ' uses' : 's use'} this plan, so its size can't change. Create a new plan and deactivate this one.`);
  }
  if (cur.active && !p.active && planSettings().requirePlan && db.prepare('SELECT COUNT(*) AS n FROM plans WHERE active = 1').get().n === 1) {
    throw fail(409, 'Customers must choose a plan, so the last active plan stays active');
  }
  // servers on this plan follow its price from their next invoice (unless they have a fixed price)
  db.prepare(`UPDATE plans SET name = ?, description = ?, cores = ?, memory_mb = ?, disk_gb = ?, gpu_profile_id = ?, price_monthly = ?, active = ?, sort = ? WHERE id = ?`)
    .run(p.name, p.description, p.cores, p.memoryMb, p.diskGb, p.gpuProfileId, p.priceMonthly, p.active ? 1 : 0, p.sort, id);
  return { ...getPlan(id), servers: used };
}

export function deletePlan(id) {
  const cur = planRow(id);
  if (!cur) throw fail(404, 'Plan not found');
  const used = db.prepare('SELECT COUNT(*) AS n FROM vms WHERE plan_id = ?').get(id).n;
  if (used) throw fail(409, `${used} server${used === 1 ? ' uses' : 's use'} this plan. Deactivate it instead.`);
  if (cur.active && planSettings().requirePlan && db.prepare('SELECT COUNT(*) AS n FROM plans WHERE active = 1').get().n === 1) {
    throw fail(409, 'Customers must choose a plan, so the last active plan can\'t be deleted');
  }
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return { deleted: true };
}

/** A plan another one can be upgraded to: nothing smaller, the same GPU, and not the same plan. */
export function isUpgrade(from, to) {
  return to.id !== from.id && to.cores >= from.cores && to.memoryMb >= from.memoryMb && to.diskGb >= from.diskGb
    && (to.gpuProfileId ?? null) === (from.gpuProfileId ?? null)
    && (to.cores > from.cores || to.memoryMb > from.memoryMb || to.diskGb > from.diskGb);
}
