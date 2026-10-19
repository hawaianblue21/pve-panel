// Role-based access control for the administration interface.
//
// Every administrator has a role; a role is a set of permissions. Each admin API
// route is mapped to the permission it needs (ROUTES below). A route that is not
// in the map needs `rbac.write`, so a forgotten mapping fails closed (only owners).
// Administrators without a role are owners: that is the first administrator from
// the bootstrap and anyone created on the command line.

import { db } from './db.js';

export const PERMISSIONS = [
  { key: 'customers.read', group: 'Customers', label: 'View customers and their limits' },
  { key: 'customers.write', group: 'Customers', label: 'Add, change, invite and delete customers' },
  { key: 'servers.read', group: 'Servers', label: 'View servers, templates and tasks' },
  { key: 'servers.manage', group: 'Servers', label: 'Assign, power, expire and unassign servers' },
  { key: 'servers.delete', group: 'Servers', label: 'Delete servers with their disks' },
  { key: 'templates.write', group: 'Servers', label: 'Offer, set up and withdraw OS templates' },
  { key: 'network.read', group: 'Network', label: 'View networks, VPN and Tailscale' },
  { key: 'network.write', group: 'Network', label: 'Remove VPN devices, resync the gateway' },
  { key: 'ipam.write', group: 'Network', label: 'Manage public IP pools (IPv4, optional IPv6), reserve and free addresses, IPAM settings' },
  { key: 'pools.read', group: 'Resources', label: 'View resource pools and datacenters' },
  { key: 'pools.write', group: 'Resources', label: 'Change resource pools, datacenters and pool members' },
  { key: 'storage.read', group: 'Resources', label: 'View block storage volumes and object storage (SeaweedFS)' },
  { key: 'storage.write', group: 'Resources', label: 'Configure block storage tiers, object storage, buckets and access keys' },
  { key: 'gpu.read', group: 'Resources', label: 'View GPU inventory and profiles' },
  { key: 'gpu.write', group: 'Resources', label: 'Manage GPU profiles, attach and detach GPUs' },
  { key: 'settings.read', group: 'Panel', label: 'View panel settings' },
  { key: 'settings.write', group: 'Panel', label: 'Change panel settings (email, sign-in, branding, appearance, updates, expiry)' },
  { key: 'support.read', group: 'Support', label: 'Read support tickets' },
  { key: 'support.write', group: 'Support', label: 'Answer, assign and close support tickets' },
  { key: 'kb.write', group: 'Support', label: 'Write and publish knowledge-base articles' },
  { key: 'plans.read', group: 'Billing', label: 'View plans' },
  { key: 'plans.write', group: 'Billing', label: 'Create, change and retire plans and their prices' },
  { key: 'billing.read', group: 'Billing', label: 'View invoices, payments and wallets' },
  { key: 'billing.write', group: 'Billing', label: 'Confirm payments, cancel invoices, adjust wallets and prices' },
  { key: 'hosts.write', group: 'Servers', label: 'Put Proxmox nodes into maintenance (no new servers there)' },
  { key: 'updates.write', group: 'Servers', label: 'Roll out OS updates to customer servers' },
  { key: 'audit.read', group: 'Panel', label: 'Read the activity log' },
  { key: 'rbac.write', group: 'Panel', label: 'Manage administrators and roles' },
];
const ALL = PERMISSIONS.map((p) => p.key);
const READS = ALL.filter((k) => k.endsWith('.read'));

