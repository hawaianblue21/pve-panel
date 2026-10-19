import { db, audit } from './db.js';
import { config } from './config.js';
import {
  pve, clusterGuests, locateTemplate, waitTask, bootDiskKey, diskSizeGb, serial,
  invalidateGuestCache, guestPath, refreshNodeMap, guestMayBeHidden, HiddenGuestError,
} from './pve.js';
import { ensureNetwork, isolateGuest, nicModel } from './network.js';
import { setupWindows, windowsPasswordProblem } from './windows.js';
import { agentExec } from './agent.js';
import { expiryForNewServer } from './expiry.js';
import { activeRun } from './winupdate.js';
import { checkPoolCapacity, placement, datacenterById } from './pools.js';
import { profilesForUser, claimGpu, applyRecordedGpus } from './gpu.js';
import { applyRecordedIps, releaseIpsOfDeletedServer } from './ipam.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

// ---- Limits & usage -------------------------------------------------------

export function limitsOf(account) {
  return {
    servers: account.max_servers,
    cores: account.max_cores,
    memoryMb: account.max_memory_mb,
    diskGb: account.max_disk_gb,
  };
}

/** Total size of a VM's disks in GB (CD drives and cloud-init drives excluded). */
export function diskTotalGb(cfg) {
  let total = 0;
  for (const [k, v] of Object.entries(cfg)) {
    if (!/^(scsi|virtio|sata|ide)\d+$/.test(k)) continue;
    if (/media=cdrom|cloudinit/.test(String(v))) continue;
    total += diskSizeGb(v) || 0;
  }
  return Math.round(total);
}

/**
 * Resources a customer uses, over ALL their servers (also the ones an admin
 * assigned). Read from each server's configuration, which includes PENDING
 * changes (e.g. more memory waiting for a restart), so resizing several running
 * servers can't exceed the plan. Servers still being created count with what
 * was requested.
 */
export async function usageOf(userId) {
  const rows = db.prepare('SELECT vmid, state, spec FROM vms WHERE user_id = ?').all(userId);
  const guests = await clusterGuests();
  const usage = { servers: 0, cores: 0, memoryMb: 0, diskGb: 0 };
  await Promise.all(rows.map(async (row) => {
    usage.servers += 1;
    const spec = row.spec ? JSON.parse(row.spec) : null;
    const guest = guests.get(row.vmid);
    if (row.state === 'creating' && spec) {
      usage.cores += spec.cores;
      usage.memoryMb += spec.memoryMb;
      usage.diskGb += spec.diskGb;
      return;
    }
    if (!guest) return;
    try {
      const cfg = await pve.get(`${guestPath(guest)}/config`); // pending values included
      usage.cores += (Number(cfg.cores) || 1) * (Number(cfg.sockets) || 1);
      usage.memoryMb += Number(cfg.memory) || 512;
      usage.diskGb += diskTotalGb(cfg);
    } catch {
      usage.cores += guest.maxcpu ?? 0;
      usage.memoryMb += Math.round((guest.maxmem ?? 0) / MB);
      usage.diskGb += Math.round((guest.maxdisk ?? 0) / GB);
    }
  }));
  // detached block storage volumes (parked as unusedN, not in the active config) still count
  usage.diskGb += db.prepare('SELECT COALESCE(SUM(size_gb), 0) AS gb FROM volumes WHERE user_id = ? AND slot IS NULL').get(userId).gb;
  return usage;
}

// ---- Templates --------------------------------------------------------------

/** Templates offered to customers, with the minimum disk size of each. */
export async function offeredTemplates() {
  const rows = db.prepare('SELECT * FROM templates ORDER BY label').all();
  const guests = await clusterGuests();
  const result = await Promise.all(rows.map(async (t) => {
    const guest = guests.get(t.vmid);
    if (!guest?.template) return null; // template was removed in Proxmox
    try {
      const cfg = await pve.get(`/nodes/${encodeURIComponent(guest.node)}/qemu/${t.vmid}/config`);
      const disk = bootDiskKey(cfg);
      const windows = t.setup === 'windows';
      return {
        id: t.vmid,
        name: t.label,
        setup: windows ? 'windows' : 'cloudinit',
        minDiskGb: Math.ceil(diskSizeGb(cfg[disk])) || 1,
        defaultUser: windows ? (t.ci_user || 'Administrator') : (t.ci_user || cfg.ciuser || ''),
        os: cfg.ostype ?? null,
        cluster: guest.cluster ?? 0,     // servers from it can only be placed in this cluster
      };
    } catch {
      return null;
    }
  }));
  return result.filter(Boolean);
}

