// Block storage: tiers, create, detach (only when stopped), move between servers
// (same node only), enlarge, delete, quota, server delete guard, billing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let rina;
let second;           // a server rina created herself
const vol = {};
const DAY = 86_400_000;

const pveGet = async (p) => (await (await fetch(`${stack.mock.url}/api2/json${p}`, { headers: { authorization: 'PVEAPIToken=panel@pve!panel=x' } })).json()).data;
const cfgOf = (vmid) => pveGet(`/nodes/pve1/qemu/${vmid}/config`);
const list = async () => (await rina.get('/api/volumes')).json;
const stop = async (vmid) => {
  await rina.post(`/api/vms/${vmid}/power/stop`);
  await waitFor(async () => ((await rina.get(`/api/vms/${vmid}`)).json.status === 'stopped' ? true : null), { what: `server ${vmid} stopped` });
};

before(async () => {
  stack = await startStack();
  admin = await stack.adminSession();
  await stack.offerTemplates();
  rina = await stack.customerWith('rina@example.com', { limits: { maxDiskGb: 200 } });
  await admin.put('/api/admin/vms/101', { userId: rina.userId, label: 'web-prod' });            // 20 GB system disk, stopped
  const r = await rina.post('/api/vms', { hostname: 'app-01', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
  assert.equal(r.status, 202, r.text);
  second = r.json.vmid;
  assert.equal((await stack.serverSettled(rina, second)).state, 'ready');
});
after(async () => { await stack?.stop(); });

test('off until the owner sets up tiers; tier rules are checked', async () => {
  assert.deepEqual((await rina.get('/api/volumes')).json, { enabled: false });
  assert.equal((await rina.post('/api/volumes', { label: 'x', tier: 'standard', sizeGb: 5, vmid: 101 })).status, 404);
  assert.equal((await admin.put('/api/admin/settings/volumes', { tiers: [{ id: 'NVMe!', name: 'x', pricePerGb: 1 }] })).status, 400);
  assert.equal((await admin.put('/api/admin/settings/volumes', { tiers: [{ id: 'a', name: 'A', pricePerGb: 1 }, { id: 'a', name: 'B', pricePerGb: 1 }] })).status, 400);
  assert.equal((await admin.put('/api/admin/settings/volumes', { tiers: [{ id: 'a', name: 'A', storage: 'bad storage', pricePerGb: 1 }] })).status, 400);
  const r = await admin.put('/api/admin/settings/volumes', {
    enabled: true, maxSizeGb: 500, maxPerServer: 4,
    tiers: [
      { id: 'nvme', name: 'NVMe', description: 'Databases', storage: 'ceph-nvme', pricePerGb: 1500 },
      { id: 'hdd', name: 'Archive', description: 'Backups, logs', storage: '', pricePerGb: 300 },
    ],
  });
  assert.equal(r.status, 200, r.text);
  const o = await list();
  assert.equal(o.enabled, true);
  assert.deepEqual(o.tiers.map((t) => t.id), ['nvme', 'hdd']);
  assert.equal(o.tiers[0].storage, undefined, 'customers do not see storage IDs');
  assert.deepEqual(o.servers.map((s) => s.vmid).sort(), [101, second].sort());
});

test('create: a new disk on the tier storage, hot-added; names, size and quota are checked', async () => {
  const r = await rina.post('/api/volumes', { label: 'db-data', tier: 'nvme', sizeGb: 50, vmid: 101 });
  assert.equal(r.status, 201, r.text);
  vol.db = r.json.id;
  assert.equal(r.json.slot, 'scsi1');
  assert.equal(r.json.attached, true);
  assert.equal(r.json.monthly, 75_000);
  const cfg = await cfgOf(101);
  assert.match(cfg.scsi1, /^ceph-nvme:vm-101-disk-\d+,size=50G,discard=on$/);

  assert.equal((await rina.post('/api/volumes', { label: 'db-data', tier: 'nvme', sizeGb: 5, vmid: 101 })).status, 409, 'same name');
  assert.equal((await rina.post('/api/volumes', { label: 'bad name!', tier: 'nvme', sizeGb: 5, vmid: 101 })).status, 400);
  assert.equal((await rina.post('/api/volumes', { label: 'big', tier: 'nvme', sizeGb: 501, vmid: 101 })).status, 400, 'over the largest size');
  assert.equal((await rina.post('/api/volumes', { label: 'gold', tier: 'gold', sizeGb: 5, vmid: 101 })).status, 400, 'unknown tier');
  // 20 + 10 + 50 used of 200
  const over = await rina.post('/api/volumes', { label: 'big', tier: 'nvme', sizeGb: 150, vmid: 101 });
  assert.equal(over.status, 409);
  assert.match(over.json.error, /120 GB left of 200 GB/);
  assert.equal((await rina.post('/api/volumes', { label: 'x', tier: 'nvme', sizeGb: 5, vmid: 102 })).status, 404, 'not her server');

  const logs = await rina.post('/api/volumes', { label: 'logs', tier: 'hdd', sizeGb: 10, vmid: second });
  assert.equal(logs.status, 201, logs.text);
  vol.logs = logs.json.id;
  assert.match((await cfgOf(second)).scsi1, /^VMStorage:vm-\d+-disk-\d+,size=10G/, 'empty tier storage: the system disk\'s storage');
});

test('detach only when the server is shut down; the data stays and still counts', async () => {
  const running = (await rina.get(`/api/vms/${second}`)).json.status;
  if (running !== 'running') { await rina.post(`/api/vms/${second}/power/start`); await new Promise((r) => setTimeout(r, 1200)); }
  const r = await rina.post(`/api/volumes/${vol.logs}/detach`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Shut the server down/);
  await stop(second);
  const d = await rina.post(`/api/volumes/${vol.logs}/detach`);
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.attached, false);
  const cfg = await cfgOf(second);
  assert.equal(cfg.scsi1, undefined);
  assert.match(cfg.unused0, /^VMStorage:vm-\d+-disk-\d+$/);
  assert.equal((await list()).disk.usedGb, 90, '20 + 10 + 50 + 10 detached');
  assert.equal((await rina.post(`/api/volumes/${vol.logs}/resize`, { sizeGb: 20 })).status, 409, 'attach before enlarging');
});

test('attach to another server on the same host moves the disk there', async () => {
  const r = await rina.post(`/api/volumes/${vol.logs}/attach`, { vmid: 101 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.vmid, 101);
  assert.equal(r.json.slot, 'scsi2');
  const target = await cfgOf(101);
  assert.match(target.scsi2, /^VMStorage:vm-101-disk-\d+,size=10G$/);
  assert.equal(Object.keys(await cfgOf(second)).some((k) => k.startsWith('unused')), false, 'gone from the old server');
  assert.equal((await rina.post(`/api/volumes/${vol.logs}/attach`, { vmid: 101 })).status, 409, 'already attached');
});

test('enlarge grows the disk in Proxmox and is checked against the quota', async () => {
  assert.equal((await rina.post(`/api/volumes/${vol.db}/resize`, { sizeGb: 40 })).status, 400, 'only grows');
  assert.equal((await rina.post(`/api/volumes/${vol.db}/resize`, { sizeGb: 200 })).status, 409, 'over the disk limit');
  const r = await rina.post(`/api/volumes/${vol.db}/resize`, { sizeGb: 80 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sizeGb, 80);
  assert.match((await cfgOf(101)).scsi1, /size=80G/);
  assert.equal((await rina.patch(`/api/volumes/${vol.db}`, { label: 'pg-data' })).json.label, 'pg-data');
});

test('a server holding volumes cannot be deleted; a detached volume can be deleted', async () => {
  const t = await rina.post('/api/volumes', { label: 'tmp', tier: 'hdd', sizeGb: 5, vmid: second });
  assert.equal(t.status, 201, t.text);
  const del = await rina.del(`/api/vms/${second}`);
  assert.equal(del.status, 409);
  assert.match(del.json.error, /holds the volume tmp/);
  assert.equal((await rina.del(`/api/volumes/${t.json.id}`)).status, 409, 'detach first');
  assert.equal((await rina.post(`/api/volumes/${t.json.id}/detach`)).status, 200);
  assert.equal((await rina.del(`/api/volumes/${t.json.id}`)).status, 200);
  assert.equal(Object.keys(await cfgOf(second)).some((k) => k.startsWith('unused')), false, 'destroyed in Proxmox');
  assert.equal((await list()).volumes.some((v) => v.label === 'tmp'), false);
});

test('moving to a server on another host is refused with a clear message', async () => {
  await fetch(`${stack.mock.url}/api2/json/__node/${second}/pve2`, { headers: { authorization: 'PVEAPIToken=panel@pve!panel=x' } });
  await stop(101).catch(() => {});
  assert.equal((await rina.post(`/api/volumes/${vol.logs}/detach`)).status, 200);
  const r = await rina.post(`/api/volumes/${vol.logs}/attach`, { vmid: second });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /same host \(pve1\)/);
  await fetch(`${stack.mock.url}/api2/json/__node/${second}/pve1`, { headers: { authorization: 'PVEAPIToken=panel@pve!panel=x' } });
  assert.equal((await rina.post(`/api/volumes/${vol.logs}/attach`, { vmid: 101 })).status, 200, 'back on its own server');
});

test('volumes are billed with the server that holds them', async () => {
  await admin.put('/api/admin/settings/billing', { enabled: true, taxRate: 11, bank: { enabled: true, instructions: 'BCA 123' } });
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: new Date(Date.now() + 10 * DAY).toISOString() });
  const inv = await rina.post('/api/billing/renewals', { vmid: 101, months: 1 });
  assert.equal(inv.status, 201, inv.text);
  assert.equal(inv.json.lines.length, 2);
  assert.match(inv.json.lines[1].description, /^Block storage: pg-data 80 GB NVMe, logs 10 GB Archive · 1 month$/);
  assert.equal(inv.json.lines[1].amount, 80 * 1500 + 10 * 300);
  assert.equal(inv.json.subtotal, 230_000 + 123_000);
  const o = (await rina.get('/api/billing')).json;
  assert.equal(o.servers.find((s) => s.vmid === 101).monthly, 353_000);
});

test('privacy, admin list, tiers in use stay', async () => {
  const bob = await stack.customerWith('bob@example.com', { limits: {} });
  assert.deepEqual((await bob.get('/api/volumes')).json.volumes, []);
  assert.equal((await bob.post(`/api/volumes/${vol.db}/detach`)).status, 404);
  assert.equal((await bob.del(`/api/volumes/${vol.db}`)).status, 404);
  const a = (await admin.get('/api/admin/volumes')).json;
  assert.deepEqual(a.volumes.map((v) => [v.email, v.label]), [['rina@example.com', 'logs'], ['rina@example.com', 'pg-data']]);
  assert.deepEqual(a.totals.map((t) => [t.tier, t.count, t.gb]), [['nvme', 1, 80], ['hdd', 1, 10]]);
  const drop = await admin.put('/api/admin/settings/volumes', { tiers: [{ id: 'nvme', name: 'NVMe', storage: 'ceph-nvme', pricePerGb: 1500 }] });
  assert.equal(drop.status, 409);
  assert.match(drop.json.error, /hdd still has volumes/);
});
