// Admin portal: importing OS images as templates (Admin-Templates design), shown above the
// templates table on the OS templates tab.
//   Wizard   format (cloud image or appliance), source URL and checksum, where it goes
//            (node, disk storage, import storage; one copy per cluster), preparation
//            (cloud-init drive, test boot, Linux or Windows, size, bridge)
//   Imports  each target with its step, the test boot result, retry and remove
// ctx: { root, api, toast, fail, esc, canEdit(), isOpen(), reloadTemplates() }

const FORMATS = [
  ['qcow2', '.qcow2 / .img', 'Cloud images (Ubuntu, Debian, Rocky, AlmaLinux)', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img'],
  ['ova', '.ova', 'Appliances with their VM settings (OVF)', 'https://vendor.example.com/appliance-2.4.ova'],
  ['iso', '.iso', 'Installer media (Windows, BSD): you install in the Proxmox console, the panel builds the template afterwards', 'https://downloads.example.com/windows-server-2025-eval.iso'],
  ['vmdk', '.vmdk upload', 'A disk from VMware ESXi / Workstation, or a qcow2 / raw disk on your computer, uploaded through the panel', ''],
];
const CHUNK = 8 * 2 ** 20;
const gb = (n) => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
const STATE = { queued: ['Waiting', ''], downloading: ['Downloading', ''], creating: ['Creating', ''], installing: ['Install', 'warn'], testing: ['Test boot', ''], ready: ['Ready', 'ok'], failed: ['Failed', 'bad'] };
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function createImports(ctx) {
  const { api, toast, fail, esc } = ctx;
  const st = { list: [], open: false, options: null, format: 'qcow2', form: null, timer: null, file: null, upload: null, uploading: false };
  const el = () => ctx.root.querySelector('#tpl-imports');

  async function load() {
    try { st.list = (await api('/api/admin/templates/imports')).imports; } catch { st.list = []; }
  }

  function schedule() {
    clearTimeout(st.timer);
    if (!st.list.some((i) => !['ready', 'failed', 'installing'].includes(i.state))) return;
    st.timer = setTimeout(async () => {
      if (!ctx.isOpen()) return;
      const before = st.list.filter((i) => i.state === 'ready').length;
      await load();
      if (st.list.filter((i) => i.state === 'ready').length !== before) { await ctx.reloadTemplates(); return; }
      draw();
    }, 3000);
  }

  async function render() {
    await load();
    draw();
  }

  function draw() {
    const box = el();
    if (!box) return;
    const can = ctx.canEdit();
    box.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <p class="muted" style="margin:0;max-width:80ch">Import a cloud image or an appliance as a Proxmox template. The panel downloads it on the node,
          builds the template and boots a throw-away clone once to check cloud-init and the guest agent. New templates stay unoffered until you offer them below.</p>
        ${can && !st.open ? '<button class="btn primary" data-imp-open>+ Import image</button>' : ''}
      </div>
      ${st.open ? wizard() : ''}
      ${st.list.length ? listTable() : ''}`;
    schedule();
  }

  // ---- wizard -------------------------------------------------------------------------------
  function targetRow(c, i) {
    const f = st.form.targets[c.id] ?? { on: i === 0, node: c.nodes[0]?.node ?? '' };
    const n = c.nodes.find((x) => x.node === f.node) ?? c.nodes[0];
    const opt = (list, cur) => (list ?? []).map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
    return `<tr data-imp-cluster="${c.id}">
      <td><label class="inline-check"><input type="checkbox" name="on" ${f.on ? 'checked' : ''} ${c.nodes.length ? '' : 'disabled'}> ${esc(c.name)}</label></td>
      ${c.nodes.length ? `
        <td><select name="node" aria-label="Node in ${esc(c.name)}">${opt(c.nodes.map((x) => x.node), n?.node)}</select></td>
        <td><select name="storage" aria-label="Disk storage in ${esc(c.name)}">${opt(n?.images, f.storage)}</select>${(n?.shared ?? []).includes(f.storage ?? n?.images?.[0]) ? '' : ' <span class="small muted" title="Clones to other nodes need shared storage">local</span>'}</td>
        <td><select name="importStorage" aria-label="${st.format === 'iso' ? 'ISO' : 'Import'} storage in ${esc(c.name)}">${(st.format === 'iso' ? n?.iso : n?.import)?.length ? opt(st.format === 'iso' ? n.iso : n.import, f.importStorage) : `<option value="">none: enable content ${st.format === 'iso' ? 'ISO image' : 'Import'} on a storage</option>`}</select></td>`
        : '<td colspan="3" class="small form-error">No node reachable</td>'}
    </tr>`;
  }

  function wizard() {
    const o = st.options;
    if (!o) return '<section class="security-card settings-card" style="max-width:1100px;margin-bottom:16px"><p class="muted">Loading nodes and storages…</p></section>';
    const fmt = FORMATS.find((f) => f[0] === st.format);
    const f = st.form;
    return `
      <form id="imp-form" class="security-card settings-card" style="max-width:1100px;display:grid;margin-bottom:16px" novalidate>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h2 class="twofa-title" style="margin:0">Import an image</h2><button type="button" class="btn ghost" data-imp-close>Close</button></div>
        <div class="segmented" role="radiogroup" aria-label="Image format" style="justify-self:start">
          ${FORMATS.map(([id, ext, desc]) => `<button type="button" role="radio" aria-checked="${st.format === id}" data-imp-format="${id}" title="${esc(desc)}">${esc(ext)}</button>`).join('')}
        </div>
        <p class="small muted" style="margin:0">${esc(fmt[2])}.${st.format === 'vmdk' ? ' The file is sent in pieces; an interrupted upload continues where it stopped.' : ' Proxmox downloads the file itself (the node needs internet access).'}</p>
        <div class="grid-2">
          ${st.format === 'vmdk' ? `<label>Disk image <span class="hint">.vmdk, .qcow2, .raw or .img${st.file ? `: ${esc(st.file.name)}, ${gb(st.file.size)}` : ''}</span><input name="file" type="file" accept=".vmdk,.qcow2,.raw,.img" ${st.uploading ? 'disabled' : ''}></label>`
            : `<label>Source address <input name="url" type="url" value="${esc(f.url)}" placeholder="${esc(fmt[3])}" spellcheck="false" required></label>`}
          <label>Checksum (SHA-256) <span class="hint">from the publisher's SHA256SUMS; empty: not checked</span><input name="checksum" value="${esc(f.checksum)}" spellcheck="false" class="mono" maxlength="64"></label>
          <label>Template name in Proxmox <input name="name" value="${esc(f.name)}" placeholder="ubuntu-2404" spellcheck="false" required></label>
          <label>Name for customers <span class="hint">empty: the OS name found in the test boot</span><input name="label" value="${esc(f.label)}" maxlength="80"></label>
        </div>
        <div class="table-wrap"><table class="table" id="imp-targets">
          <thead><tr><th>Cluster</th><th>Node</th><th>Disk storage</th><th>${st.format === 'iso' ? 'ISO storage' : 'Import storage'}</th></tr></thead>
          <tbody>${o.clusters.map(targetRow).join('')}</tbody></table></div>
        <p class="small muted" style="margin:0">Use shared storage (Ceph, NFS) so servers can be created on every node of the cluster. Ticking several clusters builds one copy in each.</p>
        <fieldset class="plain-fieldset"><legend class="small muted">Prepare the template</legend>
          ${st.format === 'iso' ? `
          <label class="check"><input type="checkbox" name="virtio" ${f.virtio ? 'checked' : ''} ${f.setup === 'windows' ? '' : 'disabled'}><span>Windows: VirtIO drivers <span class="muted">virtio-win.iso as a second CD drive (downloaded once per storage); load the storage driver during setup, then install the guest agent from it</span></span></label>
          <p class="small muted" style="margin:4px 0 8px">Windows: finish with <span class="mono">sysprep /generalize /oobe /shutdown</span> (with an unattend file if you have one). Then press <em>Installed</em> in the list below.</p>` : `
          <label class="check"><input type="checkbox" name="cloudinit" ${f.cloudinit ? 'checked' : ''}><span>Cloud-init drive <span class="muted">Hostname, user, SSH keys and network at first boot</span></span></label>`}
          <label class="check"><input type="checkbox" name="testBoot" ${f.testBoot ? 'checked' : ''}><span>Test boot <span class="muted">A linked clone boots once: guest agent, OS name, cloud-init result. The clone is removed; the template never boots.</span></span></label>
          <div class="grid-3" style="margin-top:8px">
            <label>Setup <select name="setup"><option value="cloudinit" ${f.setup !== 'windows' ? 'selected' : ''}>Linux (cloud-init)</option><option value="windows" ${f.setup === 'windows' ? 'selected' : ''}>Windows (guest agent)</option></select></label>
            <label>Cores <input name="cores" type="number" min="1" max="64" value="${f.cores}" ${st.format === 'ova' ? 'disabled title="from the OVF"' : ''}></label>
            <label>Memory (MB) <input name="memoryMb" type="number" min="256" step="256" value="${f.memoryMb}" ${st.format === 'ova' ? 'disabled title="from the OVF"' : ''}></label>
            <label>Bridge <input name="bridge" value="${esc(f.bridge)}" spellcheck="false" class="mono"></label>
            ${st.format === 'iso' ? `<label>Disk (GB) <input name="diskGb" type="number" min="4" max="4096" value="${f.diskGb}"></label>` : ''}
          </div>
        </fieldset>
        ${st.format === 'vmdk' && st.upload ? `<div class="imp-upload"><progress max="${st.upload.size}" value="${st.upload.received}" aria-label="Upload"></progress>
          <span class="small muted" data-imp-progress>${uploadText()}</span></div>` : ''}
        <div class="row"><button class="btn primary" ${st.uploading ? 'disabled' : ''}>${st.format === 'vmdk' ? (st.upload && !st.upload.complete ? 'Continue upload and import' : 'Upload and build template') : 'Import and build template'}</button>
          <span class="small muted">Runs in the background; follow it below or under Jobs.</span></div>
      </form>`;
  }

  function uploadText() {
    const u = st.upload;
    if (!u) return '';
    if (u.complete) return `Uploaded ${gb(u.size)} · SHA-256 ${u.sha256?.slice(0, 16)}…`;
    return `${gb(u.received)} of ${gb(u.size)} (${Math.floor((u.received / u.size) * 100)}%)${st.uploading ? '' : ' · paused'}`;
  }

  /** Sends the chosen file in chunks from where the panel has it; retries a chunk three times. */
  async function sendFile() {
    const file = st.file;
    if (!st.upload || st.upload.size !== file.size || st.upload.filename !== file.name.replace(/[^\w.-]/g, '_')) {
      st.upload = await api('/api/admin/templates/uploads', { method: 'POST', body: { filename: file.name, size: file.size } });
    }
    st.uploading = true;
    draw();
    try {
      let tries = 0;
      while (!st.upload.complete) {
        const off = st.upload.received;
        const res = await fetch(`/api/admin/templates/uploads/${st.upload.id}?offset=${off}`, {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(off, off + CHUNK),
        }).catch(() => null);
        const data = res ? await res.json().catch(() => null) : null;
        if (res?.ok) { st.upload = data; tries = 0; }
        else if (res?.status === 409 && data?.received !== undefined) { st.upload.received = data.received; }
        else if (++tries > 3) throw new Error(data?.error || 'The upload was interrupted; press the button to continue');
        else { await new Promise((r) => setTimeout(r, 2000 * tries)); st.upload = await api(`/api/admin/templates/uploads/${st.upload.id}`); }
        const bar = ctx.root.querySelector('.imp-upload progress');
        if (bar) bar.value = st.upload.received;
        const txt = ctx.root.querySelector('[data-imp-progress]');
        if (txt) txt.textContent = uploadText();
      }
    } finally {
      st.uploading = false;
    }
  }

  function listTable() {
    const can = ctx.canEdit();
    return `<h2 class="h2">Imports</h2>
      <div class="table-wrap"><table class="table" id="imp-list">
        <thead><tr><th>Template</th><th>Format</th><th>Where</th><th>State</th><th>Test boot</th><th>Started</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${st.list.map((i) => `<tr data-imp="${i.id}">
          <td><strong>${esc(i.name)}</strong>${i.vmid ? ` <span class="mono small muted">${i.vmid}</span>` : ''}${i.label ? `<br><span class="small muted">${esc(i.label)}</span>` : ''}</td>
          <td class="small">${esc(i.format)}${i.checksum ? ' · checked' : ''}</td>
          <td class="small">${esc(i.cluster)} · ${esc(i.node)}<br><span class="mono muted">${esc(i.storage)}</span></td>
          <td><span class="tag ${STATE[i.state]?.[1] ?? ''}">${STATE[i.state]?.[0] ?? esc(i.state)}</span>
            ${['ready', 'failed', 'installing'].includes(i.state) ? '' : `<br><span class="small muted"><span class="spinner" aria-hidden="true"></span> ${esc(i.step ?? '')}</span>`}
            ${i.state === 'installing' ? `<br><span class="small">${esc(i.step ?? '')}</span>` : ''}
            ${i.state === 'failed' ? `<br><span class="small form-error">${esc(i.error ?? '')}</span>` : ''}</td>
          <td class="small">${testText(i)}</td>
          <td class="small">${esc(when(i.createdAt))}</td>
          <td><div class="row end">${can && i.state === 'installing' ? `<button class="btn" data-imp-start>Start VM</button>
              ${i.consoleUrl ? `<a class="btn ghost" href="${esc(i.consoleUrl)}" target="_blank" rel="noopener">Console in Proxmox</a>` : ''}
              <button class="btn primary" data-imp-installed>Installed</button><button class="btn ghost" data-imp-cancel>Cancel</button>` : ''}
            ${can && i.state === 'failed' ? '<button class="btn" data-imp-retry>Retry</button>' : ''}
            ${can && ['ready', 'failed'].includes(i.state) ? '<button class="btn ghost" data-imp-remove>Remove</button>' : ''}</div></td>
        </tr>`).join('')}</tbody></table></div>
      <p class="small muted">Removing an entry keeps the template; delete templates in Proxmox.</p>`;
  }

  function testText(i) {
    if (!i.options?.testBoot) return '<span class="muted">skipped</span>';
    const t = i.test;
    if (!t) return i.state === 'failed' ? '' : '<span class="muted">pending</span>';
    if (t.error) return `<span class="form-error">${esc(t.error)}</span>`;
    return `${t.agent ? '<span class="tag ok">Agent</span>' : '<span class="tag warn">No agent</span>'}
      ${t.cloudInit === 'done' ? '<span class="tag ok">cloud-init</span>' : t.cloudInit === 'error' ? '<span class="tag bad">cloud-init error</span>' : ''}
      ${t.os ? `<br><span class="muted">${esc(t.os)}</span>` : ''}${t.seconds ? `<span class="muted"> · ${t.seconds}s</span>` : ''}`;
  }

  // ---- events --------------------------------------------------------------------------------
  function readForm() {
    const form = ctx.root.querySelector('#imp-form');
    if (!form) return;
    const e = form.elements;
    const targets = {};
    for (const tr of form.querySelectorAll('[data-imp-cluster]')) {
      const q = (n) => tr.querySelector(`[name=${n}]`);
      targets[tr.dataset.impCluster] = { on: !!q('on')?.checked, node: q('node')?.value ?? '', storage: q('storage')?.value ?? '', importStorage: q('importStorage')?.value ?? '' };
    }
    if (e.file?.files?.[0] && e.file.files[0] !== st.file) { st.file = e.file.files[0]; st.upload = null; }
    Object.assign(st.form, {
      url: e.url ? e.url.value.trim() : st.form.url, checksum: e.checksum.value.trim(), name: e.name.value.trim(), label: e.label.value.trim(),
      cloudinit: e.cloudinit ? e.cloudinit.checked : st.form.cloudinit, virtio: e.virtio ? e.virtio.checked : st.form.virtio, diskGb: Number(e.diskGb?.value) || st.form.diskGb, testBoot: e.testBoot.checked, setup: e.setup.value,
      cores: Number(e.cores.value) || 2, memoryMb: Number(e.memoryMb.value) || 2048, bridge: e.bridge.value.trim() || 'vmbr0', targets,
    });
  }

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t || !t.closest('#tpl-imports')) return false;
    if (t.hasAttribute('data-imp-open')) {
      st.open = true;
      st.form = { url: '', checksum: '', name: '', label: '', cloudinit: true, virtio: true, diskGb: 40, testBoot: true, setup: 'cloudinit', cores: 2, memoryMb: 2048, bridge: 'vmbr0', targets: {} };
      draw();
      try { st.options = await api('/api/admin/templates/import-options'); } catch (err) { fail(err); st.open = false; }
      draw();
      return true;
    }
    if (t.hasAttribute('data-imp-close')) { st.open = false; draw(); return true; }
    if (t.dataset.impFormat) {
      readForm(); st.format = t.dataset.impFormat;
      if (st.format === 'ova') st.form.cloudinit = false;
      if (st.format === 'iso') Object.assign(st.form, { setup: 'windows', cores: Math.max(st.form.cores, 2), memoryMb: Math.max(st.form.memoryMb, 4096) });
      for (const k of Object.keys(st.form.targets)) st.form.targets[k].importStorage = undefined;
      draw(); return true;
    }
    const row = t.closest('[data-imp]');
    if (row && t.hasAttribute('data-imp-retry')) {
      try { await api(`/api/admin/templates/imports/${row.dataset.imp}/retry`, { method: 'POST' }); toast('Import started again'); } catch (err) { fail(err); }
      await render();
      return true;
    }
    for (const [attr, path, msg] of [['data-imp-start', 'start', 'VM started: install in the Proxmox console'], ['data-imp-installed', 'installed', 'Building the template'], ['data-imp-cancel', 'cancel', 'Installation cancelled, VM removed']]) {
      if (!row || !t.hasAttribute(attr)) continue;
      if (path === 'cancel' && !(await ctx.confirmAction('Cancel this installation? The VM and everything installed on it are removed.', 'Remove VM'))) return true;
      if (path === 'installed' && !(await ctx.confirmAction('Is the installation done and the VM shut down? The CD drives are removed and the VM becomes a template.', 'Build template'))) return true;
      t.disabled = true;
      try { await api(`/api/admin/templates/imports/${row.dataset.imp}/${path}`, { method: 'POST' }); toast(msg); } catch (err) { fail(err); }
      await render();
      return true;
    }
    if (row && t.hasAttribute('data-imp-remove')) {
      try { await api(`/api/admin/templates/imports/${row.dataset.imp}`, { method: 'DELETE' }); } catch (err) { fail(err); }
      await render();
      return true;
    }
    return false;
  }

  function onChange(e) {
    if (e.target.closest('#imp-form') && e.target.name === 'setup' && st.format === 'iso') { readForm(); draw(); return; }
    if (e.target.closest('#imp-form') && e.target.name === 'file') {
      readForm();
      if (st.file && !st.form.name) st.form.name = st.file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 40);
      draw();
      return;
    }
    if (!e.target.closest('#imp-targets') || e.target.name !== 'node') return;
    readForm();
    const c = e.target.closest('[data-imp-cluster]').dataset.impCluster;
    st.form.targets[c] = { ...st.form.targets[c], storage: undefined, importStorage: undefined };
    draw();
  }

  async function onSubmit(e) {
    if (e.target.id !== 'imp-form') return false;
    e.preventDefault();
    readForm();
    const f = st.form;
    const targets = Object.entries(f.targets).filter(([, x]) => x.on)
      .map(([clusterId, x]) => ({ clusterId: Number(clusterId), node: x.node, storage: x.storage, importStorage: x.importStorage }));
    try {
      if (st.format === 'vmdk') {
        if (!st.file) throw new Error('Choose the disk image');
        if (!f.name) throw new Error('Give the template a name');
        if (!st.upload?.complete) await sendFile();
      }
      const r = await api('/api/admin/templates/imports', { method: 'POST', body: {
        name: f.name, ...(f.label ? { label: f.label } : {}), format: st.format, checksum: f.checksum || null,
        ...(st.format === 'vmdk' ? { uploadId: st.upload.id } : { url: f.url }),
        setup: f.setup, cloudinit: f.cloudinit, testBoot: f.testBoot, bridge: f.bridge, targets,
        ...(st.format !== 'ova' ? { cores: f.cores, memoryMb: f.memoryMb } : {}),
        ...(st.format === 'iso' ? { diskGb: f.diskGb, virtio: f.virtio } : {}),
      } });
      toast(`Importing ${f.name}${r.imports.length > 1 ? ` into ${r.imports.length} clusters` : ''}`);
      st.open = false; st.file = null; st.upload = null;
      await render();
    } catch (err) { fail(err); draw(); }
    return true;
  }

  return { render, onClick, onChange, onSubmit };
}