// ---- Create -----------------------------------------------------------------

const creatingFor = new Set(); // one creation per customer at a time

export class ProvisionError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

/** Sign-in rules per setup method (shared by create and reinstall). Mutates spec. */
function applySetupRules(spec, offered) {
  if (offered.setup === 'windows') {
    if (spec.hostname.length > 15) {
      throw new ProvisionError(400, 'Windows computer names can be at most 15 characters');
    }
    if (!spec.password) throw new ProvisionError(400, 'Set a password for the Administrator account');
    spec.username = offered.defaultUser; // fixed admin account of the template
    spec.sshKeys = undefined;
    const problem = windowsPasswordProblem(spec.password, spec.username);
    if (problem) throw new ProvisionError(400, problem);
  } else {
    if (!spec.username) throw new ProvisionError(400, 'Choose a user name');
    if (!spec.password && !spec.sshKeys?.trim()) {
      throw new ProvisionError(400, 'Set a password or add an SSH key so you can sign in to the server');
    }
  }
  spec.setup = offered.setup;
}

/**
 * Validates quota, reserves a VMID and starts the clone. Returns the new VMID
 * right away; configuration, disk resize and first start continue in the
 * background, tracked through the `state` column.
 */
// Called with the server ID when setting up a new server failed (billing refunds a paid order)
const createFailedHooks = [];
export const onCreateFailed = (fn) => { createFailedHooks.push(fn); };

/**
 * spec: hostname, templateId, cores, memoryMb, diskGb, … (planId: the plan it was made from).
 * options.charge(): called after every check and before anything is created; it
 * may throw (e.g. not enough balance) and returns { done(vmid), undo(reason) }.
 */
