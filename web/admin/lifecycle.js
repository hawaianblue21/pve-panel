// Admin portal: the server lifecycle queue (Admin-Lifecycle design): every server
// with an end date, where it stands (ending soon, stopped in grace, deletion due,
// stopped and waiting for an administrator) and its next step, with extend and
// remove-date actions, "Check now" and the global pause of deletions.
// Same shape as plans.js: tabs(), handles(), load(), render(), onClick(), onChange(), onSubmit().

const STAGES = [
  ['all', 'With an end date', 'all'],
  ['soon', 'Ending in 7 days', 'soon'],
  ['grace', 'Stopped, in grace', 'grace'],
  ['due', 'Deletion due', 'due'],
  ['stopped', 'Need a decision', 'stopped'],
];
const TAG = { later: ['Later', ''], soon: ['Ending soon', 'warn'], grace: ['In grace', 'warn'], due: ['Deletion due', 'bad'], stopped: ['Stopped', 'bad'] };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function createLifecycle({ root, api, toast, fail, confirmAction, esc }) {
  const st = { perms: new Set(), data: null, filter: 'all' };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['lifecycle', 'Server lifecycle', 'servers.read']];

  async function load() { st.data = await api('/api/admin/expiry/queue'); }

  function render() {
    const d = st.data;
    const s = d.settings;
    const w = can('servers.manage');
    const items = d.items.filter((i) => st.filter === 'all' || i.stage === st.filter);
    body().innerHTML = `
      <div class="lifecycle">
        <div class="section-head" style="margin-top:0">
          <p class="muted" style="margin:0;max-width:80ch">End dates, reminders, stop and deletion of servers that are not renewed.
            Reminders ${s.reminderDays.length ? `${esc(s.reminderDays.join(' and '))} days before` : 'off'}; stopped at the end date; customer-created
            servers are deleted after ${s.graceDays} days of grace. Servers an administrator assigned are only stopped.</p>
          <div class="row">
            ${w ? '<button class="btn" data-lc-run>Check now</button>' : ''}
            ${can('settings.write') ? `<button class="btn ${s.pauseDeletions ? 'primary' : 'danger'}" data-lc-pause="${s.pauseDeletions ? 'off' : 'on'}">${s.pauseDeletions ? 'Resume deletions' : 'Pause all deletions'}</button>` : ''}
          </div>
        </div>
        ${s.pauseDeletions ? `<div class="notice warn" role="status"><p>Deletions are paused for everyone. Servers are still stopped at their end date, but nothing is deleted until you resume.${d.counts.due ? ` ${d.counts.due} server${d.counts.due === 1 ? ' is' : 's are'} waiting.` : ''}</p></div>` : ''}
        <div class="kpi-row">
          ${STAGES.map(([k, label]) => `<button type="button" class="kpi kpi-link" data-lc-filter="${k}" aria-pressed="${st.filter === k}">
            <span class="muted small">${label}</span><strong>${d.counts[k]}</strong></button>`).join('')}
        </div>
        ${items.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Server · customer</th><th>Source</th><th>End date</th><th>State</th><th>Next step</th><th>Sent</th>${w ? '<th><span class="sr-only">Actions</span></th>' : ''}</tr></thead>
            <tbody>${items.map((i) => `
              <tr data-lc="${i.vmid}">
                <td><strong>${esc(i.name)}</strong> <span class="mono muted small">${i.vmid}</span><br><span class="small muted">${esc(i.email)}</span></td>
                <td class="small">${esc(i.source)}${i.manual ? '<br><span class="muted">date set by hand</span>' : ''}</td>
                <td class="nowrap">${esc(day(i.expiresAt))}</td>
                <td><span class="tag ${TAG[i.stage][1]}">${TAG[i.stage][0]}</span>${i.autoRenew ? ' <span class="tag ok">auto-renew</span>' : ''}</td>
                <td class="small">${esc(i.next)}${i.nextAt ? `<br><span class="muted">${esc(day(i.nextAt))}</span>` : ''}</td>
                <td class="small muted">${esc(i.sent.join(', ') || 'nothing yet')}</td>
                ${w ? `<td><div class="row end">
                  <button class="btn" data-lc-extend="7">+7 days</button><button class="btn" data-lc-extend="30">+30 days</button>
                  <button class="btn ghost" data-lc-remove>Remove date</button></div></td>` : ''}
              </tr>`).join('')}
            </tbody></table></div>`
          : `<p class="muted">${st.filter === 'all' ? 'No server has an end date.' : 'No server in this state.'}</p>`}
        <p class="small muted">Nothing is deleted unless the customer was warned by email. Every stop, extension and deletion is in the activity log.
          ${can('settings.read') ? 'Reminder days and the grace period are set in <button class="linklike" data-admin-tab="settings">Settings</button>.' : ''}</p>
      </div>`;
  }

  const go = async (fn, msg) => { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); await load(); render(); } catch (err) { fail(err); } };

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t || t.dataset.adminTab) return false;
    if (t.dataset.lcFilter) { st.filter = t.dataset.lcFilter; render(); return true; }
    if (t.hasAttribute('data-lc-run')) {
      t.disabled = true;
      await go(() => api('/api/admin/expiry/run', { method: 'POST' }), (r) => {
        const n = (k) => r[k]?.length ?? 0;
        return `Checked: ${n('stopped')} stopped, ${n('deleted')} deleted, ${n('reminded')} reminded${n('errors') ? `, ${n('errors')} errors` : ''}`;
      });
      return true;
    }
    if (t.dataset.lcPause) {
      const on = t.dataset.lcPause === 'on';
      if (on && !(await confirmAction('Pause all deletions? Servers are still stopped at their end date, but none is deleted until you resume.', 'Pause deletions'))) return true;
      await go(() => api('/api/admin/settings/expiry', { method: 'PUT', body: { pauseDeletions: on } }), on ? 'Deletions paused' : 'Deletions resumed');
      return true;
    }
    const row = t.closest('[data-lc]');
    if (!row) return false;
    const item = st.data.items.find((i) => i.vmid === Number(row.dataset.lc));
    if (t.dataset.lcExtend) {
      const days = Number(t.dataset.lcExtend);
      await go(() => api(`/api/admin/vms/${item.vmid}/expiry`, { method: 'PUT', body: { extendDays: days } }), `${item.name} extended by ${days} days`);
      return true;
    }
    if (t.hasAttribute('data-lc-remove')) {
      if (!(await confirmAction(`Remove the end date of ${item.name}? It then runs without an end date${item.expiredAt ? ' and the customer can start it again' : ''}.`, 'Remove date'))) return true;
      await go(() => api(`/api/admin/vms/${item.vmid}/expiry`, { method: 'PUT', body: { expiresAt: null } }), `${item.name} has no end date any more`);
      return true;
    }
    return false;
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange() {}, onSubmit() {},
  };
}
