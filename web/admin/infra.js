// Administration tabs for access control and infrastructure:
//   Access     roles and administrators (RBAC)
//   Resources  datacenters and resource allocation pools
//   Storage    object storage on SeaweedFS (S3): connection, buckets, access keys
//   GPUs       Proxmox PCI resource mappings, GPU profiles and assignments
// Plugged into admin.js; every action is also checked on the server (rbac.js).

const GB = 1024;

export function createInfra({ root, api, toast, fail, confirmAction, esc }) {
  const st = { perms: new Set(), rbac: null, dcs: [], pools: [], users: [], s3: null, buckets: null, gpu: null, secret: null, editRole: null };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const show = (v, unit = '') => (v === null || v === undefined ? '<span class="muted">no cap</span>' : `${esc(v)}${unit}`);

  const TABS = [
    ['access', 'Access', 'rbac.write'],
    ['resources', 'Resources', 'pools.read'],
    ['storage', 'Object storage', 'storage.read'],
    ['gpu', 'GPUs', 'gpu.read'],
  ];

  // ---- loading ----------------------------------------------------------------
  async function load(tab) {
    if (tab === 'access') st.rbac = await api('/api/admin/rbac');
    if (tab === 'resources') {
      [st.dcs, st.pools, st.users] = await Promise.all([
        api('/api/admin/datacenters'), api('/api/admin/pools'),
        can('customers.read') ? api('/api/admin/users') : Promise.resolve([]),
      ]);
      st.gpuProfiles = can('gpu.read') ? (await api('/api/admin/gpu').catch(() => ({ profiles: [] }))).profiles : [];
    }
    if (tab === 'storage') {
      st.s3 = await api('/api/admin/storage/s3');
      st.buckets = st.s3.configured ? await api('/api/admin/storage/s3/buckets').catch((err) => ({ error: err.message })) : null;
      [st.pools, st.users] = await Promise.all([api('/api/admin/pools'), can('customers.read') ? api('/api/admin/users') : Promise.resolve([])]);
    }
    if (tab === 'gpu') st.gpu = await api('/api/admin/gpu');
  }

  function render(tab) {
    if (tab === 'access') renderAccess();
    if (tab === 'resources') renderResources();
    if (tab === 'storage') renderStorage();
    if (tab === 'gpu') renderGpu();
  }

  // ---- Access (RBAC) -------------------------------------------------------------
  function renderAccess() {
    const { roles, admins, permissions } = st.rbac;
    const groups = [...new Set(permissions.map((p) => p.group))];
    const editing = st.editRole ? roles.find((r) => r.id === st.editRole) : null;
    const checked = new Set(editing?.permissions ?? []);
    body().innerHTML = `
      <p class="muted" style="max-width:75ch">Every administrator has a role. A role is a set of permissions; the server checks
      them on every request. Administrators created on the command line or at first start are owners.</p>

      <h2 class="h2">Administrators</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Email</th><th>Role</th><th>2FA</th><th>Passkeys</th><th>Added</th></tr></thead>
        <tbody>${admins.map((a) => `
          <tr data-admin="${a.id}">
            <td>${esc(a.email)}</td>
            <td><label class="sr-only" for="role-${a.id}">Role of ${esc(a.email)}</label>
              <select id="role-${a.id}" data-admin-role="${a.id}">
                ${roles.map((r) => `<option value="${r.id}" ${r.id === a.roleId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
              </select></td>
            <td>${a.totpEnabled ? 'On' : '<span class="muted">Off</span>'}</td>
            <td>${a.passkeys}</td>
            <td class="muted">${esc((a.createdAt ?? '').slice(0, 10))}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Make someone an administrator in the Customers tab; they start as Operator.</p>

      <h2 class="h2">Roles</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Role</th><th>Permissions</th><th>Members</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${roles.map((r) => `
          <tr data-role="${r.id}">
            <td><strong>${esc(r.name)}</strong> ${r.builtin ? '<span class="tag">built-in</span>' : ''}<br><span class="muted small">${esc(r.description ?? '')}</span></td>
            <td class="small">${r.permissions.length === permissions.length ? 'All' : r.permissions.map((p) => `<span class="tag">${esc(p)}</span>`).join(' ')}</td>
            <td>${r.members}</td>
            <td class="actions">${r.builtin ? '' : `
              <button class="btn" data-role-edit="${r.id}">Edit</button>
              <button class="btn danger" data-role-delete="${r.id}" ${r.members ? 'disabled title="Still assigned"' : ''}>Delete</button>`}</td>
          </tr>`).join('')}</tbody>
      </table></div>

      <h2 class="h2">${editing ? `Edit role: ${esc(editing.name)}` : 'New role'}</h2>
      <form id="role-form" class="limits-form" autocomplete="off">
        <div class="grid-3">
          <label>Key <input name="key" required pattern="[a-z][a-z0-9-]{1,30}" value="${esc(editing?.key ?? '')}" ${editing ? 'disabled' : ''} placeholder="billing-desk"></label>
          <label>Name <input name="name" required maxlength="60" value="${esc(editing?.name ?? '')}"></label>
          <label>Description <input name="description" maxlength="200" value="${esc(editing?.description ?? '')}"></label>
        </div>
        ${groups.map((g) => `
          <fieldset class="perm-group"><legend>${esc(g)}</legend>
            ${permissions.filter((p) => p.group === g).map((p) => `
              <label class="check"><input type="checkbox" name="perm" value="${esc(p.key)}" ${checked.has(p.key) ? 'checked' : ''}>
                <span>${esc(p.label)} <span class="muted mono">${esc(p.key)}</span></span></label>`).join('')}
          </fieldset>`).join('')}
        <div class="row">
          <button class="btn primary">${editing ? 'Save role' : 'Create role'}</button>
          ${editing ? '<button type="button" class="btn ghost" data-role-cancel>Cancel</button>' : ''}
        </div>
      </form>`;
  }

  // ---- Resources: datacenters + pools ----------------------------------------------
  const meter = (used, cap, fmt = (v) => v) => {
    if (cap === null || cap === undefined) return `<span class="mono">${esc(fmt(used))}</span> <span class="muted small">no cap</span>`;
    const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : (used ? 100 : 0);
    return `<span class="mono">${esc(fmt(used))} / ${esc(fmt(cap))}</span>
      <span class="meter" role="img" aria-label="${pct}% used"><i style="width:${pct}%"></i></span>`;
  };

  function poolForm(p = {}) {
    const dcIds = new Set(p.datacenters ?? []);
    const gpuIds = new Set(p.gpuProfiles ?? []);
    const v = (x) => (x === null || x === undefined ? '' : x);
    return `
      <form class="limits-form pool-form" data-pool-form="${p.id ?? ''}" autocomplete="off">
        <div class="grid-2">
          <label>Name <input name="name" required maxlength="80" value="${esc(p.name ?? '')}"></label>
          <label>Description <input name="description" maxlength="300" value="${esc(p.description ?? '')}"></label>
        </div>
        <p class="muted small">Totals for all customers in the pool. Leave empty for no cap at pool level (each customer's own limits still apply).
        GPUs and object storage are only included when set above 0.</p>
        <div class="grid-3">
          <label>vCPU <input name="maxCores" type="number" min="0" value="${v(p.maxCores)}"></label>
          <label>Memory (GB) <input name="maxMemoryGb" type="number" min="0" step="0.5" value="${p.maxMemoryMb === null || p.maxMemoryMb === undefined ? '' : p.maxMemoryMb / GB}"></label>
          <label>Disk (GB) <input name="maxDiskGb" type="number" min="0" value="${v(p.maxDiskGb)}"></label>
          <label>Public IPv4 <input name="maxPublicIps" type="number" min="0" value="${v(p.maxPublicIps)}"></label>
          <label>GPUs <input name="maxGpus" type="number" min="0" value="${v(p.maxGpus)}"></label>
          <label>S3 buckets <input name="maxS3Buckets" type="number" min="0" value="${v(p.maxS3Buckets)}"></label>
          <label>S3 storage (GB) <input name="maxS3Gb" type="number" min="0" value="${v(p.maxS3Gb)}"></label>
        </div>
        <fieldset class="perm-group"><legend>Datacenters <span class="muted small">(none ticked: all)</span></legend>
          ${st.dcs.length ? st.dcs.map((d) => `<label class="check"><input type="checkbox" name="dc" value="${d.id}" ${dcIds.has(d.id) ? 'checked' : ''}>
            <span>${esc(d.name)} <span class="muted">${esc(d.location)}</span></span></label>`).join('') : '<p class="muted small">No datacenters defined yet.</p>'}
        </fieldset>
        <fieldset class="perm-group"><legend>GPU profiles <span class="muted small">(none ticked: all)</span></legend>
          ${(st.gpuProfiles ?? []).length ? st.gpuProfiles.map((g) => `<label class="check"><input type="checkbox" name="gpu" value="${g.id}" ${gpuIds.has(g.id) ? 'checked' : ''}>
            <span>${esc(g.name)} <span class="muted">${esc(g.mode)}</span></span></label>`).join('') : '<p class="muted small">No GPU profiles yet (GPUs tab).</p>'}
        </fieldset>
        ${can('pools.write') ? `<div class="row"><button class="btn primary">${p.id ? 'Save pool' : 'Create pool'}</button></div>` : ''}
      </form>`;
  }

  function renderResources() {
    const w = can('pools.write');
    const free = st.users.filter((u) => !u.isAdmin && !u.resourcePoolId);
    body().innerHTML = `
      <h2 class="h2">Datacenters</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Datacenter</th><th>Location</th><th>Proxmox nodes</th><th>Storage for new servers</th><th>Servers</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${st.dcs.map((d) => `
          <tr><td><strong>${esc(d.name)}</strong> <span class="muted mono">${esc(d.key)}</span></td><td>${esc(d.location)}</td>
            <td class="mono">${d.nodes.map(esc).join(', ')}</td><td class="mono">${esc(d.storage) || '<span class="muted">template\'s</span>'}</td>
            <td>${d.servers}</td>
            <td class="actions">${w ? `<button class="btn danger" data-dc-delete="${d.id}" ${d.servers ? 'disabled' : ''}>Delete</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">No datacenters yet: new servers go to their template\'s node.</td></tr>'}</tbody>
      </table></div>
      ${w ? `
      <form id="dc-form" class="limits-form" autocomplete="off">
        <div class="grid-3">
          <label>Key <input name="key" required pattern="[a-z0-9][a-z0-9-]{0,30}" placeholder="jkt-dc1"></label>
          <label>Name <input name="name" required maxlength="80" placeholder="Jakarta DC1"></label>
          <label>Location <input name="location" maxlength="120" placeholder="Jakarta, ID"></label>
          <label>Proxmox nodes <input name="nodes" required placeholder="pve1, pve2"></label>
          <label>Storage (optional) <input name="storage" maxlength="100" placeholder="ceph-nvme"></label>
        </div>
        <div class="row"><button class="btn primary">Add datacenter</button></div>
      </form>` : ''}

      <h2 class="h2">Resource allocation pools</h2>
      ${st.pools.map((p) => `
        <article class="pool-card" data-pool="${p.id}">
          <div class="section-head" style="margin-top:0"><h3 class="h3">${esc(p.name)}</h3>
            <span class="muted small">${p.members.length} customer(s)${p.description ? ` · ${esc(p.description)}` : ''}</span></div>
          <div class="pool-meters">
            <div><span class="muted small">vCPU</span>${meter(p.usage.cores, p.maxCores)}</div>
            <div><span class="muted small">Memory (GB)</span>${meter(p.usage.memoryMb, p.maxMemoryMb, (v) => +(v / GB).toFixed(1))}</div>
            <div><span class="muted small">Disk (GB)</span>${meter(p.usage.diskGb, p.maxDiskGb)}</div>
            <div><span class="muted small">GPUs</span>${p.maxGpus > 0 ? meter(p.usage.gpus, p.maxGpus) : '<span class="muted">not included</span>'}</div>
            <div><span class="muted small">S3 buckets</span>${p.maxS3Buckets > 0 ? meter(p.usage.s3Buckets, p.maxS3Buckets) : '<span class="muted">not included</span>'}</div>
            <div><span class="muted small">S3 quota (GB)</span>${p.maxS3Buckets > 0 ? meter(p.usage.s3Gb, p.maxS3Gb) : '<span class="muted">not included</span>'}</div>
            <div><span class="muted small">Public IPv4</span>${show(p.maxPublicIps)} <span class="muted small">(counted once IPAM ships)</span></div>
            <div><span class="muted small">Datacenters</span>${p.datacenters.length ? p.datacenters.map((id) => esc(st.dcs.find((d) => d.id === id)?.name ?? id)).join(', ') : 'All'}</div>
          </div>
          <p class="small"><strong>Members:</strong> ${p.members.map((m) => `${esc(m.email)}${w ? ` <button class="btn ghost" data-member-remove="${p.id}:${m.id}" aria-label="Remove ${esc(m.email)}">×</button>` : ''}`).join(', ') || '<span class="muted">none</span>'}</p>
          ${w ? `<div class="row">
            <label class="sr-only" for="add-${p.id}">Add a customer to ${esc(p.name)}</label>
            <select id="add-${p.id}" data-member-select="${p.id}"><option value="">Add a customer…</option>
              ${free.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}</select>
            <button class="btn" data-member-add="${p.id}">Add</button>
            <button class="btn" data-pool-edit="${p.id}">Edit limits</button>
            <button class="btn danger" data-pool-delete="${p.id}" ${p.members.length ? 'disabled title="Has members"' : ''}>Delete</button>
          </div>` : ''}
          <div data-pool-editor="${p.id}" hidden>${poolForm(p)}</div>
        </article>`).join('') || '<p class="muted">No pools yet. Customers outside a pool only have their own limits.</p>'}
      ${w ? `<h2 class="h2">New pool</h2>${poolForm()}` : ''}`;
  }

  // ---- Object storage ------------------------------------------------------------------
  function renderStorage() {
    const s = st.s3;
    const w = can('storage.write');
    const poolOf = (userId) => st.pools.find((p) => p.members.some((m) => m.id === userId));
    const eligible = st.users.filter((u) => (poolOf(u.id)?.maxS3Buckets ?? 0) > 0);
    const b = st.buckets;
    body().innerHTML = `
      ${st.secret ? `
      <div class="notice" role="status">
        <p>New access key for <strong>${esc(st.secret.email)}</strong>. The secret is shown <strong>once</strong>; copy it now.</p>
        <p class="mono selectable">Endpoint ${esc(st.secret.endpoint)} · region ${esc(st.secret.region)}<br>
        Access key ${esc(st.secret.accessKeyId)}<br>Secret key ${esc(st.secret.secretAccessKey)}</p>
        <div class="row"><button class="btn ghost" data-secret-dismiss>Done, I've copied it</button></div>
      </div>` : ''}

      <h2 class="h2">SeaweedFS connection</h2>
      <form id="s3-form" class="limits-form" autocomplete="off">
        <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''} ${w ? '' : 'disabled'}>
          <span>Offer object storage <span class="muted">Customers in a pool with S3 buckets above 0 can create buckets and access keys.</span></span></label>
        <div class="grid-3">
          <label>S3 endpoint <input name="endpoint" type="url" required value="${esc(s.endpoint)}" placeholder="http://seaweedfs:8333"></label>
          <label>IAM endpoint <input name="iamEndpoint" type="url" value="${esc(s.iamEndpoint)}" placeholder="Same as S3 (embedded IAM)"></label>
          <label>Public endpoint <input name="publicEndpoint" type="url" value="${esc(s.publicEndpoint)}" placeholder="https://s3.example.com"></label>
          <label>Region <input name="region" value="${esc(s.region)}" pattern="[a-z0-9-]*"></label>
          <label>Admin access key <input name="accessKey" required value="${esc(s.accessKey)}"></label>
          <label>Admin secret key <input name="secretKey" type="password" autocomplete="new-password"
            placeholder="${s.hasSecretKey ? 'Stored (leave empty to keep)' : ''}"></label>
          <label>Bucket prefix <input name="bucketPrefix" value="${esc(s.bucketPrefix)}" pattern="[a-z][a-z0-9]{0,9}"></label>
        </div>
        ${w ? `<div class="row"><button class="btn primary">Save</button>
          <button type="button" class="btn" data-s3-test ${s.configured ? '' : 'disabled'}>Test connection</button></div>` : ''}
        <p class="muted small">The panel creates one IAM user per customer, buckets named <span class="mono">${esc(s.bucketPrefix)}&lt;id&gt;-&lt;name&gt;</span>
        and a policy allowing exactly their buckets. Hard quotas are applied in SeaweedFS with <span class="mono">weed shell</span>
        (command shown per bucket); run <span class="mono">s3.bucket.quota.enforce -apply</span> on a schedule so buckets over
        their quota become read-only.</p>
      </form>

      ${!s.configured ? '<p class="muted">Save a working connection to manage buckets.</p>' : b?.error ? `<p class="form-error">${esc(b.error)}</p>` : `
      <h2 class="h2">Buckets</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Bucket</th><th>Customer</th><th>Quota</th><th>Used</th><th>Apply quota in weed shell</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${b.buckets.map((x) => `
          <tr><td><span class="mono">${esc(x.name)}</span>${x.readOnly ? ' <span class="tag warn">read-only</span>' : ''}</td><td>${x.owner ? esc(x.owner) : '<span class="tag warn">no owner</span>'}</td>
            <td>${x.quotaGb ? `${x.quotaGb} GB` : '<span class="muted">none</span>'}</td>
            <td>${x.usage ? `${(x.usage.bytes / 1024 ** 3).toFixed(2)} GB · ${x.usage.objects}${x.usage.truncated ? '+' : ''} objects` : `<span class="muted">${esc(x.usageError ?? '')}</span>`}</td>
            <td class="mono small">${esc(x.quotaCommand ?? '')}</td>
            <td class="actions">${w ? `<button class="btn" data-bucket-ro="${esc(x.name)}" data-on="${x.readOnly ? '0' : '1'}">${x.readOnly ? 'Make writable' : 'Make read-only'}</button>
              <button class="btn danger" data-bucket-delete="${esc(x.name)}">Delete</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">No buckets yet.</td></tr>'}</tbody>
      </table></div>
      ${w ? `
      <form id="bucket-form" class="limits-form" autocomplete="off">
        <div class="grid-3">
          <label>Customer <select name="userId" required><option value="">Choose…</option>
            ${eligible.map((u) => `<option value="${u.id}">${esc(u.email)} (${esc(poolOf(u.id).name)})</option>`).join('')}</select></label>
          <label>Bucket name <input name="name" required pattern="[a-z0-9][a-z0-9-]{1,40}[a-z0-9]" placeholder="backups"></label>
          <label>Quota (GB) <input name="quotaGb" type="number" min="0" value="0"></label>
        </div>
        <div class="row"><button class="btn primary">Create bucket</button>
          <button type="button" class="btn" data-issue-key>New access key for this customer</button></div>
        ${eligible.length ? '' : '<p class="muted small">No customer has object storage yet: set S3 buckets above 0 on their resource pool.</p>'}
      </form>` : ''}`}`;
  }

  // ---- GPUs -----------------------------------------------------------------------------
  function renderGpu() {
    const g = st.gpu;
    const w = can('gpu.write');
    const profile = (id) => g.profiles.find((p) => p.id === id);
    body().innerHTML = `
      <p class="muted" style="max-width:75ch">GPUs come from Proxmox PCI resource mappings (Datacenter &gt; Resource Mappings).
      A profile hands out a whole device of a mapping (passthrough) or a vGPU slice of it (mediated device, the mapping needs
      "Use with Mediated Devices"). GPUs are attached to stopped servers; customers get them through their resource pool.</p>

      <h2 class="h2">Resource mappings in Proxmox</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Mapping</th><th>Mode</th><th>Devices</th><th>vGPU types (first device)</th></tr></thead>
        <tbody>${g.mappings.map((m) => `
          <tr><td><strong class="mono">${esc(m.id)}</strong><br><span class="muted small">${esc(m.description)}</span></td>
            <td>${m.mdev ? 'Mediated (vGPU)' : 'Passthrough'}</td>
            <td class="small">${m.devices.map((d) => {
              const dev = (g.devices[d.node] ?? []).find((x) => x.path === d.path);
              return `<span class="mono">${esc(d.node)}:${esc(d.path)}</span> ${esc(dev?.device ?? '')}`;
            }).join('<br>')}</td>
            <td class="small">${(m.mdevTypes ?? []).map((t) => `<span class="mono">${esc(t.type)}</span> ${esc(t.name)} · ${t.available} free`).join('<br>') || '<span class="muted">—</span>'}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">No PCI resource mappings yet. Create them in Proxmox first.</td></tr>'}</tbody>
      </table></div>

      <h2 class="h2">GPU profiles</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Profile</th><th>Mode</th><th>Mapping</th><th>VRAM</th><th>In use</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${g.profiles.map((p) => `
          <tr><td><strong>${esc(p.name)}</strong> <span class="muted mono">${esc(p.key)}</span></td>
            <td>${p.mode === 'mdev' ? `vGPU <span class="mono small">${esc(p.mdevType)}</span>` : 'Passthrough'}</td>
            <td class="mono">${esc(p.mapping)}</td><td>${p.vramGb ? `${p.vramGb} GB` : ''}</td>
            <td>${p.capacity.problem ? `<span class="tag warn">${esc(p.capacity.problem)}</span>` : meter(p.capacity.used, p.capacity.total)}</td>
            <td class="actions">${w ? `<button class="btn danger" data-profile-delete="${p.id}">Delete</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">No profiles yet.</td></tr>'}</tbody>
      </table></div>
      ${w ? `
      <form id="profile-form" class="limits-form" autocomplete="off">
        <div class="grid-3">
          <label>Key <input name="key" required pattern="[a-z0-9][a-z0-9-]{0,30}" placeholder="rtx4090"></label>
          <label>Name <input name="name" required maxlength="80" placeholder="RTX 4090 (24 GB)"></label>
          <label>Mapping <select name="mapping" required>${g.mappings.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}${m.mdev ? ' (vGPU)' : ''}</option>`).join('')}</select></label>
          <label>Mode <select name="mode"><option value="passthrough">Passthrough (whole GPU)</option><option value="mdev">vGPU / mediated device</option></select></label>
          <label>vGPU type (mdev only) <input name="mdevType" placeholder="nvidia-660" list="mdev-types"></label>
          <label>VRAM (GB) <input name="vramGb" type="number" min="0"></label>
        </div>
        <datalist id="mdev-types">${[...new Set(g.mappings.flatMap((m) => (m.mdevTypes ?? []).map((t) => t.type)))].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
        <div class="row"><button class="btn primary">Add profile</button></div>
      </form>` : ''}

      <h2 class="h2">GPUs on servers</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Server</th><th>Customer</th><th>GPU</th><th>Slot</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${g.assignments.map((a) => `
          <tr><td class="mono">${a.vmid}${a.label ? ` · ${esc(a.label)}` : ''}</td><td>${esc(a.owner ?? '')}</td>
            <td>${esc(profile(a.profileId)?.name ?? a.profileId)}</td><td class="mono">${a.slot < 0 ? 'reserved' : `hostpci${a.slot}`}</td>
            <td class="actions">${w && a.slot >= 0 ? `<button class="btn danger" data-gpu-detach="${a.vmid}:${a.slot}">Detach</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">No server has a GPU yet.</td></tr>'}</tbody>
      </table></div>
      ${w && g.profiles.length ? `
      <form id="attach-form" class="limits-form" autocomplete="off">
        <div class="grid-3">
          <label>Server ID <input name="vmid" type="number" min="100" required placeholder="1012"></label>
          <label>GPU profile <select name="profileId">${g.profiles.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.capacity.free} free)</option>`).join('')}</select></label>
        </div>
        <div class="row"><button class="btn primary">Attach GPU</button></div>
        <p class="muted small">The server must be assigned to a customer and stopped. It counts against the customer's pool.</p>
      </form>` : ''}`;
  }

  // ---- actions -----------------------------------------------------------------------------
  async function refresh(tab) {
    try { await load(tab); render(tab); } catch (err) { fail(err); }
  }

  async function onClick(e, tab) {
    const t = e.target.closest('button');
    if (!t) return false;
    const d = t.dataset;
    const run = async (fn, okText) => {
      t.disabled = true;
      try { await fn(); if (okText) toast(okText); await refresh(tab); } catch (err) { fail(err); t.disabled = false; }
    };
    if (d.roleEdit) { st.editRole = Number(d.roleEdit); renderAccess(); return true; }
    if ('roleCancel' in d) { st.editRole = null; renderAccess(); return true; }
    if (d.roleDelete) {
      if (await confirmAction('Delete this role?', 'Delete')) await run(() => api(`/api/admin/rbac/roles/${d.roleDelete}`, { method: 'DELETE' }), 'Role deleted');
      return true;
    }
    if (d.dcDelete) {
      if (await confirmAction('Delete this datacenter?', 'Delete')) await run(() => api(`/api/admin/datacenters/${d.dcDelete}`, { method: 'DELETE' }), 'Datacenter deleted');
      return true;
    }
    if (d.poolEdit) { const el = root.querySelector(`[data-pool-editor="${d.poolEdit}"]`); el.hidden = !el.hidden; return true; }
    if (d.poolDelete) {
      if (await confirmAction('Delete this resource pool?', 'Delete')) await run(() => api(`/api/admin/pools/${d.poolDelete}`, { method: 'DELETE' }), 'Pool deleted');
      return true;
    }
    if (d.memberAdd) {
      const userId = root.querySelector(`[data-member-select="${d.memberAdd}"]`).value;
      if (userId) await run(() => api(`/api/admin/pools/${d.memberAdd}/members/${userId}`, { method: 'PUT' }), 'Customer added to the pool');
      return true;
    }
    if (d.memberRemove) {
      const [pool, user] = d.memberRemove.split(':');
      await run(() => api(`/api/admin/pools/${pool}/members/${user}`, { method: 'DELETE' }), 'Customer removed from the pool');
      return true;
    }
    if ('s3Test' in d) {
      t.disabled = true;
      try { const r = await api('/api/admin/storage/s3/test', { method: 'POST' }); toast(`SeaweedFS answers (S3 and IAM) · ${r.buckets} bucket(s)`); } catch (err) { fail(err); }
      t.disabled = false;
      return true;
    }
    if ('issueKey' in d) {
      const userId = Number(root.querySelector('#bucket-form [name=userId]').value);
      if (!userId) { toast('Choose the customer first', 'warn'); return true; }
      if (!await confirmAction('Create a new access key? The customer\'s current key stops working.', 'Create key')) return true;
      t.disabled = true;
      try {
        const k = await api(`/api/admin/storage/s3/keys/${userId}`, { method: 'POST' });
        st.secret = { ...k, email: st.users.find((u) => u.id === userId)?.email ?? userId };
        await refresh(tab);
      } catch (err) { fail(err); t.disabled = false; }
      return true;
    }
    if ('secretDismiss' in d) { st.secret = null; renderStorage(); return true; }
    if (d.bucketRo) {
      const on = d.on === '1';
      if (await confirmAction(on ? `Make ${d.bucketRo} read-only? The customer's access key can then only read and list it.` : `Make ${d.bucketRo} writable for the customer again?`, on ? 'Make read-only' : 'Make writable')) {
        await run(() => api(`/api/admin/storage/s3/buckets/${encodeURIComponent(d.bucketRo)}`, { method: 'PATCH', body: { readOnly: on } }), on ? 'Bucket is read-only' : 'Bucket is writable');
      }
      return true;
    }
    if (d.bucketDelete) {
      if (await confirmAction(`Delete bucket ${d.bucketDelete}? It must be empty.`, 'Delete')) {
        await run(() => api(`/api/admin/storage/s3/buckets/${encodeURIComponent(d.bucketDelete)}`, { method: 'DELETE' }), 'Bucket deleted');
      }
      return true;
    }
    if (d.profileDelete) {
      if (await confirmAction('Delete this GPU profile?', 'Delete')) await run(() => api(`/api/admin/gpu/profiles/${d.profileDelete}`, { method: 'DELETE' }), 'Profile deleted');
      return true;
    }
    if (d.gpuDetach) {
      const [vmid, slot] = d.gpuDetach.split(':');
      if (await confirmAction(`Detach the GPU from server ${vmid}? It must be stopped.`, 'Detach')) {
        await run(() => api(`/api/admin/vms/${vmid}/gpu/${slot}`, { method: 'DELETE' }), 'GPU detached');
      }
      return true;
    }
    return false;
  }

  async function onChange(e, tab) {
    const sel = e.target.closest('[data-admin-role]');
    if (!sel) return false;
    try {
      await api(`/api/admin/rbac/admins/${sel.dataset.adminRole}`, { method: 'PUT', body: { roleId: Number(sel.value) } });
      toast('Role changed');
    } catch (err) { fail(err); }
    await refresh(tab);
    return true;
  }

  async function onSubmit(e, tab) {
    const f = e.target;
    const submit = async (fn, okText) => {
      e.preventDefault();
      const button = f.querySelector('button.primary');
      if (button) button.disabled = true;
      try { await fn(); toast(okText); await refresh(tab); } catch (err) { fail(err); if (button) button.disabled = false; }
    };
    if (f.id === 'role-form') {
      const permissions = [...f.querySelectorAll('[name=perm]:checked')].map((x) => x.value);
      const payload = { name: f.elements.name.value, description: f.elements.description.value, permissions };
      await submit(() => (st.editRole
        ? api(`/api/admin/rbac/roles/${st.editRole}`, { method: 'PUT', body: payload })
        : api('/api/admin/rbac/roles', { method: 'POST', body: { ...payload, key: f.elements.key.value } }))
        .then(() => { st.editRole = null; }), 'Role saved');
      return true;
    }
    if (f.id === 'dc-form') {
      await submit(() => api('/api/admin/datacenters', {
        method: 'POST',
        body: {
          key: f.elements.key.value, name: f.elements.name.value, location: f.elements.location.value,
          nodes: f.elements.nodes.value.split(/[\s,]+/).filter(Boolean), ...(f.elements.storage.value ? { storage: f.elements.storage.value } : {}),
        },
      }), 'Datacenter added');
      return true;
    }
    if (f.dataset.poolForm !== undefined) {
      const id = f.dataset.poolForm;
      const gb = num(f.elements.maxMemoryGb.value);
      const payload = {
        name: f.elements.name.value, description: f.elements.description.value,
        maxCores: num(f.elements.maxCores.value), maxMemoryMb: gb === null ? null : Math.round(gb * GB), maxDiskGb: num(f.elements.maxDiskGb.value),
        maxPublicIps: num(f.elements.maxPublicIps.value), maxGpus: num(f.elements.maxGpus.value),
        maxS3Buckets: num(f.elements.maxS3Buckets.value), maxS3Gb: num(f.elements.maxS3Gb.value),
        datacenters: [...f.querySelectorAll('[name=dc]:checked')].map((x) => Number(x.value)),
        gpuProfiles: [...f.querySelectorAll('[name=gpu]:checked')].map((x) => Number(x.value)),
      };
      await submit(() => api(id ? `/api/admin/pools/${id}` : '/api/admin/pools', { method: id ? 'PUT' : 'POST', body: payload }),
        id ? 'Pool saved' : 'Pool created');
      return true;
    }
    if (f.id === 's3-form') {
      const payload = {
        enabled: f.elements.enabled.checked, endpoint: f.elements.endpoint.value, iamEndpoint: f.elements.iamEndpoint.value, publicEndpoint: f.elements.publicEndpoint.value,
        region: f.elements.region.value, accessKey: f.elements.accessKey.value, bucketPrefix: f.elements.bucketPrefix.value,
        ...(f.elements.secretKey.value ? { secretKey: f.elements.secretKey.value } : {}),
      };
      await submit(() => api('/api/admin/storage/s3', { method: 'PUT', body: payload }), 'Object storage settings saved');
      return true;
    }
    if (f.id === 'bucket-form') {
      await submit(() => api('/api/admin/storage/s3/buckets', {
        method: 'POST', body: { userId: Number(f.elements.userId.value), name: f.elements.name.value, quotaGb: Number(f.elements.quotaGb.value) || 0 },
      }), 'Bucket created');
      return true;
    }
    if (f.id === 'profile-form') {
      await submit(() => api('/api/admin/gpu/profiles', {
        method: 'POST',
        body: {
          key: f.elements.key.value, name: f.elements.name.value, mode: f.elements.mode.value, mapping: f.elements.mapping.value,
          ...(f.elements.mode.value === 'mdev' ? { mdevType: f.elements.mdevType.value } : {}), ...(f.elements.vramGb.value ? { vramGb: Number(f.elements.vramGb.value) } : {}),
        },
      }), 'GPU profile added');
      return true;
    }
    if (f.id === 'attach-form') {
      await submit(() => api(`/api/admin/vms/${Number(f.elements.vmid.value)}/gpu`, { method: 'POST', body: { profileId: Number(f.elements.profileId.value) } }), 'GPU attached');
      return true;
    }
    return false;
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    can,
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange, onSubmit,
  };
}
