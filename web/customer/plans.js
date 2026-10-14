// Customer portal: choosing a plan when creating a server, and moving a server
// to a larger plan. Prices come from the panel (incl. tax); the invoice has the lines.
import { $, api, esc, toast, confirmAction } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;
const size = (p) => `${p.cores} vCPU · ${gb(p.memoryMb)} RAM · ${p.diskGb} GB disk${p.gpuName ? ` · ${esc(p.gpuName)}` : ''}`;
const MONTHS = [1, 3, 6, 12];

/** Does a plan fit in what is left of the customer's limits (and the image's minimum disk)? */
const fits = (p, left, minDiskGb = 0) => p.cores <= left.cores && p.memoryMb <= left.memoryMb && p.diskGb <= left.diskGb && p.diskGb >= minDiskGb;

/**
 * The "Size" part of the create form when plans exist. data: GET /api/plans.
 * With requirePlan off, "Custom size" is the last choice and shows the old fields.
 */
export function planFieldset(data, left, customFieldsHtml) {
  const usable = data.plans.filter((p) => fits(p, left));
  const first = usable[0];
  return `
    <fieldset class="plan-fieldset">
      <legend>Plan</legend>
      <div class="choices plan-choices">
        ${data.plans.map((p) => `
          <label class="choice plan-choice">
            <input type="radio" name="planId" value="${p.id}" ${p === first ? 'checked' : ''} ${fits(p, left) ? '' : 'disabled'}>
            <span><strong>${esc(p.name)}</strong>
              <span class="small">${size(p)}</span>
              ${p.billed ? `<span class="plan-price">${rp(p.prices[1].total)}<span class="muted small"> / month incl. tax</span></span>`
                : '<span class="muted small">No charge</span>'}
              ${p.description ? `<span class="muted small">${esc(p.description)}</span>` : ''}
              ${fits(p, left) ? '' : '<span class="muted small">Does not fit in what is left of your limits</span>'}
            </span>
          </label>`).join('')}
        ${data.requirePlan ? '' : `
          <label class="choice plan-choice">
            <input type="radio" name="planId" value="" ${first ? '' : 'checked'}>
            <span><strong>Custom size</strong><span class="muted small">Choose CPU, memory and disk yourself</span></span>
          </label>`}
      </div>
      <div class="custom-size" ${first ? 'hidden' : ''}>${data.requirePlan ? '' : customFieldsHtml}</div>
      <div class="plan-period" hidden>
        <p class="small muted" style="margin:12px 0 6px">Pay in advance from your wallet</p>
        <div class="segmented" role="radiogroup" aria-label="Period">
          ${MONTHS.map((m) => `<button type="button" role="radio" data-plan-months="${m}" aria-checked="${m === 1}">${m} mo</button>`).join('')}
        </div>
        <p class="plan-total" aria-live="polite"></p>
      </div>
    </fieldset>`;
}

