// Admin portal: block storage. Tiers (Proxmox storage, price per GB) and limits,
// and every customer's volumes. Same shape as desk.js and billing.js.

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;

export function createVolumes({ root, api, toast, fail, esc }) {
  const st = { perms: new Set(), data: null, q: '' };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['volumes', 'Block storage', 'storage.read']];

  async function load() { st.data = await api('/api/admin/volumes'); }

  function tierRow(t, i, w) {
    return `
      <tr data-tier-row>
        <td><input name="tierId" value="${esc(t.id)}" maxlength="20" pattern="[a-z0-9][a-z0-9-]*" aria-label="Tier ${i + 1} ID" ${w ? '' : 'disabled'} required></td>
        <td><input name="name" value="${esc(t.name)}" maxlength="40" aria-label="Tier ${i + 1} name" ${w ? '' : 'disabled'} required></td>
        <td><input name="storage" value="${esc(t.storage)}" maxlength="100" placeholder="system disk's" aria-label="Tier ${i + 1} Proxmox storage" ${w ? '' : 'disabled'}></td>
        <td><input name="pricePerGb" type="number" min="0" step="50" value="${esc(t.pricePerGb)}" aria-label="Tier ${i + 1} price per GB" ${w ? '' : 'disabled'}></td>
        <td><input name="description" value="${esc(t.description)}" maxlength="120" aria-label="Tier ${i + 1} description" ${w ? '' : 'disabled'}></td>
        <td>${w ? '<button type="button" class="icon-btn" data-tier-remove aria-label="Remove tier">✕</button>' : ''}</td>
      </tr>`;
  }

  function render() {
    const d = st.data;
    const s = d.settings;
    const w = can('storage.write');
    const q = st.q.toLowerCase();
    const rows = d.volumes.filter((v) => !q || `${v.email} ${v.label} ${v.server} ${v.vmid} ${v.volid}`.toLowerCase().includes(q));
    body().innerHTML = `
      <div class="volumes-admin">
        ${s.enabled ? '' : '<div class="notice warn"><p>Block storage is switched off: customers don\'t see it. Existing volumes stay attached and billed.</p></div>'}
        <div class="kpi-row">
          ${d.totals.map((t) => `<div class="kpi"><span class="muted small">${esc(t.name)}</span><strong>${t.gb} GB</strong><span class="small muted">${t.count} volume${t.count === 1 ? '' : 's'}</span></div>`).join('')}
        </div>

        <form id="volume-filter" class="row" role="search" style="margin-bottom:10px">
          <label class="sr-only" for="vol-q">Search</label>
          <input id="vol-q" name="q" type="search" value="${esc(st.q)}" placeholder="Customer, volume, server or Proxmox volume" style="max-width:320px">
          <button class="btn">Search</button>
        </form>
        ${rows.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Customer</th><th>Volume</th><th>Tier</th><th class="num">Size</th><th>Server</th><th>Proxmox volume</th><th class="num">Per month</th></tr></thead>
            <tbody>${rows.map((v) => `
              <tr><td>${esc(v.email)}</td><td><strong>${esc(v.label)}</strong></td><td>${esc(v.tierName)}</td><td class="num">${v.sizeGb} GB</td>
                <td>${esc(v.server)} <span class="muted small mono">${v.vmid}${v.node ? ` · ${esc(v.node)}` : ''}</span>
                  ${v.attached ? `<span class="tag">${esc(v.slot)}</span>` : '<span class="tag warn">detached</span>'}</td>
                <td class="mono small">${esc(v.volid)}</td><td class="num">${rp(v.monthly)}</td></tr>`).join('')}
            </tbody></table></div>` : `<p class="muted">${d.volumes.length ? 'No volumes match.' : 'No customer has a volume yet.'}</p>`}

        <section class="security-card settings-card" style="margin-top:20px">
          <div class="settings-head">
            <h2 class="twofa-title">Settings <span class="pill ${s.enabled ? 'pill-running' : ''}">${s.enabled ? 'On' : 'Off'}</span></h2>
            <p class="muted">Each tier puts volumes on a Proxmox storage that exists on the hosts of your customers' servers
              (empty: the storage of the server's system disk). Prices are per GB per month before tax and are billed with the
              server that holds the volume. Volumes count against the customer's disk limit and resource pool.</p>
          </div>
          <form id="volume-settings" class="email-form" novalidate>
            <div class="table-wrap"><table class="table tier-table">
              <thead><tr><th>ID</th><th>Name</th><th>Proxmox storage</th><th>Rp / GB / month</th><th>Description</th><th><span class="sr-only">Remove</span></th></tr></thead>
              <tbody>${s.tiers.map((t, i) => tierRow(t, i, w)).join('')}</tbody>
            </table></div>
            ${w ? '<div class="row"><button type="button" class="btn" data-tier-add>Add tier</button></div>' : ''}
            <div class="grid-3">
              <label>Largest volume (GB) <input name="maxSizeGb" type="number" min="1" value="${esc(s.maxSizeGb)}" ${w ? '' : 'disabled'}></label>
              <label>Volumes per server <input name="maxPerServer" type="number" min="1" max="30" value="${esc(s.maxPerServer)}" ${w ? '' : 'disabled'}></label>
            </div>
            ${w ? `<div class="row">
              <label class="inline-check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Offer block storage to customers</label>
              <button class="btn primary">Save</button></div>` : ''}
          </form>
        </section>
      </div>`;
  }

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return false;
    if (t.hasAttribute('data-tier-add')) {
      const tbody = root.querySelector('.tier-table tbody');
      if (tbody.children.length >= 6) { toast('At most 6 tiers'); return true; }
      tbody.insertAdjacentHTML('beforeend', tierRow({ id: '', name: '', storage: '', pricePerGb: 1000, description: '' }, tbody.children.length, true));
      tbody.lastElementChild.querySelector('input').focus();
      return true;
    }
    if (t.hasAttribute('data-tier-remove')) { t.closest('tr').remove(); return true; }
    return false;
  }

  function onChange() {}

  async function onSubmit(e) {
    const f = e.target;
    // (form.id would be shadowed by an input named "id": compare the attribute)
    const formId = f.getAttribute('id');
    if (formId === 'volume-filter') { st.q = f.elements.q.value.trim(); render(); return; }
    if (formId !== 'volume-settings') return;
    const tiers = [...f.querySelectorAll('[data-tier-row]')].map((r) => {
      const v = (n) => r.querySelector(`[name=${n}]`).value.trim();
      return { id: v('tierId'), name: v('name'), storage: v('storage'), pricePerGb: Number(v('pricePerGb')) || 0, description: v('description') };
    });
    try {
      await api('/api/admin/settings/volumes', { method: 'PUT', body: {
        enabled: f.elements.enabled.checked, maxSizeGb: Number(f.elements.maxSizeGb.value), maxPerServer: Number(f.elements.maxPerServer.value), tiers,
      } });
      toast('Block storage settings saved');
      await load(); render();
    } catch (err) { fail(err); }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange, onSubmit,
  };
}
