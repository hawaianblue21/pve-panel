// OS template imports: options per cluster, input checks, a cloud image (qcow2) from a
// URL with checksum, OVA appliances, the test boot on a linked clone, failures and
// retries from Jobs, and one copy per cluster.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';
import { startMockPve } from '../support/mock-pve.mjs';

let stack;
let admin;
let second;
let dc2;
const SHA = 'a'.repeat(64);
const target = (x = {}) => ({ clusterId: 0, node: 'pve1', storage: 'VMStorage', importStorage: 'local', ...x });
const body = (x = {}) => ({ name: 'ubuntu-2404', format: 'qcow2', url: 'https://cloud-images.example.com/noble-server-cloudimg-amd64.img', checksum: SHA, targets: [target()], ...x });
const imports = async () => (await admin.get('/api/admin/templates/imports')).json.imports;
const finished = (id) => waitFor(async () => { const i = (await imports()).find((x) => x.id === id); return ['ready', 'failed'].includes(i?.state) ? i : null; }, { timeout: 60_000, what: `import ${id}` });

before(async () => {
  second = await startMockPve({ second: true });
  stack = await startStack({ env: { TEMPLATE_TEST_BOOT_SECONDS: '10' } });
  admin = await stack.adminSession();
  const c = await admin.post('/api/admin/clusters', { key: 'dc2', name: 'Jakarta DC2', url: second.url, tokenId: 'panel@pve!panel', tokenSecret: 'x', verifyTls: true });
  assert.equal(c.status, 201, c.text);
  dc2 = c.json.id;
});
after(async () => { await stack?.stop(); await second?.close(); });

test('options: nodes per cluster with disk, import and ISO storages', async () => {
  const o = (await admin.get('/api/admin/templates/import-options')).json;
  assert.deepEqual(o.formats, ['qcow2', 'ova', 'iso']);
  const main = o.clusters.find((c) => c.id === 0);
  const pve1 = main.nodes.find((n) => n.node === 'pve1');
  assert.deepEqual(pve1.images, ['VMStorage', 'local-lvm']);
  assert.deepEqual(pve1.import, ['local']);
  assert.deepEqual(pve1.iso, ['local']);
  assert.deepEqual(o.clusters.find((c) => c.id === dc2).nodes.map((n) => n.node), ['pve3']);
});

