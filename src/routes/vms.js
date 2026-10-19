import { poolOfUser, datacentersFor } from '../pools.js';
import { profilesForUser, gpusOfServer } from '../gpu.js';
import { s3Enabled } from '../seaweedfs.js';
import { db, audit } from '../db.js';
import { config } from '../config.js';
import {
  pve, clusterGuests, locateGuest, guestPath, invalidateGuestCache, bootDiskKey, diskSizeGb, waitTask,
} from '../pve.js';
import {
  limitsOf, usageOf, offeredTemplates, createServer, deleteServer, reinstallServer, resizeServer,
} from '../provision.js';
import { networkOf } from '../network.js';
import { getSchedule, setSchedule, syncAfterRollback } from '../snapschedule.js';
import { vpnInfoFor } from '../vpn.js';
import { tailscaleStatus, connectTailscale, disconnectTailscale } from '../tailscale.js';
import { versionInfo } from '../version.js';
import { expiryInfo, expirySettings, customerExtend } from '../expiry.js';
import { updateInfo, startUpdates, refreshForServer } from '../winupdate.js';
import { planSettings, plansFor, planRow, getPlan, isUpgrade } from '../plans.js';
import {
  planIsBilled, orderQuote, chargeOrder, completeOrder, refundInvoice, upgradeQuote, chargeUpgrade,
  billingEnabled, balanceOf, MONTH_OPTIONS, voidOpenRenewals,
} from '../billing.js';

const ownedByUser = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?');
const listForUser = db.prepare('SELECT * FROM vms WHERE user_id = ? ORDER BY vmid');
const insertTask = db.prepare(
  'INSERT INTO tasks (upid, user_id, vmid, node, action) VALUES (?, ?, ?, ?, ?)'
);
const findTask = db.prepare('SELECT * FROM tasks WHERE upid = ? AND user_id = ?');

const POWER_ACTIONS = {
  qemu: ['start', 'shutdown', 'reboot', 'stop'],
  lxc: ['start', 'shutdown', 'reboot', 'stop'],
};
const TIMEFRAMES = ['hour', 'day', 'week', 'month'];
const SNAPSHOT_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

function notFound() {
  const err = new Error('Server not found');
  err.statusCode = 404;
  return err;
}

/**
 * The single gate for every per-VM route: the VMID must be a positive
 * integer, belong to the signed-in user in OUR database, and exist in
 * the cluster. Unknown and not-owned both return 404 so customers can't
 * probe for other people's VMIDs.
 */
async function ownedGuest(req) {
  const vmid = Number(req.params.vmid);
  if (!Number.isInteger(vmid) || vmid < 100) throw notFound();
  const row = ownedByUser.get(vmid, req.account.id);
  if (!row) throw notFound();
  if (row.state !== 'ready') {
    const err = new Error(row.state === 'creating'
      ? 'This server is still being set up'
      : row.state === 'deleting' ? 'This server is being deleted' : 'This server could not be set up');
    err.statusCode = 409;
    throw err;
  }
  const guest = await locateGuest(vmid);
  return { row, guest, path: guestPath(guest) };
}

function recordTask(req, guest, upid, action) {
  const isTask = typeof upid === 'string' && upid.startsWith('UPID:');
  if (isTask) insertTask.run(upid, req.account.id, guest.vmid, guest.node, action);
  audit(req, guest.vmid, action);
  invalidateGuestCache();
  // Only real Proxmox task IDs go back to the browser (it polls them).
  return { task: isTask ? upid : null };
}

const templateSetup = db.prepare('SELECT setup FROM templates WHERE vmid = ?');

/** 'windows' | 'linux' | null — for the OS glyph in the interface. */
const saveOstype = db.prepare('UPDATE vms SET ostype = ? WHERE vmid = ?');

/** 'windows' | 'linux' | null. Proxmox ostypes: win* = Windows, l24/l26 = Linux, others unknown. */
function familyOf(ostype) {
  if (!ostype) return null;
  if (/^w/.test(ostype)) return 'windows';
  if (/^l2/.test(ostype)) return 'linux';
  return null;
}

function osOf(row, ostype) {
  const known = familyOf(ostype ?? row.ostype);
  if (known) return known;
  const tpl = row.spec ? JSON.parse(row.spec).template : null;
  const setup = tpl ? templateSetup.get(tpl)?.setup : null;
  if (setup) return setup === 'windows' ? 'windows' : 'linux';
  return row.type === 'lxc' ? 'linux' : null;
}

