import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

// Node's built-in SQLite: no native build step needed on any platform.
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Which customer owns which guest. This table is the source of truth
  -- for every permission check in the panel.
  CREATE TABLE IF NOT EXISTS vms (
    vmid    INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type    TEXT NOT NULL DEFAULT 'qemu' CHECK (type IN ('qemu', 'lxc')),
    label   TEXT
  );

  -- Tasks started through the panel, so users can only poll their own.
  CREATE TABLE IF NOT EXISTS tasks (
    upid       TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vmid       INTEGER NOT NULL,
    node       TEXT NOT NULL,
    action     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER,
    vmid       INTEGER,
    action     TEXT NOT NULL,
    detail     TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- Migrations for existing databases -----------------------------------
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Self-service server creation (off unless an admin enables it per customer)
addColumn('users', 'can_create', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'max_servers', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'max_cores', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'max_memory_mb', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'max_disk_gb', 'INTEGER NOT NULL DEFAULT 0');

// ready | creating | failed | deleting
addColumn('vms', 'state', "TEXT NOT NULL DEFAULT 'ready'");
addColumn('vms', 'error', 'TEXT');
addColumn('vms', 'created_by_customer', 'INTEGER NOT NULL DEFAULT 0');
addColumn('vms', 'spec', 'TEXT'); // JSON: requested { cores, memoryMb, diskGb }

// Templates customers may create servers from
db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    vmid     INTEGER PRIMARY KEY,
    label    TEXT NOT NULL,
    storage  TEXT,               -- target storage for the full clone; NULL = template's storage
    ci_user  TEXT,               -- suggested login user
    ipconfig TEXT NOT NULL DEFAULT 'ip=dhcp'
  );
