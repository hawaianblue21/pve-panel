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
// Package updates on Linux servers share the update-run table with Windows
addColumn('winupdates', 'os', "TEXT NOT NULL DEFAULT 'windows'");

// Personal appearance (Account → Appearance): NULL = the panel's scheme / the device's mode
addColumn('users', 'ui_scheme', 'TEXT');
addColumn('users', 'ui_mode', 'TEXT');

// ---- Support: tickets, messages and the knowledge base (support.js, kb.js) --------
// Tickets live in the panel; zammad_* columns are only used when the optional
// Zammad sync is set up (zammad.js). A customer's tickets go with the customer.
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id               INTEGER PRIMARY KEY,
    number           INTEGER UNIQUE NOT NULL,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vmid             INTEGER,
    subject          TEXT NOT NULL,
    category         TEXT NOT NULL,
    priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'resolved', 'closed')),
    queue            TEXT NOT NULL DEFAULT 'L1' CHECK (queue IN ('L1', 'L2', 'L3')),
    assignee_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    context          TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    zammad_id        INTEGER UNIQUE,
    zammad_error     TEXT,
    zammad_synced_at TEXT
  );
  CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);
  CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, queue);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id                INTEGER PRIMARY KEY,
    ticket_id         INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author            TEXT NOT NULL CHECK (author IN ('customer', 'agent', 'system')),
    author_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_name       TEXT,
    body              TEXT NOT NULL,
    internal          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    zammad_article_id INTEGER UNIQUE,
    zammad_pending    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ticket_messages_ticket ON ticket_messages(ticket_id);

  CREATE TABLE IF NOT EXISTS kb_articles (
    id            INTEGER PRIMARY KEY,
    slug          TEXT UNIQUE NOT NULL,
    title         TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT 'General',
    body          TEXT NOT NULL DEFAULT '',
    visibility    TEXT NOT NULL DEFAULT 'customers' CHECK (visibility IN ('public', 'customers', 'internal')),
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    source_ticket INTEGER,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    published_at  TEXT,
    views         INTEGER NOT NULL DEFAULT 0,
    helpful       INTEGER NOT NULL DEFAULT 0,
    not_helpful   INTEGER NOT NULL DEFAULT 0
  );

  -- What people searched in the help center, to find missing articles
  CREATE TABLE IF NOT EXISTS kb_searches (
    id         INTEGER PRIMARY KEY,
    query      TEXT NOT NULL,
    results    INTEGER NOT NULL,
    signed_in  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- AI assistant (ai.js): conversations of customers with the assistant ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL DEFAULT 'New conversation',
    ticket_number INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ai_conversations_user ON ai_conversations(user_id);

  -- role: user | assistant | tool. Assistant rows may carry tool calls (JSON),
  -- tool rows the result given to the model; sources = articles the answer used.
  CREATE TABLE IF NOT EXISTS ai_messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content         TEXT NOT NULL DEFAULT '',
    tool_calls      TEXT,
    tool_call_id    TEXT,
    tool_name       TEXT,
    sources         TEXT,
    handover        TEXT,
    rating          INTEGER,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id);
`);

// ---- Billing (billing.js): invoices in whole rupiah, payments, wallet ----------------
db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id            INTEGER PRIMARY KEY,
    number        TEXT UNIQUE NOT NULL,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose       TEXT NOT NULL CHECK (purpose IN ('renewal', 'topup', 'manual', 'order', 'upgrade')),
    vmid          INTEGER,
    months        INTEGER,
    lines         TEXT NOT NULL,
    subtotal      INTEGER NOT NULL,
    tax_name      TEXT NOT NULL DEFAULT 'PPN',
    tax_rate      REAL NOT NULL,
    tax           INTEGER NOT NULL,
    total         INTEGER NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'IDR',
    status        TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void', 'refunded')),
    due_at        TEXT NOT NULL,
    paid_at       TEXT,
    paid_via      TEXT,
    fulfilled_at  TEXT,
    auto          INTEGER NOT NULL DEFAULT 0,
    customer_ref  TEXT,
    note          TEXT,
    bill_to       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS invoices_user ON invoices(user_id, status);

  -- One checkout at a payment gateway (an invoice can have several attempts)
  CREATE TABLE IF NOT EXISTS checkouts (
    id          INTEGER PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    gateway     TEXT NOT NULL CHECK (gateway IN ('xendit', 'midtrans')),
    order_id    TEXT UNIQUE NOT NULL,
    gateway_id  TEXT,
    url         TEXT,
    amount      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    method      TEXT NOT NULL,
    reference   TEXT,
    amount      INTEGER NOT NULL,
    admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS wallet_entries (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    invoice_id    INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    admin_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS wallet_user ON wallet_entries(user_id);
`);
addColumn('vms', 'auto_renew', 'INTEGER NOT NULL DEFAULT 0');
addColumn('vms', 'price_monthly', 'INTEGER');            // fixed price; NULL = from the rate card
addColumn('users', 'billing_profile', 'TEXT');           // JSON: name, address, tax ID on invoices