const SSH_KEY_ERROR = 'One of the SSH keys is not in OpenSSH format (ssh-ed25519 AAAA… or ssh-rsa AAAA…)';
function badSshKeys(keys) {
  if (!keys?.trim()) return false;
  return keys.trim().split(/\r?\n/)
    .some((l) => l.trim() && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)\S*\s+\S+/.test(l.trim()));
}

function summarize(row, guest) {
  return {
    os: osOf(row, guest?.ostype),
    vmid: row.vmid,
    type: row.type,
    state: row.state,
    error: row.state === 'failed' ? row.error : null,
    progress: row.state === 'creating' ? row.progress : null,
    deletable: !!row.created_by_customer,
    reinstallable: !!row.created_by_customer,
    expiry: expiryInfo(row, expirySettings()),
    plan: row.plan_id ? (({ id, name }) => ({ id, name }))(getPlan(row.plan_id) ?? { id: row.plan_id, name: 'plan' }) : null,
    name: row.label || guest?.name || (row.spec && JSON.parse(row.spec).hostname) || `Server ${row.vmid}`,
    hostname: guest?.name ?? null,
    status: guest?.status ?? 'unknown',
    cpu: guest?.cpu ?? 0,
    cores: guest?.maxcpu ?? null,
    mem: guest?.mem ?? 0,
    maxmem: guest?.maxmem ?? null,
    maxdisk: guest?.maxdisk ?? null,
    uptime: guest?.uptime ?? 0,
    locked: guest?.lock ?? null,
  };
}

async function guestIps(path) {
  try {
    const data = await pve.get(`${path}/agent/network-get-interfaces`);
    const ips = [];
    for (const iface of data?.result ?? []) {
      if (iface.name === 'lo') continue;
      for (const a of iface['ip-addresses'] ?? []) {
        const ip = a['ip-address'];
        if (!ip || ip.startsWith('127.') || ip === '::1' || ip.toLowerCase().startsWith('fe80')) continue;
        ips.push(ip);
      }
    }
    return ips;
  } catch {
    return null; // guest agent not installed or not running
  }
}