// Built-in roles are kept in step with this definition on every start and
// can't be edited or deleted; custom roles can be added next to them.
export const BUILTIN_ROLES = [
  { key: 'owner', name: 'Owner', description: 'Everything, including administrators and roles', permissions: ALL },
  // OS templates and panel settings stay with owners (the built-in roles below
  // only read them); give them to a custom role if someone else should change them.
  {
    key: 'operator', name: 'Operator', description: 'Day-to-day operations: customers, servers, network',
    permissions: [...READS, 'customers.write', 'servers.manage', 'servers.delete', 'network.write', 'support.write', 'kb.write', 'updates.write'],
  },
  {
    key: 'agent', name: 'Support agent', description: 'Tickets and the knowledge base; reads customers and servers',
    permissions: [...READS, 'support.write', 'kb.write'],
  },
  {
    key: 'resources', name: 'Resource manager', description: 'Capacity: pools, datacenters, block and object storage, GPUs, public IPs',
    permissions: [...READS, 'pools.write', 'storage.write', 'gpu.write', 'ipam.write', 'hosts.write'],
  },
  {
    key: 'finance', name: 'Finance', description: 'Invoices, payments, wallets, plans and prices; reads everything else',
    permissions: [...READS, 'billing.write', 'plans.write'],
  },
  { key: 'support', name: 'Support (read-only)', description: 'Sees everything, changes nothing', permissions: READS },
];

