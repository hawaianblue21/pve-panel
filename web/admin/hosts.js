// Admin portal: the Overview dashboard (first tab) and the Hosts tab (Proxmox
// nodes, maintenance mode). Same shape as desk.js and the other tab modules.

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const gib = (b) => (b >= 2 ** 40 ? `${(b / 2 ** 40).toFixed(1)} TB` : `${Math.round(b / 2 ** 30)} GB`);
const pc = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const up = (s) => (s >= 86_400 ? `${Math.floor(s / 86_400)} d` : s >= 3600 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 60)} min`);
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`;
};
const utc = (d) => new Date(/Z|[+-]\d\d:?\d\d$/.test(d) ? d : `${String(d).replace(' ', 'T')}Z`);

export function createHosts({ root, api, toast, fail, confirmAction, promptText, esc, labels, openTab }) {
  const st = { perms: new Set(), dash: null, hosts: null };
  const can = (p) => !p || st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['overview', 'Overview', null], ['hosts', 'Hosts', 'servers.read']];

  async function load(tab) {
    if (tab === 'overview') st.dash = await api('/api/admin/dashboard');
    if (tab === 'hosts') st.hosts = await api('/api/admin/hosts');
  }
  function render(tab) {
    if (tab === 'overview') renderOverview();
    if (tab === 'hosts') renderHosts();
  }

  const meter = (used, total, warnAt = 85) => {
    const p = pc(used, total);
    return `<span class="meter ${p >= warnAt ? 'meter-warn' : ''}" aria-hidden="true"><i style="width:${Math.min(100, p)}%"></i></span>`;
  };
  const statusTag = (n) => (!n.online ? '<span class="tag bad">Unreachable</span>' : n.maintenance ? '<span class="tag warn">Maintenance</span>' : '<span class="tag ok">Online</span>');

  function nodeRows(nodes, { actions = false } = {}) {
    return nodes.map((n) => `
      <tr data-node="${esc(n.node)}" class="${!n.online ? 'row-attention' : ''}">
        <td><strong>${esc(n.node)}</strong>${n.datacenter ? `<br><span class="small muted">${esc(n.datacenter)}</span>` : ''}</td>
        <td>${statusTag(n)}${n.stale && n.lastSeen ? `<br><span class="small muted">last data ${esc(ago(n.lastSeen))}</span>` : ''}${n.note ? `<br><span class="small muted">${esc(n.note)}</span>` : ''}</td>
        <td class="num">${n.cores != null ? `${Math.round((n.cpu ?? 0) * 100)}%<br><span class="small muted">${n.cores} cores</span>` : '·'}</td>
        <td>${n.memTotal ? `${meter(n.memUsed, n.memTotal)}<span class="small">${gib(n.memUsed)} / ${gib(n.memTotal)}</span>` : '·'}</td>
        <td>${(n.storage ?? []).map((s) => `<div>${meter(s.used, s.total)}<span class="small"><span class="mono">${esc(s.storage)}</span> ${gib(s.used)} / ${gib(s.total)}${s.shared ? ' · shared' : ''}</span></div>`).join('') || '·'}</td>
        <td class="num">${n.running} / ${n.guests}</td>
        ${actions ? `
          <td class="small">${n.pveVersion ? `PVE ${esc(n.pveVersion)}` : ''}${n.kernel ? `<br><span class="muted mono">${esc(n.kernel)}</span>` : ''}${n.uptime && n.online ? `<br><span class="muted">up ${up(n.uptime)}</span>` : ''}</td>
          <td>${can('hosts.write') ? `<div class="row end">${n.maintenance ? '<button class="btn" data-maint-off>End maintenance</button>' : '<button class="btn" data-maint-on>Maintenance…</button>'}</div>` : ''}</td>` : ''}
      </tr>`).join('');
  }

  // ---- Overview ------------------------------------------------------------------------
  function renderOverview() {
    const d = st.dash;
    const k = d.kpis;
    const tiles = [];
    if (k.guests) tiles.push(['Guests', k.guests.total, `${k.guests.running} running · ${k.guests.total - k.guests.running} stopped`, 'servers']);
    if (k.nodes) tiles.push(['Nodes online', `${k.nodes.online} / ${k.nodes.total}`, k.nodes.maintenance ? `${k.nodes.maintenance} in maintenance` : d.cluster ? (d.cluster.quorate ? 'cluster has quorum' : 'no quorum') : '', 'hosts', k.nodes.online < k.nodes.total]);
    if (k.billing) tiles.push(['Revenue this month', rp(k.billing.revenueMonth), `${rp(k.billing.unpaid)} unpaid`, 'billing']);
    if (k.billing) tiles.push(['Overdue invoices', k.billing.overdue, k.billing.overdue ? `${rp(k.billing.overdueAmount)} outstanding` : 'none', 'billing', k.billing.overdue > 0]);
    if (k.tickets) tiles.push(['Open tickets', k.tickets.open, `${k.tickets.unassigned} unassigned${k.tickets.urgent ? ` · ${k.tickets.urgent} urgent` : ''}`, 'tickets', k.tickets.urgent > 0]);
    if (k.publicIps) tiles.push(['Public IPv4', `${k.publicIps.assigned} / ${k.publicIps.total}`, `${k.publicIps.free} free`, 'ipam']);
    body().innerHTML = `
      <div class="overview">
        <p class="muted small">Data as of ${esc(new Date(d.generatedAt).toLocaleString())} <button class="link-btn" data-overview-refresh>Refresh</button></p>
        <div class="kpi-row">
          ${tiles.map(([label, value, sub, tab, warn]) => `
            <button class="kpi kpi-link" data-open-tab="${tab}" ${labels.has(tab) ? '' : 'disabled'}>
              <span class="muted small">${esc(label)}</span><strong>${esc(value)}</strong><span class="small ${warn ? 'warn-text' : 'muted'}">${esc(sub)}</span></button>`).join('')}
        </div>
        <div class="overview-grid">
          ${d.nodes ? `
            <section aria-labelledby="ov-nodes">
              <div class="section-head" style="margin-top:0"><h2 id="ov-nodes">Nodes</h2></div>
              <div class="table-wrap"><table class="table node-table">
                <thead><tr><th>Node</th><th>Status</th><th class="num">CPU</th><th>Memory</th><th>Storage</th><th class="num">Guests</th></tr></thead>
                <tbody>${nodeRows(d.nodes)}</tbody></table></div>
            </section>` : ''}
          <aside class="overview-side">
            <section aria-labelledby="ov-alerts">
              <h2 id="ov-alerts">Alerts <span class="count">${d.alerts.length}</span></h2>
              ${d.alerts.length ? `<ul class="alert-list">${d.alerts.map((a) => `
                <li class="alert-${a.level}">${a.tab && labels.has(a.tab) ? `<button class="link-btn" data-open-tab="${a.tab}">${esc(a.title)}</button>` : `<strong>${esc(a.title)}</strong>`}
                  <span class="small muted">${esc(a.sub ?? '')}</span></li>`).join('')}</ul>` : '<p class="muted small">Nothing needs attention.</p>'}
            </section>
            ${d.activity ? `
              <section aria-labelledby="ov-activity">
                <h2 id="ov-activity">Latest activity</h2>
                <ul class="activity-mini">${d.activity.map((e) => `
                  <li><span>${esc(labels.action(e.action))}${e.vmid ? ` <span class="mono muted">${e.vmid}</span>` : ''}${e.email ? ` <span class="muted">· ${esc(e.email)}</span>` : ''}</span>
                    <span class="small muted nowrap">${esc(ago(utc(e.createdAt).toISOString()))}</span></li>`).join('')}</ul>
                <button class="link-btn" data-open-tab="activity">All activity</button>
              </section>` : ''}
          </aside>
        </div>
      </div>`;
  }

  // ---- Hosts ------------------------------------------------------------------------------
  function renderHosts() {
    const h = st.hosts;
    body().innerHTML = `
      <div class="hosts">
        ${h.cluster ? `<p>${h.cluster.quorate ? '<span class="tag ok">Quorum</span>' : '<span class="tag bad">No quorum</span>'}
          Cluster <strong>${esc(h.cluster.name)}</strong> · ${h.cluster.nodes} node${h.cluster.nodes === 1 ? '' : 's'}</p>` : ''}
        <p class="muted small">Maintenance mode keeps new servers off a node (they go to another node of its datacenter); servers
          already on it keep running. Datacenters and their nodes are set under <button class="link-btn" data-open-tab="resources">Resources</button>.</p>
        <div class="table-wrap"><table class="table node-table">
          <thead><tr><th>Node</th><th>Status</th><th class="num">CPU</th><th>Memory</th><th>Storage</th><th class="num">Guests</th><th>Version</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${nodeRows(h.nodes, { actions: true })}</tbody></table></div>
      </div>`;
  }

  async function onClick(e, tab) {
    const t = e.target.closest('button');
    if (!t) return false;
    if (t.dataset.openTab) { openTab(t.dataset.openTab); return true; }
    if (t.hasAttribute('data-overview-refresh')) { try { await load('overview'); renderOverview(); } catch (err) { fail(err); } return true; }
    const node = t.closest('[data-node]')?.dataset.node;
    if (tab === 'hosts' && node && (t.hasAttribute('data-maint-on') || t.hasAttribute('data-maint-off'))) {
      const on = t.hasAttribute('data-maint-on');
      let note = null;
      if (on) {
        note = await promptText(`Put ${node} into maintenance? New servers are placed on other nodes; running servers stay.`, { hint: 'Optional note, e.g. RAM upgrade until 18:00', okLabel: 'Start maintenance' });
        if (note === null) return true;
      } else if (!(await confirmAction(`End maintenance on ${node}? New servers can be placed there again.`, 'End maintenance'))) {
        return true;
      }
      try {
        await api(`/api/admin/hosts/${encodeURIComponent(node)}/maintenance`, { method: 'PUT', body: { maintenance: on, ...(note ? { note } : {}) } });
        toast(on ? `${node} is in maintenance` : `${node} takes new servers again`);
        await load('hosts'); renderHosts();
      } catch (err) { fail(err); }
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
