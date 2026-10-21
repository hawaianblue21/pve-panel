// Customer portal: the Backups tab of a server (Customer-Backups design).
//   Status        the backup plan (from the plan, an add-on or support), window, encryption,
//                 last backup; "Back up now" within the daily allowance
//   Restore points newest first: protect, browse files, restore (as a new server or over
//                 this one)
//   Add-on        a longer backup plan for this server, billed with its renewal
import { api, esc, toast, fail, confirmAction } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const size = (b) => (b == null ? '' : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`);
const policyText = (p) => (p ? `${p.frequency === 'weekly' ? `Every ${DAYS[p.weekday]}` : 'Every day'}, keeps ${[
  p.keepDaily && `${p.keepDaily} daily`, p.keepWeekly && `${p.keepWeekly} weekly`, p.keepMonthly && `${p.keepMonthly} monthly`].filter(Boolean).join(', ')}` : '');

/** ctx: { getVm(): the server shown, isOpen(): the tab is showing, reload(): list + detail again } */
export function createBackups(ctx) {
  const st = { data: null, vmid: null, browse: null, restore: null, timer: null };
  const body = () => document.getElementById('tab-body');

  async function render(el) {
    const vm = ctx.getVm();
    if (st.vmid !== vm.vmid) Object.assign(st, { data: null, vmid: vm.vmid, browse: null, restore: null });
    if (!st.data) el.innerHTML = '<p class="muted">Loading backups…</p>';
    try { st.data = await api(`/api/vms/${vm.vmid}/backups`); } catch (err) { return fail(err); }
    if (!ctx.isOpen() || ctx.getVm()?.vmid !== vm.vmid) return;
    draw();
    // follow a running backup
    clearTimeout(st.timer);
    if (st.data.running) st.timer = setTimeout(() => { if (ctx.isOpen()) render(body()); }, 3000);
  }

  function draw() {
    const el = body();
    const d = st.data;
    if (!el || !d) return;
    if (!d.enabled) { el.innerHTML = '<p class="muted">Backups are not offered right now.</p>'; return; }
    const vm = ctx.getVm();
    const can = d.policy && !d.excluded;
    const nowOk = can && !d.running && d.manual.left > 0;
    const source = d.excluded ? 'Switched off by support' : d.addon ? `Add-on: ${d.addon.name}` : d.setBySupport ? 'Set by support' : d.policy ? 'Included with your plan' : '';
    el.innerHTML = `
      <div class="section-head"><h2>Backups</h2>
        ${can ? `<button class="btn primary" data-bk-now ${nowOk ? '' : 'disabled'}>${icon('shield', { size: 16 })}<span>Back up now</span></button>` : ''}</div>
      <section class="security-card settings-card bk-status" aria-label="Backup plan">
        <div class="bk-facts">
          <div><span class="muted small">Backup plan</span><strong>${d.policy ? esc(policyText(d.policy)) : 'No backups'}</strong><span class="small muted">${esc(source)}</span></div>
          <div><span class="muted small">Runs</span><strong class="mono">${esc(d.window)}</strong><span class="small muted">a few servers at a time</span></div>
          <div><span class="muted small">Last backup</span><strong>${d.running ? 'Running…' : d.lastRun ? (d.lastRun.state === 'ok' ? esc(when(d.lastRun.finishedAt)) : 'Failed') : 'None yet'}</strong>
            <span class="small ${d.lastRun?.state === 'failed' ? 'form-error' : 'muted'}">${d.lastRun?.state === 'failed' ? esc(d.lastRun.error ?? '') : can ? `${d.manual.left} of ${d.manual.perDay} own backups left today` : ''}</span></div>
          <div><span class="muted small">Encryption</span><strong>${d.encrypted ? 'On' : 'Off'}</strong><span class="small muted">${d.encrypted ? 'a key of your own' : ''}</span></div>
        </div>
        ${d.running ? '<p class="progress-step"><span class="spinner" aria-hidden="true"></span>A backup is running. The server keeps working meanwhile.</p>' : ''}
        ${!d.policy && !d.excluded && !d.addons.length ? '<p class="muted small">Your plan has no backups. Ask support if you need them.</p>' : ''}
      </section>
      ${d.lastRestore?.state === 'failed' ? `<div class="notice warn"><p>The last restore did not work: ${esc(d.lastRestore.error ?? '')}</p></div>` : ''}

      <h2 class="h2">Restore points</h2>
      ${d.points.length ? `<ul class="snap-list bk-points">${d.points.map((p, i) => `
        <li data-bk-point="${esc(p.id)}">
          <div class="grow">
            <div><strong>${esc(when(p.time))}</strong>${i === 0 ? ' <span class="tag">latest</span>' : ''}${p.protected ? ' <span class="tag ok">protected</span>' : ''}${p.verified === false ? ' <span class="tag bad">not verified</span>' : ''}</div>
            <div class="muted small">${size(p.size)}${p.verified ? ' · verified' : ''}</div>
          </div>
          <button class="btn" data-bk-browse>Files</button>
          <button class="btn" data-bk-restore>Restore…</button>
          <button class="btn ghost" data-bk-protect>${p.protected ? 'Unprotect' : 'Protect'}</button>
        </li>
        ${st.restore === p.id ? restoreForm(p, vm, d) : ''}
        ${st.browse?.id === p.id ? `<li class="bk-browse-row">${browser()}</li>` : ''}`).join('')}</ul>
        <p class="muted small" style="max-width:75ch">Protected backups are kept until you unprotect them (up to ${d.protectMax}); the others go as your backup plan says.
          Files are read from the backup while your server keeps running.</p>`
        : `<p class="muted">${can ? 'No backups yet. The first one runs in the next backup window, or back up now.' : 'No backups.'}</p>`}
      ${addonCard(d)}`;
  }

  function restoreForm(p, vm, d) {
    const running = vm.status === 'running';
    const blocked = running ? 'Shut down the server first.' : d.hasVolumes ? 'This server holds block storage volumes, so it can only be restored as a new server.' : '';
    return `<li class="bk-restore-row"><form id="bk-restore-form" class="bk-restore" data-point="${esc(p.id)}" novalidate>
      <fieldset class="plain-fieldset"><legend><strong>Restore the backup of ${esc(when(p.time))}</strong></legend>
        <label class="check"><input type="radio" name="mode" value="new" checked>
          <span>As a new server <span class="muted">A copy next to this one with its own address. Counts as a new server of the same plan
            (and is billed like one); only the system disk is restored, public IPs and volumes stay here.</span></span></label>
        <label class="bk-indent" data-bk-new>Name of the new server <input name="hostname" value="${esc(`${(vm.name || 'server').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'server'}-restore`)}" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" spellcheck="false"></label>
        <label class="check"><input type="radio" name="mode" value="replace" ${blocked ? 'disabled' : ''}>
          <span>Over this server <span class="muted">${blocked ? esc(blocked) : 'This server goes back to the backup; everything changed since is lost.'}</span></span></label>
        <label class="check bk-indent" data-bk-first hidden><input type="checkbox" name="backupFirst" checked>
          <span>Back up the current state first <span class="muted">So you can go back if the restore is not what you wanted.</span></span></label>
      </fieldset>
      <div class="row"><button class="btn primary">Restore</button><button type="button" class="btn ghost" data-bk-cancel>Cancel</button></div>
    </form></li>`;
  }

  function browser() {
    const b = st.browse;
    const parts = b.path.split('/').filter(Boolean);
    const crumbs = [['/', 'Backup'], ...parts.map((x, i) => [`/${parts.slice(0, i + 1).join('/')}`, x])];
    const href = (path, folder) => `/api/vms/${st.vmid}/backups/${encodeURIComponent(b.id)}/download?path=${encodeURIComponent(path)}${folder ? '&folder=true' : ''}`;
    return `<div class="bk-browser" aria-label="Files in the backup">
      <div class="row" style="justify-content:space-between">
        <nav class="crumbs" aria-label="Folder">${crumbs.map(([path, label], i) => (i === crumbs.length - 1
          ? `<span class="mono small">${esc(label)}</span>` : `<button class="link-btn mono small" data-bk-path="${esc(path)}">${esc(label)}</button><span class="muted">/</span>`)).join('')}</nav>
        <button class="btn ghost" data-bk-close>Close</button></div>
      ${b.loading ? '<p class="muted">Reading the backup…</p>' : `<table class="table bk-files"><tbody>
        ${b.entries.map((e) => `<tr><td>${e.type === 'folder'
          ? `<button class="link-btn" data-bk-path="${esc(e.path)}">${icon('layers', { size: 15 })}<span>${esc(e.name)}/</span></button>`
          : `<span class="mono">${esc(e.name)}</span>`}</td>
          <td class="small muted">${e.type === 'file' ? size(e.size) : ''}</td>
          <td><div class="row end"><a class="btn ghost" href="${href(e.path, e.type === 'folder')}" download>${icon('download', { size: 15 })}<span>${e.type === 'folder' ? 'Zip' : 'Download'}</span></a></div></td></tr>`).join('')
          || '<tr><td class="muted">Empty folder.</td></tr>'}</tbody></table>`}
    </div>`;
  }

  function addonCard(d) {
    if (d.excluded || (!d.addons.length && !d.addon)) return '';
    if (d.setBySupport) return '';
    return `<section class="security-card settings-card" style="margin-top:20px" aria-labelledby="bk-addon">
      <h2 class="twofa-title" id="bk-addon">Longer backups</h2>
      <p class="muted">Keep backups for longer than your plan does. Billed per month with this server's next renewal.</p>
      <form id="bk-addon-form" class="email-form"><div class="grid-2">
        <label>Backup plan <select name="policyId">
          <option value="">${d.planPolicy ? `Included: ${esc(policyText(d.planPolicy))}` : 'No backups (plan)'}</option>
          ${d.addons.map((x) => `<option value="${x.id}" ${d.addon?.id === x.id ? 'selected' : ''}>${esc(x.name)}: ${esc(policyText(x))} · ${rp(x.addonPrice)} / month</option>`).join('')}
        </select></label></div>
        <div class="row"><button class="btn primary">Save</button></div></form>
    </section>`;
  }

  async function loadFolder(path) {
    st.browse = { ...st.browse, path, loading: true };
    draw();
    try {
      const r = await api(`/api/vms/${st.vmid}/backups/${encodeURIComponent(st.browse.id)}/files?path=${encodeURIComponent(path)}`);
      st.browse = { ...st.browse, path: r.path, entries: r.entries, loading: false };
    } catch (err) { st.browse = null; fail(err); }
    draw();
  }

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    const point = t.closest('[data-bk-point]')?.dataset.bkPoint;
    if (t.hasAttribute('data-bk-now')) {
      t.disabled = true;
      try { await api(`/api/vms/${st.vmid}/backups`, { method: 'POST' }); toast('Backup started'); } catch (err) { fail(err); }
      render(body());
      return;
    }
    if (point && t.hasAttribute('data-bk-browse')) { st.restore = null; st.browse = { id: point, path: '/', entries: [] }; loadFolder('/'); return; }
    if (t.dataset.bkPath) { loadFolder(t.dataset.bkPath); return; }
    if (t.hasAttribute('data-bk-close')) { st.browse = null; draw(); return; }
    if (point && t.hasAttribute('data-bk-restore')) { st.browse = null; st.restore = st.restore === point ? null : point; draw(); return; }
    if (t.hasAttribute('data-bk-cancel')) { st.restore = null; draw(); return; }
    if (point && t.hasAttribute('data-bk-protect')) {
      const p = st.data.points.find((x) => x.id === point);
      try {
        await api(`/api/vms/${st.vmid}/backups/${encodeURIComponent(point)}`, { method: 'PUT', body: { protected: !p.protected } });
        toast(p.protected ? 'Backup unprotected' : 'Backup protected');
      } catch (err) { fail(err); }
      render(body());
    }
  }

  function onChange(e) {
    if (e.target.name === 'mode' && e.target.closest('#bk-restore-form')) {
      const f = e.target.form;
      f.querySelector('[data-bk-new]').hidden = e.target.value !== 'new';
      f.querySelector('[data-bk-first]').hidden = e.target.value !== 'replace';
    }
  }

  async function onSubmit(e) {
    const f = e.target;
    if (f.id === 'bk-addon-form') {
      e.preventDefault();
      try {
        await api(`/api/vms/${st.vmid}/backups/addon`, { method: 'PUT', body: { policyId: f.elements.policyId.value ? Number(f.elements.policyId.value) : null } });
        toast(f.elements.policyId.value ? 'Backup add-on on; billed with the next renewal' : 'Back to the backups of your plan');
      } catch (err) { fail(err); }
      render(body());
      return;
    }
    if (f.id !== 'bk-restore-form') return;
    e.preventDefault();
    const id = f.dataset.point;
    const p = st.data.points.find((x) => x.id === id);
    const mode = f.elements.mode.value;
    if (mode === 'replace') {
      if (!(await confirmAction(`Restore this server to the backup of ${when(p.time)}? Everything changed since then is lost${f.elements.backupFirst.checked ? ' (a backup of the current state is made first)' : ''}.`, 'Restore'))) return;
      try {
        await api(`/api/vms/${st.vmid}/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { mode, backupFirst: f.elements.backupFirst.checked } });
        toast('Restoring the server');
        st.restore = null;
        await ctx.reload();
      } catch (err) { fail(err); }
      return;
    }
    const hostname = f.elements.hostname.value.trim();
    try {
      const r = await api(`/api/vms/${st.vmid}/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { mode, hostname } });
      toast(`Restoring as a new server: ${hostname} (${r.vmid})`);
      st.restore = null;
      await ctx.reload();
    } catch (err) { fail(err); }
  }

  return { render, onClick, onChange, onSubmit };
}