/** Permission each admin route needs; null = any signed-in administrator. */
const ROUTES = {
  'GET /api/admin/me': null,
  'GET /api/admin/about': null,

  'GET /api/admin/users': 'customers.read',
  'POST /api/admin/users': 'customers.write',
  'POST /api/admin/users/:id/invite': 'customers.write',
  'PATCH /api/admin/users/:id': 'customers.write',
  'GET /api/admin/users/:id/deletion-plan': 'customers.read',
  'DELETE /api/admin/users/:id': 'customers.write',

  'GET /api/admin/vms': 'servers.read',
  'PUT /api/admin/vms/:vmid': 'servers.manage',
  'PUT /api/admin/vms/:vmid/expiry': 'servers.manage',
  'POST /api/admin/vms/:vmid/power/:action': 'servers.manage',
  'DELETE /api/admin/vms/:vmid/server': 'servers.delete',
  'DELETE /api/admin/vms/:vmid': 'servers.manage',
  'GET /api/admin/tasks/:upid': 'servers.read',
  'POST /api/admin/expiry/run': 'servers.manage',

  'GET /api/admin/templates': 'servers.read',
  'PUT /api/admin/templates/:vmid': 'templates.write',
  'DELETE /api/admin/templates/:vmid': 'templates.write',

  'GET /api/admin/vpn': 'network.read',
  'DELETE /api/admin/vpn/devices/:id': 'network.write',
  'POST /api/admin/vpn/sync': 'network.write',
  'GET /api/admin/networks': 'network.read',

  // The Customers tab reads the email settings to know whether invitations work.
  'GET /api/admin/settings/email': 'customers.read',
  'PUT /api/admin/settings/email': 'settings.write',
  'DELETE /api/admin/settings/email': 'settings.write',
  'POST /api/admin/settings/email/test': 'settings.write',
  'GET /api/admin/settings/appearance': 'settings.read',
  'PUT /api/admin/settings/appearance': 'settings.write',
  'GET /api/admin/settings/branding': 'settings.read',
  'PUT /api/admin/settings/branding': 'settings.write',
  'PUT /api/admin/settings/branding/:asset': 'settings.write',
  'DELETE /api/admin/settings/branding/:asset': 'settings.write',
  'GET /api/admin/settings/sso': 'settings.read',
  'PUT /api/admin/settings/sso/:provider': 'settings.write',
  'GET /api/admin/settings/winupdates': 'settings.read',
  'PUT /api/admin/settings/winupdates': 'settings.write',
  'GET /api/admin/settings/expiry': 'settings.read',
  'PUT /api/admin/settings/expiry': 'settings.write',

  'GET /api/admin/support/tickets': 'support.read',
  'GET /api/admin/support/tickets/:number': 'support.read',
  'POST /api/admin/support/tickets/:number/messages': 'support.write',
  'PATCH /api/admin/support/tickets/:number': 'support.write',
  'POST /api/admin/support/tickets/:number/kb-draft': 'kb.write',
  'GET /api/admin/kb': 'support.read',
  'GET /api/admin/kb/:id': 'support.read',
  'GET /api/admin/kb-search': 'support.read',
  'POST /api/admin/kb': 'kb.write',
  'PUT /api/admin/kb/:id': 'kb.write',
  'DELETE /api/admin/kb/:id': 'kb.write',
  'GET /api/admin/ai': 'support.read',
  'GET /api/admin/ai/conversations/:id': 'support.read',
  'GET /api/admin/settings/ai': 'settings.read',
  'PUT /api/admin/settings/ai': 'settings.write',
  'POST /api/admin/settings/ai/test': 'settings.write',
  'GET /api/admin/settings/zammad': 'settings.read',
  'PUT /api/admin/settings/zammad': 'settings.write',
  'POST /api/admin/settings/zammad/test': 'settings.write',
  'POST /api/admin/settings/zammad/retry': 'support.write',
  'GET /api/admin/plans': 'plans.read',
  'POST /api/admin/plans': 'plans.write',
  'PUT /api/admin/plans/:id': 'plans.write',
  'DELETE /api/admin/plans/:id': 'plans.write',
  'PUT /api/admin/settings/plans': 'plans.write',
  'GET /api/admin/billing': 'billing.read',
  'GET /api/admin/billing/invoices/:number': 'billing.read',
  'POST /api/admin/billing/invoices/:number/mark-paid': 'billing.write',
  'POST /api/admin/billing/invoices/:number/void': 'billing.write',
  'POST /api/admin/billing/wallets/:userId': 'billing.write',
  'PUT /api/admin/billing/servers/:vmid/price': 'billing.write',
  'POST /api/admin/billing/auto-renew/run': 'billing.write',
  'GET /api/admin/settings/billing': 'settings.read',
  'PUT /api/admin/settings/billing': 'settings.write',
  'GET /api/admin/audit': 'audit.read',
  'GET /api/admin/activity': 'audit.read',

  'GET /api/admin/rbac': 'rbac.write',
  'POST /api/admin/rbac/roles': 'rbac.write',
  'PUT /api/admin/rbac/roles/:id': 'rbac.write',
  'DELETE /api/admin/rbac/roles/:id': 'rbac.write',
  'PUT /api/admin/rbac/admins/:id': 'rbac.write',

  'GET /api/admin/datacenters': 'pools.read',
  'POST /api/admin/datacenters': 'pools.write',
  'PUT /api/admin/datacenters/:id': 'pools.write',
  'DELETE /api/admin/datacenters/:id': 'pools.write',
  'GET /api/admin/pools': 'pools.read',
  'POST /api/admin/pools': 'pools.write',
  'PUT /api/admin/pools/:id': 'pools.write',
  'DELETE /api/admin/pools/:id': 'pools.write',
  'PUT /api/admin/pools/:id/members/:userId': 'pools.write',
  'DELETE /api/admin/pools/:id/members/:userId': 'pools.write',

  'GET /api/admin/dashboard': null,
  'GET /api/admin/clusters': 'servers.read',
  'POST /api/admin/clusters/test': 'rbac.write',
  'POST /api/admin/clusters': 'rbac.write',
  'PUT /api/admin/clusters/:id': 'rbac.write',
  'DELETE /api/admin/clusters/:id': 'rbac.write',
  'GET /api/admin/jobs': 'servers.read',
  'POST /api/admin/jobs/retry': 'servers.read',
  'GET /api/admin/updates/fleet': 'servers.read',
  'POST /api/admin/updates/check': 'updates.write',
  'GET /api/admin/updates/rollouts': 'servers.read',
  'GET /api/admin/updates/rollouts/:id': 'servers.read',
  'POST /api/admin/updates/rollouts': 'updates.write',
  'POST /api/admin/updates/rollouts/:id/:action': 'updates.write',
  'GET /api/admin/tokens': null,
  'POST /api/admin/tokens': null,
  'DELETE /api/admin/tokens/:id': null,
  'GET /api/admin/tokens/all': 'rbac.write',
  'DELETE /api/admin/tokens/all/:id': 'rbac.write',
  'GET /api/admin/hosts': 'servers.read',
  'PUT /api/admin/hosts/:node/maintenance': 'hosts.write',
  'GET /api/admin/ipam': 'network.read',
  'POST /api/admin/ipam/pools': 'ipam.write',
  'PUT /api/admin/ipam/pools/:id': 'ipam.write',
  'DELETE /api/admin/ipam/pools/:id': 'ipam.write',
  'GET /api/admin/ipam/pools/:id/addresses': 'network.read',
  'PUT /api/admin/ipam/addresses/:id': 'ipam.write',
  'GET /api/admin/settings/ipam': 'network.read',
  'PUT /api/admin/settings/ipam': 'ipam.write',
  'GET /api/admin/volumes': 'storage.read',
  'GET /api/admin/settings/volumes': 'storage.read',
  'PUT /api/admin/settings/volumes': 'storage.write',
  'GET /api/admin/storage/s3': 'storage.read',
  'PUT /api/admin/storage/s3': 'storage.write',
  'POST /api/admin/storage/s3/test': 'storage.write',
  'GET /api/admin/storage/s3/buckets': 'storage.read',
  'POST /api/admin/storage/s3/buckets': 'storage.write',
  'DELETE /api/admin/storage/s3/buckets/:name': 'storage.write',
  'PATCH /api/admin/storage/s3/buckets/:name': 'storage.write',
  'POST /api/admin/storage/s3/keys/:userId': 'storage.write',

  'GET /api/admin/gpu': 'gpu.read',
  'POST /api/admin/gpu/profiles': 'gpu.write',
  'PUT /api/admin/gpu/profiles/:id': 'gpu.write',
  'DELETE /api/admin/gpu/profiles/:id': 'gpu.write',
  'POST /api/admin/vms/:vmid/gpu': 'gpu.write',
  'DELETE /api/admin/vms/:vmid/gpu/:slot': 'gpu.write',
};

