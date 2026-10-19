// Admin portal: public IPv4 pools (optionally with an IPv6 prefix) and addresses (IPAM), and IPAM settings with
// optional PowerDNS for reverse DNS. Same shape as desk.js, billing.js, volumes.js.

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const STATES = [['', 'All'], ['free', 'Free'], ['assigned', 'Assigned'], ['reserved', 'Reserved'], ['cooldown', 'Cooling down'], ['held', 'Held']];
const TAG = { free: '', assigned: 'ok', reserved: '', cooldown: 'warn', held: 'warn' };

export function createIpam({ root, api, toast, fail, confirmAction, promptText, esc }) {
  const st = { perms: new Set(), data: null, dcs: [], pool: null, addresses: null, filter: { state: '', q: '' }, adding: false };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['ipam', 'Public IPs', 'network.read']];

  async function loadAddresses() {
    const p = new URLSearchParams();
    if (st.filter.state) p.set('state', st.filter.state);
    if (st.filter.q) p.set('q', st.filter.q);
    st.addresses = await api(`/api/admin/ipam/pools/${st.pool}/addresses?${p}`);
  }
  async function load() {
    [st.data, st.dcs] = await Promise.all([api('/api/admin/ipam'), api('/api/admin/datacenters').catch(() => [])]);
    if (st.pool && !st.data.pools.some((p) => p.id === st.pool)) st.pool = null;
    if (st.pool) await loadAddresses();
  }

  function poolForm(p = null) {
    const v = (x) => esc(x ?? '');
    return `
      <form id="ipam-pool-form" class="email-form" data-pool-id="${p?.id ?? ''}" novalidate>
        <div class="grid-3">
          <label>Name <input name="name" maxlength="60" value="${v(p?.name)}" placeholder="Jakarta public A" required></label>
          <label>Subnet <input name="cidr" value="${v(p?.cidr)}" placeholder="203.0.113.0/26" ${p ? 'disabled' : 'required'} spellcheck="false"></label>
          <label>Gateway <input name="gateway" value="${v(p?.gateway)}" placeholder="203.0.113.1" required spellcheck="false"></label>
          <label>Bridge <input name="bridge" value="${v(p?.bridge)}" placeholder="vmbr1" required spellcheck="false"></label>
          <label>VLAN tag <span class="hint">optional</span><input name="vlan" type="number" min="1" max="4094" value="${v(p?.vlan)}"></label>
          <label>DNS servers <span class="hint">optional</span><input name="dns" value="${v(p?.dns?.join(', '))}" placeholder="1.1.1.1, 8.8.8.8" spellcheck="false"></label>
          <label>Datacenter <select name="datacenterId"><option value="">Any</option>
            ${st.dcs.map((d) => `<option value="${d.id}" ${p?.datacenterId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
          <label>Price per address / month (Rp) <input name="priceMonthly" type="number" min="0" step="1000" value="${v(p?.priceMonthly ?? 0)}"></label>
          <label>Reverse zone <span class="hint">for PowerDNS</span><input name="reverseZone" value="${v(p?.reverseZone)}" placeholder="113.0.203.in-addr.arpa" spellcheck="false"></label>
        </div>
        <h3 class="h3">IPv6 <span class="hint">optional: each address of the subnet gets its own /64 of this prefix</span></h3>
        ${p?.ipv6On ? `<p class="hint">${p.ipv6On} server${p.ipv6On === 1 ? ' uses' : 's use'} IPv6 from this pool: the prefix and gateway are locked.</p>` : ''}
        <div class="grid-3">
          <label>IPv6 prefix <input name="ipv6Cidr" value="${v(p?.ipv6?.cidr)}" placeholder="2001:db8:100::/56" spellcheck="false" ${p?.ipv6On ? 'disabled' : ''}></label>
          <label>IPv6 gateway <input name="ipv6Gateway" value="${v(p?.ipv6?.gateway ?? (p?.ipv6 ? '' : 'fe80::1'))}" placeholder="fe80::1" spellcheck="false" ${p?.ipv6On ? 'disabled' : ''}></label>
          <label>Price per /64 / month (Rp) <input name="ipv6PriceMonthly" type="number" min="0" step="1000" value="${v(p?.ipv6?.priceMonthly ?? 0)}"></label>
          <label>IPv6 reverse zone <span class="hint">for PowerDNS</span><input name="ipv6ReverseZone" value="${v(p?.ipv6?.reverseZone)}" placeholder="0.0.1.0.8.b.d.0.1.0.0.2.ip6.arpa" spellcheck="false"></label>
        </div>
        <div class="row"><button class="btn primary">${p ? 'Save pool' : 'Add pool'}</button>
          <button type="button" class="btn" data-ipam-cancel>Cancel</button></div>
      </form>`;
  }

  function render() {
    if (st.pool) return renderPool();
    const d = st.data;
    const s = d.settings;
    const w = can('ipam.write');
    body().innerHTML = `
      <div class="ipam-admin">
        ${s.enabled ? '' : '<div class="notice warn"><p>Public IPs are switched off: customers can\'t add addresses. Assigned addresses keep working.</p></div>'}
        <div class="section-head" style="margin-top:0"><h2>Pools</h2>
          ${w && !st.adding ? '<button class="btn" data-ipam-add>Add pool</button>' : ''}</div>
        ${st.adding ? `<section class="security-card settings-card" style="max-width:1100px;display:grid">${poolForm()}</section>` : ''}
        ${d.pools.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Pool</th><th>Subnet</th><th>Bridge</th><th>Datacenter</th><th class="num">Free</th><th class="num">Assigned</th><th class="num">Other</th><th class="num">Per address</th></tr></thead>
            <tbody>${d.pools.map((p) => `
              <tr data-ipam-pool="${p.id}" tabindex="0">
                <td><strong>${esc(p.name)}</strong></td><td class="mono">${esc(p.cidr)} <span class="muted small">gw ${esc(p.gateway)}</span>${p.ipv6 ? `<br><span class="small">${esc(p.ipv6.cidr)}</span> <span class="muted small">${p.ipv6On} on</span>` : ''}</td>
                <td class="mono">${esc(p.bridge)}${p.vlan ? ` · tag ${p.vlan}` : ''}</td><td>${esc(p.datacenter ?? 'Any')}</td>
                <td class="num">${p.free}</td><td class="num">${p.assigned}</td>
                <td class="num">${p.reserved + p.cooldown + p.held}${p.held ? ' <span class="tag warn">held</span>' : ''}</td><td class="num">${rp(p.priceMonthly)}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No pools yet. Add the public subnets routed to your Proxmox hosts.</p>'}

        <section class="security-card settings-card" style="margin-top:20px;max-width:1100px;display:grid">
          <div class="settings-head">
            <h2 class="twofa-title">Settings <span class="pill ${s.enabled ? 'pill-running' : ''}">${s.enabled ? 'On' : 'Off'}</span></h2>
            <p class="muted">A public address becomes a second network card on the pool's bridge. VMs with cloud-init get it at
              the next restart, containers at once; other VMs are set up by the customer. The Proxmox firewall IP filter lets
              each card use only its own address. Released addresses cool down before they are handed out again.</p>
          </div>
          <form id="ipam-settings" class="email-form" novalidate>
            <div class="grid-3">
              <label>Addresses per server <input name="maxPerServer" type="number" min="1" max="7" value="${esc(s.maxPerServer)}" ${w ? '' : 'disabled'}></label>
              <label>Cool-down (hours) <input name="cooldownHours" type="number" min="0" max="2160" value="${esc(s.cooldownHours)}" ${w ? '' : 'disabled'}></label>
            </div>
            <h3 class="h3">Reverse DNS (PowerDNS, optional)</h3>
            <div class="grid-3">
              <label>API address <input name="pdnsUrl" value="${esc(s.powerdns.url)}" placeholder="http://dns.internal:8081" spellcheck="false" ${w ? '' : 'disabled'}></label>
              <label>API key <input name="pdnsKey" type="password" autocomplete="new-password" placeholder="${s.powerdns.hasApiKey ? 'Stored; leave empty to keep it' : 'X-API-Key'}" ${w ? '' : 'disabled'}></label>
              <label>Server ID <input name="pdnsServer" value="${esc(s.powerdns.serverId)}" ${w ? '' : 'disabled'}></label>
            </div>
            <p class="hint">Without PowerDNS, customers' reverse DNS names are stored and shown here for you to publish.</p>
            <h3 class="h3">IPv6 <span class="pill ${s.ipv6Enabled ? 'pill-running' : ''}">${s.ipv6Enabled ? 'On' : 'Off'}</span></h3>
            <p class="hint">With IPv6 on, customers can switch on a /64 for each public address whose pool has an IPv6 prefix.
              Switched off here, nobody can switch it on; servers that have it keep it until their owner switches it off.
              Your router must deliver every /64 on the pool's bridge (the prefix on-link, or a route per /64).</p>
            ${w ? `<div class="row"><label class="inline-check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Customers can add public addresses</label>
              <label class="inline-check"><input type="checkbox" name="ipv6Enabled" ${s.ipv6Enabled ? 'checked' : ''}> Customers can switch IPv6 on</label>
              <button class="btn primary">Save</button></div>` : ''}
          </form>
        </section>
      </div>`;
  }

  function renderPool() {
    const p = st.data.pools.find((x) => x.id === st.pool);
    const w = can('ipam.write');
    body().innerHTML = `
      <div class="ipam-admin">
        <button class="link-btn back-link" data-ipam-back>‹ All pools</button>
        <div class="section-head" style="margin-top:6px"><h2>${esc(p.name)} <span class="mono muted small">${esc(p.cidr)}</span></h2>
          ${w ? `<div class="row"><button class="btn" data-ipam-edit>Edit</button><button class="btn danger" data-ipam-delete>Delete pool</button></div>` : ''}</div>
        ${st.editing ? `<section class="security-card settings-card" style="max-width:1100px;display:grid">${poolForm(p)}</section>` : ''}
        <div class="kpi-row">
          ${[['Free', p.free], ['Assigned', p.assigned], ['Reserved', p.reserved], ['Cooling down', p.cooldown], ['Held', p.held]].map(([l, n]) => `<div class="kpi"><span class="muted small">${l}</span><strong>${n}</strong></div>`).join('')}
        </div>
        <form id="ipam-filter" class="row" role="search" style="margin-bottom:10px">
          <div class="segmented" role="radiogroup" aria-label="State">
            ${STATES.map(([v, l]) => `<button type="button" role="radio" aria-checked="${st.filter.state === v}" data-ipam-state="${v}">${l}</button>`).join('')}
          </div>
          <label class="sr-only" for="ipam-q">Search</label>
          <input id="ipam-q" name="q" type="search" value="${esc(st.filter.q)}" placeholder="Address, customer, server, reverse DNS" style="max-width:280px">
          <button class="btn">Search</button>
        </form>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Address</th><th>State</th><th>Customer</th><th>Server</th><th>Reverse DNS</th><th>Note</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${st.addresses.map((a) => `
            <tr data-ipam-address="${a.id}">
              <td class="mono">${esc(a.address)}${a.ipv6 ? `<br><span class="small">${esc(a.ipv6.prefix)}</span>` : ''}</td><td><span class="tag ${TAG[a.state]}">${esc(STATES.find(([v]) => v === a.state)?.[1] ?? a.state)}</span></td>
              <td>${esc(a.email ?? '')}</td><td>${a.vmid ? `${esc(a.server ?? '')} <span class="mono muted small">${a.vmid}${a.nic ? ` · ${esc(a.nic)}` : ''}</span>` : ''}</td>
              <td class="mono small">${esc(a.ptr ?? '')}${a.ipv6?.ptr ? `<br>${esc(a.ipv6.ptr)}` : ''}</td><td class="small">${esc(a.note ?? '')}${a.state === 'cooldown' && a.releasedAt ? `released ${esc(new Date(a.releasedAt).toLocaleString())}` : ''}</td>
              <td><div class="row end">${w && a.address !== p.gateway ? (a.state === 'free' || a.state === 'cooldown' ? '<button class="btn" data-ipam-reserve>Reserve</button>'
                : ['reserved', 'cooldown', 'held'].includes(a.state) ? '<button class="btn" data-ipam-free>Make free</button>' : '') : ''}</div></td>
            </tr>`).join('') || '<tr><td colspan="7" class="muted">No addresses match.</td></tr>'}
          </tbody></table></div>
      </div>`;
  }

  // ---- events --------------------------------------------------------------------
  const go = async (fn, msg) => { try { await fn(); if (msg) toast(msg); await load(); render(); } catch (err) { fail(err); } };

  async function onClick(e) {
    const row = e.target.closest('[data-ipam-pool]');
    if (row && !e.target.closest('button')) { st.pool = Number(row.dataset.ipamPool); st.editing = false; await go(() => {}); return true; }
    const t = e.target.closest('button');
    if (!t) return false;
    if (t.hasAttribute('data-ipam-add')) { st.adding = true; render(); return true; }
    if (t.hasAttribute('data-ipam-cancel')) { st.adding = false; st.editing = false; render(); return true; }
    if (t.hasAttribute('data-ipam-back')) { st.pool = null; st.editing = false; await go(() => {}); return true; }
    if (t.hasAttribute('data-ipam-edit')) { st.editing = true; render(); return true; }
    if (t.dataset.ipamState !== undefined) { st.filter.state = t.dataset.ipamState; await go(() => {}); return true; }
    if (t.hasAttribute('data-ipam-delete')) {
      const p = st.data.pools.find((x) => x.id === st.pool);
      if (!(await confirmAction(`Delete the pool ${p.name} (${p.cidr})? Only possible while no address is assigned or held.`, 'Delete pool'))) return true;
      await go(async () => { await api(`/api/admin/ipam/pools/${p.id}`, { method: 'DELETE' }); st.pool = null; }, 'Pool deleted');
      return true;
    }
    const addr = t.closest('[data-ipam-address]');
    if (addr && t.hasAttribute('data-ipam-reserve')) {
      const note = await promptText('Reserve this address: what is it for?', { hint: 'e.g. Router, a customer\'s own equipment', okLabel: 'Reserve' });
      if (note === null) return true;
      await go(() => api(`/api/admin/ipam/addresses/${addr.dataset.ipamAddress}`, { method: 'PUT', body: { state: 'reserved', note } }), 'Address reserved');
      return true;
    }
    if (addr && t.hasAttribute('data-ipam-free')) {
      const a = st.addresses.find((x) => x.id === Number(addr.dataset.ipamAddress));
      const warn = a.state === 'held' ? ' It was on a server that left the panel: make sure it is no longer configured there.' : '';
      if (!(await confirmAction(`Make ${a.address} free for customers again?${warn}`, 'Make free'))) return true;
      await go(() => api(`/api/admin/ipam/addresses/${a.id}`, { method: 'PUT', body: { state: 'free' } }), `${a.address} is free`);
      return true;
    }
    return false;
  }

  function onChange() {}

  async function onSubmit(e) {
    const f = e.target;
    const el = f.elements;
    if (f.getAttribute('id') === 'ipam-filter') { st.filter.q = el.q.value.trim(); await go(() => {}); return; }
    if (f.getAttribute('id') === 'ipam-pool-form') {
      const id = f.dataset.poolId;
      const b = {
        name: el.name.value.trim(), gateway: el.gateway.value.trim(), bridge: el.bridge.value.trim(),
        vlan: el.vlan.value ? Number(el.vlan.value) : null, dns: el.dns.value.split(/[\s,]+/).filter(Boolean),
        datacenterId: el.datacenterId.value ? Number(el.datacenterId.value) : null, priceMonthly: Number(el.priceMonthly.value) || 0,
        reverseZone: el.reverseZone.value.trim(), ipv6PriceMonthly: Number(el.ipv6PriceMonthly.value) || 0, ipv6ReverseZone: el.ipv6ReverseZone.value.trim(),
      };
      if (!el.ipv6Cidr.disabled) { b.ipv6Cidr = el.ipv6Cidr.value.trim(); b.ipv6Gateway = el.ipv6Gateway.value.trim(); }
      if (!id) b.cidr = el.cidr.value.trim();
      await go(async () => {
        const p = await api(id ? `/api/admin/ipam/pools/${id}` : '/api/admin/ipam/pools', { method: id ? 'PUT' : 'POST', body: b });
        st.adding = false; st.editing = false;
        if (!id) st.pool = p.id;
      }, id ? 'Pool saved' : 'Pool added');
      return;
    }
    if (f.getAttribute('id') === 'ipam-settings') {
      const b = { enabled: el.enabled.checked, ipv6Enabled: el.ipv6Enabled.checked, maxPerServer: Number(el.maxPerServer.value), cooldownHours: Number(el.cooldownHours.value),
        powerdns: { url: el.pdnsUrl.value.trim(), serverId: el.pdnsServer.value.trim() || 'localhost' } };
      if (el.pdnsKey.value) b.powerdns.apiKey = el.pdnsKey.value;
      await go(() => api('/api/admin/settings/ipam', { method: 'PUT', body: b }), 'Public IP settings saved');
    }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange, onSubmit,
  };
}
