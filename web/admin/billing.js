// Admin portal: billing. Invoices with filters and KPIs, one invoice (confirm a
// bank transfer, cancel, wallet adjustment, fixed server price), and the owner's
// Settings card (tax, seller, rates, discounts, bank, Xendit, Midtrans).
// Same shape as desk.js: tabs(), handles(), load(), render(), onClick(), onChange(), onSubmit().

const rp = (n) => { const v = Math.round(Number(n) || 0); return `${v < 0 ? '−' : ''}Rp ${Math.abs(v).toLocaleString('id-ID')}`; };
const toDate = (d) => new Date(/^\d{4}-\d{2}-\d{2} /.test(d) ? `${d.replace(' ', 'T')}Z` : d);
const day = (d) => (d ? toDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (d) => (d ? toDate(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const FILTERS = [['', 'All'], ['unpaid', 'Unpaid'], ['reported', 'Transfer reported'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['refunded', 'Refunded'], ['void', 'Cancelled']];
const VIA = { wallet: 'Wallet', xendit: 'Xendit', midtrans: 'Midtrans', bank: 'Bank / by hand' };

export function createBilling({ root, api, toast, fail, confirmAction, esc }) {
  const st = { perms: new Set(), filter: { status: '', q: '' }, data: null, invoice: null };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['billing', 'Billing', 'billing.read']];
  const tag = (i) => (i.status === 'unpaid'
    ? `<span class="tag warn">${i.overdue ? 'Overdue' : i.customerRef ? 'Transfer reported' : 'Unpaid'}</span>`
    : `<span class="tag ${i.status === 'paid' ? 'ok' : ''}">${({ paid: 'Paid', refunded: 'Refunded', void: 'Cancelled' })[i.status] ?? esc(i.status)}</span>`);
  const WHAT = { topup: () => 'Wallet top-up', order: (i) => `New server${i.vmid ? ` ${i.vmid}` : ''} · ${i.months} mo`, upgrade: (i) => `Plan upgrade · server ${i.vmid}`,
    renewal: (i) => `Server ${i.vmid} · ${i.months} mo`, manual: (i) => i.lines[0]?.description ?? 'Invoice' };

  async function loadList() {
    const p = new URLSearchParams();
    if (st.filter.status) p.set('status', st.filter.status);
    if (st.filter.q) p.set('q', st.filter.q);
    st.data = await api(`/api/admin/billing?${p}`);
  }
  async function load() {
    await loadList();
    if (st.invoice) st.invoice = await api(`/api/admin/billing/invoices/${st.invoice.number}`).catch(() => null);
  }

  // ---- list ------------------------------------------------------------------------
  function render() {
    if (st.invoice) return renderInvoice();
    const d = st.data;
    const k = d.kpis;
    const off = !d.settings.enabled;
    body().innerHTML = `
      <div class="billing-admin">
        ${off ? `<div class="notice warn"><p>Billing is switched off: customers don't see it and nothing is renewed automatically.
          ${can('settings.write') ? 'Switch it on under <strong>Settings → Billing</strong>.' : 'The owner switches it on in Settings.'}</p></div>` : ''}
        <div class="kpi-row">
          <div class="kpi"><span class="muted small">Revenue this month</span><strong>${rp(k.revenueMonth)}</strong><span class="small muted">incl. ${esc(d.settings.taxName)} ${rp(k.taxMonth)}</span></div>
          <div class="kpi"><span class="muted small">Unpaid</span><strong>${rp(k.unpaid)}</strong><span class="small muted">${k.overdue} overdue</span></div>
          <div class="kpi"><span class="muted small">Transfers to confirm</span><strong>${k.reported}</strong></div>
          <div class="kpi"><span class="muted small">Customer wallets</span><strong>${rp(k.wallets)}</strong><span class="small muted">money held for customers</span></div>
        </div>
        <form id="billing-filter" class="row desk-controls" role="search">
          <div class="segmented" role="radiogroup" aria-label="Status">
            ${FILTERS.map(([v, l]) => `<button type="button" role="radio" aria-checked="${st.filter.status === v}" data-billing-status="${v}">${l}</button>`).join('')}
          </div>
          <label class="sr-only" for="billing-q">Search</label>
          <input id="billing-q" name="q" type="search" value="${esc(st.filter.q)}" placeholder="Invoice, email or server ID" style="max-width:260px">
          <button class="btn">Search</button>
          ${can('billing.write') ? '<button type="button" class="btn" data-auto-renew-run title="Normally runs every hour">Run auto-renew now</button>' : ''}
        </form>
        ${d.invoices.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>For</th><th>Date</th><th class="num">Total</th><th>Status</th><th>Paid via</th></tr></thead>
            <tbody>${d.invoices.map((i) => `
              <tr data-billing-invoice="${esc(i.number)}" tabindex="0" class="${i.status === 'unpaid' && (i.overdue || i.customerRef) ? 'row-attention' : ''}">
                <td class="mono nowrap">${esc(i.number)}</td><td>${esc(i.email)}</td>
                <td>${esc((WHAT[i.purpose] ?? WHAT.manual)(i))}${i.auto ? ' <span class="tag">auto</span>' : ''}</td>
                <td class="nowrap muted">${esc(day(i.createdAt))}</td><td class="num">${rp(i.total)}</td><td>${tag(i)}</td>
                <td class="muted">${esc(VIA[i.paidVia] ?? '')}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No invoices match.</p>'}
      </div>`;
  }

  // ---- one invoice ------------------------------------------------------------------
  function renderInvoice() {
    const i = st.invoice;
    const w = can('billing.write');
    body().innerHTML = `
      <div class="billing-admin">
        <button class="link-btn back-link" data-billing-back>‹ All invoices</button>
        <div class="invoice-doc">
          <div class="invoice-head">
            <div><h2 class="h2" style="margin:0">Invoice <span class="mono">${esc(i.number)}</span> ${tag(i)}</h2>
              <p class="muted small">${esc(i.email)} · created ${esc(when(i.createdAt))} · due ${esc(day(i.dueAt))}${i.paidAt ? ` · paid ${esc(when(i.paidAt))} (${esc(VIA[i.paidVia] ?? i.paidVia)})` : ''}</p></div>
            <p class="small"><span class="muted">Wallet balance</span><br><strong>${rp(i.balance)}</strong></p>
          </div>
          <div class="table-wrap"><table class="table invoice-lines">
            <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
            <tbody>${i.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.quantity}</td><td class="num">${rp(l.unitPrice)}</td><td class="num">${rp(l.amount)}</td></tr>`).join('')}</tbody>
            <tfoot>
              <tr><td colspan="3" class="num">Subtotal</td><td class="num">${rp(i.subtotal)}</td></tr>
              ${i.purpose === 'topup' ? '' : `<tr><td colspan="3" class="num">${esc(i.taxName)} ${i.taxRate}%</td><td class="num">${rp(i.tax)}</td></tr>`}
              <tr class="invoice-total"><td colspan="3" class="num">Total</td><td class="num">${rp(i.total)}</td></tr>
            </tfoot></table></div>
          ${i.customerRef ? `<p><strong>Customer reported a transfer:</strong> ${esc(i.customerRef)}</p>` : ''}
          ${i.note ? `<p class="muted small">Note: ${esc(i.note)}</p>` : ''}
        </div>

        ${i.payments.length || i.checkouts.length ? `
          <h3 class="h3" style="margin-top:20px">Payments and payment pages</h3>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>When</th><th>What</th><th>Reference</th><th class="num">Amount</th></tr></thead>
            <tbody>
              ${i.payments.map((p) => `<tr><td class="nowrap muted">${esc(when(p.createdAt))}</td><td>Payment · ${esc(VIA[p.method] ?? p.method)}</td><td class="mono small">${esc(p.reference ?? '')}</td><td class="num">${rp(p.amount)}</td></tr>`).join('')}
              ${i.checkouts.map((c) => `<tr><td class="nowrap muted">${esc(when(c.createdAt))}</td><td>Payment page · ${esc(VIA[c.gateway] ?? c.gateway)} <span class="tag">${esc(c.status)}</span></td><td class="mono small">${esc(c.orderId)}</td><td class="num">${rp(c.amount)}</td></tr>`).join('')}
            </tbody></table></div>` : ''}

        ${w && i.status === 'unpaid' ? `
          <div class="grid-2" style="margin-top:16px">
            <form id="billing-mark-paid" class="security-card settings-card">
              <h3 class="h3">Confirm a payment</h3>
              <p class="muted small">Only after the money is on the account (bank statement). ${i.purpose === 'renewal' ? 'The server is extended at once and runs again if it had expired.' : 'The amount goes to the customer\'s wallet.'}</p>
              <label>Bank reference or how it was paid <input name="reference" required minlength="3" maxlength="120" value="${esc(i.customerRef ?? '')}"></label>
              <label>Internal note <span class="hint">optional</span><input name="note" maxlength="500"></label>
              <div class="row"><button class="btn primary">Mark as paid</button></div>
            </form>
            <form id="billing-void" class="security-card settings-card">
              <h3 class="h3">Cancel the invoice</h3>
              <p class="muted small">The customer can no longer pay it. A payment that still arrives through a gateway goes to the wallet.</p>
              <label>Reason <input name="reason" required minlength="3" maxlength="500"></label>
              <div class="row"><button class="btn danger">Cancel invoice</button></div>
            </form>
          </div>` : ''}

        ${w ? `
          <div class="grid-2" style="margin-top:16px">
            <form id="billing-wallet" class="security-card settings-card">
              <h3 class="h3">Adjust the wallet of ${esc(i.email)}</h3>
              <p class="muted small">Credit (e.g. goodwill) or debit (e.g. refund paid out). The reason is shown to the customer.</p>
              <div class="grid-2">
                <label>Amount (Rp, minus to debit) <input name="amount" type="number" step="1" required></label>
                <label>Reason <input name="reason" required minlength="3" maxlength="200"></label>
              </div>
              <div class="row"><button class="btn">Apply</button></div>
            </form>
            ${i.vmid ? `
              <form id="billing-price" class="security-card settings-card">
                <h3 class="h3">Fixed price for server ${i.vmid}</h3>
                <p class="muted small">Replaces the rate card for this server on new invoices. Leave empty to use the rate card again.</p>
                <label>Per month (Rp, before tax) <input name="price" type="number" min="0" step="1000"></label>
                <div class="row"><button class="btn">Save price</button></div>
              </form>` : ''}
          </div>` : ''}
      </div>`;
  }

  // ---- settings card (Settings tab; owner) ----------------------------------------------
  function settingsCard(s) {
    if (!s) return '';
    const secret = (has) => (has ? 'Stored; leave empty to keep it' : '');
    return `
      <section class="security-card settings-card">
        <div class="settings-head">
          <h2 class="twofa-title">Billing <span class="pill ${s.enabled ? 'pill-running' : ''}">${s.enabled ? 'On' : 'Off'}</span></h2>
          <p class="muted">Invoices in rupiah for server renewals and wallet top-ups. Customers pay from their wallet, online through
            Xendit or Midtrans, or by bank transfer that you confirm. A gateway notification is only trusted after the payment is
            confirmed with the gateway's own API.</p>
        </div>
        <form id="billing-settings-form" class="email-form" novalidate>
          <h3 class="h3">Seller and tax</h3>
          <div class="grid-3">
            <label>Company name <input name="companyName" maxlength="120" value="${esc(s.company.name)}" placeholder="Acme Cloud"></label>
            <label>Tax number (NPWP) <input name="companyTaxId" maxlength="120" value="${esc(s.company.taxId)}"></label>
            <label>Invoice prefix <input name="invoicePrefix" maxlength="8" pattern="[A-Z0-9]{1,8}" value="${esc(s.invoicePrefix)}"></label>
          </div>
          <label>Address <textarea name="companyAddress" rows="2" maxlength="300">${esc(s.company.address)}</textarea></label>
          <div class="grid-3">
            <label>Tax name <input name="taxName" maxlength="20" value="${esc(s.taxName)}"></label>
            <label>Tax rate (%) <input name="taxRate" type="number" min="0" max="50" step="0.01" value="${esc(s.taxRate)}"></label>
            <label>Days to pay <input name="dueDays" type="number" min="1" max="60" value="${esc(s.dueDays)}"></label>
          </div>

          <h3 class="h3">Prices (per month, before tax)</h3>
          <div class="grid-3">
            <label>Per vCPU <input name="rateVcpu" type="number" min="0" step="500" value="${esc(s.rates.vcpu)}"></label>
            <label>Per GB RAM <input name="rateRamGb" type="number" min="0" step="500" value="${esc(s.rates.ramGb)}"></label>
            <label>Per GB disk <input name="rateDiskGb" type="number" min="0" step="100" value="${esc(s.rates.diskGb)}"></label>
            <label>Lowest price per server <input name="rateMinimum" type="number" min="0" step="1000" value="${esc(s.rates.minimum)}"></label>
            ${[3, 6, 12].map((m) => `<label>Discount ${m} months (%) <input name="discount${m}" type="number" min="0" max="50" value="${esc(s.discounts[m])}"></label>`).join('')}
            <label>Smallest top-up <input name="topupMin" type="number" min="10000" step="1000" value="${esc(s.topupMin)}"></label>
            <label>Auto-renew, days before the end <input name="autoRenewDays" type="number" min="1" max="30" value="${esc(s.autoRenewDays)}"></label>
          </div>
          <p class="hint">Prices are rounded up to the next Rp 1.000. A fixed price per server is set on an invoice of that server (Billing tab).</p>

          <h3 class="h3">Bank transfer</h3>
          <label class="inline-check"><input type="checkbox" name="bankEnabled" ${s.bank.enabled ? 'checked' : ''}> Offer bank transfer (you confirm each payment)</label>
          <label>Instructions for the customer <textarea name="bankInstructions" rows="3" maxlength="2000" placeholder="Bank, account number, account name">${esc(s.bank.instructions)}</textarea></label>

          <h3 class="h3">Xendit</h3>
          <div class="grid-2">
            <label>Secret API key <input name="xenditSecretKey" type="password" autocomplete="new-password" placeholder="${secret(s.xendit.hasSecretKey) || 'xnd_production_… (Money-in: write)'}"></label>
            <label>Callback verification token <input name="xenditCallbackToken" type="password" autocomplete="new-password" placeholder="${secret(s.xendit.hasCallbackToken) || 'Settings → Webhooks'}"></label>
          </div>
          <p class="hint">In the Xendit dashboard set the <em>Invoices paid</em> webhook to
            <span class="selectable">${esc(s.xendit.webhookUrl ?? 'the customer portal address (set PANEL_PUBLIC_URL) + /api/billing/webhooks/xendit')}</span></p>
          <label class="inline-check"><input type="checkbox" name="xenditEnabled" ${s.xendit.enabled ? 'checked' : ''}> Offer Xendit</label>

          <h3 class="h3">Midtrans</h3>
          <div class="grid-2">
            <label>Server key <input name="midtransServerKey" type="password" autocomplete="new-password" placeholder="${secret(s.midtrans.hasServerKey) || 'Mid-server-… or SB-Mid-server-…'}"></label>
            <label class="check" style="align-self:end"><input type="checkbox" name="midtransSandbox" ${s.midtrans.sandbox ? 'checked' : ''}><span>Sandbox (test payments)</span></label>
          </div>
          <p class="hint">In the Midtrans dashboard (Settings → Payment → Notification URL) set
            <span class="selectable">${esc(s.midtrans.webhookUrl ?? 'the customer portal address + /api/billing/webhooks/midtrans')}</span></p>
          <label class="inline-check"><input type="checkbox" name="midtransEnabled" ${s.midtrans.enabled ? 'checked' : ''}> Offer Midtrans</label>

          <div class="row">
            <label class="inline-check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Billing switched on for customers</label>
            <button class="btn primary">Save</button>
          </div>
        </form>
      </section>`;
  }

  /** Settings form → PUT body; secrets only when typed. */
  async function saveSettings(form) {
    const el = form.elements;
    const n = (x) => Number(el[x].value);
    const b = {
      enabled: el.enabled.checked, taxName: el.taxName.value, taxRate: n('taxRate'), invoicePrefix: el.invoicePrefix.value.trim().toUpperCase(),
      dueDays: n('dueDays'), topupMin: n('topupMin'), autoRenewDays: n('autoRenewDays'),
      company: { name: el.companyName.value, address: el.companyAddress.value, taxId: el.companyTaxId.value },
      rates: { vcpu: n('rateVcpu'), ramGb: n('rateRamGb'), diskGb: n('rateDiskGb'), minimum: n('rateMinimum') },
      discounts: { 3: n('discount3'), 6: n('discount6'), 12: n('discount12') },
      bank: { enabled: el.bankEnabled.checked, instructions: el.bankInstructions.value },
      xendit: { enabled: el.xenditEnabled.checked },
      midtrans: { enabled: el.midtransEnabled.checked, sandbox: el.midtransSandbox.checked },
    };
    if (el.xenditSecretKey.value) b.xendit.secretKey = el.xenditSecretKey.value;
    if (el.xenditCallbackToken.value) b.xendit.callbackToken = el.xenditCallbackToken.value;
    if (el.midtransServerKey.value) b.midtrans.serverKey = el.midtransServerKey.value;
    const saved = await api('/api/admin/settings/billing', { method: 'PUT', body: b });
    toast(saved.enabled ? 'Billing settings saved; billing is on' : 'Billing settings saved');
    return saved;
  }

  // ---- events ------------------------------------------------------------------------
  async function openInvoice(number) {
    try { st.invoice = await api(`/api/admin/billing/invoices/${encodeURIComponent(number)}`); renderInvoice(); } catch (err) { fail(err); }
  }

  async function onClick(e) {
    const row = e.target.closest('[data-billing-invoice]');
    if (row) { await openInvoice(row.dataset.billingInvoice); return true; }
    const t = e.target.closest('button');
    if (!t) return false;
    if (t.dataset.billingStatus !== undefined) {
      st.filter.status = t.dataset.billingStatus;
      try { await loadList(); render(); } catch (err) { fail(err); }
      return true;
    }
    if (t.hasAttribute('data-billing-back')) {
      st.invoice = null;
      try { await loadList(); } catch (err) { fail(err); }
      render();
      return true;
    }
    if (t.hasAttribute('data-auto-renew-run')) {
      t.disabled = true;
      try {
        const r = await api('/api/admin/billing/auto-renew/run', { method: 'POST' });
        toast(`Auto-renew: ${r.renewed} renewed from the wallet, ${r.short} short of balance (emailed)`);
        await loadList(); render();
      } catch (err) { fail(err); t.disabled = false; }
      return true;
    }
    return false;
  }

  function onChange() {}

  async function onSubmit(e) {
    const f = e.target;
    const el = f.elements;
    const n = st.invoice?.number;
    try {
      if (f.id === 'billing-filter') { st.filter.q = el.q.value.trim(); await loadList(); render(); }
      if (f.id === 'billing-mark-paid') {
        if (!(await confirmAction(`Confirm that ${rp(st.invoice.total)} for ${n} has arrived?`, 'Mark as paid'))) return;
        st.invoice = await api(`/api/admin/billing/invoices/${n}/mark-paid`, { method: 'POST', body: { reference: el.reference.value, note: el.note.value || undefined } });
        toast(`${n} is paid`); renderInvoice();
      }
      if (f.id === 'billing-void') {
        if (!(await confirmAction(`Cancel ${n}? The customer can no longer pay it.`, 'Cancel invoice'))) return;
        st.invoice = await api(`/api/admin/billing/invoices/${n}/void`, { method: 'POST', body: { reason: el.reason.value } });
        toast(`${n} cancelled`); renderInvoice();
      }
      if (f.id === 'billing-wallet') {
        const amount = Number(el.amount.value);
        if (!(await confirmAction(`${amount < 0 ? 'Debit' : 'Credit'} ${rp(Math.abs(amount))} ${amount < 0 ? 'from' : 'to'} the wallet of ${st.invoice.email}?`, 'Apply'))) return;
        const r = await api(`/api/admin/billing/wallets/${st.invoice.userId}`, { method: 'POST', body: { amount, reason: el.reason.value } });
        toast(`New balance ${rp(r.balance)}`);
        await openInvoice(n);
      }
      if (f.id === 'billing-price') {
        const v = el.price.value.trim();
        const r = await api(`/api/admin/billing/servers/${st.invoice.vmid}/price`, { method: 'PUT', body: { priceMonthly: v === '' ? null : Number(v) } });
        toast(r.priceMonthly == null ? 'The rate card applies again' : `Fixed price ${rp(r.priceMonthly)} per month for new invoices`);
      }
    } catch (err) { fail(err); }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange, onSubmit, settingsCard, saveSettings,
  };
}