export async function createServer(req, spec, { charge = null } = {}) {
  const account = req.account;
  if (!account.can_create) throw new ProvisionError(403, 'Creating servers is not enabled for your account');
  if (creatingFor.has(account.id)) {
    throw new ProvisionError(409, 'Another server is being created. Wait until it has finished.');
  }
  creatingFor.add(account.id);

  let background = false;
  let releaseGpu = null;
  try {
    const tplRow = db.prepare('SELECT * FROM templates WHERE vmid = ?').get(spec.templateId);
    if (!tplRow) throw new ProvisionError(400, 'That image is not available');
    const tpl = await locateTemplate(spec.templateId);
    const offered = (await offeredTemplates()).find((t) => t.id === spec.templateId);
    if (!offered) throw new ProvisionError(400, 'That image is not available');
    if (spec.diskGb < offered.minDiskGb) {
      throw new ProvisionError(400, `This image needs a disk of at least ${offered.minDiskGb} GB`);
    }

    applySetupRules(spec, offered);

    // Quota
    const limits = limitsOf(account);
    const usage = await usageOf(account.id);
    const over = [];
    if (usage.servers + 1 > limits.servers) over.push(`servers (${limits.servers} allowed)`);
    if (usage.cores + spec.cores > limits.cores) over.push(`CPU cores (${limits.cores - usage.cores} left)`);
    if (usage.memoryMb + spec.memoryMb > limits.memoryMb) {
      over.push(`memory (${((limits.memoryMb - usage.memoryMb) / 1024).toFixed(1)} GB left)`);
    }
    if (usage.diskGb + spec.diskGb > limits.diskGb) over.push(`disk (${limits.diskGb - usage.diskGb} GB left)`);
    if (over.length) throw new ProvisionError(409, `This exceeds your plan: ${over.join(', ')}`);

    // GPU (only through a resource pool that offers the profile)
    let gpu = null;
    if (spec.gpuProfileId) {
      gpu = profilesForUser(account.id).find((p) => p.id === spec.gpuProfileId);
      if (!gpu) throw new ProvisionError(403, 'That GPU is not available for your account');
      releaseGpu = await claimGpu(gpu);
      if (!releaseGpu) throw new ProvisionError(409, `No ${gpu.name} is free right now. Try again later or choose another GPU.`);
    }

    // Resource pool (shared by several customers) and the datacenter it may use
    await checkPoolCapacity(account.id, {
      cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, gpus: gpu ? 1 : 0,
    });
    // Several clusters: a clone stays in the image's cluster
    await refreshNodeMap();
    const tplCluster = tpl.cluster ?? 0;
    const place = placement(account.id, spec.datacenterId ?? null, tpl.node, { cluster: tplCluster, image: offered.name });

    // The customer's private network (created with their first server, on each cluster used)
    const net = config.network.enabled ? await ensureNetwork(account.id, tplCluster) : null;

    // Pay for it (plans with a price), last thing before anything is created
    const order = charge ? await charge() : null;

    // Reserve ID + start clone, serialised against other creations
    let reserved;
    try {
      reserved = await serial(async () => {
        // Proxmox's next free ID, skipping IDs the panel still has records for
        // (e.g. a VM that was deleted directly in Proxmox but is still assigned here).
        const known = db.prepare('SELECT 1 FROM vms WHERE vmid = ?');
        let id = Number(await pve.get('/cluster/nextid'));
        for (let tries = 0; ; tries += 1, id += 1) {
          if (tries > 1000) throw new Error('No free VM ID found');
          if (known.get(id)) continue;
          try {
            await pve.get('/cluster/nextid', { vmid: id }); // errors if the ID is taken in Proxmox
            break;
          } catch {
            // taken in Proxmox, try the next one
          }
        }
        const task = await pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
          newid: id,
          name: spec.hostname,
          full: 1,
          // Another node of the datacenter: Proxmox clones there (full clone)
          target: place && place.node !== tpl.node ? place.node : undefined,
          storage: place?.storage || tplRow.storage || undefined,
          pool: config.pve.pool,
        });
        return { vmid: id, upid: task };
      });
    } catch (err) {
      order?.undo('the server could not be set up');
      throw err;
    }
    const { vmid, upid } = reserved;

    db.prepare(`
      INSERT INTO vms (vmid, user_id, type, label, state, created_by_customer, spec, progress, expires_at, expiry_set_at, datacenter_id, plan_id)
      VALUES (?, ?, 'qemu', NULL, 'creating', 1, ?, 'Copying the image', ?, ?, ?, ?)
    `).run(vmid, account.id, JSON.stringify({
      cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, template: tpl.vmid,
      hostname: spec.hostname, gpu: gpu?.key ?? undefined,
    }), expiryForNewServer(account.id), new Date().toISOString(), place?.datacenter.id ?? null, spec.planId ?? null);
    order?.done(vmid);
    // The GPU is reserved now (slot -1) and written into the config before first start
    if (gpu) {
      db.prepare('INSERT INTO gpu_assignments (vmid, slot, profile_id, user_id) VALUES (?, -1, ?, ?)').run(vmid, gpu.id, account.id);
    }
    audit(req, vmid, 'server_create_started', { template: tpl.vmid, hostname: spec.hostname });

    background = true;
    const actor = { account: { id: account.id }, ip: req.ip };
    finishCreate(actor, place?.node ?? tpl.node, vmid, upid, spec, tplRow, net)
      .finally(() => creatingFor.delete(account.id));

    return vmid;
  } finally {
    // From here the reservation row counts the GPU (or creation failed)
    releaseGpu?.();
    if (!background) creatingFor.delete(account.id);
  }
}

const setProgress = db.prepare('UPDATE vms SET progress = ? WHERE vmid = ?');

