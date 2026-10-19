// Customer portal: storage. Block volumes (extra disks for servers) and object
// storage (S3 buckets on SeaweedFS), each shown when the provider offers it.
import { $, api, esc, toast, fail, confirmAction, promptText } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const gb = (bytes) => (bytes == null ? '·' : bytes < 2 ** 30 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`);
const SIZES = [10, 50, 100, 200, 500];
const SNIPPETS = {
  aws: (c) => `aws configure set aws_access_key_id ${c.key}
aws configure set aws_secret_access_key <secret key>
aws --endpoint-url ${c.endpoint} s3 ls s3://${c.bucket}/
aws --endpoint-url ${c.endpoint} s3 cp ./backup.tar.gz s3://${c.bucket}/`,
  rclone: (c) => `[panel]
type = s3
provider = SeaweedFS
endpoint = ${c.endpoint}
region = ${c.region}
access_key_id = ${c.key}
secret_access_key = <secret key>

# rclone sync /var/backups panel:${c.bucket}`,
  restic: (c) => `export AWS_ACCESS_KEY_ID=${c.key}
export AWS_SECRET_ACCESS_KEY=<secret key>
restic -r s3:${c.endpoint}/${c.bucket} init
restic -r s3:${c.endpoint}/${c.bucket} backup /etc /srv`,
};