export default async function vmRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // All servers of the signed-in customer
  app.get('/api/vms', async (req) => {
    const rows = listForUser.all(req.account.id);
    const guests = await clusterGuests();
    // First time a server shows up: read its OS type once (e.g. assigned Windows VMs).
    const unknown = rows.filter((r) => !r.ostype && r.state === 'ready' && guests.has(r.vmid));
    await Promise.allSettled(unknown.map(async (r) => {
      const cfg = await pve.get(`${guestPath(guests.get(r.vmid))}/config`);
      r.ostype = cfg.ostype ?? (r.type === 'lxc' ? 'l26' : 'other');
      saveOstype.run(r.ostype, r.vmid);
    }));
    return rows.map((row) => summarize(row, guests.get(row.vmid)));
  });

  // ---- Self-service creation ---------------------------------------------

  app.get('/api/account', async (req) => {
    const a = req.account;
    const network = networkOf(a.id);
    const vpn = vpnInfoFor(a.id);
    const tailscale = config.tailscale.enabled;
    // Version number only; commit, build date and update status stay admin-only.
    const panelVersion = config.showVersionToCustomers ? versionInfo.version : null;
    if (!a.can_create) return { canCreate: false, network, vpn, tailscale, panelVersion };
    const pool = poolOfUser(a.id);
    return {
      canCreate: true,
      limits: limitsOf(a),
      usage: await usageOf(a.id),
      // Where servers can go and which GPUs can be added (from the resource pool)
      datacenters: datacentersFor(a.id).map(({ id, name, location }) => ({ id, name, location })),
      gpuProfiles: profilesForUser(a.id).map(({ id, name, mode, vramGb }) => ({ id, name, mode, vramGb })),
      pool: pool ? { name: pool.name, objectStorage: pool.maxS3Buckets > 0 && s3Enabled() } : null,
      network,
      networksEnabled: config.network.enabled,
      vpn,
      tailscale,
      panelVersion,
    };
  });

  app.get('/api/templates', async (req, reply) => {
    if (!req.account.can_create) return reply.code(403).send({ error: 'Creating servers is not enabled for your account' });
    return offeredTemplates();
  });

  // Plans this customer can create servers from, with prices when billing is on
  app.get('/api/plans', async (req, reply) => {
    if (!req.account.can_create) return reply.code(403).send({ error: 'Creating servers is not enabled for your account' });
    const gpuIds = profilesForUser(req.account.id).map((p) => p.id);
    const billed = billingEnabled();
    return {
      requirePlan: planSettings().requirePlan,
      billing: billed ? { enabled: true, balance: balanceOf(req.account.id) } : { enabled: false },
      plans: plansFor(gpuIds).map((p) => {
        const row = planRow(p.id);
        return {
          ...p,
          billed: planIsBilled(row),
          // total incl. tax for each period (the invoice shows the lines)
          prices: planIsBilled(row) ? Object.fromEntries(MONTH_OPTIONS.map((m) => {
            const q = orderQuote(row, m);
            return [m, { total: q.total, tax: q.tax, subtotal: q.subtotal, discount: q.lines[1] ? -q.lines[1].amount : 0 }];
          })) : null,
        };
      }),
    };
  });

  app.post('/api/vms', {
    config: { rateLimit: { max: 15, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['hostname', 'templateId'],
        additionalProperties: false,
        properties: {
          hostname: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' },
          templateId: { type: 'integer', minimum: 100 },
          cores: { type: 'integer', minimum: 1, maximum: 128 },
          memoryMb: { type: 'integer', minimum: 512, maximum: 1048576 },
          diskGb: { type: 'integer', minimum: 1, maximum: 65536 },
          username: { type: 'string', pattern: '^[a-z_][a-z0-9_-]{0,31}$' },
          password: { type: 'string', minLength: 12, maxLength: 200 },
          sshKeys: { type: 'string', maxLength: 16000 },
          datacenterId: { type: 'integer', minimum: 1 },
          gpuProfileId: { type: 'integer', minimum: 1 },
          planId: { type: 'integer', minimum: 1 },
          months: { type: 'integer', enum: [1, 3, 6, 12] },
        },
      },
    },
  }, async (req, reply) => {
    const { months, ...spec } = req.body;
    if (badSshKeys(spec.sshKeys)) return reply.code(400).send({ error: SSH_KEY_ERROR });
    let charge = null;
    if (spec.planId) {
      // The plan decides the size (and the GPU); what else was sent for the size is ignored
      const plan = planRow(spec.planId);
      const offered = plan?.active && plansFor(profilesForUser(req.account.id).map((p) => p.id)).some((p) => p.id === plan.id);
      if (!offered) return reply.code(400).send({ error: 'That plan is not available' });
      Object.assign(spec, { cores: plan.cores, memoryMb: plan.memory_mb, diskGb: plan.disk_gb, gpuProfileId: plan.gpu_profile_id ?? undefined });
      if (!spec.gpuProfileId) delete spec.gpuProfileId;
      if (planIsBilled(plan)) {
        const period = months ?? 1;
        charge = () => {
          const inv = chargeOrder(req, plan, period);
          return { done: (vmid) => completeOrder(inv.id, vmid, period), undo: (why) => refundInvoice(inv.id, why) };
        };
      }
    } else {
      if (planSettings().requirePlan) return reply.code(400).send({ error: 'Choose a plan' });
      if (!spec.cores || !spec.memoryMb || !spec.diskGb) return reply.code(400).send({ error: 'Give the size: cores, memoryMb and diskGb' });
    }
    const vmid = await createServer(req, spec, { charge });
    return reply.code(202).send({ vmid });
  });

  // Larger plans this server can move to, with what the move costs now
  app.get('/api/vms/:vmid/plans', async (req) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    const current = row.plan_id ? getPlan(row.plan_id) : null;
    if (!current) return { current: null, options: [] };
    const gpuIds = profilesForUser(req.account.id).map((p) => p.id);
    const options = plansFor([...gpuIds, current.gpuProfileId].filter(Boolean)).filter((p) => isUpgrade(current, p)).map((p) => {
      const q = upgradeQuote(vmid, planRow(current.id), planRow(p.id));
      return { ...p, cost: { total: q.total, tax: q.tax, days: q.days, perMonth: q.perMonth } };
    });
    return { current, options, balance: billingEnabled() ? balanceOf(req.account.id) : null };
  });

  // Move to a larger plan: pay the difference for the rest of the period, then resize
  app.post('/api/vms/:vmid/plan', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', required: ['planId'], additionalProperties: false,
        properties: { planId: { type: 'integer', minimum: 1 }, restart: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    const from = row.plan_id ? planRow(row.plan_id) : null;
    if (!from) throw Object.assign(new Error('This server is not on a plan'), { statusCode: 400, expose: true });
    const gpuIds = profilesForUser(req.account.id).map((p) => p.id);
    const target = plansFor([...gpuIds, from.gpu_profile_id].filter(Boolean)).find((p) => p.id === req.body.planId);
    if (!target || !isUpgrade(getPlan(from.id), target)) {
      throw Object.assign(new Error('Choose a larger plan with the same GPU'), { statusCode: 400, expose: true });
    }
    const to = planRow(target.id);
    if (row.expired_at) throw Object.assign(new Error('This server has expired. Renew it first.'), { statusCode: 403, expose: true });
    const inv = chargeUpgrade(req, vmid, from, to);
    let result;
    try {
      result = await resizeServer(req, row, { cores: to.cores, memoryMb: to.memory_mb, diskGb: to.disk_gb, restart: !!req.body.restart }, { planChange: true });
    } catch (err) {
      if (inv) refundInvoice(inv.id, 'the upgrade could not be applied');
      throw err;
    }
    db.prepare('UPDATE vms SET plan_id = ? WHERE vmid = ?').run(to.id, vmid);
    voidOpenRenewals(vmid, `Replaced: the server moved to plan ${to.name}`);
    audit(req, vmid, 'server_plan_changed', { from: from.name, to: to.name, invoice: inv?.number ?? null });
    return { ...result, plan: { id: to.id, name: to.name }, invoice: inv?.number ?? null };
  });

  // Reinstall: fresh copy of an image, same ID, name, size and network address
  app.post('/api/vms/:vmid/reinstall', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['templateId'],
        additionalProperties: false,
        properties: {
          templateId: { type: 'integer', minimum: 100 },
          username: { type: 'string', pattern: '^[a-z_][a-z0-9_-]{0,31}$' },
          password: { type: 'string', minLength: 12, maxLength: 200 },
          sshKeys: { type: 'string', maxLength: 16000 },
        },
      },
    },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    if (badSshKeys(req.body.sshKeys)) return reply.code(400).send({ error: SSH_KEY_ERROR });
    await reinstallServer(req, row, { ...req.body });
    return reply.code(202).send({ started: true });
  });

  // ---- Windows updates ---------------------------------------------------------
  app.get('/api/vms/:vmid/updates', async (req) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    await refreshForServer(row);            // fresh progress while someone watches
    return updateInfo(row);
  });

  app.post('/api/vms/:vmid/updates', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['security', 'all'] },
          snapshot: { type: 'boolean' },
          autoRestart: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    return reply.code(202).send(await startUpdates(req, row, req.body));
  });

  // The customer's one self-service extension (if allowed for them)
  app.post('/api/vms/:vmid/extend', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    return customerExtend(req, row);
  });

  // Resize within the plan: cores, memory, disk (grow only)
  app.post('/api/vms/:vmid/resize', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cores: { type: 'integer', minimum: 1, maximum: 128 },
          memoryMb: { type: 'integer', minimum: 512, maximum: 1024 * 1024 },
          diskGb: { type: 'integer', minimum: 1, maximum: 64 * 1024 },
          restart: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    return resizeServer(req, row, req.body);
  });

  app.delete('/api/vms/:vmid', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    if (!row.created_by_customer) {
      return reply.code(403).send({ error: 'This server was set up for you by your provider. Contact support to cancel it.' });
    }
    if (row.state === 'creating' || row.state === 'deleting') {
      return reply.code(409).send({ error: 'Wait until the current operation has finished' });
    }
    const result = await deleteServer(req, row);
    return reply.code(202).send(result);
  });

  // ---- Tailscale (the customer's own tailnet) --------------------------------
  app.get('/api/vms/:vmid/tailscale', async (req) => tailscaleStatus(req, Number(req.params.vmid)));

  app.post('/api/vms/:vmid/tailscale', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['authKey', 'mode', 'hostname'],
        additionalProperties: false,
        properties: {
          authKey: { type: 'string', maxLength: 220 },
          mode: { type: 'string', enum: ['server', 'gateway'] },
          hostname: { type: 'string', maxLength: 63 },
        },
      },
    },
  }, async (req, reply) => {
    await connectTailscale(req, Number(req.params.vmid), req.body);
    return reply.code(202).send({ started: true });
  });

  app.delete('/api/vms/:vmid/tailscale', async (req) => disconnectTailscale(req, Number(req.params.vmid)));

  // Detail view
  app.get('/api/vms/:vmid', async (req) => {
    const { row, guest, path } = await ownedGuest(req);
    const [status, cfg] = await Promise.all([
      pve.get(`${path}/status/current`),
      pve.get(`${path}/config`),
    ]);
    if (cfg.ostype && cfg.ostype !== row.ostype) saveOstype.run(cfg.ostype, row.vmid);

    const ips = guest.type === 'qemu' && status.status === 'running' && status.agent
      ? await guestIps(path)
      : null;

    // CPU/memory changes that wait for a restart by Proxmox
    let pendingSize = null;
    if (status.status === 'running' && guest.type === 'qemu') {
      const pending = await pve.get(`${path}/pending`).catch(() => []);
      const p = Object.fromEntries(pending.filter((e) => e.pending !== undefined).map((e) => [e.key, e.pending]));
      if (p.cores !== undefined || p.memory !== undefined || p.sockets !== undefined) {
        pendingSize = {
          cores: (Number(p.cores ?? cfg.cores) || 1) * (Number(p.sockets ?? cfg.sockets) || 1),
          memoryMb: Number(p.memory ?? cfg.memory) || null,
        };
      }
    }

    return {
      ...summarize(row, { ...guest, ...status, maxcpu: status.cpus ?? guest.maxcpu }),
      os: cfg.ostype ?? null,          // raw Proxmox ostype, e.g. "win11", "l26"
      osFamily: osOf(row, cfg.ostype),  // 'windows' | 'linux' | null
      // for the reinstall form: current image and disk size
      templateId: row.spec ? JSON.parse(row.spec).template ?? null : null,
      diskGb: (() => { const k = bootDiskKey(cfg); return k ? Math.ceil(diskSizeGb(cfg[k])) : null; })(),
      // What the server runs with now (config would show pending values)
      memoryMb: status.status === 'running' && status.maxmem ? Math.round(status.maxmem / 2 ** 20) : (Number(cfg.memory) || null),
      cores: status.status === 'running' && status.cpus ? status.cpus : (Number(cfg.cores) || 1) * (Number(cfg.sockets) || 1),
      ipconfig: cfg.ipconfig0 ?? cfg.net0 ?? null,
      ips,
      pendingSize,
      resizable: !!row.created_by_customer && !row.plan_id,
      upgradable: !!row.created_by_customer && !!row.plan_id,
      gpus: gpusOfServer(row.vmid).map(({ slot, name, mode, vramGb }) => ({ slot, name, mode, vramGb })),
      netin: status.netin ?? 0,
      netout: status.netout ?? 0,
    };
  });

  // Power actions
  app.post('/api/vms/:vmid/power/:action', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { row, guest, path } = await ownedGuest(req);
    const { action } = req.params;
    if (!POWER_ACTIONS[guest.type].includes(action)) {
      return reply.code(400).send({ error: `Unsupported action "${action}"` });
    }
    if (row.expired_at && ['start', 'reboot'].includes(action)) {
      return reply.code(403).send({ error: 'This server has expired. Extend it to use it again.' });
    }
    const upid = await pve.post(`${path}/status/${action}`);
    // Proxmox rebuilds the cloud-init drive on start and reboot: public addresses become active
    if (['start', 'reboot'].includes(action)) db.prepare("UPDATE ip_addresses SET apply = 'live' WHERE vmid = ? AND apply = 'restart'").run(row.vmid);
    return recordTask(req, guest, upid, `power_${action}`);
  });

  // Usage graphs
  app.get('/api/vms/:vmid/rrd', async (req, reply) => {
    const { path } = await ownedGuest(req);
    const timeframe = req.query.timeframe ?? 'hour';
    if (!TIMEFRAMES.includes(timeframe)) {
      return reply.code(400).send({ error: 'timeframe must be hour, day, week or month' });
    }
    const data = await pve.get(`${path}/rrddata`, { timeframe, cf: 'AVERAGE' });
    return data.map((p) => ({
      time: p.time,
      cpu: p.cpu ?? null,
      mem: p.mem ?? null,
      maxmem: p.maxmem ?? null,
      netin: p.netin ?? null,
      netout: p.netout ?? null,
      diskread: p.diskread ?? null,
      diskwrite: p.diskwrite ?? null,
    }));
  });

  // Snapshots
  app.get('/api/vms/:vmid/snapshots', async (req) => {
    const { path } = await ownedGuest(req);
    const list = await pve.get(`${path}/snapshot`);
    return list
      .filter((s) => s.name !== 'current')
      .map((s) => ({
        name: s.name,
        description: s.description ?? '',
        time: s.snaptime ?? null,
        includesRam: !!s.vmstate,
        auto: /^auto_\d{14}$/.test(s.name),
      }))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  });

  app.post('/api/vms/:vmid/snapshots', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 40 },
          description: { type: 'string', maxLength: 200 },
          includeRam: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    const { name, description = '', includeRam = false } = req.body;
    if (!SNAPSHOT_NAME.test(name)) {
      return reply.code(400).send({
        error: 'Snapshot names start with a letter and use only letters, numbers, - and _ (2–40 characters)',
      });
    }
    const existing = (await pve.get(`${path}/snapshot`)).filter((s) => s.name !== 'current');
    if (existing.length >= config.limits.maxSnapshots) {
      return reply.code(409).send({
        error: `Your plan allows ${config.limits.maxSnapshots} snapshots. Delete one to create another.`,
      });
    }
    // Saving RAM (vmstate) only exists for VMs and needs a running VM. It also
    // skips the guest-agent filesystem freeze, which can hang on some guests
    // (e.g. Windows VSS). The state file uses disk space equal to the used RAM.
    const params = { snapname: name, description };
    if (includeRam) {
      // Live status, not the few-seconds cache: the server may have just been started.
      const live = guest.type === 'qemu' ? (await pve.get(`${path}/status/current`)).status : null;
      if (live !== 'running') {
        return reply.code(400).send({ error: 'RAM can only be included for a running VM' });
      }
      params.vmstate = 1;
    }
    const upid = await pve.post(`${path}/snapshot`, params);
    return recordTask(req, guest, upid, 'snapshot_create');
  });

  app.post('/api/vms/:vmid/snapshots/:name/rollback', async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    if (!SNAPSHOT_NAME.test(req.params.name)) return reply.code(400).send({ error: 'Invalid snapshot name' });
    const upid = await pve.post(`${path}/snapshot/${req.params.name}/rollback`);
    // the restored configuration may differ in volumes and network cards: bring the panel in line
    waitTask(guest.node, upid).then(() => syncAfterRollback(guest.vmid))
      .catch((err) => req.log.warn(`After rollback of ${guest.vmid}: ${err.message}`));
    return recordTask(req, guest, upid, 'snapshot_rollback');
  });

  // Automatic snapshots (daily / weekly, keep N)
  app.get('/api/vms/:vmid/snapshot-schedule', async (req) => {
    await ownedGuest(req);
    return getSchedule(Number(req.params.vmid));
  });
  app.put('/api/vms/:vmid/snapshot-schedule', {
    schema: {
      body: {
        type: 'object', required: ['frequency'], additionalProperties: false,
        properties: { frequency: { type: 'string', enum: ['off', 'daily', 'weekly'] }, hour: { type: 'integer' }, weekday: { type: 'integer' }, keep: { type: 'integer' } },
      },
    },
  }, async (req) => {
    await ownedGuest(req);
    const row = ownedByUser.get(Number(req.params.vmid), req.account.id);
    return setSchedule(req, row, req.body);
  });

  app.delete('/api/vms/:vmid/snapshots/:name', async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    if (!SNAPSHOT_NAME.test(req.params.name)) return reply.code(400).send({ error: 'Invalid snapshot name' });
    const upid = await pve.del(`${path}/snapshot/${req.params.name}`);
    return recordTask(req, guest, upid, 'snapshot_delete');
  });

  // Task progress — only for tasks this user started through the panel
  app.get('/api/tasks/:upid', async (req) => {
    const task = findTask.get(req.params.upid, req.account.id);
    if (!task) throw notFound();
    const status = await pve.get(
      `/nodes/${encodeURIComponent(task.node)}/tasks/${encodeURIComponent(task.upid)}/status`
    );
    return {
      done: status.status === 'stopped',
      ok: status.status === 'stopped' ? status.exitstatus === 'OK' : null,
      message: status.exitstatus ?? null,
      action: task.action,
    };
  });
}
