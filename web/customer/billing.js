// Customer portal: billing. Wallet and top-ups, renewals with auto-renew,
// invoices (printable) and paying them: wallet, Xendit, Midtrans or bank transfer.
import { $, api, esc, toast, fail, confirmAction } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const rp = (n) => { const v = Math.round(Number(n) || 0); return `${v < 0 ? '−' : ''}Rp ${Math.abs(v).toLocaleString('id-ID')}`; };
// SQLite dates are "YYYY-MM-DD HH:MM:SS" in UTC; the others are ISO
const toDate = (d) => new Date(/^\d{4}-\d{2}-\d{2} /.test(d) ? `${d.replace(' ', 'T')}Z` : d);
const day = (d) => (d ? toDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS = { unpaid: ['Unpaid', 'warn'], paid: ['Paid', 'ok'], void: ['Cancelled', ''], refunded: ['Refunded to wallet', ''] };
const statusTag = (inv) => (inv.status === 'unpaid' && inv.overdue
  ? '<span class="tag warn">Overdue</span>'
  : `<span class="tag ${STATUS[inv.status]?.[1] ?? ''}">${esc(STATUS[inv.status]?.[0] ?? inv.status)}</span>`);
const METHOD = {
  wallet: ['Wallet balance', 'Paid at once from your balance.'],
  xendit: ['Pay online (Xendit)', 'Virtual account, QRIS, e-wallet or card on the Xendit payment page.'],
  midtrans: ['Pay online (Midtrans)', 'Virtual account, QRIS, GoPay, ShopeePay or card on the Midtrans payment page.'],
  bank: ['Bank transfer', 'Transfer by hand; we confirm it when the money arrives (usually within one working day).'],
};
const VIA = { wallet: 'wallet', xendit: 'Xendit', midtrans: 'Midtrans', bank: 'bank transfer' };

/** Estimate shown before an invoice exists; the invoice has the exact figures. */
function estimate(monthly, m, taxRate) {
  const gross = monthly * m.months;
  const sub = gross - Math.round((gross * m.discount) / 100);
  return sub + Math.round((sub * taxRate) / 100);
}

/** ctx: { state, renderList, setView(view, hash) } */
export function createBilling(ctx) {
  const detail = () => $('#detail');
  let data = null;
  let inv = null;
  let picked = {};          // vmid → months chosen

  async function loadStatus() {
    try { data = await api('/api/billing'); } catch { data = { enabled: false }; }
    ctx.state.billingEnabled = !!data.enabled;
    return data;
  }

  // ---- Overview ------------------------------------------------------------------
  async function open({ focus = null } = {}) {
    ctx.setView('billing', '#billing');
    detail().innerHTML = '<div class="page"><p class="muted">Loading…</p></div>';
    await loadStatus();
    if (ctx.state.view !== 'billing') return;
    ctx.renderList();
    if (!data.enabled) {
      detail().innerHTML = '<div class="page"><div class="empty"><h2>Billing is not available</h2><p class="muted">Your provider bills you another way. Questions? <a href="#support/new">Open a ticket</a>.</p></div></div>';
      return;
    }
    render();
    if (focus) {
      const row = detail().querySelector(`[data-server="${focus}"]`);
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('row-attention');
      row?.querySelector('[data-renew]')?.focus();
    }
  }

  function render() {
    const d = data;
    const unpaid = d.invoices.filter((i) => i.status === 'unpaid');
    const next = d.servers.find((s) => !s.expired);
    detail().innerHTML = `
      <div class="page billing-page">
        <header class="page-head">
          <div><h1>Billing</h1><p class="lede">Your balance, renewals and invoices. Prices in rupiah; ${esc(d.taxName)} ${d.taxRate}% is added to services.</p></div>
        </header>

        <div class="kpi-row">
          <div class="kpi"><span class="muted small">Wallet balance</span><strong data-balance>${rp(d.balance)}</strong></div>
          <div class="kpi"><span class="muted small">To pay</span><strong>${rp(unpaid.reduce((a, i) => a + i.total, 0))}</strong>
            <span class="small muted">${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}</span></div>
          <div class="kpi"><span class="muted small">Next end date</span><strong>${next ? esc(day(next.expiresAt)) : '·'}</strong>
            <span class="small muted">${next ? esc(next.name) : 'No servers with an end date'}</span></div>
        </div>

        ${unpaid.length ? `<div class="notice warn"><p>${unpaid.length === 1 ? 'One invoice is' : `${unpaid.length} invoices are`} waiting for payment:
          ${unpaid.map((i) => `<a href="#billing/${esc(i.number)}">${esc(i.number)}</a>`).join(', ')}.</p></div>` : ''}

        <section class="billing-section" aria-labelledby="b-servers">
          <h2 class="h2" id="b-servers">Servers</h2>
          ${d.servers.length ? `
            <div class="table-wrap"><table class="table bill-servers">
              <thead><tr><th>Server</th><th>Runs until</th><th>Per month</th><th>Renew for</th><th>Auto-renew</th></tr></thead>
              <tbody>${d.servers.map(serverRow).join('')}</tbody>
            </table></div>
            <p class="small muted">Renewing adds the months to the current end date. With auto-renew, one month is paid from your wallet
              a few days before the end date; if the balance is too low we email you.</p>`
          : '<p class="muted">None of your servers has an end date, so there is nothing to renew.</p>'}
        </section>

        <section class="billing-section" aria-labelledby="b-wallet">
          <h2 class="h2" id="b-wallet">Wallet</h2>
          <form id="topup-form" class="row" novalidate>
            <label for="topup-amount">Top up (Rp)</label>
            <input id="topup-amount" name="amount" type="number" inputmode="numeric" min="${d.topupMin}" step="1000" required value="${Math.max(d.topupMin, 100_000)}" style="max-width:180px">
            <button class="btn primary">${icon('plus')}<span>Top up</span></button>
            <span class="small muted">At least ${rp(d.topupMin)}. Top-ups carry no tax; it is charged when the balance pays for a service.</span>
          </form>
          <p class="form-error" id="topup-error" role="alert"></p>
          ${d.wallet.length ? `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Date</th><th>What</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
              <tbody>${d.wallet.map((w) => `<tr><td class="nowrap muted">${esc(day(w.createdAt))}</td><td>${esc(w.reason)}</td>
                <td class="num ${w.amount < 0 ? '' : 'pos'}">${w.amount > 0 ? '+' : ''}${rp(w.amount)}</td><td class="num">${rp(w.balance)}</td></tr>`).join('')}</tbody>
            </table></div>` : '<p class="muted small">No movements yet.</p>'}
        </section>

        <section class="billing-section" aria-labelledby="b-invoices">
          <h2 class="h2" id="b-invoices">Invoices</h2>
          ${d.invoices.length ? `
            <div class="table-wrap"><table class="table invoice-table">
              <thead><tr><th>Invoice</th><th>For</th><th>Date</th><th class="num">Total</th><th>Status</th></tr></thead>
              <tbody>${d.invoices.map((i) => `
                <tr data-invoice="${esc(i.number)}" tabindex="0" class="${i.status === 'unpaid' ? 'row-attention' : ''}">
                  <td class="mono nowrap">${esc(i.number)}</td><td>${esc(i.lines[0]?.description ?? '')}</td>
                  <td class="nowrap muted">${esc(day(i.createdAt))}</td><td class="num">${rp(i.total)}</td><td>${statusTag(i)}</td></tr>`).join('')}
              </tbody></table></div>` : '<p class="muted">No invoices yet.</p>'}
        </section>

        <section class="billing-section" aria-labelledby="b-profile">
          <h2 class="h2" id="b-profile">Billing details</h2>
          <p class="small muted">Printed on new invoices. For a company: its name, address and tax number (NPWP).</p>
          <form id="profile-form" class="grid-2" style="max-width:760px">
            <label>Name or company<input name="name" maxlength="120" value="${esc(d.profile.name)}" autocomplete="organization"></label>
            <label>Tax number (NPWP) <span class="hint">optional</span><input name="taxId" maxlength="120" value="${esc(d.profile.taxId)}"></label>
            <label style="grid-column:1/-1">Address<textarea name="address" rows="2" maxlength="300">${esc(d.profile.address)}</textarea></label>
            <div class="row"><button class="btn">Save details</button></div>
          </form>
        </section>
      </div>`;
  }

  function serverRow(s) {
    const m = picked[s.vmid] ?? 1;
    const opt = data.months.find((x) => x.months === m) ?? data.months[0];
    return `
      <tr data-server="${s.vmid}">
        <td><a href="#${s.vmid}">${esc(s.name)}</a> <span class="muted small mono">${s.vmid}</span></td>
        <td class="nowrap" data-label="Runs until">${s.expired ? '<span class="tag warn">Expired</span>' : esc(day(s.expiresAt))}</td>
        <td class="nowrap" data-label="Per month">${s.monthly == null ? '<span class="muted">·</span>' : rp(s.monthly)}</td>
        <td data-label="Renew for">
          <div class="row">
            <div class="segmented" role="radiogroup" aria-label="Months for ${esc(s.name)}">
              ${data.months.map((x) => `<button type="button" role="radio" aria-checked="${x.months === m}" data-months="${x.months}"
                title="${x.discount ? `${x.discount}% discount` : ''}">${x.months} mo${x.discount ? ` <span class="small">−${x.discount}%</span>` : ''}</button>`).join('')}
            </div>
            <button class="btn primary" data-renew ${s.monthly == null ? 'disabled' : ''}>Renew${s.monthly == null ? '' : ` · ${rp(estimate(s.monthly, opt, data.taxRate))}`}</button>
          </div>
        </td>
        <td data-label="Auto-renew"><label class="inline-check"><input type="checkbox" data-auto-renew ${s.autoRenew ? 'checked' : ''}> <span class="sr-only">Auto-renew ${esc(s.name)}</span>Monthly</label></td>
      </tr>`;
  }

  // ---- One invoice -------------------------------------------------------------------
  async function openInvoice(number, { notice = null } = {}) {
    ctx.setView('invoice', `#billing/${number}`);
    detail().innerHTML = '<div class="page"><p class="muted">Loading…</p></div>';
    try { inv = await api(`/api/billing/invoices/${encodeURIComponent(number)}`); } catch (err) {
      detail().innerHTML = `<div class="page"><a class="back-link" href="#billing">‹ Billing</a><div class="empty"><h2>Invoice not found</h2></div></div>`;
      return fail(err);
    }
    if (ctx.state.view !== 'invoice') return;
    renderInvoice(notice);
  }

  function renderInvoice(notice) {
    const i = inv;
    const methods = i.methods ?? [];
    const first = methods.find((m) => m !== 'wallet' || i.balance >= i.total) ?? methods[0];
    detail().innerHTML = `
      <div class="page invoice-page">
        <a class="back-link" href="#billing">‹ Billing</a>
        ${notice ? `<div class="notice">${notice}</div>` : ''}
        <article class="invoice-doc" aria-label="Invoice ${esc(i.number)}">
          <header class="invoice-head">
            <div>
              <h1>Invoice <span class="mono">${esc(i.number)}</span> ${statusTag(i)}</h1>
              <p class="muted small">Date ${esc(day(i.createdAt))}${i.status === 'unpaid' ? ` · due ${esc(day(i.dueAt))}` : ''}${i.paidAt ? ` · paid ${esc(day(i.paidAt))} by ${esc(VIA[i.paidVia] ?? i.paidVia)}` : ''}</p>
            </div>
            <div class="row no-print"><button class="btn" data-print>${icon('download')}<span>Print or save as PDF</span></button></div>
          </header>
          <div class="grid-2 invoice-parties">
            <div><p class="small muted">From</p>
              <p><strong>${esc(i.seller.name || 'Your provider')}</strong>${i.seller.address ? `<br>${esc(i.seller.address).replace(/\n/g, '<br>')}` : ''}${i.seller.taxId ? `<br>NPWP ${esc(i.seller.taxId)}` : ''}</p></div>
            <div><p class="small muted">Bill to</p>
              <p><strong>${esc(i.billTo?.name || i.billTo?.email || '')}</strong>${i.billTo?.name ? `<br>${esc(i.billTo.email)}` : ''}${i.billTo?.address ? `<br>${esc(i.billTo.address).replace(/\n/g, '<br>')}` : ''}${i.billTo?.taxId ? `<br>NPWP ${esc(i.billTo.taxId)}` : ''}</p></div>
          </div>
          <div class="table-wrap"><table class="table invoice-lines">
            <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
            <tbody>${i.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.quantity}</td><td class="num">${rp(l.unitPrice)}</td><td class="num">${rp(l.amount)}</td></tr>`).join('')}</tbody>
            <tfoot>
              <tr><td colspan="3" class="num">Subtotal</td><td class="num">${rp(i.subtotal)}</td></tr>
              ${i.purpose === 'topup' ? '' : `<tr><td colspan="3" class="num">${esc(i.taxName)} ${i.taxRate}%</td><td class="num">${rp(i.tax)}</td></tr>`}
              <tr class="invoice-total"><td colspan="3" class="num">Total</td><td class="num">${rp(i.total)}</td></tr>
            </tfoot>
          </table></div>
        </article>

        ${i.status === 'unpaid' && methods.length ? `
          <section class="pay-box no-print" aria-labelledby="pay-title">
            <h2 class="h2" id="pay-title">Pay ${rp(i.total)}</h2>
            <form id="pay-form">
              <fieldset class="plain-fieldset"><legend class="sr-only">Payment method</legend>
                <div class="choices">
                  ${methods.map((m) => {
                    const short = m === 'wallet' && i.balance < i.total;
                    return `<label class="choice"><input type="radio" name="method" value="${m}" ${m === first ? 'checked' : ''} ${short ? 'disabled' : ''}>
                      <span><strong>${esc(METHOD[m][0])}</strong><br><span class="small muted">${m === 'wallet' ? `Balance ${rp(i.balance)}.${short ? ' Not enough; <a href="#billing">top up</a> first.' : ''}` : esc(METHOD[m][1])}</span></span></label>`;
                  }).join('')}
                </div>
              </fieldset>
              <div class="bank-box" ${first === 'bank' ? '' : 'hidden'}>
                <p><strong>Transfer exactly ${rp(i.total)}</strong> and write <span class="selectable">${esc(i.number)}</span> in the transfer note.</p>
                <pre class="bank-instructions">${esc(i.bank ?? '')}</pre>
                <label>After transferring: your bank's reference or the time of the transfer <span class="hint">optional, helps us find it</span>
                  <input name="reference" maxlength="120" value="${esc(i.customerRef ?? '')}"></label>
              </div>
              <p class="form-error" id="pay-error" role="alert"></p>
              <div class="row"><button class="btn primary" id="pay-btn">${payLabel(first)}</button></div>
            </form>
          </section>` : ''}
        ${i.status === 'unpaid' && i.customerRef ? `<p class="muted small no-print">You reported a transfer (${esc(i.customerRef)}). We confirm it when the money arrives.</p>` : ''}
      </div>`;
  }

  const payLabel = (m) => ({ wallet: 'Pay from wallet', xendit: 'Continue to Xendit', midtrans: 'Continue to Midtrans', bank: 'I have transferred' }[m] ?? 'Pay');

  // ---- Actions -----------------------------------------------------------------------
  async function renew(vmid, months) {
    try {
      const i = await api('/api/billing/renewals', { method: 'POST', body: { vmid, months } });
      return openInvoice(i.number);
    } catch (err) { fail(err); }
  }

  detail().addEventListener('click', async (e) => {
    if (!['billing', 'invoice'].includes(ctx.state.view)) return;
    const row = e.target.closest('[data-invoice]');
    if (row && !e.target.closest('a')) return openInvoice(row.dataset.invoice);
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.months) {
      const vmid = Number(t.closest('[data-server]').dataset.server);
      picked[vmid] = Number(t.dataset.months);
      const s = data.servers.find((x) => x.vmid === vmid);
      t.closest('tr').outerHTML = serverRow(s);
      detail().querySelector(`[data-server="${vmid}"] [aria-checked="true"]`)?.focus();
      return;
    }
    if (t.hasAttribute('data-renew')) {
      const vmid = Number(t.closest('[data-server]').dataset.server);
      t.disabled = true;
      return renew(vmid, picked[vmid] ?? 1);
    }
    if (t.hasAttribute('data-print')) window.print();
  });

  detail().addEventListener('keydown', (e) => {
    const row = e.target.closest?.('tr[data-invoice]');
    if (row && ['billing', 'invoice'].includes(ctx.state.view) && e.key === 'Enter') { e.preventDefault(); openInvoice(row.dataset.invoice); }
  });

  detail().addEventListener('change', async (e) => {
    if (ctx.state.view === 'billing' && e.target.matches('[data-auto-renew]')) {
      const vmid = Number(e.target.closest('[data-server]').dataset.server);
      const enabled = e.target.checked;
      try {
        await api(`/api/billing/servers/${vmid}/auto-renew`, { method: 'PUT', body: { enabled } });
        data.servers.find((x) => x.vmid === vmid).autoRenew = enabled;
        toast(enabled ? 'Auto-renew is on: one month is paid from your wallet before the end date' : 'Auto-renew is off');
      } catch (err) { e.target.checked = !enabled; fail(err); }
    }
    if (ctx.state.view === 'invoice' && e.target.name === 'method') {
      const form = e.target.form;
      form.querySelector('.bank-box').hidden = e.target.value !== 'bank';
      form.querySelector('#pay-btn').textContent = payLabel(e.target.value);
    }
  });

  detail().addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'topup-form') {
      e.preventDefault();
      const amount = Number(f.amount.value);
      $('#topup-error').textContent = '';
      if (!Number.isInteger(amount) || amount < data.topupMin) { $('#topup-error').textContent = `Enter at least ${rp(data.topupMin)} in whole rupiah.`; return; }
      try {
        const i = await api('/api/billing/topups', { method: 'POST', body: { amount } });
        openInvoice(i.number);
      } catch (err) { $('#topup-error').textContent = err.message; }
    }
    if (f.id === 'profile-form') {
      e.preventDefault();
      try {
        data.profile = await api('/api/billing/profile', { method: 'PUT', body: { name: f.name.value, address: f.address.value, taxId: f.taxId.value } });
        toast('Billing details saved; they appear on new invoices');
      } catch (err) { fail(err); }
    }
    if (f.id === 'pay-form') {
      e.preventDefault();
      const method = f.method.value;
      const btn = f.querySelector('#pay-btn');
      $('#pay-error').textContent = '';
      if (method === 'wallet' && !(await confirmAction(`Pay ${rp(inv.total)} from your wallet?`, 'Pay'))) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/billing/invoices/${encodeURIComponent(inv.number)}/pay`, { method: 'POST', body: { method, ...(method === 'bank' ? { reference: f.reference.value } : {}) } });
        if (r.redirectUrl) { location.href = r.redirectUrl; return; }
        if (r.paid) { toast('Paid. Thank you!'); return openInvoice(inv.number, { notice: inv.purpose === 'renewal' ? '<p>Paid from your wallet. The server end date has moved.</p>' : '<p>Paid.</p>' }); }
        if (method === 'bank') {
          toast(r.reported ? 'Thanks, we will confirm your transfer' : 'Transfer instructions are shown above');
          return openInvoice(inv.number);
        }
      } catch (err) { $('#pay-error').textContent = err.message; btn.disabled = false; }
    }
  });

  function route(hash) {
    if (hash === '#billing') { open(); return true; }
    const m = /^#billing\/([A-Z0-9]{1,8}-\d{6}-\d{4})$/.exec(hash);
    if (m) {
      // back from a payment page: the gateway's notification may take a moment, so look again a few times
      openInvoice(m[1]).then(async () => {
        for (let n = 0; n < 5 && inv?.number === m[1] && inv.status === 'unpaid' && ctx.state.view === 'invoice'; n += 1) {
          await new Promise((r) => setTimeout(r, 4000));
          if (ctx.state.view !== 'invoice' || inv?.number !== m[1]) return;
          const fresh = await api(`/api/billing/invoices/${encodeURIComponent(m[1])}`).catch(() => null);
          if (fresh?.status === 'paid') { inv = fresh; renderInvoice('<p>Payment received. Thank you!</p>'); return; }
        }
      });
      return true;
    }
    return false;
  }

  return { open, openInvoice, route, loadStatus };
}
