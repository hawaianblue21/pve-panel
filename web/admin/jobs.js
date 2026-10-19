// Admin portal: Jobs (background work) and Updates (the fleet's OS update state
// and update rollouts in rings). Same shape as the other tab modules.

const STATE_TAG = { running: ['Running', ''], failed: ['Failed', 'bad'], done: ['Done', 'ok'] };
const FLAG = { ok: ['Up to date', 'ok'], never: ['Never updated', 'warn'], stale: ['Older than 30 days', 'warn'], failed: ['Last run failed', 'bad'], running: ['Running', ''] };
const ITEM = { pending: ['Waiting', ''], started: ['Running', ''], done: ['Done', 'ok'], failed: ['Failed', 'bad'], skipped: ['Skipped', 'warn'] };
const RO = { running: ['Running', ''], paused: ['Paused', 'warn'], done: ['Done', 'ok'], cancelled: ['Cancelled', ''] };
const RINGS = [['10,30,60', '3 rings: 10 %, 30 %, 60 %'], ['25,75', '2 rings: 25 %, 75 %'], ['100', 'All at once']];
const RETRY = { delete: ['Retry deletion', 'servers.delete'], updates: ['Retry updates', 'updates.write'], snapshot: ['Retry snapshot', 'servers.manage'] };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const tag = (map, k) => `<span class="tag ${map[k]?.[1] ?? ''}">${map[k]?.[0] ?? k}</span>`;
const when = (d) => {
  if (!d) return '';
  const t = new Date(/Z|[+-]\d\d:?\d\d$/.test(d) ? d : `${String(d).replace(' ', 'T')}Z`);
  return t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function createJobs({ root, api, toast, fail, confirmAction, esc }) {
  const st = { perms: new Set(), jobs: null, filter: 'all', fleet: null, rollouts: [], fleetFilter: 'all', picked: new Set(), open: null, timer: null };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['jobs', 'Jobs', 'servers.read'], ['updates', 'Updates', 'servers.read']];

  async function load(tab) {
    if (tab === 'jobs') st.jobs = await api(`/api/admin/jobs?filter=${st.filter}`);
    if (tab === 'updates') {
      [st.fleet, { rollouts: st.rollouts }] = await Promise.all([api('/api/admin/updates/fleet'), api('/api/admin/updates/rollouts')]);
    }
  }
  function render(tab) {
    clearTimeout(st.timer);
    if (tab === 'jobs') renderJobs();
    if (tab === 'updates') renderUpdates();
    // keep running work fresh while the tab is open
    const busy = tab === 'jobs' ? st.jobs?.counts.running
      : st.rollouts.some((r) => r.state === 'running') || st.fleet?.servers.some((s) => s.check?.state === 'checking');
    if (busy) {
      const tick = async () => {
        if (!root.querySelector(`[data-admin-tab="${tab}"][aria-selected="true"]`)) return;
        // someone is filling in the rollout form: don't wipe it, look again later
        if (root.querySelector('#rollout-form')?.contains(document.activeElement)) { st.timer = setTimeout(tick, 5000); return; }
        try { await load(tab); render(tab); } catch { st.timer = setTimeout(tick, 5000); }
      };
      st.timer = setTimeout(tick, 5000);
    }
  }

  // ---- Jobs ---------------------------------------------------------------------------
  function renderJobs() {
    const j = st.jobs;
    body().innerHTML = `
      <div class="jobs">
        <div class="row" style="margin-bottom:12px">
          <div class="segmented" role="radiogroup" aria-label="Show">
            ${[['all', 'All'], ['running', `Running ${j.counts.running}`], ['failed', `Failed ${j.counts.failed}`], ['done', 'Done']].map(([v, l]) =>
              `<button role="radio" aria-checked="${st.filter === v}" data-job-filter="${v}">${l}</button>`).join('')}
          </div>
          <span class="small muted">Servers being set up, reinstalled or deleted, update runs and rollouts; finished work of the last 7 days. Failed deletions, update runs and automatic snapshots can be retried.</span>
        </div>
        ${j.jobs.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Job</th><th>Server or target</th><th>By</th><th>Started</th><th>State</th><th>Details</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${j.jobs.map((x) => `
              <tr class="${x.state === 'failed' ? 'row-attention' : ''}" data-job="${esc(x.id)}"><td>${esc(x.action)}</td>
                <td>${esc(x.target)}${x.vmid && !String(x.target).includes(x.vmid) ? ` <span class="mono muted small">${x.vmid}</span>` : ''}</td>
                <td class="small">${esc(x.by ?? '')}</td><td class="small nowrap">${esc(when(x.at))}</td><td>${tag(STATE_TAG, x.state)}</td>
                <td class="small">${esc(x.detail ?? '')}${x.rolloutId ? ' <button class="link-btn" data-open-rollouts>Open</button>' : ''}
                  ${x.retryNote ? `<br><span class="muted">${esc(x.retryNote)}</span>` : ''}</td>
                <td><div class="row end">${x.retry && can(RETRY[x.retry][1]) ? `<button class="btn" data-job-retry>${RETRY[x.retry][0]}</button>` : ''}</div></td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">Nothing here.</p>'}
      </div>`;
  }

  // ---- Updates --------------------------------------------------------------------------
  const keep = (s) => ({ all: true, never: s.flag === 'never', stale: s.flag === 'stale', failed: s.flag === 'failed', running: s.flag === 'running',
    windows: s.os === 'windows', linux: s.os === 'linux' })[st.fleetFilter];

  function pendingCell(s) {
    const c = s.check;
    if (!s.patchable) return '';
    if (!c) return '<span class="muted">not checked</span>';
    if (c.state === 'checking') return '<span class="muted">checking…</span>';
    if (c.state === 'failed') return `<span class="warn-text" title="${esc(when(c.checkedAt))}">${esc(c.error ?? 'Check failed')}</span>`;
    return `<strong>${c.pending}</strong>${c.pending ? ` <span class="muted">(${c.security} security)</span>` : ' <span class="muted">up to date</span>'}${c.rebootRequired ? ' · restart pending' : ''}
      <br><span class="muted">${esc(when(c.checkedAt))}</span>`;
  }

  function renderUpdates() {
    const f = st.fleet;
    const k = f.kpis;
    const rows = f.servers.filter(keep);
    const w = can('updates.write');
    const picked = [...st.picked].filter((v) => f.servers.some((s) => s.vmid === v && s.patchable));
    body().innerHTML = `
      <div class="updates-admin">
        <div class="kpi-row">
          <div class="kpi"><span class="muted small">Up to date (30 days)</span><strong>${k.patchable ? Math.round((k.ok / k.patchable) * 100) : 0}%</strong><span class="small muted">${k.ok} of ${k.patchable} servers</span></div>
          <div class="kpi"><span class="muted small">Never updated</span><strong>${k.never}</strong></div>
          <div class="kpi"><span class="muted small">Older than 30 days</span><strong>${k.stale}</strong></div>
          <div class="kpi"><span class="muted small">Last run failed</span><strong>${k.failed}</strong></div>
          <div class="kpi"><span class="muted small">Runs this week</span><strong>${k.runsWeek}</strong><span class="small muted">${k.running} running now</span></div>
        </div>

        ${st.rollouts.length ? `
          <section aria-labelledby="ro-title" style="margin-bottom:20px">
            <h2 id="ro-title" class="h2">Rollouts</h2>
            ${st.rollouts.map((r) => `
              <div class="rollout" data-rollout="${r.id}">
                <div class="rollout-head">
                  <div><strong>${esc(r.name)}</strong> ${tag(RO, r.state)} <span class="small muted">${esc(r.scope)} updates${r.snapshot ? ', snapshot first' : ''} · stops above ${r.maxFailPct} % failed${r.window ? ` · window ${esc(r.window.text)}` : ''} · ${esc(when(r.createdAt))}</span>
                    ${r.reason ? `<p class="small warn-text" style="margin:4px 0 0">${esc(r.reason)}</p>` : ''}</div>
                  <div class="row">
                    ${w && r.state === 'running' ? '<button class="btn" data-ro="pause">Pause</button>' : ''}
                    ${w && r.state === 'paused' ? '<button class="btn primary" data-ro="resume">Resume</button>' : ''}
                    ${w && ['running', 'paused'].includes(r.state) ? '<button class="btn danger" data-ro="cancel">Cancel</button>' : ''}
                    <button class="btn" data-ro-toggle>${st.open === r.id ? 'Hide servers' : 'Servers'}</button>
                  </div>
                </div>
                <div class="rings">${r.rings.map((g) => `
                  <div class="ring"><span class="small muted">Ring ${g.ring} · ${g.total} server${g.total === 1 ? '' : 's'}</span>
                    <span class="ring-bar" aria-label="${g.done} done, ${g.failed} failed, ${g.skipped} skipped, ${g.running} running, ${g.pending} waiting">
                      ${['done', 'failed', 'skipped', 'running'].map((s) => (g[s] ? `<i class="seg-${s}" style="flex:${g[s]}"></i>` : '')).join('')}${g.pending ? `<i class="seg-pending" style="flex:${g.pending}"></i>` : ''}</span>
                    <span class="small">${g.done} done${g.failed ? `, ${g.failed} failed` : ''}${g.skipped ? `, ${g.skipped} skipped` : ''}${g.running ? `, ${g.running} running` : ''}</span></div>`).join('')}
                </div>
                ${st.open === r.id ? `
                  <div class="table-wrap"><table class="table">
                    <thead><tr><th>Server</th><th>Ring</th><th>State</th><th>Note</th></tr></thead>
                    <tbody>${r.items.map((i) => `<tr><td>${esc(i.name)} <span class="mono muted small">${i.vmid}</span></td><td>${i.ring}</td><td>${tag(ITEM, i.state)}</td><td class="small">${esc(i.note ?? '')}</td></tr>`).join('')}</tbody>
                  </table></div>` : ''}
              </div>`).join('')}
          </section>` : ''}

        <div class="row" style="margin-bottom:10px">
          ${w ? `<button class="btn" data-check-picked ${picked.length ? '' : 'disabled'}>Check now${picked.length ? ` (${picked.length})` : ''}</button>` : ''}
          <div class="segmented" role="radiogroup" aria-label="Show">
            ${[['all', 'All'], ['never', 'Never updated'], ['stale', 'Older than 30 days'], ['failed', 'Failed'], ['running', 'Running'], ['windows', 'Windows'], ['linux', 'Linux']].map(([v, l]) =>
              `<button role="radio" aria-checked="${st.fleetFilter === v}" data-fleet-filter="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="table-wrap"><table class="table fleet-table">
          <thead><tr>${w ? `<th><input type="checkbox" data-pick-all aria-label="Select all shown" ${rows.filter((s) => s.patchable).every((s) => st.picked.has(s.vmid)) && rows.some((s) => s.patchable) ? 'checked' : ''}></th>` : ''}
            <th>Server</th><th>Customer</th><th>OS</th><th>Power</th><th>Last run</th><th>Pending</th><th>State</th></tr></thead>
          <tbody>${rows.map((s) => `
            <tr data-fleet="${s.vmid}">
              ${w ? `<td>${s.patchable ? `<input type="checkbox" data-pick aria-label="Select ${esc(s.name)}" ${st.picked.has(s.vmid) ? 'checked' : ''}>` : ''}</td>` : ''}
              <td>${esc(s.name)} <span class="mono muted small">${s.vmid}</span></td><td class="small">${esc(s.email)}</td>
              <td>${esc(s.os === 'windows' ? 'Windows' : s.os === 'linux' ? 'Linux' : s.os === 'container' ? 'Container' : 'Other')}</td>
              <td class="small">${esc(s.status)}${s.expired ? ' · expired' : ''}</td>
              <td class="small">${s.lastRun ? `${esc(when(s.lastRun.finishedAt ?? s.lastRun.startedAt))}${s.lastRun.state === 'done' ? ` · ${s.lastRun.installed} installed` : ''}${s.lastRun.rebootRequired ? ' · restart needed' : ''}` : '<span class="muted">never</span>'}</td>
              <td class="small">${pendingCell(s)}</td>
              <td>${s.patchable ? tag(FLAG, s.flag) : '<span class="small muted">not through the panel</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No servers here.</td></tr>'}
          </tbody></table></div>

        ${w ? `
          <section class="security-card settings-card" style="margin-top:20px;max-width:1100px;display:grid">
            <h2 class="twofa-title">Plan a rollout</h2>
            <p class="muted">Installs updates on the selected servers ring by ring, with the same checks as when a customer starts them.
              The next ring starts only when the previous one is finished and no more than the failure limit failed; otherwise the
              rollout pauses for you. Customers are told by email when their server is updated.</p>
            <form id="rollout-form" class="email-form" novalidate>
              <div class="grid-3">
                <label>Name <input name="name" maxlength="80" placeholder="October security updates" required></label>
                <label>Rings <select name="rings">${RINGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
                <label>Updates <select name="scope"><option value="security">Security only</option><option value="all">All</option></select></label>
                <label>Stop above (% failed) <input name="maxFailPct" type="number" min="0" max="50" value="2"></label>
              </div>
              <div class="row">
                <label class="inline-check"><input type="checkbox" name="snapshot" checked> Snapshot first</label>
                <label class="inline-check"><input type="checkbox" name="autoRestart" checked> Restart when needed</label>
                <label class="inline-check"><input type="checkbox" name="useWindow"> Only in a maintenance window</label>
              </div>
              <fieldset class="window-fields" data-window hidden>
                <legend class="small muted">Runs start only on these days, between these hours (${esc(st.fleet.timeZone ?? 'panel time zone')}); started runs finish.</legend>
                <div class="row">${DAYS.map((d, i) => `<label class="inline-check"><input type="checkbox" name="day" value="${i}" ${i === 0 || i === 6 ? 'checked' : ''}> ${d}</label>`).join('')}</div>
                <div class="grid-3">
                  <label>From <select name="winStart">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 1 ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
                  <label>Until <select name="winEnd">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 5 ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
                </div>
              </fieldset>
              <div class="row"><button class="btn primary" ${picked.length ? '' : 'disabled'}>Start rollout on ${picked.length} server${picked.length === 1 ? '' : 's'}</button>
                ${picked.length ? '' : '<span class="small muted">Select servers in the list above.</span>'}</div>
            </form>
          </section>` : ''}
      </div>`;
  }

  async function onClick(e, tab) {
    const t = e.target.closest('button, input[type=checkbox]');
    if (!t) return false;
    try {
      if (t.dataset.jobFilter) { st.filter = t.dataset.jobFilter; await load('jobs'); render('jobs'); return true; }
      if (t.hasAttribute('data-open-rollouts')) { root.querySelector('[data-admin-tab="updates"]')?.click(); return true; }
      if (t.hasAttribute('data-check-picked')) {
        const vmids = [...st.picked].filter((v) => st.fleet.servers.some((s) => s.vmid === v && s.patchable));
        const r = await api('/api/admin/updates/check', { method: 'POST', body: { vmids } });
        toast(`Checking ${r.queued} server${r.queued === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already being checked)` : ''}; nothing is installed`);
        await load('updates'); render('updates'); return true;
      }
      if (t.hasAttribute('data-job-retry')) {
        const job = st.jobs.jobs.find((x) => x.id === t.closest('[data-job]').dataset.job);
        if (!(await confirmAction(`${RETRY[job.retry][0]} for ${job.target}?`, RETRY[job.retry][0]))) return true;
        t.disabled = true;
        const r = await api('/api/admin/jobs/retry', { method: 'POST', body: { id: job.id } });
        toast(r.message);
        await load('jobs'); render('jobs'); return true;
      }
      if (t.dataset.fleetFilter) { st.fleetFilter = t.dataset.fleetFilter; render('updates'); return true; }
      if (t.hasAttribute('data-pick')) {
        const v = Number(t.closest('[data-fleet]').dataset.fleet);
        if (t.checked) st.picked.add(v); else st.picked.delete(v);
        render('updates'); return true;
      }
      if (t.hasAttribute('data-pick-all')) {
        for (const s of st.fleet.servers.filter(keep).filter((x) => x.patchable)) { if (t.checked) st.picked.add(s.vmid); else st.picked.delete(s.vmid); }
        render('updates'); return true;
      }
      const ro = t.closest('[data-rollout]');
      if (ro && t.hasAttribute('data-ro-toggle')) { const id = Number(ro.dataset.rollout); st.open = st.open === id ? null : id; render('updates'); return true; }
      if (ro && t.dataset.ro) {
        const r = st.rollouts.find((x) => x.id === Number(ro.dataset.rollout));
        const ask = { pause: `Pause ${r.name}? Runs already started finish; no new ones start.`, resume: `Resume ${r.name}?${r.reason ? ' The next ring starts despite the failures.' : ''}`,
          cancel: `Cancel ${r.name}? Servers still waiting are skipped; runs already started finish.` }[t.dataset.ro];
        if (!(await confirmAction(ask, t.textContent.trim()))) return true;
        await api(`/api/admin/updates/rollouts/${r.id}/${t.dataset.ro}`, { method: 'POST' });
        toast(`Rollout ${t.dataset.ro === 'cancel' ? 'cancelled' : t.dataset.ro === 'pause' ? 'paused' : 'resumed'}`);
        await load('updates'); render('updates'); return true;
      }
    } catch (err) { fail(err); return true; }
    return false;
  }

  async function onSubmit(e) {
    const f = e.target;
    if (f.getAttribute('id') !== 'rollout-form') return;
    const el = f.elements;
    const vmids = [...st.picked].filter((v) => st.fleet.servers.some((s) => s.vmid === v && s.patchable));
    if (!el.name.value.trim()) { el.name.reportValidity(); return; }
    if (!(await confirmAction(`Install ${el.scope.value === 'all' ? 'all' : 'security'} updates on ${vmids.length} server${vmids.length === 1 ? '' : 's'}? Their customers are told by email.`, 'Start rollout'))) return;
    try {
      await api('/api/admin/updates/rollouts', { method: 'POST', body: {
        name: el.name.value.trim(), vmids, rings: el.rings.value.split(',').map(Number), scope: el.scope.value,
        snapshot: el.snapshot.checked, autoRestart: el.autoRestart.checked, maxFailPct: Number(el.maxFailPct.value),
        window: el.useWindow.checked ? { days: [...f.querySelectorAll('[name=day]:checked')].map((x) => Number(x.value)), start: Number(el.winStart.value), end: Number(el.winEnd.value) } : null,
      } });
      st.picked.clear();
      toast('Rollout started');
      await load('updates'); render('updates');
    } catch (err) { fail(err); }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onSubmit,
    onChange(e) {
      if (e.target.name === 'useWindow') root.querySelector('[data-window]').hidden = !e.target.checked;
    },
  };
}