/** The permission a route needs. Unmapped routes need rbac.write (owners only). */
export function permissionFor(method, url) {
  const key = `${method} ${url}`;
  return key in ROUTES ? ROUTES[key] : 'rbac.write';
}

// ---- Roles in the database ------------------------------------------------------

const parse = (r) => r && ({ ...r, builtin: !!r.builtin, permissions: JSON.parse(r.permissions) });

export function seedRoles() {
  const upsert = db.prepare(`
    INSERT INTO admin_roles (key, name, description, builtin, permissions) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description,
      builtin = 1, permissions = excluded.permissions
  `);
  for (const r of BUILTIN_ROLES) upsert.run(r.key, r.name, r.description, JSON.stringify(r.permissions));
}
seedRoles();

export const listRoles = () => db.prepare(`
  SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.is_admin = 1 AND u.admin_role_id = r.id) AS members
  FROM admin_roles r ORDER BY r.builtin DESC, r.name
`).all().map(parse);

export const roleById = (id) => parse(db.prepare('SELECT * FROM admin_roles WHERE id = ?').get(id));
export const roleByKey = (key) => parse(db.prepare('SELECT * FROM admin_roles WHERE key = ?').get(key));

/** Role of an administrator (owner when none is set). */
export function roleOf(account) {
  if (!account?.is_admin) return null;
  return (account.admin_role_id && roleById(account.admin_role_id)) || roleByKey('owner');
}

export function permissionsOf(account) {
  return new Set(roleOf(account)?.permissions ?? []);
}

export const can = (account, permission) => permissionsOf(account).has(permission);

export class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

/** Throws 403 unless the administrator has the permission. */
export function requirePermission(account, permission) {
  if (!can(account, permission)) {
    const label = PERMISSIONS.find((p) => p.key === permission)?.label ?? permission;
    throw new AccessError(403, `Your role doesn't allow this (${label.toLowerCase()})`);
  }
}

/** Fastify preHandler for the admin server, after authentication. */
export async function enforceRoutePermission(req) {
  const permission = permissionFor(req.method, req.routeOptions?.url ?? '');
  if (permission) requirePermission(req.account, permission);
}