async function finishCreate(actor, node, vmid, cloneUpid, spec, tplRow, net, {
  mac = null, done = 'server_created', failed = 'server_create_failed',
} = {}) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}`;
  const progress = (text) => setProgress.run(text, vmid);
  const windows = spec.setup === 'windows';
  try {
    // The clone task runs on the template's node, which may differ from `node`
    await waitTask(null, cloneUpid);

    progress('Configuring');
    const cfg = await pve.get(`${path}/config`);
    const params = { cores: spec.cores, sockets: 1, memory: spec.memoryMb };
    if (net) {
      // Customer's VNet, firewall on for isolation. A kept MAC (reinstall) gets
      // the same DHCP address again; otherwise Proxmox assigns a new one.
      params.net0 = `${nicModel(cfg.net0)}${mac ? `=${mac}` : ''},bridge=${net.vnet},firewall=1`;
    } else if (mac && cfg.net0) {
      params.net0 = cfg.net0.replace(/^(\w+)=([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})/, `$1=${mac}`);
    }
    if (!windows) {
      params.ciuser = spec.username;
      params.ipconfig0 = tplRow.ipconfig || 'ip=dhcp';
      if (spec.password) params.cipassword = spec.password;
      // Proxmox expects the key list URL-encoded (in addition to form encoding).
      if (spec.sshKeys) params.sshkeys = encodeURIComponent(`${spec.sshKeys.trim()}\n`);
    }
    await pve.put(`${path}/config`, params);
    if (net) await isolateGuest(path, net);
    // GPUs reserved at creation, or recorded before a reinstall
    await applyRecordedGpus(path, vmid);
    // public addresses recorded before a reinstall
    await applyRecordedIps(path, vmid);

    const disk = bootDiskKey(cfg);
    if (disk && spec.diskGb > diskSizeGb(cfg[disk])) {
      progress('Resizing the disk');
      const resize = await pve.put(`${path}/resize`, { disk, size: `${spec.diskGb}G` });
      await waitTask(node, resize); // async in newer PVE versions, sync in older
    }

    progress('Starting');
    await waitTask(node, await pve.post(`${path}/status/start`));

    if (windows) {
      await setupWindows({
        path, node,
        hostname: spec.hostname,
        adminUser: spec.username,
        password: spec.password,
        net,
        progress,
      });
    }

    db.prepare("UPDATE vms SET state = 'ready', error = NULL, progress = NULL WHERE vmid = ?").run(vmid);
    audit(actor, vmid, done);
  } catch (err) {
    db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
      .run(String(err.message).slice(0, 500), vmid);
    audit(actor, vmid, failed, { error: err.message });
    if (failed === 'server_create_failed') {
      for (const fn of createFailedHooks) { try { fn(vmid); } catch { /* best effort */ } }
    }
  } finally {
    invalidateGuestCache();
  }
}

// ---- Reinstall --------------------------------------------------------------

/**
 * Replaces a server's installation with a fresh copy of an image: stops and
 * deletes the VM, clones the image again under the SAME ID, keeps name, size and
 * MAC address (so DHCP gives the same IP), re-applies network isolation and runs
 * the image's setup with new sign-in details. Disk content and snapshots are
 * erased. Only for servers the customer created. Returns right away; progress is
 * tracked through the `state` column like a creation.
 */
export async function reinstallServer(req, row, input) {
  const account = req.account;
  if (!row.created_by_customer) {
    throw new ProvisionError(403, 'Only servers you created yourself can be reinstalled');
  }
  if (!account.can_create) throw new ProvisionError(403, 'Reinstalling is not enabled for your account');
  if (activeRun(row.vmid)) throw new ProvisionError(409, 'Windows updates are being installed on this server. Wait until they have finished.');
  if (row.expired_at) throw new ProvisionError(403, 'This server has expired. Extend it first.');
  if (!['ready', 'failed'].includes(row.state)) {
    throw new ProvisionError(409, 'Wait until the current operation on this server has finished');
  }
  assertNoVolumes(row.vmid);
  if (creatingFor.has(account.id)) {
    throw new ProvisionError(409, 'Another server is being set up. Wait until it has finished.');
  }
  creatingFor.add(account.id);

  let background = false;
  try {
    const vmid = row.vmid;
    const old = row.spec ? JSON.parse(row.spec) : {};
    const guest = (await clusterGuests(true)).get(vmid) ?? null; // may be gone after a failed attempt
    const oldCfg = guest ? await pve.get(`${guestPath(guest)}/config`) : {};
    const oldDisk = bootDiskKey(oldCfg);
    const mac = /=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(oldCfg.net0 ?? '')?.[1] ?? old.mac ?? null;

    // Same size as before
    const spec = {
      ...input,
      hostname: old.hostname ?? guest?.name ?? `server-${vmid}`,
      cores: old.cores ?? (Number(oldCfg.cores) || 1),
      memoryMb: old.memoryMb ?? (Number(oldCfg.memory) || 1024),
      diskGb: old.diskGb ?? (oldDisk ? Math.ceil(diskSizeGb(oldCfg[oldDisk])) : 0),
    };

    const tplRow = db.prepare('SELECT * FROM templates WHERE vmid = ?').get(spec.templateId);
    const offered = (await offeredTemplates()).find((t) => t.id === spec.templateId);
    if (!tplRow || !offered) throw new ProvisionError(400, 'That image is not available');
    if (spec.diskGb < offered.minDiskGb) {
      throw new ProvisionError(400, `This image needs a disk of at least ${offered.minDiskGb} GB; this server has ${spec.diskGb} GB`);
    }
    applySetupRules(spec, offered);
    const tpl = await locateTemplate(spec.templateId);
    const cluster = guest?.cluster ?? tpl.cluster ?? 0;
    if (guest && (tpl.cluster ?? 0) !== cluster) {
      throw new ProvisionError(400, `The image ${offered.name} is not available where this server runs. Choose another image.`);
    }
    const net = config.network.enabled ? await ensureNetwork(account.id, cluster) : null;

    // The row keeps the ID reserved: new creations skip IDs the panel knows.
    db.prepare(`
      UPDATE vms SET state = 'creating', error = NULL, progress = 'Removing the old installation', spec = ?, ostype = NULL
      WHERE vmid = ?`).run(JSON.stringify({
      cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, template: tpl.vmid,
      hostname: spec.hostname, mac, reinstalledAt: new Date().toISOString(),
    }), vmid);
    // Things that belonged to the old installation
    db.prepare('DELETE FROM tasks WHERE vmid = ?').run(vmid);
    db.prepare('DELETE FROM tailscale WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'server_reinstall_started', { template: tpl.vmid, previousTemplate: old.template ?? null });

    background = true;
    const actor = { account: { id: account.id }, ip: req.ip };
    (async () => {
      try {
        if (guest) {
          const path = guestPath(guest);
          if (guest.status !== 'stopped') await waitTask(guest.node, await pve.post(`${path}/status/stop`));
          await waitTask(guest.node, await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 }));
          invalidateGuestCache();
        }
        setProgress.run('Copying the image', vmid);
        // Stay on the same node (and so in the same datacenter) as before
        const node = guest?.node ?? tpl.node;
        const upid = await serial(() => pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
          newid: vmid,
          name: spec.hostname,
          full: 1,
          target: node !== tpl.node ? node : undefined,
          storage: (row.datacenter_id && datacenterById(row.datacenter_id)?.storage) || tplRow.storage || undefined,
          pool: config.pve.pool,
        }));
        await finishCreate(actor, node, vmid, upid, spec, tplRow, net, {
          mac, done: 'server_reinstalled', failed: 'server_reinstall_failed',
        });
      } catch (err) {
        db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
          .run(`Reinstalling failed: ${err.message}`.slice(0, 500), vmid);
        audit(actor, vmid, 'server_reinstall_failed', { error: err.message });
        invalidateGuestCache();
      } finally {
        creatingFor.delete(account.id);
      }
    })();
  } finally {
    if (!background) creatingFor.delete(account.id);
  }
}

// ---- Resize -----------------------------------------------------------------

const resizing = new Set(); // one resize per server at a time

// Extends drive C: into free space behind it. Prints "extended", "nothing"
// (already full size) or "blocked" (another partition, e.g. Recovery, is in the way).
const WIN_EXTEND_C = `
$ErrorActionPreference = 'Stop'
Update-HostStorageCache
$part = Get-Partition -DriveLetter C
$max = (Get-PartitionSupportedSize -DriveLetter C).SizeMax
$disk = Get-Disk -Number $part.DiskNumber
if ($max - $part.Size -gt 100MB) { Resize-Partition -DriveLetter C -Size $max; 'extended' }
elseif ($disk.LargestFreeExtent -gt 100MB) { 'blocked' }
else { 'nothing' }
`;

/**
 * Changes CPU cores, memory and/or disk size of a customer-created server
 * within the plan. CPU/memory on a running server take effect at the next
 * restart by Proxmox (optionally right away); disks only grow.
 */
export async function resizeServer(req, row, { cores, memoryMb, diskGb, restart = false }, { planChange = false } = {}) {
  const account = req.account;
  if (!row.created_by_customer) throw new ProvisionError(403, 'Only servers you created yourself can be resized');
  if (row.plan_id && !planChange) throw new ProvisionError(409, 'This server is on a plan. Move it to a larger plan instead.');
  if (!account.can_create) throw new ProvisionError(403, 'Resizing is not enabled for your account');
  if (activeRun(row.vmid)) throw new ProvisionError(409, 'Windows updates are being installed on this server. Wait until they have finished.');
  if (row.expired_at) throw new ProvisionError(403, 'This server has expired. Extend it first.');
  if (row.state !== 'ready') throw new ProvisionError(409, 'Wait until the current operation on this server has finished');
  if (resizing.has(row.vmid)) throw new ProvisionError(409, 'This server is already being resized');
  resizing.add(row.vmid);
  try {
    const guest = (await clusterGuests(true)).get(row.vmid);
    if (!guest) throw new ProvisionError(404, 'Server not found');
    const path = guestPath(guest);
    const cfg = await pve.get(`${path}/config`); // includes pending values
    const windows = /^w/.test(cfg.ostype ?? '');
    const disk = bootDiskKey(cfg);
    const cur = {
      cores: (Number(cfg.cores) || 1) * (Number(cfg.sockets) || 1),
      memoryMb: Number(cfg.memory) || 512,
      diskGb: disk ? Math.ceil(diskSizeGb(cfg[disk])) : 0,
    };
    const next = { cores: cores ?? cur.cores, memoryMb: memoryMb ?? cur.memoryMb, diskGb: diskGb ?? cur.diskGb };

    if (next.diskGb < cur.diskGb) throw new ProvisionError(400, `Disks can only grow; this one has ${cur.diskGb} GB`);
    if (next.diskGb > cur.diskGb && !disk) throw new ProvisionError(400, "This server's disk can't be resized here");
    if (windows && next.memoryMb < 2048) throw new ProvisionError(400, 'Windows needs at least 2 GB of memory');
    const cpuMemChanged = next.cores !== cur.cores || next.memoryMb !== cur.memoryMb;
    const diskChanged = next.diskGb > cur.diskGb;
    if (!cpuMemChanged && !diskChanged) throw new ProvisionError(400, 'Nothing to change');

    // Plan: everything else the customer uses, plus this server's new size
    const limits = limitsOf(account);
    const usage = await usageOf(account.id);
    const others = { cores: usage.cores - cur.cores, memoryMb: usage.memoryMb - cur.memoryMb, diskGb: usage.diskGb - cur.diskGb };
    const over = [];
    if (others.cores + next.cores > limits.cores) over.push(`CPU cores (at most ${limits.cores - others.cores} for this server)`);
    if (others.memoryMb + next.memoryMb > limits.memoryMb) {
      over.push(`memory (at most ${((limits.memoryMb - others.memoryMb) / 1024).toFixed(1)} GB for this server)`);
    }
    if (others.diskGb + next.diskGb > limits.diskGb) over.push(`disk (at most ${limits.diskGb - others.diskGb} GB for this server)`);
    if (over.length) throw new ProvisionError(409, `This exceeds your plan: ${over.join(', ')}`);
    await checkPoolCapacity(account.id, {
      cores: next.cores - cur.cores, memoryMb: next.memoryMb - cur.memoryMb, diskGb: next.diskGb - cur.diskGb,
    });

    const running = guest.status === 'running';
    if (cpuMemChanged) {
      await pve.put(`${path}/config`, { cores: next.cores, sockets: 1, memory: next.memoryMb });
    }
    if (diskChanged) {
      try {
        await waitTask(guest.node, await pve.put(`${path}/resize`, { disk, size: `${next.diskGb}G` }));
      } catch (err) {
        throw new ProvisionError(502, `Proxmox could not enlarge the disk: ${err.message}`
          + (cpuMemChanged ? ' (the CPU/memory change was saved)' : ''));
      }
    }

    // Keep the stored size in step (used by reinstall)
    const spec = row.spec ? JSON.parse(row.spec) : {};
    db.prepare('UPDATE vms SET spec = ? WHERE vmid = ?')
      .run(JSON.stringify({ ...spec, cores: next.cores, memoryMb: next.memoryMb, diskGb: next.diskGb }), row.vmid);

    // Windows doesn't grow its partition by itself
    let windowsDisk = null;
    if (diskChanged && windows) {
      if (!running) {
        windowsDisk = 'not-running';
      } else {
        try {
          const r = await agentExec(path, [
            'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', Buffer.from(WIN_EXTEND_C, 'utf16le').toString('base64'),
          ], 120_000);
          windowsDisk = /extended/.test(r.out) ? 'extended' : /blocked/.test(r.out) ? 'blocked' : /nothing/.test(r.out) ? 'extended' : 'failed';
        } catch {
          windowsDisk = 'failed';
        }
      }
    }

    let restartTask = null;
    if (cpuMemChanged && running && restart) {
      restartTask = await pve.post(`${path}/status/reboot`); // a Proxmox restart applies pending changes
      invalidateGuestCache();
    }
    audit(req, row.vmid, 'server_resized', { before: cur, after: next, restart: !!restartTask });
    return {
      before: cur,
      after: next,
      pendingRestart: cpuMemChanged && running && !restartTask,
      restartTask: typeof restartTask === 'string' ? restartTask : null,
      windowsDisk,
    };
  } finally {
    resizing.delete(row.vmid);
  }
}

// ---- Delete -----------------------------------------------------------------

/** Proxmox destroys a VM's disks with it: refuse while the server holds block storage volumes. */
function assertNoVolumes(vmid) {
  const rows = db.prepare('SELECT label FROM volumes WHERE vmid = ?').all(vmid);
  if (rows.length) {
    throw new ProvisionError(409, `This server holds ${rows.length === 1 ? 'the volume' : 'the volumes'} ${rows.map((r) => r.label).join(', ')}. `
      + 'Move them to another server or delete them first; they would be destroyed with it.');
  }
}

/** Destroys a customer-created server (must be stopped) and removes its record. */
export async function deleteServer(req, row) {
  assertNoVolumes(row.vmid);
  const guests = await clusterGuests(true);
  const guest = guests.get(row.vmid);

  if (!guest) {
    // Clone never happened or VM already gone: just drop the record
    // (unless a cluster is out of sight: then the VM may still be there)
    if (guestMayBeHidden()) throw new HiddenGuestError();
    releaseIpsOfDeletedServer(row.vmid);
    db.prepare('DELETE FROM vms WHERE vmid = ?').run(row.vmid);
    audit(req, row.vmid, 'server_deleted');
    return { removed: true };
  }
  if (guest.status !== 'stopped') {
    throw new ProvisionError(409, 'Shut down the server before deleting it');
  }

  const path = `/nodes/${encodeURIComponent(guest.node)}/qemu/${row.vmid}`;
  const upid = await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 });
  db.prepare("UPDATE vms SET state = 'deleting' WHERE vmid = ?").run(row.vmid);
  audit(req, row.vmid, 'server_delete_started');

  const actor = { account: { id: req.account.id }, ip: req.ip };
  waitTask(guest.node, upid)
    .then(() => {
      releaseIpsOfDeletedServer(row.vmid);      // the VM and its NICs are gone
      db.prepare('DELETE FROM vms WHERE vmid = ?').run(row.vmid);
      audit(actor, row.vmid, 'server_deleted');
    })
    .catch((err) => {
      db.prepare("UPDATE vms SET state = 'failed', error = ? WHERE vmid = ?")
        .run(`Deleting failed: ${err.message}`.slice(0, 500), row.vmid);
    })
    .finally(invalidateGuestCache);

  return { removed: false };
}