test('input is checked; read-only roles can only look', async () => {
  const bad = async (x) => (await admin.post('/api/admin/templates/imports', body(x))).status;
  assert.equal(await bad({ url: 'ftp://example.com/x.img' }), 400);
  assert.equal(await bad({ url: 'https://user:pw@example.com/x.img' }), 400);
  assert.equal(await bad({ checksum: 'abc' }), 400);
  assert.equal(await bad({ format: 'vhd' }), 400);
  assert.equal(await bad({ targets: [] }), 400);
  assert.equal(await bad({ targets: [target({ clusterId: 42 })] }), 400);
  assert.equal(await bad({ targets: [target(), target()] }), 400, 'one target per cluster');
  assert.equal(await bad({ name: '9lives' }), 400);

  const u = await admin.post('/api/admin/users', { email: 'look@example.com', password: 'readonly-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'look@example.com', password: 'readonly-password-1' });
  assert.equal((await ro.get('/api/admin/templates/imports')).status, 200);
  assert.equal((await ro.post('/api/admin/templates/imports', body())).status, 403);
});

test('a cloud image becomes a draft template; a linked clone boots once and is removed', async () => {
  const r = await admin.post('/api/admin/templates/imports', body());
  assert.equal(r.status, 202, r.text);
  const i = await finished(r.json.imports[0].id);
  assert.equal(i.state, 'ready', i.error);
  assert.ok(i.vmid >= 9000);

  const dl = stack.mock.downloads.at(-1);
  assert.equal(dl.content, 'import');
  assert.equal(dl.checksum, SHA);
  assert.equal(dl['checksum-algorithm'], 'sha256');
  assert.match(dl.filename, /^pvepanel-\d+-ubuntu-2404\.qcow2$/);
  const made = stack.mock.created.findLast((c) => Number(c.vmid) === i.vmid);
  assert.equal(made.scsi0, `VMStorage:0,import-from=local:import/${dl.filename},discard=on`);
  assert.equal(made.ide2, 'VMStorage:cloudinit');
  assert.equal(made.agent, 'enabled=1');
  assert.match(made.net0, /^virtio,bridge=vmbr0/);
  assert.equal(stack.mock.vms.get(i.vmid).template, 1);
  assert.equal(stack.mock.files.get('local').length, 0, 'the downloaded file is removed');

  // test boot on a linked clone, which is gone again
  const clone = stack.mock.clones.find((c) => c.from === i.vmid);
  assert.equal(clone.full, '0');
  assert.equal(stack.mock.vms.has(Number(clone.newid)), false);
  assert.equal(stack.mock.vms.get(i.vmid).status, 'stopped', 'the template itself never boots');
  assert.deepEqual({ agent: i.test.agent, os: i.test.os, cloudInit: i.test.cloudInit }, { agent: true, os: 'Ubuntu 24.04.1 LTS', cloudInit: 'done' });
  assert.equal(i.label, 'Ubuntu 24.04.1 LTS');

  // listed with the templates, not offered yet
  const t = (await admin.get('/api/admin/templates')).json.templates.find((x) => x.vmid === i.vmid);
  assert.equal(t.offered, false);
  assert.equal(t.imported.format, 'qcow2');
  assert.equal(t.imported.test.agent, true);
});

test('an appliance (OVA): settings from the OVF, disks on VirtIO SCSI; a missing guest agent is reported', async () => {
  const r = await admin.post('/api/admin/templates/imports', body({ name: 'erp-noagent', format: 'ova', url: 'https://vendor.example.com/erp-2.4.ova', checksum: null, cloudinit: false }));
  assert.equal(r.status, 202, r.text);
  const i = await finished(r.json.imports[0].id);
  assert.equal(i.state, 'ready', i.error);
  const made = stack.mock.created.findLast((c) => Number(c.vmid) === i.vmid);
  assert.equal(made.cores, '2');
  assert.equal(made.memory, '4096');
  assert.match(made.scsi0, /^VMStorage:0,import-from=local:import\/pvepanel-\d+-erp-noagent\.ova\/erp-appliance-disk1\.vmdk$/);
  assert.match(made.scsi1, /erp-appliance-disk2\.vmdk$/);
  assert.equal(made.ide2, undefined, 'no cloud-init drive');
  assert.match(made.net0, /^virtio,/);
  assert.equal(i.test.agent, false);
  assert.equal(i.test.os, null);
});

test('failures: a wrong address or checksum leave nothing behind; Jobs can retry', async () => {
  const before = stack.mock.vms.size;
  const a = await finished((await admin.post('/api/admin/templates/imports', body({ name: 'gone', url: 'https://example.com/notfound.img' }))).json.imports[0].id);
  assert.equal(a.state, 'failed');
  assert.match(a.error, /404/);
  const b = await finished((await admin.post('/api/admin/templates/imports', body({ name: 'badsum', checksum: '0'.repeat(64) }))).json.imports[0].id);
  assert.match(b.error, /checksum mismatch/);
  assert.equal(stack.mock.vms.size, before, 'no VM was created');

  const job = (await admin.get('/api/admin/jobs?filter=failed')).json.jobs.find((j) => j.id === `import-${b.id}`);
  assert.equal(job.retry, 'template');
  const again = await admin.post('/api/admin/jobs/retry', { id: job.id });
  assert.equal(again.status, 200, again.text);
  assert.equal((await imports()).some((x) => x.id === b.id), false, 'the failed row is replaced');
  assert.ok((await imports()).find((x) => x.name === 'badsum' && x.id > b.id));
  assert.equal((await admin.del(`/api/admin/templates/imports/${a.id}`)).json.removed, true);
});

test('one copy per cluster', async () => {
  const r = await admin.post('/api/admin/templates/imports', body({ name: 'debian-12', url: 'https://cloud.example.com/debian-12-genericcloud-amd64.qcow2',
    targets: [target(), { clusterId: dc2, node: 'pve3', storage: 'VMStorage', importStorage: 'local' }] }));
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.imports.length, 2);
  assert.equal(new Set(r.json.imports.map((x) => x.batch)).size, 1);
  const [x, y] = await Promise.all(r.json.imports.map((i) => finished(i.id)));
  assert.equal(x.state, 'ready', x.error);
  assert.equal(y.state, 'ready', y.error);
  assert.equal(y.cluster, 'Jakarta DC2');
  assert.equal(second.vms.get(y.vmid).template, 1, 'built on the second cluster');
  assert.equal(y.test.os, 'Debian GNU/Linux 12 (bookworm)');
});

test('ISO (Windows): VirtIO drivers, UEFI and TPM; the administrator installs, then the template is built', async () => {
  const r = await admin.post('/api/admin/templates/imports', body({ name: 'win2025', format: 'iso', setup: 'windows', url: 'https://downloads.example.com/win2025-eval.iso', checksum: null, diskGb: 60, memoryMb: 4096 }));
  assert.equal(r.status, 202, r.text);
  const id = r.json.imports[0].id;
  const i = await waitFor(async () => { const x = (await imports()).find((y) => y.id === id); return ['installing', 'failed'].includes(x?.state) ? x : null; }, { timeout: 30_000, what: 'the VM to install' });
  assert.equal(i.state, 'installing', i.error);
  assert.match(i.consoleUrl, new RegExp(`#v1:0:=qemu%2F${i.vmid}:4`));
  const made = stack.mock.created.findLast((c) => Number(c.vmid) === i.vmid);
  assert.equal(made.scsi0, 'VMStorage:60,discard=on');
  assert.match(made.ide2, /^local:iso\/pvepanel-\d+-win2025\.iso,media=cdrom$/);
  assert.equal(made.ide0, 'local:iso/virtio-win.iso,media=cdrom');
  assert.deepEqual([made.bios, made.machine, made.ostype], ['ovmf', 'q35', 'win11']);
  assert.match(made.efidisk0, /efitype=4m/);
  assert.match(made.tpmstate0, /version=v2\.0/);
  assert.equal(made.boot, 'order=scsi0;ide2');
  assert.equal(stack.mock.downloads.filter((d) => d.filename === 'virtio-win.iso').length, 1);
  const job = (await admin.get('/api/admin/jobs')).json.jobs.find((j) => j.id === `import-${id}`);
  assert.equal(job.state, 'running');
  assert.match(job.detail, /Waiting for the installation/);

  assert.equal((await admin.post(`/api/admin/templates/imports/${id}/start`)).status, 200);
  await waitFor(() => (stack.mock.vms.get(i.vmid).status === 'running' ? true : null), { what: 'the VM to run' });
  const early = await admin.post(`/api/admin/templates/imports/${id}/installed`);
  assert.equal(early.status, 409);
  assert.match(early.json.error, /Sysprep/);
  stack.mock.vms.get(i.vmid).status = 'stopped';                    // sysprep /shutdown
  assert.equal((await admin.post(`/api/admin/templates/imports/${id}/installed`)).status, 202);
  const done = await finished(id);
  assert.equal(done.state, 'ready', done.error);
  const cfg = stack.mock.vms.get(i.vmid).cfg;
  assert.equal(cfg.ide2, 'none,media=cdrom');
  assert.equal(cfg.ide0, undefined, 'the driver CD is removed');
  assert.equal(cfg.boot, 'order=scsi0');
  assert.equal(stack.mock.vms.get(i.vmid).template, 1);
  assert.equal(done.test.agent, true);
  assert.equal(done.test.cloudInit, null);

  // a second Windows ISO uses the driver ISO that is there already
  const again = await admin.post('/api/admin/templates/imports', body({ name: 'win2022', format: 'iso', setup: 'windows', url: 'https://downloads.example.com/win2022.iso', checksum: null }));
  await waitFor(async () => ((await imports()).find((y) => y.id === again.json.imports[0].id)?.state === 'installing' ? true : null), { what: 'second install' });
  assert.equal(stack.mock.downloads.filter((d) => d.filename === 'virtio-win.iso').length, 1);
  assert.equal((await admin.post(`/api/admin/templates/imports/${again.json.imports[0].id}/cancel`)).json.error, 'Cancelled');
});

test('ISO (BSD): no drivers, no UEFI; cancelling removes the VM', async () => {
  const r = await admin.post('/api/admin/templates/imports', body({ name: 'freebsd-14', format: 'iso', setup: 'cloudinit', url: 'https://download.example.org/FreeBSD-14.2-RELEASE-amd64-disc1.iso', checksum: null }));
  const id = r.json.imports[0].id;
  const i = await waitFor(async () => { const x = (await imports()).find((y) => y.id === id); return x?.state === 'installing' ? x : null; }, { what: 'the VM to install' });
  const made = stack.mock.created.findLast((c) => Number(c.vmid) === i.vmid);
  assert.equal(made.ostype, 'other');
  assert.equal(made.ide0, undefined);
  assert.equal(made.bios, undefined);
  assert.equal(made.scsi0, 'VMStorage:40,discard=on');
  assert.equal((await admin.del(`/api/admin/templates/imports/${id}`)).status, 409, 'cancel first');
  const c = await admin.post(`/api/admin/templates/imports/${id}/cancel`);
  assert.equal(c.json.state, 'failed');
  await waitFor(() => (stack.mock.vms.has(i.vmid) ? null : true), { what: 'the VM to be removed' });
  assert.equal((await admin.post(`/api/admin/templates/imports/${id}/installed`)).status, 409);
});
