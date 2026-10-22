// OS template imports: an image becomes a Proxmox template the panel can offer.
//
//   qcow2 / img   a cloud image from a URL: Proxmox downloads it into an import storage
//                 (checksum verified there), a VM is created with the disk imported from
//                 it (import-from), a cloud-init drive and the guest agent switched on.
//   ova           an appliance from a URL: CPU, memory, OS type and disks are read from
//                 the OVF (import-metadata); disks are imported on VirtIO SCSI, the network
//                 card becomes VirtIO.
//   iso           installer media (Windows, BSD): the ISO (and for Windows the VirtIO driver
//                 ISO) is downloaded into an ISO storage, a VM with an empty disk boots
//                 from it; the administrator installs in the Proxmox console (Windows:
//                 VirtIO drivers, guest agent, Sysprep /generalize /oobe /shutdown), then
//                 "Installed": the CD drives are removed and the build continues.
//   Template      the VM is converted to a template (state Draft: not offered yet).
//   Test boot     optional: a linked clone of the template boots once, the panel waits for
//                 the guest agent, reads the OS name and the cloud-init result, then the
//                 clone is destroyed. The template itself never boots, so no machine-id or
//                 host key ends up in it.
//   Placement     node and storage per target; several clusters get one copy each (a batch).
//
// The downloaded file is removed once the disk is imported. Imports run in the
// background, two at a time; a restart marks running ones failed.

import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, allClusters, clusterById, serial, invalidateGuestCache, sleep } from './pve.js';
import { agentExec } from './agent.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const PARALLEL = Math.max(1, Number(process.env.TEMPLATE_IMPORTS_PARALLEL || 2));
const TEST_BOOT_MS = Math.max(10, Number(process.env.TEMPLATE_TEST_BOOT_SECONDS || 300)) * 1000;
const DOWNLOAD_MS = 4 * 3600_000;
const FORMATS = ['qcow2', 'ova', 'iso'];
export const VIRTIO_URL = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso';
const STEP = { queued: 'Waiting', downloading: 'Downloading', creating: 'Creating the VM', installing: 'Waiting for the installation', testing: 'Test boot', ready: 'Ready', failed: 'Failed' };
const nowIso = () => new Date().toISOString();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';

// ---- Options: where an import can go ---------------------------------------------------

/** Per cluster: online nodes with storages for VM disks, imports and ISO images. */
export async function importOptions() {
  const out = [];
  for (const c of allClusters()) {
    const api = pve.on(c.id);
    let nodes = [];
    try { nodes = (await api.get('/nodes')).filter((n) => n.status === 'online').map((n) => n.node).sort(); } catch { /* unreachable */ }
    const list = await Promise.all(nodes.map(async (node) => {
      const st = await api.get(`/nodes/${encodeURIComponent(node)}/storage`, { enabled: 1 }).catch(() => []);
      const has = (kind) => st.filter((x) => String(x.content ?? '').split(',').includes(kind)).map((x) => x.storage).sort();
      return { node, images: has('images'), import: has('import'), iso: has('iso'), shared: st.filter((x) => Number(x.shared)).map((x) => x.storage) };
    }));
    out.push({ id: c.id, name: c.name, nodes: list });
  }
  return { clusters: out, formats: FORMATS };
}

// ---- Requests -------------------------------------------------------------------------------