// Invoices from before plans: widen the allowed kinds and states (SQLite can't change a CHECK in place)
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoices'").get()?.sql ?? '';
  if (sql && !sql.includes("'order'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      const widened = sql
        .replace("('renewal', 'topup', 'manual')", "('renewal', 'topup', 'manual', 'order', 'upgrade')")
        .replace("('unpaid', 'paid', 'void')", "('unpaid', 'paid', 'void', 'refunded')")
        .replace(/CREATE TABLE "?invoices"?/, 'CREATE TABLE invoices_new');
      db.exec(widened);
      db.exec('INSERT INTO invoices_new SELECT * FROM invoices');
      db.exec('DROP TABLE invoices');
      db.exec('ALTER TABLE invoices_new RENAME TO invoices');
      db.exec('CREATE INDEX IF NOT EXISTS invoices_user ON invoices(user_id, status)');
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
}

// ---- Plans (plans.js): sizes customers create servers from, with a monthly price --------
db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    cores           INTEGER NOT NULL,
    memory_mb       INTEGER NOT NULL,
    disk_gb         INTEGER NOT NULL,
    gpu_profile_id  INTEGER REFERENCES gpu_profiles(id),
    price_monthly   INTEGER,                   -- whole rupiah before tax; NULL = no charge
    active          INTEGER NOT NULL DEFAULT 1,
    sort            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
addColumn('vms', 'plan_id', 'INTEGER REFERENCES plans(id)');

// ---- Single sign-on identities (Google, Microsoft, GitHub; see sso.js) ------------
// One identity per provider per account; found by provider + issuer + subject.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_identities (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    UNIQUE (provider, issuer, subject),
    UNIQUE (user_id, provider)
  );
`);

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

// ---- Block storage volumes (volumes.js) -------------------------------------------
// An extra disk of a customer's VM. Attached: a scsiN key in the VM config (slot).
// Detached: parked as unusedN on the same VM (slot NULL), still the customer's and
// still counted. Proxmox destroys a VM's disks with it, so the row goes with the VM.
db.exec(`
  CREATE TABLE IF NOT EXISTS volumes (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vmid       INTEGER NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    tier       TEXT NOT NULL,
    size_gb    INTEGER NOT NULL,
    volid      TEXT NOT NULL,                 -- Proxmox volume, e.g. ceph-nvme:vm-101-disk-3
    slot       TEXT,                          -- scsiN while attached; NULL = detached
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, label)
  );
  CREATE INDEX IF NOT EXISTS volumes_vm ON volumes(vmid);
