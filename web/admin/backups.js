// Admin portal: Backups on Proxmox Backup Server (Admin-Backups design).
//   Overview  coverage and the last 24 hours, servers that need attention, backup servers
//             with datastore figures, settings (window, limits, encryption, retention
//             after deletion, default policy)
//   Runs      scheduled and manual backups with their outcome
//   Servers   every customer server: policy (plan, own or default), status, back up now,
//             exclude
//   Policies  when and how long, which plan uses which, add-on prices
//   Connect   owners connect a backup server (test, certificate pin, datastore, clusters)
// Same shape as the other tab modules: tabs(), handles(), load(), render(), onClick(), onChange(), onSubmit().

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const tb = (b) => (b == null ? '·' : b >= 2 ** 40 ? `${(b / 2 ** 40).toFixed(1)} TB` : `${Math.round(b / 2 ** 30)} GB`);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const size = (b) => (b == null ? '·' : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`);
const took = (a, b) => { if (!a || !b) return ''; const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000); return m < 1 ? '< 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const STATUS = {
  protected: ['Protected', 'ok'], pending: ['No backup yet', ''], stale: ['Out of date', 'warn'], failing: ['Failing', 'bad'],
  'no-policy': ['No policy', 'warn'], excluded: ['Excluded', ''],
};
const RUN = { running: ['Running', ''], ok: ['OK', 'ok'], failed: ['Failed', 'bad'] };
const tag = (map, k) => `<span class="tag ${map[k]?.[1] ?? ''}">${map[k]?.[0] ?? k}</span>`;

export function createBackups({ root, api, toast, fail, confirmAction, esc }) {
  const st = { perms: new Set(), data: null, view: 'overview', editing: null, test: null, form: null, runFilter: 'all', srvFilter: 'attention' };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['backups', 'Backups', 'backups.read']];

  async function load() { st.data = await api('/api/admin/backups'); }

  const policyText = (p) => `${p.frequency === 'weekly' ? `Weekly on ${DAYS[p.weekday]}` : 'Daily'} · keep ${[
    p.keepDaily && `${p.keepDaily} daily`, p.keepWeekly && `${p.keepWeekly} weekly`, p.keepMonthly && `${p.keepMonthly} monthly`].filter(Boolean).join(', ')}`;

  function render() {
    const views = [['overview', 'Overview'], ['runs', 'Runs'], ['servers', 'Servers'], ['policies', 'Policies'], ...(can('rbac.write') ? [['connect', 'Backup servers']] : [])];
    body().innerHTML = `
      <div class="backups-admin">
        <div class="segmented" role="radiogroup" aria-label="Backups" style="margin-bottom:16px">
          ${views.map(([v, l]) => `<button type="button" role="radio" aria-checked="${st.view === v}" data-bk-view="${v}">${l}</button>`).join('')}
        </div>
        <div id="bk-view"></div>
      </div>`;
    const el = body().querySelector('#bk-view');
    if (st.view === 'overview') el.innerHTML = overview();
    if (st.view === 'runs') el.innerHTML = runsView();
    if (st.view === 'servers') el.innerHTML = serversView();
    if (st.view === 'policies') el.innerHTML = policies();
    if (st.view === 'connect') el.innerHTML = connect();
  }

  // ---- Overview ---------------------------------------------------------------------------
  function overview() {
    const d = st.data;
    const s = d.settings;
    const w = can('backups.write');
    const live = d.servers.filter((x) => x.status?.reachable);
    const used = live.reduce((a, x) => a + (x.status.used ?? 0), 0);
    const total = live.reduce((a, x) => a + (x.status.total ?? 0), 0);
    const verify = live.map((x) => x.status.lastVerify).filter(Boolean);
    const c = d.coverage;
    const attention = c.servers.filter((x) => ['failing', 'stale'].includes(x.status));
    return `
      ${!d.servers.length ? `<div class="notice warn"><p>No backup server is connected yet.${can('rbac.write') ? ' Connect one under <button class="linklike" data-bk-view="connect">Backup servers</button>.' : ' An owner connects one.'}</p></div>` : ''}
      ${d.servers.length && !s.enabled ? '<div class="notice warn"><p>Backups are switched off: nothing runs and customers don\'t see backups. Switch them on below.</p></div>' : ''}
      <div class="kpi-row">
        <div class="kpi"><span class="muted small">Backup servers</span><strong>${live.length} / ${d.servers.length}</strong><span class="small muted">reachable</span></div>
        <div class="kpi"><span class="muted small">Datastore used</span><strong>${tb(used)}</strong><span class="small muted">of ${tb(total)}</span></div>
        <div class="kpi"><span class="muted small">Protected servers</span><strong>${c.counts.protected} / ${c.servers.length}</strong><span class="small muted">${c.counts['no-policy']} without a policy · ${c.counts.excluded} excluded</span></div>
        <div class="kpi"><span class="muted small">Last 24 hours</span><strong>${c.last24h.ok} ok</strong><span class="small muted">${c.last24h.failed} failed · ${c.last24h.running} running · ${size(c.last24h.bytes)}</span></div>
        <div class="kpi"><span class="muted small">Last verify</span><strong>${verify.length ? (verify.every((v) => v.ok) ? 'OK' : 'Failed') : '·'}</strong><span class="small muted">${verify[0]?.at ? esc(when(verify[0].at)) : 'no verify job seen'}</span></div>
        <div class="kpi"><span class="muted small">Customer keys</span><strong>${d.keys}</strong><span class="small muted">${s.encrypt ? 'encryption on' : 'encryption off'}</span></div>
      </div>
      ${attention.length ? `
        <h2 class="h2">Needs attention</h2>
        <div class="table-wrap"><table class="table" id="bk-attention">
          <thead><tr><th>Server</th><th>Customer</th><th>Status</th><th>Last good backup</th><th>Last error</th></tr></thead>
          <tbody>${attention.slice(0, 8).map((x) => `<tr><td><strong>${esc(x.label || `server ${x.vmid}`)}</strong> <span class="mono small muted">${x.vmid}</span></td>
            <td class="small">${esc(x.email ?? '')}</td><td>${tag(STATUS, x.status)}</td><td class="small">${x.lastOk ? esc(when(x.lastOk)) : '·'}</td>
            <td class="small">${esc(x.lastError ?? '')}</td></tr>`).join('')}</tbody></table></div>
        ${attention.length > 8 ? `<p class="small muted">${attention.length - 8} more under <button class="linklike" data-bk-view="servers">Servers</button>.</p>` : ''}` : ''}
      ${c.orphans.length ? `<div class="notice" style="margin-top:16px"><p>Backups of ${c.orphans.length} server${c.orphans.length === 1 ? '' : 's'} that are no longer the customer's
        ${d.settings.keepAfterDeleteDays ? `are removed ${d.settings.keepAfterDeleteDays} days after the panel noticed (first: ${esc(when(c.orphans[0].firstSeen))})` : 'are kept (removal is off)'}.</p></div>` : ''}
      ${d.servers.length ? `
        <h2 class="h2">Datastores</h2>
        <div class="pbs-cards">${d.servers.map((x) => {
          const t = x.status;
          const pct = t?.total ? Math.round((t.used / t.total) * 100) : 0;
          return `<article class="pool-card" data-pbs="${x.id}">
            <div class="row" style="justify-content:space-between"><div><strong>${esc(x.name)}</strong> <span class="mono muted small">/ ${esc(x.datastore)}</span><br>
              <span class="mono small muted">${esc(x.url)}</span></div>
              ${!x.enabled ? '<span class="tag">Disabled</span>' : t?.reachable ? '<span class="tag ok">Online</span>' : '<span class="tag bad">Unreachable</span>'}</div>
            ${t?.reachable ? `
              <div><span class="meter ${pct >= 85 ? 'meter-warn' : ''}" aria-hidden="true"><i style="width:${pct}%"></i></span>
                <span class="small">${tb(t.used)} / ${tb(t.total)} · ${pct}%</span></div>
              <div class="pool-meters small">
                <div><span class="muted">Dedup</span><span class="mono">${t.dedup ? `${t.dedup}×` : '·'}</span></div>
                <div><span class="muted">Last verify</span><span class="mono">${t.lastVerify ? `${t.lastVerify.ok ? 'OK' : esc(t.lastVerify.status ?? 'failed')} · ${esc(when(t.lastVerify.at))}` : '·'}</span></div>
                <div><span class="muted">Last GC</span><span class="mono">${t.lastGc?.at ? esc(when(t.lastGc.at)) : '·'}</span></div>
              </div>` : x.enabled ? `<p class="small form-error">${esc(t?.error ?? 'Not reachable')}</p>` : ''}
            <p class="small muted" style="margin:0">Serves ${x.clusters.length ? esc(x.clusters.map((c) => d.clusters.find((k) => k.id === c)?.name ?? c).join(', ')) : 'all clusters'} · ${x.storages} customer storage${x.storages === 1 ? '' : 's'}</p>
          </article>`;
        }).join('')}</div>` : ''}

      <section class="security-card settings-card" style="margin-top:20px;max-width:1100px;display:grid">
        <div class="settings-head">
          <h2 class="twofa-title">Settings <span class="pill ${s.enabled ? 'pill-running' : ''}">${s.enabled ? 'On' : 'Off'}</span></h2>
          <p class="muted">Jobs start inside the backup window (panel time zone), a few per node at a time. Every customer has their own
            namespace on the backup server${s.encrypt ? ' and their own encryption key' : ''}. Backups of a deleted server are kept for the days below, then removed (0: kept).</p>
        </div>
        <form id="bk-settings" class="email-form" novalidate>
          <div class="grid-3">
            <label>Window from <select name="windowStart" ${w ? '' : 'disabled'}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.windowStart === h ? 'selected' : ''}>${hh(h)}</option>`).join('')}</select></label>
            <label>Window until <select name="windowEnd" ${w ? '' : 'disabled'}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.windowEnd === h ? 'selected' : ''}>${hh(h)}</option>`).join('')}</select></label>
            <label>Parallel jobs per node <input name="parallelPerNode" type="number" min="1" max="16" value="${s.parallelPerNode}" ${w ? '' : 'disabled'}></label>
            <label>Bandwidth per job (MB/s, 0 = none) <input name="bwlimitMBs" type="number" min="0" max="10000" value="${s.bwlimitMBs}" ${w ? '' : 'disabled'}></label>
            <label>Manual backups per server per day <input name="manualPerDay" type="number" min="0" max="24" value="${s.manualPerDay}" ${w ? '' : 'disabled'}></label>
            <label>Keep backups of deleted servers (days, 0 = keep) <input name="keepAfterDeleteDays" type="number" min="0" max="3650" value="${s.keepAfterDeleteDays}" ${w ? '' : 'disabled'}></label>
            <label>Default policy <span class="hint">servers without a plan policy</span>
              <select name="defaultPolicyId" ${w ? '' : 'disabled'}><option value="">None (no backups)</option>
                ${d.policies.map((p) => `<option value="${p.id}" ${s.defaultPolicyId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          </div>
          <label class="check"><input type="checkbox" name="encrypt" ${s.encrypt ? 'checked' : ''} ${w ? '' : 'disabled'}>
            <span>Encrypt backups with a key per customer <span class="muted">Proxmox makes the key with the customer's first backup; the panel keeps it sealed and
              owners can export it. Without the key nobody can read the backups, so keep exported keys safe. Applies to customers whose first backup is still to come.</span></span></label>
          ${w ? `<div class="row"><label class="inline-check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Backups on</label>
            <button class="btn primary">Save settings</button></div>` : ''}
        </form>
      </section>`;
  }

  // ---- Runs -------------------------------------------------------------------------------------
  function runsView() {
    const list = st.data.runs.filter((r) => st.runFilter === 'all' || r.state === st.runFilter);
    const n = (k) => st.data.runs.filter((r) => r.state === k).length;
    return `
      <div class="segmented" role="radiogroup" aria-label="Show" style="margin-bottom:12px">
        ${[['all', `All ${st.data.runs.length}`], ['running', `Running ${n('running')}`], ['failed', `Failed ${n('failed')}`], ['ok', `OK ${n('ok')}`]]
          .map(([v, l]) => `<button type="button" role="radio" aria-checked="${st.runFilter === v}" data-bk-runs="${v}">${l}</button>`).join('')}
      </div>
      <div class="table-wrap"><table class="table" id="bk-runs">
        <thead><tr><th>Server</th><th>Customer</th><th>Kind</th><th>State</th><th>Started</th><th>Took</th><th>Size</th><th>Detail</th></tr></thead>
        <tbody>${list.map((r) => `<tr data-run="${r.id}">
          <td><strong>${esc(r.label || `server ${r.vmid}`)}</strong> <span class="mono small muted">${r.vmid}</span></td>
          <td class="small">${esc(r.email ?? '')}</td>
          <td class="small">${r.kind === 'manual' ? 'Manual' : 'Scheduled'}</td>
          <td>${tag(RUN, r.state)}</td>
          <td class="small">${esc(when(r.startedAt))}</td>
          <td class="small">${took(r.startedAt, r.finishedAt)}</td>
          <td class="small mono">${r.state === 'ok' ? size(r.size) : ''}</td>
          <td class="small ${r.state === 'failed' ? 'form-error' : 'muted'}">${esc(r.state === 'failed' ? r.error ?? '' : r.state === 'ok' ? r.error ?? '' : r.node ?? '')}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">No backup has run yet.</td></tr>'}</tbody></table></div>
      <p class="small muted">The latest 50 runs. Failed backups can also be retried from Jobs.</p>`;
  }

  // ---- Servers ------------------------------------------------------------------------------------
  function serversView() {
    const d = st.data;
    const w = can('backups.write');
    const all = d.coverage.servers;
    const filters = [['attention', 'Needs attention', (x) => !['protected', 'excluded'].includes(x.status)], ['all', 'All', () => true],
      ['protected', 'Protected', (x) => x.status === 'protected'], ['excluded', 'Excluded', (x) => x.status === 'excluded']];
    const f = filters.find(([k]) => k === st.srvFilter) ?? filters[0];
    const list = all.filter(f[2]);
    return `
      <div class="segmented" role="radiogroup" aria-label="Show" style="margin-bottom:12px">
        ${filters.map(([k, l, fn]) => `<button type="button" role="radio" aria-checked="${st.srvFilter === k}" data-bk-srv="${k}">${l} ${all.filter(fn).length}</button>`).join('')}
      </div>
      <div class="table-wrap"><table class="table" id="bk-servers">
        <thead><tr><th>Server</th><th>Customer</th><th>Policy</th><th>Status</th><th>Last good backup</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${list.map((x) => `<tr data-bk-vm="${x.vmid}">
          <td><strong>${esc(x.label || `server ${x.vmid}`)}</strong> <span class="mono small muted">${x.vmid}</span></td>
          <td class="small">${esc(x.email ?? '')}</td>
          <td><select data-bk-override aria-label="Backup policy of server ${x.vmid}" ${w && !x.excluded ? '' : 'disabled'}>
            <option value="">${x.override ? 'Plan or default' : `Plan or default${x.policy ? `: ${esc(x.policy)}` : ': none'}`}</option>
            ${d.policies.map((p) => `<option value="${p.id}" ${x.override === p.id ? 'selected' : ''}>${esc(p.name)}${p.addonPrice != null ? ' (add-on)' : ''}</option>`).join('')}</select></td>
          <td>${tag(STATUS, x.status)}${x.lastError ? `<br><span class="small form-error">${esc(x.lastError)}</span>` : ''}</td>
          <td class="small">${x.lastOk ? esc(when(x.lastOk)) : '·'}</td>
          <td><div class="row end">${w ? `${!x.excluded && d.settings.enabled ? '<button class="btn" data-bk-now>Back up now</button>' : ''}
            <button class="btn ghost" data-bk-exclude>${x.excluded ? 'Include' : 'Exclude'}</button>` : ''}</div></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>'}</tbody></table></div>
      <p class="small muted">A server's own policy replaces its plan's (an add-on policy is billed with the server). Excluded servers are never backed up.</p>`;
  }

  // ---- Policies ---------------------------------------------------------------------------
  function policyForm(p = null) {
    const v = (x) => esc(x ?? '');
    return `
      <form id="bk-policy" class="security-card settings-card" style="max-width:1100px;display:grid;margin-bottom:16px" data-policy-id="${p?.id ?? ''}" novalidate>
        <h2 class="twofa-title">${p ? `Edit ${esc(p.name)}` : 'New policy'}</h2>
        <div class="grid-3">
          <label>Name <input name="name" maxlength="60" value="${v(p?.name)}" placeholder="Daily 7" required></label>
          <label>Runs <select name="frequency"><option value="daily" ${p?.frequency !== 'weekly' ? 'selected' : ''}>Every day</option><option value="weekly" ${p?.frequency === 'weekly' ? 'selected' : ''}>Once a week</option></select></label>
          <label data-bk-weekday ${p?.frequency === 'weekly' ? '' : 'hidden'}>On <select name="weekday">${DAYS.map((d, i) => `<option value="${i}" ${(p?.weekday ?? 0) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label>Keep daily <input name="keepDaily" type="number" min="0" max="400" value="${v(p?.keepDaily ?? 7)}"></label>
          <label>Keep weekly <input name="keepWeekly" type="number" min="0" max="400" value="${v(p?.keepWeekly ?? 0)}"></label>
          <label>Keep monthly <input name="keepMonthly" type="number" min="0" max="400" value="${v(p?.keepMonthly ?? 0)}"></label>
          <label>Sold as an add-on (Rp / month) <span class="hint">empty: not sold separately</span><input name="addonPrice" type="number" min="0" step="1000" value="${v(p?.addonPrice)}"></label>
        </div>
        <div class="row"><button class="btn primary">${p ? 'Save policy' : 'Add policy'}</button><button type="button" class="btn ghost" data-bk-cancel>Cancel</button></div>
      </form>`;
  }

  function policies() {
    const d = st.data;
    const w = can('backups.write');
    return `
      <p class="muted" style="max-width:90ch;margin-top:0">A policy says when servers are backed up and how long backups are kept. Each plan points to one policy;
        a customer can buy a policy that is sold as an add-on for a single server. Servers without a plan use the default policy (Overview).</p>
      ${w && !st.editing ? '<div class="row" style="margin-bottom:12px"><button class="btn" data-bk-new>New policy</button></div>' : ''}
      ${st.editing ? policyForm(st.editing === 'new' ? null : d.policies.find((p) => p.id === st.editing)) : ''}
      <div class="pbs-cards">${d.policies.map((p) => `
        <article class="pool-card" data-policy="${p.id}">
          <div class="row" style="justify-content:space-between"><strong>${esc(p.name)}</strong><span class="tag">${p.servers} server${p.servers === 1 ? '' : 's'}</span></div>
          <span class="small">${esc(policyText(p))}</span>
          <span class="small muted">${p.plans.length ? `Plans: ${esc(p.plans.map((x) => x.name).join(', '))}` : 'No plan uses it'}${p.addonPrice != null ? ` · add-on ${rp(p.addonPrice)} / month` : ''}${d.settings.defaultPolicyId === p.id ? ' · default' : ''}</span>
          ${w ? '<div class="row"><button class="btn" data-bk-edit>Edit</button><button class="btn danger" data-bk-delete>Delete</button></div>' : ''}
        </article>`).join('') || '<p class="muted">No policy yet.</p>'}</div>
      ${d.plans.length ? `
        <h2 class="h2">Plans</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Plan</th><th>Backup policy</th></tr></thead>
          <tbody>${d.plans.map((p) => `<tr data-plan="${p.id}"><td>${esc(p.name)}${p.active ? '' : ' <span class="tag">retired</span>'}</td>
            <td><select data-plan-policy aria-label="Backup policy of ${esc(p.name)}" ${w ? '' : 'disabled'}><option value="">No backups</option>
              ${d.policies.map((x) => `<option value="${x.id}" ${p.policyId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td></tr>`).join('')}
          </tbody></table></div>` : ''}`;
  }

  // ---- Backup servers (owners) -----------------------------------------------------------------
  function connect() {
    const d = st.data;
    const f = st.form ?? { name: '', url: '', tokenId: '', tokenSecret: '', datastore: '', clusters: [] };
    const t = st.test;
    return `
      ${d.servers.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Backup server</th><th>Datastore</th><th>Serves</th><th>State</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${d.servers.map((x) => `<tr data-pbs="${x.id}">
          <td><strong>${esc(x.name)}</strong><br><span class="mono small muted">${esc(x.url)}${x.fingerprint ? ' · pinned certificate' : ''}</span></td>
          <td class="mono">${esc(x.datastore)}</td>
          <td class="small">${x.clusters.length ? esc(x.clusters.map((c) => d.clusters.find((k) => k.id === c)?.name ?? c).join(', ')) : 'All clusters'}</td>
          <td>${x.enabled ? '<span class="tag ok">Enabled</span>' : '<span class="tag">Disabled</span>'}</td>
          <td><div class="row end"><button class="btn" data-pbs-toggle>${x.enabled ? 'Disable' : 'Enable'}</button><button class="btn danger" data-pbs-remove>Remove</button></div></td>
        </tr>`).join('')}</tbody></table></div>` : ''}
      <form id="pbs-form" class="security-card settings-card" style="max-width:1100px;display:grid;margin-top:16px" novalidate>
        <h2 class="twofa-title">Connect a Proxmox Backup Server</h2>
        <p class="muted">Create an API token on the backup server (Configuration → Access Control → API Token) and give it the
          <span class="mono">DatastoreAdmin</span> role on the datastore (it creates a namespace per customer). The panel adds the server as a storage on each
          cluster it serves, one per customer, when that customer's first backup runs.</p>
        <div class="grid-3">
          <label>Name <input name="name" value="${esc(f.name)}" placeholder="pbs-jkt" spellcheck="false" required></label>
          <label>Address <input name="url" value="${esc(f.url)}" placeholder="https://10.10.0.40:8007" spellcheck="false" required></label>
          <label>API token ID <input name="tokenId" value="${esc(f.tokenId)}" placeholder="panel@pbs!panel" spellcheck="false" required></label>
          <label>Token secret <input name="tokenSecret" type="password" autocomplete="new-password" value="${esc(f.tokenSecret)}" required></label>
          <label>Datastore <select name="datastore" ${t?.ok ? '' : 'disabled'}>${t?.ok ? t.datastores.map((x) => `<option value="${esc(x.name)}" ${f.datastore === x.name ? 'selected' : ''}>${esc(x.name)} (${tb(x.used)} of ${tb(x.total)})</option>`).join('') : '<option>Test the connection first</option>'}</select></label>
        </div>
        <fieldset class="plain-fieldset"><legend class="small muted">Serves these clusters (none ticked: all)</legend>
          <div class="row">${d.clusters.map((c) => `<label class="inline-check"><input type="checkbox" name="cluster" value="${c.id}" ${f.clusters.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></fieldset>
        ${t?.fingerprint ? `<label class="check"><input type="checkbox" name="pin" ${f.pin ? 'checked' : ''}><span>Trust this certificate: <span class="mono small">${esc(t.fingerprint)}</span>
          <span class="muted">Compare with <span class="mono">proxmox-backup-manager cert info</span> on the backup server.</span></span></label>` : ''}
        ${t ? `<div class="notice ${t.ok ? '' : 'warn'}"><p>${t.ok ? `Connected: Proxmox Backup Server ${esc(t.version ?? '')}, ${t.datastores.length} datastore${t.datastores.length === 1 ? '' : 's'}.` : esc(t.error)}</p></div>` : ''}
        <div class="row"><button type="button" class="btn" data-pbs-test>Test connection</button>
          <button class="btn primary" ${t?.ok ? '' : 'disabled'}>Connect</button></div>
      </form>`;
  }

  function readForm() {
    const el = root.querySelector('#pbs-form').elements;
    st.form = {
      name: el.name.value.trim(), url: el.url.value.trim(), tokenId: el.tokenId.value.trim(), tokenSecret: el.tokenSecret.value,
      datastore: el.datastore.disabled ? '' : el.datastore.value,
      clusters: [...root.querySelectorAll('#pbs-form [name=cluster]:checked')].map((x) => Number(x.value)),
      pin: !!el.pin?.checked,
    };
    return st.form;
  }

  // ---- events ---------------------------------------------------------------------------
  const go = async (fn, msg) => { try { await fn(); if (msg) toast(msg); await load(); render(); } catch (err) { fail(err); } };

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t || t.dataset.adminTab) return false;
    if (t.dataset.bkView) { st.view = t.dataset.bkView; st.editing = null; render(); return true; }
    if (t.dataset.bkRuns) { st.runFilter = t.dataset.bkRuns; render(); return true; }
    if (t.dataset.bkSrv) { st.srvFilter = t.dataset.bkSrv; render(); return true; }
    const vm = t.closest('[data-bk-vm]');
    if (vm && t.hasAttribute('data-bk-now')) {
      t.disabled = true;
      await go(() => api(`/api/admin/backups/run/${vm.dataset.bkVm}`, { method: 'POST' }), 'Backup started');
      return true;
    }
    if (vm && t.hasAttribute('data-bk-exclude')) {
      const x = st.data.coverage.servers.find((s) => s.vmid === Number(vm.dataset.bkVm));
      if (!x.excluded && !(await confirmAction(`Exclude ${x.label || `server ${x.vmid}`} from backups? No new backups are made; existing ones are kept as the policy says.`, 'Exclude'))) return true;
      await go(() => api(`/api/admin/backups/vms/${x.vmid}`, { method: 'PUT', body: { excluded: !x.excluded } }), x.excluded ? 'Included in backups' : 'Excluded from backups');
      return true;
    }
    if (t.hasAttribute('data-bk-new')) { st.editing = 'new'; render(); return true; }
    if (t.hasAttribute('data-bk-cancel')) { st.editing = null; render(); return true; }
    const pol = t.closest('[data-policy]');
    if (pol && t.hasAttribute('data-bk-edit')) { st.editing = Number(pol.dataset.policy); render(); return true; }
    if (pol && t.hasAttribute('data-bk-delete')) {
      const p = st.data.policies.find((x) => x.id === Number(pol.dataset.policy));
      if (!(await confirmAction(`Delete the policy ${p.name}?`, 'Delete'))) return true;
      await go(() => api(`/api/admin/backups/policies/${p.id}`, { method: 'DELETE' }), 'Policy deleted');
      return true;
    }
    if (t.hasAttribute('data-pbs-test')) {
      const f = readForm();
      t.disabled = true;
      try {
        st.test = await api('/api/admin/backups/servers/test', { method: 'POST', body: { url: f.url, tokenId: f.tokenId, tokenSecret: f.tokenSecret, fingerprint: f.pin ? st.test?.fingerprint ?? null : null } });
        if (st.test.ok && !f.datastore) st.form.datastore = st.test.datastores[0]?.name ?? '';
      } catch (err) { fail(err); }
      render();
      return true;
    }
    const row = t.closest('[data-pbs]');
    if (row && t.hasAttribute('data-pbs-toggle')) {
      const x = st.data.servers.find((s) => s.id === Number(row.dataset.pbs));
      await go(() => api(`/api/admin/backups/servers/${x.id}`, { method: 'PUT', body: { enabled: !x.enabled } }), x.enabled ? `${x.name} disabled` : `${x.name} enabled`);
      return true;
    }
    if (row && t.hasAttribute('data-pbs-remove')) {
      const x = st.data.servers.find((s) => s.id === Number(row.dataset.pbs));
      if (!(await confirmAction(`Remove ${x.name}? Its storage entries are removed from the clusters; the backups stay on the backup server.`, 'Remove'))) return true;
      await go(() => api(`/api/admin/backups/servers/${x.id}`, { method: 'DELETE' }), `${x.name} removed`);
      return true;
    }
    return false;
  }

  async function onChange(e) {
    if (e.target.matches('#bk-policy [name=frequency]')) {
      root.querySelector('[data-bk-weekday]').hidden = e.target.value !== 'weekly';
      return;
    }
    if (e.target.matches('[data-bk-override]')) {
      const vmid = Number(e.target.closest('[data-bk-vm]').dataset.bkVm);
      await go(() => api(`/api/admin/backups/vms/${vmid}`, { method: 'PUT', body: { policyId: e.target.value ? Number(e.target.value) : null } }), 'Server policy saved');
      return;
    }
    if (e.target.matches('[data-plan-policy]')) {
      const plan = Number(e.target.closest('[data-plan]').dataset.plan);
      await go(() => api(`/api/admin/backups/plans/${plan}`, { method: 'PUT', body: { policyId: e.target.value ? Number(e.target.value) : null } }), 'Plan saved');
    }
  }

  async function onSubmit(e) {
    const f = e.target;
    const el = f.elements;
    const id = f.getAttribute('id');
    if (id === 'bk-settings') {
      const b = {
        enabled: el.enabled.checked, encrypt: el.encrypt.checked, windowStart: Number(el.windowStart.value), windowEnd: Number(el.windowEnd.value),
        parallelPerNode: Number(el.parallelPerNode.value), bwlimitMBs: Number(el.bwlimitMBs.value), manualPerDay: Number(el.manualPerDay.value),
        keepAfterDeleteDays: Number(el.keepAfterDeleteDays.value), defaultPolicyId: el.defaultPolicyId.value ? Number(el.defaultPolicyId.value) : null,
      };
      await go(() => api('/api/admin/backups/settings', { method: 'PUT', body: b }), 'Backup settings saved');
      return;
    }
    if (id === 'bk-policy') {
      const pid = f.dataset.policyId;
      const b = {
        name: el.name.value.trim(), frequency: el.frequency.value, weekday: el.frequency.value === 'weekly' ? Number(el.weekday.value) : null,
        keepDaily: Number(el.keepDaily.value) || 0, keepWeekly: Number(el.keepWeekly.value) || 0, keepMonthly: Number(el.keepMonthly.value) || 0,
        addonPrice: el.addonPrice.value === '' ? null : Number(el.addonPrice.value),
      };
      await go(async () => { await api(pid ? `/api/admin/backups/policies/${pid}` : '/api/admin/backups/policies', { method: pid ? 'PUT' : 'POST', body: b }); st.editing = null; }, pid ? 'Policy saved' : 'Policy added');
      return;
    }
    if (id === 'pbs-form') {
      const x = readForm();
      await go(async () => {
        await api('/api/admin/backups/servers', { method: 'POST', body: {
          name: x.name, url: x.url, tokenId: x.tokenId, tokenSecret: x.tokenSecret, datastore: x.datastore, clusters: x.clusters,
          fingerprint: x.pin ? st.test?.fingerprint ?? null : null,
        } });
        st.form = null; st.test = null; st.view = 'overview';
      }, `${x.name} connected`);
    }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([tid, label]) => [tid, label]),
    handles: (tab) => TABS.some(([tid]) => tid === tab),
    load, render, onClick, onChange, onSubmit,
  };
}