function checkInput(input) {
  const name = slug(input.name);
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) throw fail(400, 'Name: letters, digits and dashes, starting with a letter');
  if (!FORMATS.includes(input.format)) throw fail(400, `Format: ${FORMATS.join(' or ')}`);
  const url = String(input.url ?? '').trim();
  let u;
  try { u = new URL(url); } catch { throw fail(400, 'Source: a full http(s) address of the image'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw fail(400, 'Source: a full http(s) address of the image');
  const checksum = input.checksum ? String(input.checksum).trim().toLowerCase() : null;
  if (checksum && !/^[0-9a-f]{64}$/.test(checksum)) throw fail(400, 'Checksum: SHA-256, 64 hex characters (or leave it empty)');
  const setup = input.setup === 'windows' ? 'windows' : 'cloudinit';
  const cores = Number(input.cores ?? 2);
  const memoryMb = Number(input.memoryMb ?? 2048);
  if (!Number.isInteger(cores) || cores < 1 || cores > 64) throw fail(400, 'Cores: 1 to 64');
  if (!Number.isInteger(memoryMb) || memoryMb < 256 || memoryMb > 262_144) throw fail(400, 'Memory: 256 MB to 256 GB');
  const bridge = String(input.bridge ?? 'vmbr0').trim();
  if (!/^[A-Za-z][\w.-]{0,14}$/.test(bridge)) throw fail(400, 'Bridge: e.g. vmbr0');
  const targets = (input.targets ?? []).map((t) => ({
    clusterId: Number(t.clusterId ?? 0), node: String(t.node ?? ''), storage: String(t.storage ?? ''), importStorage: String(t.importStorage ?? ''),
  }));
  if (!targets.length) throw fail(400, 'Choose where the template goes');
  if (new Set(targets.map((t) => t.clusterId)).size !== targets.length) throw fail(400, 'One target per cluster');
  for (const t of targets) {
    if (!clusterById(t.clusterId)) throw fail(400, `Unknown cluster ${t.clusterId}`);
    for (const k of ['node', 'storage', 'importStorage']) if (!/^[A-Za-z0-9][\w.-]{0,62}$/.test(t[k])) throw fail(400, 'Choose node, disk storage and import storage');
  }
  const label = String(input.label ?? '').trim().slice(0, 80) || null;
  const options = { cloudinit: input.cloudinit !== false, testBoot: input.testBoot !== false, cores, memoryMb, bridge };
  if (input.format === 'iso') {
    const diskGb = Number(input.diskGb ?? 40);
    if (!Number.isInteger(diskGb) || diskGb < 4 || diskGb > 4096) throw fail(400, 'Disk: 4 to 4096 GB');
    options.diskGb = diskGb;
    options.virtio = setup === 'windows' && input.virtio !== false;
    options.cloudinit = setup === 'windows' ? false : input.cloudinit === true;
  }
  return { name, label, format: input.format, url, checksum, setup, targets, options };
}

export function startImport(req, input) {
  const x = checkInput(input);
  const batch = crypto.randomBytes(6).toString('hex');
  const ids = x.targets.map((t) => Number(db.prepare(`INSERT INTO template_imports
    (batch, name, label, format, source, checksum, cluster_id, node, storage, import_storage, setup, options, state, step, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(batch, x.name, x.label, x.format, x.url, x.checksum, t.clusterId, t.node, t.storage,
    t.importStorage, x.setup, JSON.stringify(x.options), STEP.queued, req.account?.id ?? null, nowIso()).lastInsertRowid));
  audit(req, null, 'admin_template_import', { batch, name: x.name, format: x.format, source: x.url, targets: x.targets });
  kick();
  return { batch, imports: ids.map((id) => pubImport(rowOf(id))) };
}

/** A failed import again, with the same settings (a new row). */
export function retryImport(req, id) {
  const r = rowOf(id);
  if (!r) throw fail(404, 'Import not found');
  if (r.state !== 'failed') throw fail(409, 'Only failed imports can be retried');
  const nid = Number(db.prepare(`INSERT INTO template_imports
    (batch, name, label, format, source, checksum, cluster_id, node, storage, import_storage, setup, options, state, step, created_by, created_at)
    SELECT batch, name, label, format, source, checksum, cluster_id, node, storage, import_storage, setup, options, 'queued', ?, ?, ? FROM template_imports WHERE id = ?`)
    .run(STEP.queued, req.account?.id ?? null, nowIso(), id).lastInsertRowid);
  db.prepare('DELETE FROM template_imports WHERE id = ?').run(id);
  audit(req, null, 'admin_template_import_retried', { id, newId: nid, name: r.name });
  kick();
  return pubImport(rowOf(nid));
}

export function removeImport(req, id) {
  const r = rowOf(id);
  if (!r) throw fail(404, 'Import not found');
  if (!['ready', 'failed'].includes(r.state)) throw fail(409, 'The import is still running');
  db.prepare('DELETE FROM template_imports WHERE id = ?').run(id);
  audit(req, null, 'admin_template_import_removed', { id, name: r.name });
  return { removed: true };
}

const rowOf = (id) => db.prepare('SELECT * FROM template_imports WHERE id = ?').get(id);
export const pubImport = (r) => ({
  id: r.id, batch: r.batch, name: r.name, label: r.label, format: r.format, source: r.source, checksum: !!r.checksum,
  clusterId: r.cluster_id, cluster: clusterById(r.cluster_id)?.name ?? String(r.cluster_id), node: r.node, storage: r.storage, importStorage: r.import_storage,
  setup: r.setup, options: JSON.parse(r.options || '{}'), vmid: r.vmid, state: r.state, step: r.step, error: r.error,
  test: r.test ? JSON.parse(r.test) : null, createdAt: r.created_at, finishedAt: r.finished_at,
  consoleUrl: r.state === 'installing' && r.vmid && clusterById(r.cluster_id)?.url ? `${String(clusterById(r.cluster_id).url).replace(/\/+$/, '')}/#v1:0:=qemu%2F${r.vmid}:4:::::::` : null,
});
export const listImports = (limit = 100) => db.prepare('SELECT * FROM template_imports ORDER BY id DESC LIMIT ?').all(limit).map(pubImport);
/** The latest finished import of a template VMID (for the templates table). */
export const importOfTemplate = (vmid) => {
  const r = db.prepare("SELECT * FROM template_imports WHERE vmid = ? AND state = 'ready' ORDER BY id DESC LIMIT 1").get(vmid);
  return r ? pubImport(r) : null;
};

// ---- Worker ---------------------------------------------------------------------------------------

const set = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE template_imports SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
};
const running = new Set();
let log = null;

function kick() {
  for (const r of db.prepare("SELECT id FROM template_imports WHERE state = 'queued' ORDER BY id").all()) {
    if (running.size >= PARALLEL) return;
    if (running.has(r.id)) continue;
    running.add(r.id);
    runImport(r.id).catch((err) => log?.warn(`Template import ${r.id}: ${err.message}`)).finally(() => { running.delete(r.id); kick(); });
  }
}

async function waitOn(api, upid, timeoutMs) {
  if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return 'OK';
  const node = upid.split(':')[1];
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await api.get(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
    if (s.status === 'stopped') {
      const exit = String(s.exitstatus ?? '');
      if (exit === 'OK' || exit.startsWith('WARNINGS')) return exit;
      throw new Error(exit || 'the Proxmox task failed');
    }
    if (Date.now() > end) throw new Error('the Proxmox task took too long');
    await sleep(1000);
  }
}

/** A free VMID on the cluster (templates from 9000 up), skipping IDs the panel knows. */
async function freeVmid(api, from) {
  return serial(async () => {
    const known = db.prepare('SELECT 1 FROM vms WHERE vmid = ? UNION SELECT 1 FROM template_imports WHERE vmid = ? AND state != \'failed\'');
    for (let id = from, tries = 0; tries < 2000; id += 1, tries += 1) {
      if (known.get(id, id)) continue;
      try { await api.get('/cluster/nextid', { vmid: id }); return id; } catch { /* taken */ }
    }
    throw new Error('No free VM ID found');
  });
}

async function runImport(id) {
  let r = rowOf(id);
  const api = pve.on(r.cluster_id);
  const o = JSON.parse(r.options || '{}');
  const node = encodeURIComponent(r.node);
  let vmid = null;
  let fileVolid = null;
  try {
    // 1. download into the import storage (Proxmox checks the checksum)
    set(id, { state: 'downloading', step: 'Downloading the image' });
    const iso = r.format === 'iso';
    const content = iso ? 'iso' : 'import';
    const filename = `pvepanel-${id}-${r.name}.${{ ova: 'ova', iso: 'iso' }[r.format] ?? 'qcow2'}`;
    const istore = `/nodes/${node}/storage/${encodeURIComponent(r.import_storage)}`;
    const upid = await api.post(`${istore}/download-url`, {
      content, filename, url: r.source, 'verify-certificates': 1,
      ...(r.checksum ? { checksum: r.checksum, 'checksum-algorithm': 'sha256' } : {}),
    });
    await waitOn(api, upid, DOWNLOAD_MS);
    fileVolid = `${r.import_storage}:${content}/${filename}`;
    set(id, { file_volid: fileVolid });
    let virtioVolid = null;
    if (iso && o.virtio) {
      // the VirtIO driver ISO, once per storage
      virtioVolid = `${r.import_storage}:iso/virtio-win.iso`;
      const have = await api.get(`${istore}/content`, { content: 'iso' }).catch(() => []);
      if (!have.some((f) => f.volid === virtioVolid)) {
        set(id, { step: 'Downloading the VirtIO drivers' });
        await waitOn(api, await api.post(`${istore}/download-url`, { content: 'iso', filename: 'virtio-win.iso', url: VIRTIO_URL, 'verify-certificates': 1 }), DOWNLOAD_MS);
      }
    }

    // 2. the VM, its disk(s) imported from the file
    set(id, { state: 'creating', step: 'Creating the VM' });
    vmid = await freeVmid(api, 9000);
    set(id, { vmid });
    const params = {
      vmid, name: r.name, cores: o.cores, memory: o.memoryMb, ostype: r.setup === 'windows' ? 'win11' : 'l26',
      scsihw: 'virtio-scsi-single', agent: 'enabled=1', net0: `virtio,bridge=${o.bridge}`, pool: config.pve.pool || undefined,
    };
    if (iso) {
      params.scsi0 = `${r.storage}:${o.diskGb},discard=on`;
      params.ide2 = `${fileVolid},media=cdrom`;
      if (virtioVolid) params.ide0 = `${virtioVolid},media=cdrom`;
      if (r.setup === 'windows') {
        Object.assign(params, { machine: 'q35', bios: 'ovmf', efidisk0: `${r.storage}:1,efitype=4m,pre-enrolled-keys=1`, tpmstate0: `${r.storage}:1,version=v2.0` });
      } else {
        params.ostype = 'other';
      }
    } else if (r.format === 'qcow2') {
      params.scsi0 = `${r.storage}:0,import-from=${fileVolid},discard=on`;
    } else {
      const meta = await api.get(`/nodes/${node}/storage/${encodeURIComponent(r.import_storage)}/import-metadata`, { volume: fileVolid });
      const ca = meta?.['create-args'] ?? {};
      for (const k of ['cores', 'sockets', 'memory', 'ostype', 'bios']) if (ca[k] !== undefined) params[k] = ca[k];
      const disks = Object.keys(meta?.disks ?? {}).sort();
      if (!disks.length) throw new Error('The OVF lists no disks');
      disks.forEach((k, i) => { params[`scsi${i}`] = `${r.storage}:0,import-from=${meta.disks[k]}`; });
      if (params.bios === 'ovmf') params.efidisk0 = `${r.storage}:1,efitype=4m`;
    }
    params.boot = iso ? 'order=scsi0;ide2' : 'order=scsi0';
    if (o.cloudinit && !iso) params.ide2 = `${r.storage}:cloudinit`;
    await waitOn(api, await api.post(`/nodes/${node}/qemu`, params), 2 * 3600_000);
    if (iso) {
      // the administrator installs now; "Installed" continues (finishInstall)
      set(id, { state: 'installing', step: 'Start the VM, install in the Proxmox console, then shut it down' });
      audit({ account: r.created_by ? { id: r.created_by } : null, ip: 'import' }, vmid, 'admin_template_install_ready', { id, name: r.name });
      return;
    }
    await api.del(`${istore}/content/${encodeURIComponent(fileVolid)}`).catch(() => {});
    fileVolid = null;
    set(id, { file_volid: null });
    await finishBuild(id, api, vmid);
  } catch (err) {
    await failImport(id, api, r, vmid, fileVolid, err);
  }
}

/** Template, test boot, ready: the end of every import. */
async function finishBuild(id, api, vmid) {
  const r = rowOf(id);
  const o = JSON.parse(r.options || '{}');
  const node = encodeURIComponent(r.node);
  // 3. template
  set(id, { state: 'creating', step: 'Converting to a template' });
  await waitOn(api, await api.post(`/nodes/${node}/qemu/${vmid}/template`), 30 * 60_000);
  invalidateGuestCache();

  // 4. test boot on a linked clone
  let test = null;
  if (o.testBoot) {
    set(id, { state: 'testing', step: 'Test boot: starting a clone' });
    test = await testBoot(api, r, vmid, o, (step) => set(id, { step }));
  }
  set(id, {
    state: 'ready', step: STEP.ready, test: test ? JSON.stringify(test) : null, finished_at: nowIso(),
    label: r.label ?? (test?.os || null),
  });
  audit({ account: r.created_by ? { id: r.created_by } : null, ip: 'import' }, vmid, 'admin_template_imported', { id, name: r.name, test });
}

async function failImport(id, api, r, vmid, fileVolid, err) {
  const message = String(err.message ?? err).slice(0, 400);
  const templated = vmid ? await api.get(`/nodes/${encodeURIComponent(r.node)}/qemu/${vmid}/config`).then((c) => Number(c.template) === 1).catch(() => false) : false;
  if (vmid && !templated) await destroy(api, r.node, vmid);
  if (fileVolid && r.format !== 'iso') await api.del(`/nodes/${encodeURIComponent(r.node)}/storage/${encodeURIComponent(r.import_storage)}/content/${encodeURIComponent(fileVolid)}`).catch(() => {});
  set(id, { state: 'failed', step: STEP.failed, error: message, finished_at: nowIso(), ...(templated ? {} : { vmid: null }) });
  audit({ account: r.created_by ? { id: r.created_by } : null, ip: 'import' }, null, 'admin_template_import_failed', { id, name: r.name, error: message });
}

// ---- ISO installs: start, installed, cancel --------------------------------------------------------

function installing(id) {
  const r = rowOf(id);
  if (!r) throw fail(404, 'Import not found');
  if (r.state !== 'installing') throw fail(409, 'This import is not waiting for an installation');
  return { r, api: pve.on(r.cluster_id), path: `/nodes/${encodeURIComponent(r.node)}/qemu/${r.vmid}` };
}

export async function startInstallVm(req, id) {
  const { r, api, path } = installing(id);
  const st = await api.get(`${path}/status/current`);
  if (st.status !== 'running') await waitOn(api, await api.post(`${path}/status/start`), 5 * 60_000);
  audit(req, r.vmid, 'admin_template_install_started', { id, name: r.name });
  return pubImport(rowOf(id));
}

/** The installation is done and the VM shut down: remove the CD drives and build the template. */
export async function finishInstall(req, id) {
  const { r, api, path } = installing(id);
  const st = await api.get(`${path}/status/current`);
  if (st.status !== 'stopped') throw fail(409, r.setup === 'windows' ? 'Shut the VM down first (Sysprep /generalize /oobe /shutdown)' : 'Shut the VM down first');
  const cfg = await api.get(`${path}/config`);
  const drop = Object.keys(cfg).filter((k) => /^(ide|sata)\d+$/.test(k) && /media=cdrom/.test(String(cfg[k])) && k !== 'ide2');
  await api.put(`${path}/config`, { ide2: 'none,media=cdrom', boot: 'order=scsi0', ...(drop.length ? { delete: drop.join(',') } : {}) });
  set(id, { state: 'creating', step: 'Converting to a template' });
  audit(req, r.vmid, 'admin_template_installed', { id, name: r.name });
  running.add(id);
  // a failure here keeps the installed VM (and its VMID) for a look; retry builds a new one
  finishBuild(id, api, r.vmid).catch((err) => {
    set(id, { state: 'failed', step: STEP.failed, error: String(err.message ?? err).slice(0, 400), finished_at: nowIso() });
  }).finally(() => running.delete(id));
  return pubImport(rowOf(id));
}

export async function cancelInstall(req, id) {
  const { r, api } = installing(id);
  await destroy(api, r.node, r.vmid);
  set(id, { state: 'failed', step: STEP.failed, error: 'Cancelled', vmid: null, finished_at: nowIso() });
  audit(req, null, 'admin_template_install_cancelled', { id, name: r.name });
  return pubImport(rowOf(id));
}

async function destroy(api, node, vmid) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}`;
  try {
    const st = await api.get(`${path}/status/current`).catch(() => null);
    if (st && st.status !== 'stopped') await waitOn(api, await api.post(`${path}/status/stop`), 120_000).catch(() => {});
    await waitOn(api, await api.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 }), 10 * 60_000);
  } catch { /* left for an administrator */ }
  invalidateGuestCache();
}

/** Boots a linked clone of the template once: guest agent, OS name, cloud-init result. */
async function testBoot(api, r, templateId, o, step) {
  const started = Date.now();
  const node = encodeURIComponent(r.node);
  const testId = await freeVmid(api, Number(await api.get('/cluster/nextid')));
  const path = `/nodes/${node}/qemu/${testId}`;
  const result = { agent: false, os: null, cloudInit: o.cloudinit ? 'unknown' : null, seconds: null, error: null };
  try {
    let upid;
    try {
      upid = await api.post(`/nodes/${node}/qemu/${templateId}/clone`, { newid: testId, name: `${r.name}-test`, full: 0, pool: config.pve.pool || undefined });
    } catch {
      upid = await api.post(`/nodes/${node}/qemu/${templateId}/clone`, { newid: testId, name: `${r.name}-test`, full: 1, storage: r.storage, pool: config.pve.pool || undefined });
    }
    await waitOn(api, upid, 30 * 60_000);
    if (o.cloudinit) {
      await api.put(`${path}/config`, { ciuser: 'paneltest', cipassword: crypto.randomBytes(18).toString('base64url'), ipconfig0: 'ip=dhcp' });
    }
    step('Test boot: waiting for the guest agent');
    await waitOn(api, await api.post(`${path}/status/start`), 5 * 60_000);
    const end = Date.now() + TEST_BOOT_MS;
    while (Date.now() < end) {
      try { await api.post(`${path}/agent/ping`); result.agent = true; break; } catch { await sleep(3000); }
    }
    if (result.agent) {
      const info = await api.get(`${path}/agent/get-osinfo`).catch(() => null);
      result.os = info?.result?.['pretty-name'] ?? info?.result?.name ?? null;
      if (o.cloudinit && r.setup !== 'windows') {
        step('Test boot: checking cloud-init');
        const c = await agentExec(path, ['cloud-init', 'status', '--wait'], 180_000).catch(() => null);
        result.cloudInit = !c ? 'unknown' : /status: done/.test(c.out) ? 'done' : /status: (error|degraded)/.test(c.out) ? 'error' : 'unknown';
      }
    }
  } catch (err) {
    result.error = String(err.message ?? err).slice(0, 300);
  } finally {
    step('Test boot: removing the clone');
    await destroy(api, r.node, testId);
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  return result;
}

export function startImportWorker(logger) {
  log = logger;
  const cut = db.prepare("UPDATE template_imports SET state = 'failed', step = 'Failed', error = 'Interrupted (the panel restarted); retry it', finished_at = ? WHERE state IN ('downloading', 'creating', 'testing')").run(nowIso()).changes;
  if (cut) log?.warn(`${cut} template import(s) were interrupted by a restart`);
  kick();
  setInterval(kick, 30_000).unref();
}