`);

// How a template is prepared after cloning: cloud-init (Linux) or guest agent (Windows)
addColumn('templates', 'setup', "TEXT NOT NULL DEFAULT 'cloudinit'");
// Human-readable step shown to the customer while a server is being set up
addColumn('vms', 'progress', 'TEXT');

// One private network (SDN VNet + /24) per customer. If a customer is deleted the
// row stays (user_id NULL) so the subnet isn't handed out again while servers use it.
db.exec(`
  CREATE TABLE IF NOT EXISTS networks (
    vnet       TEXT PRIMARY KEY,
    user_id    INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    idx        INTEGER UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// VPN devices. Only the public key is stored; the private key is shown once.
db.exec(`
  CREATE TABLE IF NOT EXISTS vpn_devices (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    public_key TEXT UNIQUE NOT NULL,
    host       INTEGER NOT NULL,     -- last octet of the device address
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, host)
  );
`);

// Tailscale on customer servers (the customer's own tailnet). No keys stored.
db.exec(`
  CREATE TABLE IF NOT EXISTS tailscale (
    vmid       INTEGER PRIMARY KEY REFERENCES vms(vmid) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode       TEXT NOT NULL CHECK (mode IN ('server', 'gateway')),
    state      TEXT NOT NULL,          -- installing | connected | failed | disconnecting
    progress   TEXT,
    error      TEXT,
    hostname   TEXT,
    ts_ip      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Two-factor authentication (TOTP). Secrets encrypted, recovery codes hashed.
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_pending', 'TEXT');           // during enrolment, until confirmed
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_required', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_last_step', 'INTEGER');      // last used time step (no replay)
addColumn('users', 'recovery_codes', 'TEXT');         // JSON array of SHA-256 hashes

// Single sign-on: the account is linked to the provider's stable identity
// (issuer + subject), not to the email address, which can change.
addColumn('users', 'oidc_issuer', 'TEXT');
addColumn('users', 'oidc_subject', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_identity
  ON users (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL`);

// Deleting a customer is a background job (servers, VPN, network, then the account)
addColumn('users', 'deleting', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'deletion_error', 'TEXT');

// Proxmox OS type of each server (e.g. "win11", "l26"), remembered so lists and
// the network map can show the right OS glyph without reading every config.
addColumn('vms', 'ostype', 'TEXT');

// Settings changed in the admin interface (e.g. email), as JSON per key
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Invitations: the user sets their own password through a one-time link.
// Only a SHA-256 hash of the token is stored.
addColumn('users', 'password_set', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'invite_token_hash', 'TEXT');
addColumn('users', 'invite_expires', 'TEXT');
addColumn('users', 'invited_at', 'TEXT');

// Passkeys (WebAuthn). The public key is stored, never a secret. The user handle
// stored in passkeys is a random value per account, not the email address.
addColumn('users', 'webauthn_user_id', 'TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS passkeys (
    id           TEXT PRIMARY KEY,                 -- credential ID (base64url)
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rp_id        TEXT NOT NULL,                    -- domain it belongs to
    public_key   TEXT NOT NULL,                    -- COSE public key (base64url)
    counter      INTEGER NOT NULL DEFAULT 0,
    transports   TEXT,                             -- JSON array
    device_type  TEXT,                             -- singleDevice | multiDevice (synced)
    backed_up    INTEGER NOT NULL DEFAULT 0,
    name         TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
`);

// Expiry (opt-in per customer): servers are reminded, stopped at expiry, kept for
// a grace period, then deleted (customer-created servers only).
addColumn('users', 'expiry_mode', 'TEXT');                 // NULL | after_creation | fixed_date
addColumn('users', 'expiry_days', 'INTEGER');              // for after_creation
addColumn('users', 'expiry_date', 'TEXT');                 // YYYY-MM-DD, for fixed_date
addColumn('users', 'expiry_self_extend', 'INTEGER NOT NULL DEFAULT 0');
addColumn('vms', 'expires_at', 'TEXT');                    // ISO time, NULL = never
addColumn('vms', 'expiry_set_at', 'TEXT');                 // when the date was set (for reminders)
addColumn('vms', 'expiry_manual', 'INTEGER NOT NULL DEFAULT 0'); // set by hand, not by the customer rule
addColumn('vms', 'expired_at', 'TEXT');                    // stopped by expiry; grace period runs from here
addColumn('vms', 'expiry_notified', 'TEXT');               // JSON: emails already sent
addColumn('vms', 'self_extended', 'INTEGER NOT NULL DEFAULT 0');

// Windows updates started through the panel (one row per run)
db.exec(`
  CREATE TABLE IF NOT EXISTS winupdates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    vmid         INTEGER NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL,
    run_id       TEXT NOT NULL,
    scope        TEXT NOT NULL,
    auto_restart INTEGER NOT NULL DEFAULT 1,
    snapshot     TEXT,
    state        TEXT NOT NULL,
    status_json  TEXT,
    error        TEXT,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS winupdates_vm ON winupdates(vmid);
`);

// ---- Role-based access for the administration interface ----------------------
// A role is a named set of permissions (see rbac.js). Administrators without a
// role (created by the first-start bootstrap or the command line) are owners.
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_roles (
    id          INTEGER PRIMARY KEY,
    key         TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    builtin     INTEGER NOT NULL DEFAULT 0,
    permissions TEXT NOT NULL DEFAULT '[]',   -- JSON array of permission keys
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Not a foreign key with ON DELETE SET NULL: "no role" means owner, so deleting a
// role must never silently promote its members. rbac.js refuses deleting a role in use.
addColumn('users', 'admin_role_id', 'INTEGER');

// ---- Datacenters and resource allocation pools --------------------------------
// A datacenter is a named location made of Proxmox nodes. A resource pool is a
// shared envelope (vCPU, memory, disk, public IPs, GPUs, object storage and the
// datacenters it may use) that several customers draw from, e.g. one tenant
// organisation or reseller. Compute limits: NULL = no pool-level cap, 0 = none.
// GPUs and object storage are opt-in: NULL or 0 = not included (pools.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS datacenters (
    id         INTEGER PRIMARY KEY,
    key        TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    location   TEXT,
    nodes      TEXT NOT NULL DEFAULT '[]',     -- JSON array of Proxmox node names
    storage    TEXT,                           -- target storage for new servers here
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resource_pools (
    id             INTEGER PRIMARY KEY,
    name           TEXT UNIQUE NOT NULL,
    description    TEXT,
    max_cores      INTEGER,
    max_memory_mb  INTEGER,
    max_disk_gb    INTEGER,
    max_public_ips INTEGER,
    max_gpus       INTEGER,
    max_s3_buckets INTEGER,
    max_s3_gb      INTEGER,
    datacenters    TEXT NOT NULL DEFAULT '[]', -- JSON array of datacenter ids; [] = all
    gpu_profiles   TEXT NOT NULL DEFAULT '[]', -- JSON array of GPU profile ids; [] = all
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
addColumn('users', 'resource_pool_id', 'INTEGER REFERENCES resource_pools(id) ON DELETE SET NULL');
addColumn('vms', 'datacenter_id', 'INTEGER');

// ---- GPUs ------------------------------------------------------------------------
// A GPU profile points at a Proxmox PCI resource mapping (Datacenter > Resource
// Mappings), either as a whole device (passthrough) or as a mediated device type
// (NVIDIA vGPU / mdev). Assignments record which server holds which GPU slot.
db.exec(`
  CREATE TABLE IF NOT EXISTS gpu_profiles (
    id          INTEGER PRIMARY KEY,
    key         TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('passthrough', 'mdev')),
    mapping     TEXT NOT NULL,               -- Proxmox PCI resource mapping id
    mdev_type   TEXT,                        -- e.g. nvidia-660 (mdev mode only)
    vram_gb     INTEGER,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gpu_assignments (
    vmid       INTEGER NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
    slot       INTEGER NOT NULL,             -- hostpci<slot> in the VM config
    profile_id INTEGER NOT NULL REFERENCES gpu_profiles(id),
    user_id    INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (vmid, slot)
  );
`);

// ---- Object storage (SeaweedFS, S3 API) ----------------------------------------
// One SeaweedFS IAM identity per customer; only the access key id is stored,
// the secret key is shown once. Buckets survive a customer's deletion (owner
// NULL) so no data is destroyed without an administrator deciding it.
db.exec(`
  CREATE TABLE IF NOT EXISTS s3_accounts (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    iam_user      TEXT UNIQUE NOT NULL,
    access_key_id TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS s3_buckets (
    name       TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    quota_gb   INTEGER NOT NULL DEFAULT 0,   -- 0 = no quota of its own
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Background jobs don't survive a restart; don't leave servers stuck forever.
db.exec(`
  UPDATE vms SET state = 'failed', error = 'Setup was interrupted because the panel restarted'
  WHERE state = 'creating';
  UPDATE vms SET state = 'ready' WHERE state = 'deleting';
  UPDATE tailscale SET state = 'failed', error = 'Interrupted because the panel restarted. Try again.'
  WHERE state IN ('installing', 'disconnecting');
  UPDATE users SET deletion_error = 'Interrupted because the panel restarted. Retry to continue.'
  WHERE deleting = 1 AND deletion_error IS NULL;
`);

const insertAudit = db.prepare(
  'INSERT INTO audit_log (user_id, vmid, action, detail, ip) VALUES (?, ?, ?, ?, ?)'
);

/** `req` may be a Fastify request or any { account: { id }, ip } object. */
export function audit(req, vmid, action, detail = null) {
  insertAudit.run(
    req.account?.id ?? null,
    vmid ?? null,
    action,
    detail ? JSON.stringify(detail) : null,
    req.ip
  );
}