`);

// ---- Public IPv4 pools and addresses (ipam.js) ----------------------------------
// Every usable address of a pool is a row. state: free | assigned | reserved (by an
// administrator, e.g. the gateway) | cooldown (released; free again after the
// cool-down) | held (its server left the panel without being destroyed: an
// administrator decides). nic is the server's netN carrying it.
db.exec(`
  CREATE TABLE IF NOT EXISTS ip_pools (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    cidr          TEXT NOT NULL UNIQUE,
    gateway       TEXT NOT NULL,
    bridge        TEXT NOT NULL,
    vlan          INTEGER,
    dns           TEXT NOT NULL DEFAULT '',
    datacenter_id INTEGER REFERENCES datacenters(id) ON DELETE SET NULL,
    price_monthly INTEGER NOT NULL DEFAULT 0,
    reverse_zone  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ip_addresses (
    id          INTEGER PRIMARY KEY,
    pool_id     INTEGER NOT NULL REFERENCES ip_pools(id) ON DELETE CASCADE,
    address     TEXT NOT NULL UNIQUE,
    state       TEXT NOT NULL DEFAULT 'free',
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    vmid        INTEGER,
    nic         TEXT,
    mac         TEXT,
    apply       TEXT,
    ptr         TEXT,
    note        TEXT,
    assigned_at TEXT,
    released_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ip_addresses_vm ON ip_addresses(vmid);
  CREATE INDEX IF NOT EXISTS ip_addresses_pool ON ip_addresses(pool_id, state);
  -- a server row removed without the panel destroying the VM (e.g. unassigned):
  -- the address may still be configured there, so it is held for an administrator
  CREATE TRIGGER IF NOT EXISTS ip_hold_on_vm_delete AFTER DELETE ON vms BEGIN
    UPDATE ip_addresses SET state = 'held', note = 'Server ' || OLD.vmid || ' left the panel; check it before freeing', user_id = NULL
      WHERE vmid = OLD.vmid AND state = 'assigned';
  END;
`);

// IPv6 (optional): a pool may carry an IPv6 prefix; every IPv4 address of the pool
// maps to its own /64 in it, switched on per address by the customer.
// read-only bucket: the customer's access key may only read and list it
addColumn('s3_buckets', 'read_only', 'INTEGER NOT NULL DEFAULT 0');
addColumn('ip_pools', 'ipv6_cidr', 'TEXT');
addColumn('ip_pools', 'ipv6_gateway', 'TEXT');
addColumn('ip_pools', 'ipv6_reverse_zone', 'TEXT');
addColumn('ip_pools', 'ipv6_price_monthly', 'INTEGER NOT NULL DEFAULT 0');
addColumn('ip_addresses', 'ipv6_on', 'INTEGER NOT NULL DEFAULT 0');
addColumn('ip_addresses', 'ipv6_ptr', 'TEXT');

// ---- Proxmox nodes (hosts.js): maintenance flag and the last reported state -------
db.exec(`
  CREATE TABLE IF NOT EXISTS node_settings (
    node        TEXT PRIMARY KEY,
    maintenance INTEGER NOT NULL DEFAULT 0,      -- 1 = no new servers are placed here
    note        TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS node_snapshots (
    node    TEXT PRIMARY KEY,
    data    TEXT NOT NULL,                       -- JSON: load, memory, storage, version
    seen_at TEXT NOT NULL
  );
`);

// ---- API tokens (tokens.js) -------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portal       TEXT NOT NULL CHECK (portal IN ('customer', 'admin')),
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL,                -- SHA-256 of the secret (hex)
    scopes       TEXT NOT NULL DEFAULT '[]',   -- customer: JSON list of permissions
    read_only    INTEGER NOT NULL DEFAULT 0,   -- admin: GET only
    expires_at   TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id, portal);
`);

// ---- Update rollouts (rollouts.js): updates on many servers, ring by ring --------
db.exec(`
  CREATE TABLE IF NOT EXISTS rollouts (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    scope        TEXT NOT NULL,
    snapshot     INTEGER NOT NULL DEFAULT 1,
    auto_restart INTEGER NOT NULL DEFAULT 1,
    max_fail_pct INTEGER NOT NULL DEFAULT 2,
    state        TEXT NOT NULL,                 -- running | paused | done | cancelled
    reason       TEXT,
    allow_ring   INTEGER,                       -- resumed despite failures: this ring may start
    created_by   INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS rollout_items (
    rollout_id INTEGER NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    vmid       INTEGER NOT NULL,
    ring       INTEGER NOT NULL,
    state      TEXT NOT NULL,                   -- pending | started | done | failed | skipped
    run_id     INTEGER,                         -- winupdates.id
    note       TEXT,
    PRIMARY KEY (rollout_id, vmid)
  );
`);
// pending-update counts per server ("Check now" in the Updates tab)
db.exec(`
  CREATE TABLE IF NOT EXISTS update_checks (
    vmid            INTEGER PRIMARY KEY REFERENCES vms(vmid) ON DELETE CASCADE,
    state           TEXT NOT NULL,              -- checking | done | failed
    pending         INTEGER,
    security        INTEGER,
    reboot_required INTEGER,
    error           TEXT,
    checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// maintenance window of a rollout: JSON { days, start, end } (clock.js), or NULL for any time
addColumn('rollouts', 'window_json', 'TEXT');


// ---- Proxmox clusters besides the main one (pve.js routes requests to them) -------
// network_clusters: the clusters a customer's private network (VNet) exists on;
// the main cluster (0) is implied for every network row.
db.exec(`
  CREATE TABLE IF NOT EXISTS clusters (
    id           INTEGER PRIMARY KEY,
    key          TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    url          TEXT NOT NULL,
    token_id     TEXT NOT NULL,
    token_secret TEXT NOT NULL,                -- sealed
    verify_tls   INTEGER NOT NULL DEFAULT 1,
    fingerprint  TEXT,                         -- SHA-256 of a self-signed certificate
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS network_clusters (
    vnet       TEXT NOT NULL,
    cluster_id INTEGER NOT NULL,
    PRIMARY KEY (vnet, cluster_id)
  );
`);
// networks created before several clusters existed are on the main cluster (once)
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'network_clusters_migrated'").get()) {
  db.exec(`INSERT OR IGNORE INTO network_clusters (vnet, cluster_id) SELECT vnet, 0 FROM networks;
    INSERT INTO settings (key, value, updated_at) VALUES ('network_clusters_migrated', '1', datetime('now'));`);
}

// ---- Automatic snapshots (snapschedule.js) ----------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshot_schedules (
    vmid        INTEGER PRIMARY KEY REFERENCES vms(vmid) ON DELETE CASCADE,
    frequency   TEXT NOT NULL,              -- daily | weekly
    hour        INTEGER NOT NULL,           -- 0-23, panel time zone
    weekday     INTEGER,                    -- 0 (Sunday) - 6, weekly only
    keep        INTEGER NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_error  TEXT
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
  // done with an API token: say which one
  const d = req.apiToken ? { ...(detail ?? {}), apiToken: req.apiToken.name } : detail;
  insertAudit.run(
    req.account?.id ?? null,
    vmid ?? null,
    action,
    d ? JSON.stringify(d) : null,
    req.ip
  );
}