/** Administrators who are owners and not being deleted. */
function ownerIds() {
  const owner = roleByKey('owner');
  return db.prepare(`SELECT id FROM users WHERE is_admin = 1 AND deleting = 0
    AND (admin_role_id IS NULL OR admin_role_id = ?)`).all(owner.id).map((r) => r.id);
}

/** Refuses a change that would leave no owner (nobody could manage roles any more). */
export function assertOwnerRemains(userId, { newRoleId = undefined, removingAdmin = false } = {}) {
  const owners = ownerIds();
  if (!owners.includes(userId)) return;
  const owner = roleByKey('owner');
  const staysOwner = !removingAdmin && (newRoleId === undefined || newRoleId === null || newRoleId === owner.id);
  if (!staysOwner && owners.length <= 1) {
    throw new AccessError(409, 'This is the last owner. Make another administrator an owner first.');
  }
}

const ROLE_KEY = /^[a-z][a-z0-9-]{1,30}$/;

function cleanPermissions(list) {
  const unknown = list.filter((p) => !ALL.includes(p));
  if (unknown.length) throw new AccessError(400, `Unknown permission: ${unknown.join(', ')}`);
  return [...new Set(list)];
}

export function createRole({ key, name, description = '', permissions = [] }) {
  if (!ROLE_KEY.test(key)) throw new AccessError(400, 'Role key: 2-31 lowercase letters, digits or dashes, starting with a letter');
  if (roleByKey(key)) throw new AccessError(409, 'A role with this key already exists');
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO admin_roles (key, name, description, builtin, permissions) VALUES (?, ?, ?, 0, ?)',
  ).run(key, name.trim(), description.trim(), JSON.stringify(cleanPermissions(permissions)));
  return roleById(Number(lastInsertRowid));
}

export function updateRole(id, { name, description, permissions }) {
  const role = roleById(id);
  if (!role) throw new AccessError(404, 'Role not found');
  if (role.builtin) throw new AccessError(409, 'Built-in roles can\'t be changed; create your own role instead');
  db.prepare('UPDATE admin_roles SET name = ?, description = ?, permissions = ? WHERE id = ?').run(
    (name ?? role.name).trim(), (description ?? role.description ?? '').trim(),
    JSON.stringify(permissions ? cleanPermissions(permissions) : role.permissions), id,
  );
  return roleById(id);
}

export function deleteRole(id) {
  const role = roleById(id);
  if (!role) throw new AccessError(404, 'Role not found');
  if (role.builtin) throw new AccessError(409, 'Built-in roles can\'t be deleted');
  const members = db.prepare('SELECT COUNT(*) AS n FROM users WHERE admin_role_id = ?').get(id).n;
  if (members) throw new AccessError(409, `${members} administrator(s) still have this role. Give them another role first.`);
  db.prepare('DELETE FROM admin_roles WHERE id = ?').run(id);
}

/** Sets the role of an administrator (by role id). */
export function setAdminRole(userId, roleId) {
  const user = db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').get(userId);
  if (!user) throw new AccessError(404, 'User not found');
  if (!user.is_admin) throw new AccessError(400, 'This user is not an administrator');
  const role = roleById(roleId);
  if (!role) throw new AccessError(400, 'Role not found');
  assertOwnerRemains(userId, { newRoleId: role.id });
  db.prepare('UPDATE users SET admin_role_id = ? WHERE id = ?').run(role.id, userId);
  return { user, role };
}

export function listAdmins() {
  const owner = roleByKey('owner');
  return db.prepare(`
    SELECT u.id, u.email, u.admin_role_id AS roleId, u.totp_enabled AS totpEnabled,
           (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys, u.created_at AS createdAt
    FROM users u WHERE u.is_admin = 1 AND u.deleting = 0 ORDER BY u.email
  `).all().map((a) => {
    const role = (a.roleId && roleById(a.roleId)) || owner;
    return { ...a, roleId: role.id, roleKey: role.key, roleName: role.name, totpEnabled: !!a.totpEnabled };
  });
}