/** Shows the period, total and wallet check for the chosen plan; returns the submit label. */
export function updatePlanChoice(form, data) {
  const id = Number(form.planId?.value || 0);
  const plan = data?.plans.find((p) => p.id === id) ?? null;
  const custom = form.querySelector('.custom-size');
  if (custom) {
    custom.hidden = !!plan;
    // hidden fields must not block the form
    custom.querySelectorAll('input, select').forEach((f) => { f.disabled = !!plan; });
  }
  const period = form.querySelector('.plan-period');
  const button = $('#create-submit');
  if (!plan?.billed) {
    if (period) period.hidden = true;
    button.textContent = 'Create server';
    button.disabled = false;
    return;
  }
  period.hidden = false;
  const months = Number(form.dataset.months || 1);
  form.querySelectorAll('[data-plan-months]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.planMonths) === months)));
  const price = plan.prices[months];
  const balance = data.billing.balance;
  const short = balance < price.total;
  form.querySelector('.plan-total').innerHTML = `
    <strong>${rp(price.total)}</strong> for ${months} month${months > 1 ? 's' : ''}
    <span class="muted small">(${price.discount ? `discount ${rp(price.discount)}, ` : ''}incl. tax ${rp(price.tax)}) · wallet ${rp(balance)}</span>
    ${short ? `<br><span class="warn-text">Not enough balance. <a href="#billing">Top up ${rp(price.total - balance)} or more</a>, then come back.</span>` : ''}`;
  button.textContent = `Pay ${rp(price.total)} and create`;
  button.disabled = short;
}

/** { planId, months } for the request, or {} for a custom size. */
export function planBody(form, data) {
  const id = Number(form.planId?.value || 0);
  if (!id) return {};
  const plan = data.plans.find((p) => p.id === id);
  return { planId: id, ...(plan?.billed ? { months: Number(form.dataset.months || 1) } : {}) };
}

// ---- Upgrade ------------------------------------------------------------------------

/** ctx: { back() } — renders the "Change plan" page for a server into #detail. */
export async function openUpgrade(vm, ctx) {
  $('#detail').innerHTML = '<div class="detail-inner"><p class="muted">Loading…</p></div>';
  let d;
  try { d = await api(`/api/vms/${vm.vmid}/plans`); } catch (err) { $('#detail').innerHTML = ''; throw err; }
  const running = vm.status === 'running';
  const head = `
    <button class="link-btn" data-back-to-server>${icon('back', { size: 16 })}<span>${esc(vm.name)}</span></button>
    <div class="detail-head"><div><h1>Change plan of ${esc(vm.name)}</h1>
      <p class="muted plan-line">Now: plan <strong>${esc(d.current?.name ?? '')}</strong>${d.current ? ` (${size(d.current)})` : ''}.
        A server can move to a larger plan; disks can't shrink, so moving down is not possible.</p></div></div>`;
  if (!d.options.length) {
    $('#detail').innerHTML = `<div class="detail-inner">${head}<div class="pending"><p>There is no larger plan for this server.</p>
      <p class="muted">Need more? <a href="#support/new">Ask support</a>.</p></div></div>`;
    return;
  }
  $('#detail').innerHTML = `
    <div class="detail-inner">${head}
      <form id="upgrade-form" class="create-form" novalidate>
        <fieldset><legend>New plan</legend>
          <div class="choices plan-choices">
            ${d.options.map((p, i) => `
              <label class="choice plan-choice">
                <input type="radio" name="planId" value="${p.id}" ${i === 0 ? 'checked' : ''}>
                <span><strong>${esc(p.name)}</strong><span class="small">${size(p)}</span>
                  ${p.cost.total ? `<span class="plan-price">${rp(p.cost.total)}<span class="muted small"> now, for the ${p.cost.days} days already paid (incl. tax)</span></span>`
                    : '<span class="muted small">No charge now</span>'}
                  ${p.billed ? `<span class="muted small">Then ${rp(p.prices[1].total)} per month</span>` : ''}
                </span>
              </label>`).join('')}
          </div>
          ${d.balance != null ? `<p class="small muted">Paid from your wallet (balance ${rp(d.balance)}).</p>` : ''}
          ${running ? `<label class="check"><input type="checkbox" name="restart" checked>
            <span>Restart the server now <span class="muted">so the new CPU and memory take effect. Without it, they wait for the next restart.</span></span></label>` : ''}
        </fieldset>
        <p id="upgrade-error" class="form-error" role="alert"></p>
        <div class="row"><button class="btn primary" id="upgrade-submit">Change plan</button>
          <button type="button" class="btn ghost" data-back-to-server>Cancel</button></div>
      </form>
    </div>`;
  const form = $('#upgrade-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = d.options.find((x) => x.id === Number(form.planId.value));
    const err = $('#upgrade-error');
    err.textContent = '';
    if (d.balance != null && p.cost.total > d.balance) { err.innerHTML = `Not enough balance: ${rp(p.cost.total)} needed. <a href="#billing">Top up</a> first.`; return; }
    const msg = `Move ${vm.name} to plan ${p.name}${p.cost.total ? ` and pay ${rp(p.cost.total)} from your wallet` : ''}? The disk grows to ${p.diskGb} GB and can't be made smaller again.`;
    if (!(await confirmAction(msg, 'Change plan'))) return;
    $('#upgrade-submit').disabled = true;
    try {
      const r = await api(`/api/vms/${vm.vmid}/plan`, { method: 'POST', body: { planId: p.id, restart: !!form.restart?.checked } });
      toast(`Now on plan ${r.plan.name}.${r.restartTask ? ' Restarting to apply it.' : r.pendingRestart ? ' CPU and memory take effect at the next restart.' : ''}`);
      ctx.back();
    } catch (ex) { err.textContent = ex.message; $('#upgrade-submit').disabled = false; }
  });
}