/** ctx: { state, renderList, setView(view, hash) } */
export function createStorage(ctx) {
  const detail = () => $('#detail');
  let block = { enabled: false };
  let object = { enabled: false };
  let tab = 'block';
  let form = { tier: null, size: 50 };
  let attaching = null;        // volume id with the server picker open
  let secret = null;           // a new access key, shown once
  let tool = 'aws';

  async function loadStatus() {
    [block, object] = await Promise.all([
      api('/api/volumes').catch(() => ({ enabled: false })),
      api('/api/storage').catch(() => ({ enabled: false })),
    ]);
    ctx.state.storageEnabled = block.enabled || object.enabled;
    return ctx.state.storageEnabled;
  }

  async function open(which = null) {
    ctx.setView('storage', which === 'object' ? '#storage/object' : '#storage');
    detail().innerHTML = '<div class="page"><p class="muted">Loading…</p></div>';
    await loadStatus();
    if (ctx.state.view !== 'storage') return;
    ctx.renderList();
    tab = which === 'object' && object.enabled ? 'object' : block.enabled ? 'block' : 'object';
    render();
  }

  function render() {
    if (!block.enabled && !object.enabled) {
      detail().innerHTML = '<div class="page"><div class="empty"><h2>Storage is not available</h2><p class="muted">Your provider does not offer extra storage for your account. Questions? <a href="#support/new">Open a ticket</a>.</p></div></div>';
      return;
    }
    const both = block.enabled && object.enabled;
    detail().innerHTML = `
      <div class="page storage-page">
        <header class="page-head">
          <div><h1>Storage</h1>
            <p class="lede">${tab === 'block' ? 'Extra disks for your servers: attach, detach and move them between servers on the same host.'
              : 'S3-compatible buckets for backups, media and datasets. Works with the AWS CLI, rclone, restic and SDKs.'}</p></div>
        </header>
        ${both ? `<div class="segmented" role="tablist" aria-label="Kind of storage" style="margin-bottom:16px">
          <button role="tab" aria-selected="${tab === 'block'}" aria-pressed="${tab === 'block'}" data-storage-tab="block">Block volumes</button>
          <button role="tab" aria-selected="${tab === 'object'}" aria-pressed="${tab === 'object'}" data-storage-tab="object">Object storage</button></div>` : ''}
        ${tab === 'block' ? blockHtml() : objectHtml()}
      </div>`;
  }

  // ---- Block volumes ------------------------------------------------------------------
  function blockHtml() {
    const b = block;
    const tier = b.tiers.find((t) => t.id === form.tier) ?? b.tiers[0];
    form.tier = tier.id;
    const left = b.disk.usedGb == null ? null : Math.max(0, b.disk.limitGb - b.disk.usedGb);
    const fits = left == null || form.size <= left;
    const servers = b.servers.filter((s) => !s.expired);
    return `
      ${b.disk.usedGb != null ? `
        <div class="kpi-row">
          <div class="kpi"><span class="muted small">Disk in use (servers and volumes)</span><strong>${b.disk.usedGb} / ${b.disk.limitGb} GB</strong>
            <span class="meter" aria-hidden="true"><i style="width:${Math.min(100, Math.round((b.disk.usedGb / Math.max(1, b.disk.limitGb)) * 100))}%"></i></span></div>
          <div class="kpi"><span class="muted small">Volumes</span><strong>${b.volumes.length}</strong>
            <span class="small muted">${b.volumes.reduce((a, v) => a + v.sizeGb, 0)} GB</span></div>
          <div class="kpi"><span class="muted small">Per month, before tax</span><strong>${rp(b.volumes.reduce((a, v) => a + v.monthly, 0))}</strong>
            <span class="small muted">billed with the server holding each volume</span></div>
        </div>` : ''}

      ${b.volumes.length ? `
        <div class="table-wrap"><table class="table vol-table">
          <thead><tr><th>Volume</th><th class="num">Size</th><th>Server</th><th class="num">Per month</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${b.volumes.map(volumeRow).join('')}</tbody>
        </table></div>
        <details class="vol-help"><summary>After attaching: using the disk inside the server</summary>
          <p class="small muted">Linux (the first extra disk is usually <span class="mono">/dev/sdb</span>; check with <span class="mono">lsblk</span>):</p>
          <pre class="snippet">lsblk
sudo mkfs.ext4 /dev/sdb          # first use only: erases the volume
sudo mkdir -p /data && sudo mount /dev/sdb /data
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdb) /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab</pre>
          <p class="small muted">Windows: <em>Disk Management</em> → initialize the new disk (GPT) → <em>New Simple Volume</em>.
            Before detaching, unmount it (Linux) or take it offline (Windows), then shut the server down.</p>
          <p class="small muted">Backups: snapshots of a server (also automatic ones, on its Snapshots tab) include the volumes attached to it.</p>
        </details>` : '<p class="muted">No volumes yet.</p>'}

      <section class="security-card settings-card" style="margin-top:20px;max-width:900px" aria-labelledby="new-vol">
        <h2 class="twofa-title" id="new-vol">New volume</h2>
        ${servers.length ? `
          <form id="volume-form" class="email-form" novalidate>
            <div class="grid-2">
              <label>Name <input name="label" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9-]*" placeholder="db-data" required></label>
              <label>Attach to <select name="vmid">${servers.map((s) => `<option value="${s.vmid}">${esc(s.name)} (${s.vmid}${s.node ? ` · ${esc(s.node)}` : ''})</option>`).join('')}</select></label>
            </div>
            <fieldset class="plain-fieldset"><legend class="small muted">Tier</legend>
              <div class="choices">${b.tiers.map((t) => `
                <label class="choice"><input type="radio" name="tier" value="${esc(t.id)}" ${t.id === tier.id ? 'checked' : ''}>
                  <span><strong>${esc(t.name)}</strong> <span class="small muted">${rp(t.pricePerGb)} / GB</span><br><span class="small muted">${esc(t.description)}</span></span></label>`).join('')}
              </div></fieldset>
            <div class="row">
              <label for="vol-size">Size (GB)</label>
              <input id="vol-size" name="sizeGb" type="number" min="1" max="${b.maxSizeGb}" step="1" value="${form.size}" style="max-width:120px" required>
              <div class="chips">${SIZES.filter((n) => n <= b.maxSizeGb).map((n) => `<button type="button" class="chip" data-size="${n}" aria-pressed="${n === form.size}">${n} GB</button>`).join('')}</div>
            </div>
            <p class="small ${fits ? 'muted' : 'warn-text'}" id="vol-fit">${left == null ? '' : fits ? `Fits: ${left - form.size} GB of your disk limit left after this.` : `Only ${left} GB of your disk limit is left.`}</p>
            <div class="row"><button class="btn primary" ${fits ? '' : 'disabled'}>${icon('plus')}<span>Create volume · ${rp(tier.pricePerGb * form.size)} / month</span></button>
              <span class="small muted">before tax; added to the server's renewal</span></div>
            <p class="form-error" id="volume-error" role="alert"></p>
          </form>` : '<p class="muted">You need a running virtual machine to attach a volume to.</p>'}
      </section>`;
  }

  function volumeRow(v) {
    const servers = block.servers.filter((s) => !s.expired);
    const where = v.attached
      ? `${esc(v.server)} <span class="muted small mono">${esc(v.device ?? v.slot)}</span>`
      : `<span class="tag warn">Not attached</span> <span class="small muted">kept on ${esc(v.server)}</span>`;
    return `
      <tr data-volume="${v.id}">
        <td><strong>${esc(v.label)}</strong><br><span class="small muted">${esc(v.tierName)}</span></td>
        <td class="num">${v.sizeGb} GB</td>
        <td>${where}${attaching === v.id ? `
          <div class="row" style="margin-top:6px">
            <label class="sr-only" for="attach-${v.id}">Attach to</label>
            <select id="attach-${v.id}" data-attach-target>${servers.map((s) => `<option value="${s.vmid}" ${s.vmid === v.vmid ? 'selected' : ''}>${esc(s.name)} (${s.vmid})</option>`).join('')}</select>
            <button class="btn primary" data-attach-go>Attach</button><button class="btn" data-attach-cancel>Cancel</button></div>` : ''}</td>
        <td class="num">${rp(v.monthly)}</td>
        <td><div class="nowrap row end">
          ${v.attached ? '<button class="btn" data-vol-detach>Detach</button><button class="btn" data-vol-resize>Enlarge</button>'
            : `${attaching === v.id ? '' : '<button class="btn" data-vol-attach>Attach</button>'}<button class="btn danger" data-vol-delete>Delete</button>`}
          <button class="icon-btn" data-vol-rename title="Rename" aria-label="Rename ${esc(v.label)}">✎</button>
        </div></td>
      </tr>`;
  }

  // ---- Object storage -------------------------------------------------------------------
  function objectHtml() {
    const o = object;
    const quota = o.buckets.reduce((a, b) => a + (b.quotaGb || 0), 0);
    const stored = o.buckets.reduce((a, b) => a + (b.usage?.bytes ?? 0), 0);
    const c = { endpoint: o.endpoint, region: o.region, key: secret?.accessKeyId ?? o.accessKeyId ?? '<access key>', bucket: o.buckets[0]?.name ?? 'my-bucket' };
    return `
      <div class="kpi-row">
        <div class="kpi"><span class="muted small">Buckets</span><strong>${o.buckets.length} / ${o.limits.buckets}</strong></div>
        <div class="kpi"><span class="muted small">Quota given to buckets</span><strong>${quota} GB${o.limits.gb != null ? ` / ${o.limits.gb} GB` : ''}</strong></div>
        <div class="kpi"><span class="muted small">Stored</span><strong>${gb(stored)}</strong></div>
      </div>

      ${secret ? `
        <div class="notice warn secret-box" role="alert">
          <p><strong>Copy your secret key now. It won't be shown again.</strong></p>
          <p>Access key <span class="selectable">${esc(secret.accessKeyId)}</span><br>Secret key <span class="selectable" id="s3-secret">${esc(secret.secretAccessKey)}</span></p>
          <div class="row"><button class="btn" data-copy-secret>Copy secret key</button><button class="btn primary" data-secret-done>I've copied it</button></div>
        </div>` : ''}

      ${o.buckets.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Bucket</th><th class="num">Objects</th><th class="num">Used</th><th class="num">Quota</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${o.buckets.map((b) => `
            <tr data-bucket="${esc(b.name)}"><td><span class="mono">${esc(b.name)}</span>${b.readOnly ? ' <span class="tag warn">read-only</span>' : ''}</td>
              <td class="num">${b.usage ? b.usage.objects.toLocaleString('id-ID') : '·'}</td><td class="num">${gb(b.usage?.bytes)}</td>
              <td class="num">${b.quotaGb ? `${b.quotaGb} GB` : 'none'}</td>
              <td><div class="row end"><button class="btn" data-bucket-ro="${b.readOnly ? 'off' : 'on'}">${b.readOnly ? 'Make writable' : 'Make read-only'}</button>
                <button class="btn danger" data-bucket-delete>Delete</button></div></td></tr>`).join('')}
          </tbody></table></div>
          <p class="small muted">Read-only: your access key can read and list the bucket but not add, change or delete anything in it,
            for example to protect a finished backup from a compromised script.</p>` : '<p class="muted">No buckets yet.</p>'}

      <div class="grid-2" style="margin-top:20px;max-width:1100px">
        <section class="security-card settings-card">
          <h2 class="twofa-title">New bucket</h2>
          ${o.buckets.length < o.limits.buckets ? `
            <form id="bucket-form" class="email-form" novalidate>
              <label>Name <input name="name" maxlength="42" pattern="[a-z0-9][a-z0-9-]{1,40}[a-z0-9]" placeholder="backups" required>
                <span class="hint">3 to 42 lowercase letters, digits or dashes. Your account prefix is added.</span></label>
              <label>Quota (GB) <input name="quotaGb" type="number" min="${o.limits.gb != null ? 1 : 0}" step="1" value="${o.limits.gb != null ? 10 : 0}">
                <span class="hint">${o.limits.gb != null ? 'Required: your pool caps object storage.' : '0 = no quota of its own.'}</span></label>
              <div class="row"><button class="btn primary">${icon('plus')}<span>Create bucket</span></button></div>
              <p class="form-error" id="bucket-error" role="alert"></p>
            </form>` : `<p class="muted">You have used all ${o.limits.buckets} buckets of your account.</p>`}
        </section>
        <section class="security-card settings-card">
          <h2 class="twofa-title">Connection</h2>
          <dl class="conn-list">
            <dt>Endpoint</dt><dd class="mono">${esc(o.endpoint)}</dd>
            <dt>Region</dt><dd class="mono">${esc(o.region)}</dd>
            <dt>Access key</dt><dd class="mono">${o.accessKeyId ? esc(o.accessKeyId) : '<span class="muted">none yet</span>'}</dd>
          </dl>
          <div class="row"><button class="btn" data-new-key>${o.accessKeyId ? 'Create new access key' : 'Create access key'}</button></div>
          ${o.accessKeyId ? '<p class="small muted">A new key replaces the current one; programs using the old key stop working.</p>' : ''}
        </section>
      </div>

      <section style="margin-top:20px;max-width:1100px" aria-labelledby="s3-start">
        <h2 class="h2" id="s3-start">Get started</h2>
        <div class="segmented" role="radiogroup" aria-label="Tool">
          ${[['aws', 'AWS CLI'], ['rclone', 'rclone'], ['restic', 'restic']].map(([id, l]) => `<button role="radio" aria-checked="${tool === id}" data-tool="${id}">${l}</button>`).join('')}
        </div>
        <pre class="snippet">${esc(SNIPPETS[tool](c))}</pre>
      </section>`;
  }

  // ---- Events ------------------------------------------------------------------------------
  async function reloadBlock() { block = await api('/api/volumes'); render(); }
  async function reloadObject() { object = await api('/api/storage'); render(); }
  const volumeOf = (el) => block.volumes.find((v) => v.id === Number(el.closest('[data-volume]').dataset.volume));

  detail().addEventListener('click', async (e) => {
    if (ctx.state.view !== 'storage') return;
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.storageTab) { tab = t.dataset.storageTab; history.replaceState(null, '', tab === 'object' ? '#storage/object' : '#storage'); return render(); }
    if (t.dataset.size) {
      $('#volume-form').sizeGb.value = t.dataset.size;
      return refreshForm();
    }
    if (t.dataset.tool) { tool = t.dataset.tool; return render(); }
    try {
      if (t.hasAttribute('data-vol-attach')) { attaching = volumeOf(t).id; return render(); }
      if (t.hasAttribute('data-attach-cancel')) { attaching = null; return render(); }
      if (t.hasAttribute('data-attach-go')) {
        const v = volumeOf(t);
        const vmid = Number(t.closest('tr').querySelector('[data-attach-target]').value);
        t.disabled = true;
        await api(`/api/volumes/${v.id}/attach`, { method: 'POST', body: { vmid } });
        attaching = null;
        toast(`${v.label} is attached`);
        return reloadBlock();
      }
      if (t.hasAttribute('data-vol-detach')) {
        const v = volumeOf(t);
        if (!(await confirmAction(`Detach ${v.label} from ${v.server}? Unmount it inside the server and shut the server down first. The data is kept.`, 'Detach'))) return;
        await api(`/api/volumes/${v.id}/detach`, { method: 'POST' });
        toast(`${v.label} is detached; its data is kept`);
        return reloadBlock();
      }
      if (t.hasAttribute('data-vol-resize')) {
        const v = volumeOf(t);
        const n = await promptText(`New size for ${v.label} (GB)`, { value: String(v.sizeGb * 2), type: 'number', okLabel: 'Enlarge', hint: `Now ${v.sizeGb} GB. Volumes can only grow. Afterwards, grow the file system inside the server (e.g. resize2fs).`, minLength: 1 });
        if (n == null) return;
        await api(`/api/volumes/${v.id}/resize`, { method: 'POST', body: { sizeGb: Number(n) } });
        toast(`${v.label} now has ${n} GB`);
        return reloadBlock();
      }
      if (t.hasAttribute('data-vol-rename')) {
        const v = volumeOf(t);
        const n = await promptText('New name', { value: v.label, pattern: '[A-Za-z0-9][A-Za-z0-9-]{0,39}', okLabel: 'Rename' });
        if (n == null || n === v.label) return;
        await api(`/api/volumes/${v.id}`, { method: 'PATCH', body: { label: n } });
        return reloadBlock();
      }
      if (t.hasAttribute('data-vol-delete')) {
        const v = volumeOf(t);
        const typed = await promptText(`Delete ${v.label} with all its data? This can't be undone. Type the name to confirm.`, { okLabel: 'Delete volume', danger: true, minLength: 1 });
        if (typed !== v.label) return;
        await api(`/api/volumes/${v.id}`, { method: 'DELETE' });
        toast(`${v.label} deleted`);
        return reloadBlock();
      }
      if (t.hasAttribute('data-bucket-ro')) {
        const name = t.closest('[data-bucket]').dataset.bucket;
        const on = t.dataset.bucketRo === 'on';
        if (!(await confirmAction(on ? `Make ${name} read-only? Your access key can then only read and list it; uploads and deletions are refused.`
          : `Make ${name} writable again? Your access key can then change and delete its objects.`, on ? 'Make read-only' : 'Make writable'))) return;
        await api(`/api/storage/buckets/${encodeURIComponent(name)}`, { method: 'PATCH', body: { readOnly: on } });
        toast(on ? `${name} is read-only` : `${name} is writable`);
        return reloadObject();
      }
      if (t.hasAttribute('data-bucket-delete')) {
        const name = t.closest('[data-bucket]').dataset.bucket;
        if (!(await confirmAction(`Delete the bucket ${name}? It must be empty.`, 'Delete bucket'))) return;
        await api(`/api/storage/buckets/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast('Bucket deleted');
        return reloadObject();
      }
      if (t.hasAttribute('data-new-key')) {
        if (object.accessKeyId && !(await confirmAction('Create a new access key? The current key stops working at once.', 'Create new key'))) return;
        secret = await api('/api/storage/keys', { method: 'POST' });
        return reloadObject();
      }
      if (t.hasAttribute('data-copy-secret')) {
        await navigator.clipboard?.writeText(secret.secretAccessKey).then(() => toast('Secret key copied'), () => toast('Select the key and copy it'));
        return;
      }
      if (t.hasAttribute('data-secret-done')) { secret = null; return render(); }
    } catch (err) { fail(err); t.disabled = false; }
  });

  /** Price, fit and chips follow the tier and size without redrawing the form. */
  function refreshForm() {
    const f = $('#volume-form');
    if (!f) return;
    form.tier = f.tier.value;
    form.size = Math.max(0, Math.floor(Number(f.sizeGb.value) || 0));
    const tier = block.tiers.find((t) => t.id === form.tier) ?? block.tiers[0];
    const left = block.disk.usedGb == null ? null : Math.max(0, block.disk.limitGb - block.disk.usedGb);
    const fits = form.size > 0 && (left == null || form.size <= left);
    f.querySelectorAll('[data-size]').forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.size) === form.size)));
    const fit = $('#vol-fit');
    fit.className = `small ${fits ? 'muted' : 'warn-text'}`;
    fit.textContent = left == null ? '' : fits ? `Fits: ${left - form.size} GB of your disk limit left after this.` : `Only ${left} GB of your disk limit is left.`;
    const btn = f.querySelector('.btn.primary');
    btn.disabled = !fits;
    btn.querySelector('span').textContent = `Create volume · ${rp(tier.pricePerGb * form.size)} / month`;
  }
  detail().addEventListener('input', (e) => {
    if (ctx.state.view === 'storage' && e.target.closest('#volume-form') && ['sizeGb', 'tier'].includes(e.target.name)) refreshForm();
  });
  detail().addEventListener('change', (e) => {
    if (ctx.state.view === 'storage' && e.target.closest('#volume-form') && ['sizeGb', 'tier'].includes(e.target.name)) refreshForm();
  });

  detail().addEventListener('submit', async (e) => {
    if (ctx.state.view !== 'storage') return;
    const f = e.target;
    if (f.id === 'volume-form') {
      e.preventDefault();
      $('#volume-error').textContent = '';
      if (!f.reportValidity()) return;
      const body = { label: f.label.value.trim(), tier: f.tier.value, sizeGb: Number(f.sizeGb.value), vmid: Number(f.vmid.value) };
      f.querySelector('.btn.primary').disabled = true;
      try {
        const v = await api('/api/volumes', { method: 'POST', body });
        toast(`${v.label} is attached to ${v.server}`);
        await reloadBlock();
      } catch (err) { $('#volume-error').textContent = err.message; f.querySelector('.btn.primary').disabled = false; }
    }
    if (f.id === 'bucket-form') {
      e.preventDefault();
      $('#bucket-error').textContent = '';
      if (!f.reportValidity()) return;
      try {
        await api('/api/storage/buckets', { method: 'POST', body: { name: f.name.value.trim(), quotaGb: Number(f.quotaGb.value) || 0 } });
        toast('Bucket created');
        await reloadObject();
      } catch (err) { $('#bucket-error').textContent = err.message; }
    }
  });

  function route(hash) {
    if (hash === '#storage') { open(); return true; }
    if (hash === '#storage/object') { open('object'); return true; }
    return false;
  }

  return { open, route, loadStatus };
}
