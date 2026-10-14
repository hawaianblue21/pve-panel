// Admin portal: plans (server sizes with a monthly price) and whether customers
// must choose one. Same shape as desk.js: tabs(), handles(), load(), render(), onClick(), onChange(), onSubmit().

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;

export function createPlans({ root, api, toast, fail, confirmAction, esc }) {
  const st = { perms: new Set(), data: null, editing: null };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['plans', 'Plans', 'plans.read']];

  async function load() { st.data = await api('/api/admin/plans'); }

  function render() {
    const d = st.data;
    const w = can('plans.write');
    const e = st.editing;
    body().innerHTML = `
      <div class="plans-admin">
        <p class="muted" style="max-width:80ch">Customers create servers from these plans. With billing on and a price set, the first
          period is paid from the wallet before the server is set up, and renewals use the plan's price. A server can move to a
          larger plan; it pays the difference for the days already paid. Customer limits and resource pools still apply.</p>
        <label class="inline-check" style="margin:6px 0 14px">
          <input type="checkbox" data-require-plan ${d.settings.requirePlan ? 'checked' : ''} ${w ? '' : 'disabled'}>
          Customers must choose a plan (no custom sizes)</label>
        ${d.plans.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Plan</th><th>Size</th><th class="num">Per month</th><th>Servers</th><th>Status</th>${w ? '<th></th>' : ''}</tr></thead>
            <tbody>${d.plans.map((p) => `
              <tr>
                <td><strong>${esc(p.name)}</strong>${p.description ? `<br><span class="muted small">${esc(p.description)}</span>` : ''}</td>
                <td class="nowrap">${p.cores} vCPU · ${gb(p.memoryMb)} · ${p.diskGb} GB${p.gpuName ? ` · ${esc(p.gpuName)}` : ''}</td>
                <td class="num">${p.priceMonthly == null ? '<span class="muted">No charge</span>' : rp(p.priceMonthly)}</td>
                <td>${p.servers}</td>
                <td>${p.active ? '<span class="tag ok">Offered</span>' : '<span class="tag">Retired</span>'}</td>
                ${w ? `<td class="nowrap"><button class="btn" data-plan-edit="${p.id}">Edit</button>
                  <button class="btn" data-plan-toggle="${p.id}">${p.active ? 'Retire' : 'Offer again'}</button>
                  ${p.servers ? '' : `<button class="btn danger" data-plan-delete="${p.id}">Delete</button>`}</td>` : ''}
              </tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No plans yet. Customers choose their own size within their limits.</p>'}
        ${w ? `
          <form id="plan-form" class="security-card settings-card" style="margin-top:18px;max-width:900px">
            <h3 class="h3">${e ? `Edit plan ${esc(e.name)}` : 'New plan'}</h3>
            ${e?.servers ? `<p class="small muted">${e.servers} server${e.servers === 1 ? ' is' : 's are'} on this plan: the size is fixed. A new price applies from their next invoice.</p>` : ''}
            <div class="grid-3">
              <label>Name <input name="name" required maxlength="60" value="${esc(e?.name ?? '')}" placeholder="Small"></label>
              <label>Price per month (Rp, before tax) <input name="priceMonthly" type="number" min="0" step="1000" value="${e?.priceMonthly ?? ''}" placeholder="empty = no charge"></label>
              <label>Order in the list <input name="sort" type="number" value="${e?.sort ?? (d.plans.length + 1)}"></label>
              <label>vCPU <input name="cores" type="number" min="1" max="128" required value="${e?.cores ?? 1}" ${e?.servers ? 'disabled' : ''}></label>
              <label>Memory (GB) <input name="memoryGb" type="number" min="0.5" max="1024" step="0.25" required value="${e ? e.memoryMb / 1024 : 1}" ${e?.servers ? 'disabled' : ''}></label>
              <label>Disk (GB) <input name="diskGb" type="number" min="1" max="65536" required value="${e?.diskGb ?? 20}" ${e?.servers ? 'disabled' : ''}></label>
            </div>
            <div class="grid-2">
              <label>GPU <select name="gpuProfileId" ${e?.servers ? 'disabled' : ''}>
                <option value="">None</option>
                ${d.gpuProfiles.map((g) => `<option value="${g.id}" ${e?.gpuProfileId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
              </select><span class="hint">Shown only to customers whose resource pool offers this GPU.</span></label>
              <label>Description <input name="description" maxlength="200" value="${esc(e?.description ?? '')}" placeholder="For small websites"></label>
            </div>
            <div class="row"><button class="btn primary">${e ? 'Save plan' : 'Add plan'}</button>
              ${e ? '<button type="button" class="btn ghost" data-plan-cancel>Cancel</button>' : ''}</div>
          </form>` : ''}
      </div>`;
  }

  async function reload() { await load(); render(); }

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return false;
    const id = Number(t.dataset.planEdit || t.dataset.planToggle || t.dataset.planDelete || 0);
    const plan = st.data?.plans.find((p) => p.id === id);
    try {
      if (t.dataset.planEdit) { st.editing = plan; render(); root.querySelector('#plan-form [name=name]').focus(); return true; }
      if (t.hasAttribute('data-plan-cancel')) { st.editing = null; render(); return true; }
      if (t.dataset.planToggle) {
        await api(`/api/admin/plans/${id}`, { method: 'PUT', body: { active: !plan.active } });
        toast(plan.active ? `${plan.name} is no longer offered; its servers keep it` : `${plan.name} is offered again`);
        await reload(); return true;
      }
      if (t.dataset.planDelete) {
        if (!(await confirmAction(`Delete plan ${plan.name}?`, 'Delete'))) return true;
        await api(`/api/admin/plans/${id}`, { method: 'DELETE' });
        toast(`${plan.name} deleted`);
        await reload(); return true;
      }
    } catch (err) { fail(err); return true; }
    return false;
  }

  async function onChange(e) {
    if (!e.target.matches('[data-require-plan]')) return;
    try {
      const s = await api('/api/admin/settings/plans', { method: 'PUT', body: { requirePlan: e.target.checked } });
      st.data.settings = s;
      toast(s.requirePlan ? 'Customers now choose a plan' : 'Customers may also choose their own size');
    } catch (err) { e.target.checked = !e.target.checked; fail(err); }
  }

  async function onSubmit(e) {
    if (e.target.id !== 'plan-form') return;
    const el = e.target.elements;
    const price = el.priceMonthly.value.trim();
    const b = {
      name: el.name.value.trim(), description: el.description.value.trim(), sort: Number(el.sort.value || 0),
      priceMonthly: price === '' ? null : Number(price),
    };
    if (!st.editing?.servers) {
      Object.assign(b, {
        cores: Number(el.cores.value), memoryMb: Math.round(Number(el.memoryGb.value) * 1024), diskGb: Number(el.diskGb.value),
        gpuProfileId: el.gpuProfileId.value ? Number(el.gpuProfileId.value) : null,
      });
    }
    try {
      const saved = st.editing
        ? await api(`/api/admin/plans/${st.editing.id}`, { method: 'PUT', body: b })
        : await api('/api/admin/plans', { method: 'POST', body: b });
      toast(st.editing ? `${saved.name} saved` : `${saved.name} added`);
      st.editing = null;
      await reload();
    } catch (err) { fail(err); }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange, onSubmit,
  };
}
