// Admin portal: ticket desk and knowledge-base editor. Same shape as infra.js:
// tabs(), handles(), load(), render(), onClick(), onChange(), onSubmit().
import { markdown } from '/shared/markdown.js';

const STATUS = { open: 'Open', waiting: 'Waiting for customer', resolved: 'Solved', closed: 'Closed' };
const PRIORITY = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const VISIBILITY = { public: 'Everyone (also signed out)', customers: 'Signed-in customers', internal: 'Agents only' };
const utc = (d) => new Date(`${String(d).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(d) ? '' : 'Z'}`);
const when = (d) => utc(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function createDesk({ root, api, toast, fail, confirmAction, esc, getMe }) {
  const st = {
    perms: new Set(), filter: { status: 'active', queue: '', q: '', mine: false },
    list: null, ticket: null, kb: null, article: null, editing: null, preview: false,
  };
  const can = (p) => st.perms.has(p);
  const body = () => root.querySelector('#admin-body');
  const TABS = [['tickets', 'Tickets', 'support.read'], ['kb', 'Knowledge base', 'support.read'], ['ai', 'AI assistant', 'support.read']];

  // ---- loading ---------------------------------------------------------------------
  async function loadList() {
    const p = new URLSearchParams();
    if (st.filter.status) p.set('status', st.filter.status);
    if (st.filter.queue) p.set('queue', st.filter.queue);
    if (st.filter.q) p.set('q', st.filter.q);
    if (st.filter.mine) p.set('mine', '1');
    st.list = await api(`/api/admin/support/tickets?${p}`);
  }
  async function load(tab) {
    if (tab === 'tickets') {
      await loadList();
      if (st.ticket) st.ticket = await api(`/api/admin/support/tickets/${st.ticket.number}`).catch(() => null);
    }
    if (tab === 'kb') st.kb = await api('/api/admin/kb');
    if (tab === 'ai') st.ai = await api('/api/admin/ai');
  }
  function render(tab) {
    if (tab === 'tickets') renderTickets();
    if (tab === 'kb') renderKb();
    if (tab === 'ai') renderAi();
  }
  async function refresh(tab) {
    try { await load(tab); render(tab); } catch (err) { fail(err); }
  }

  // ---- tickets ---------------------------------------------------------------------
  function renderTickets() {
    const c = st.list?.counts ?? {};
    body().innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><span class="muted small">Open</span><strong>${c.open ?? 0}</strong></div>
        <div class="kpi"><span class="muted small">Urgent or high, open</span><strong class="${c.urgent ? 'warn-text' : ''}">${c.urgent ?? 0}</strong></div>
        <div class="kpi"><span class="muted small">Waiting for customer</span><strong>${c.waiting ?? 0}</strong></div>
        <div class="kpi"><span class="muted small">Solved (7 days)</span><strong>${c.solvedWeek ?? 0}</strong></div>
      </div>
      <form id="desk-filter" class="activity-filter" role="search">
        <label class="grow"><span class="sr-only">Search tickets</span>
          <input type="search" name="q" value="${esc(st.filter.q)}" placeholder="Ticket #, subject, customer email, server ID"></label>
        <label><span class="sr-only">Status</span><select name="status">
          ${[['active', 'Open and waiting'], ['open', 'Open'], ['waiting', 'Waiting for customer'], ['resolved', 'Solved'], ['closed', 'Closed'], ['', 'All']]
            .map(([v, l]) => `<option value="${v}" ${st.filter.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label><span class="sr-only">Queue</span><select name="queue">
          ${[['', 'All queues'], ['L1', 'L1 · first response'], ['L2', 'L2 · network & compute'], ['L3', 'L3 · security']]
            .map(([v, l]) => `<option value="${v}" ${st.filter.queue === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="inline-check"><input type="checkbox" name="mine" ${st.filter.mine ? 'checked' : ''}> Mine</label>
        <button class="btn">Filter</button>
      </form>
      <div class="desk">
        <div class="desk-list" role="list">
          ${st.list?.tickets.length ? st.list.tickets.map((t) => `
            <button type="button" class="desk-item" role="listitem" data-open-ticket="${t.number}" aria-current="${st.ticket?.number === t.number}">
              <span class="desk-item-top"><span class="mono">#${t.number}</span>
                <span class="tag ${t.priority === 'urgent' || t.priority === 'high' ? 'warn' : ''}">${PRIORITY[t.priority]}</span>
                <span class="tag">${t.queue}</span>${t.zammadError ? '<span class="tag warn" title="Not synced to Zammad">sync</span>' : ''}</span>
              <strong>${esc(t.subject)}</strong>
              <span class="muted small">${esc(t.email)} · ${STATUS[t.status]} · ${esc(when(t.updatedAt))}</span>
            </button>`).join('') : '<p class="muted">No tickets match.</p>'}
        </div>
        <div class="desk-detail">${st.ticket ? ticketView(st.ticket) : '<p class="muted">Choose a ticket.</p>'}</div>
      </div>`;
  }

  function ticketView(t) {
    const me = getMe();
    const write = can('support.write');
    return `
      <header class="desk-head">
        <div><h2 class="h2">${esc(t.subject)}</h2>
          <p class="muted small"><span class="mono">#${t.number}</span> · ${esc(t.email)} · opened ${esc(when(t.createdAt))}
            ${t.context ? ` · server <span class="mono">${esc(t.context.name ?? '')} (${t.context.vmid})</span>, ${esc(t.context.status ?? '')}` : ''}</p></div>
      </header>
      <div class="desk-controls">
        <label>Status <select data-ticket-field="status" ${write ? '' : 'disabled'}>${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${t.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Priority <select data-ticket-field="priority" ${write ? '' : 'disabled'}>${Object.entries(PRIORITY).map(([v, l]) => `<option value="${v}" ${t.priority === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Queue <select data-ticket-field="queue" ${write ? '' : 'disabled'}>${['L1', 'L2', 'L3'].map((q) => `<option ${t.queue === q ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
        ${write ? (t.assigneeId === me.id ? '<button class="btn ghost" data-assign="none">Unassign me</button>' : '<button class="btn" data-assign="me">Assign to me</button>') : ''}
        ${can('kb.write') ? '<button class="btn ghost" data-kb-draft>Draft article from this ticket</button>' : ''}
      </div>
      ${t.zammad || t.zammadError ? `<p class="small ${t.zammadError ? 'warn-text' : 'muted'}">Zammad: ${t.zammad ? `ticket ${t.zammad.id}, synced ${esc(when(t.zammad.syncedAt))}` : 'not created yet'}${t.zammadError ? ` · ${esc(t.zammadError)}` : ''}</p>` : ''}
      <div class="desk-body">
        <div>
          <ol class="conversation">
            ${t.messages.map((m) => `
              <li class="msg msg-${m.author}${m.internal ? ' msg-internal' : ''}">
                <div class="msg-head"><strong>${esc(m.name)}${m.internal ? ' <span class="tag warn">Internal note</span>' : ''}</strong><span class="muted small">${esc(when(m.createdAt))}</span></div>
                <div class="msg-body md">${markdown(m.body)}</div>
              </li>`).join('')}
          </ol>
          ${write ? `
            <form id="desk-reply" class="email-form" novalidate>
              <label>Reply <textarea name="body" rows="5" maxlength="20000" required placeholder="Markdown: **bold**, \`code\`, lists, [link](https://…)"></textarea></label>
              <div class="row">
                <label class="inline-check"><input type="checkbox" name="internal"> Internal note (the customer doesn't see it)</label>
                <label class="inline-check">then
                  <select name="status"><option value="">wait for the customer</option><option value="resolved">mark solved</option><option value="open">keep open</option></select></label>
                <button class="btn primary">Send</button>
              </div>
            </form>` : ''}
        </div>
        <aside class="desk-side">
          <section><h3 class="h3">Customer</h3>
            <p class="small">${esc(t.customer.email)}<br><span class="muted">since ${esc(utc(t.customer.createdAt).toLocaleDateString())} · ${t.customer.tickets} ticket${t.customer.tickets === 1 ? '' : 's'} · 2FA ${t.customer.twoFactor ? 'on' : 'off'}</span></p>
            <ul class="plain-list small">${t.customer.servers.map((s) => `<li><span class="mono">${s.vmid}</span> ${esc(s.name)} <span class="muted">${esc(s.status ?? '')}</span></li>`).join('') || '<li class="muted">No servers</li>'}</ul>
          </section>
          <section><h3 class="h3">Recent activity</h3>
            <ul class="plain-list small">${t.customer.activity.slice(0, 8).map((a) => `<li><span class="muted">${esc(when(a.createdAt))}</span> ${esc(a.action)}${a.vmid ? ` <span class="mono">${a.vmid}</span>` : ''}</li>`).join('') || '<li class="muted">Nothing yet</li>'}</ul>
          </section>
          <section><h3 class="h3">Knowledge base</h3>
            ${t.suggestions.length ? `<ul class="plain-list small">${t.suggestions.map((a) => `
              <li><strong>${esc(a.title)}</strong><br>${write ? `<button type="button" class="link-btn" data-insert-article="${esc(a.slug)}" data-title="${esc(a.title)}">Add link to reply</button>` : ''}</li>`).join('')}</ul>`
              : '<p class="muted small">No matching article. Solved it? Draft one from this ticket.</p>'}
          </section>
        </aside>
      </div>`;
  }

  async function openTicket(number) {
    try {
      st.ticket = await api(`/api/admin/support/tickets/${number}`);
      renderTickets();
    } catch (err) { fail(err); }
  }

  // ---- knowledge base ------------------------------------------------------------------
  function renderKb() {
    if (st.editing) return renderEditor();
    const k = st.kb;
    const s = k.stats;
    const rate = s.helpful + s.notHelpful ? `${Math.round((s.helpful / (s.helpful + s.notHelpful)) * 100)}%` : '–';
    body().innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><span class="muted small">Published</span><strong>${s.published}</strong></div>
        <div class="kpi"><span class="muted small">Drafts</span><strong>${s.drafts}</strong></div>
        <div class="kpi"><span class="muted small">Views</span><strong>${s.views}</strong></div>
        <div class="kpi"><span class="muted small">Found helpful</span><strong>${rate}</strong></div>
      </div>
      <div class="section-head"><p class="muted" style="margin:0">Articles for the customer help center and for agents. Markdown, with drafts and visibility.</p>
        ${can('kb.write') ? '<button class="btn primary" data-kb-new>New article</button>' : ''}</div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Title</th><th>Category</th><th>Visible to</th><th>Status</th><th>Views</th><th>Helpful</th><th><span class="sr-only">Edit</span></th></tr></thead>
        <tbody>${k.articles.length ? k.articles.map((a) => `
          <tr><td>${esc(a.title)}${a.sourceTicket ? ` <span class="muted small">from #${a.sourceTicket}</span>` : ''}</td><td>${esc(a.category)}</td>
            <td class="small">${VISIBILITY[a.visibility]}</td>
            <td><span class="tag ${a.status === 'published' ? 'ok' : ''}">${a.status === 'published' ? 'Published' : 'Draft'}</span></td>
            <td>${a.views}</td><td>${a.helpful + a.notHelpful ? `${a.helpful} / ${a.helpful + a.notHelpful}` : '–'}</td>
            <td class="actions"><button class="btn" data-kb-edit="${a.id}">${can('kb.write') ? 'Edit' : 'View'}</button></td></tr>`).join('')
          : '<tr><td colspan="7" class="muted">No articles yet.</td></tr>'}</tbody>
      </table></div>
      <section class="security-card settings-card">
        <div class="settings-head"><h2 class="twofa-title">Searches without an answer (30 days)</h2>
          <p class="muted">What customers looked for in the help center and didn't find. Good candidates for new articles.</p></div>
        ${k.gaps.length ? `<ul class="plain-list">${k.gaps.map((g) => `
          <li class="gap-row"><span><span class="mono">“${esc(g.query)}”</span> <span class="muted small">${g.count}× · last ${esc(when(g.lastAt))}</span></span>
            ${can('kb.write') ? `<button class="btn ghost" data-kb-gap="${esc(g.query)}">Write article</button>` : ''}</li>`).join('')}</ul>`
          : '<p class="muted small">None. Every search found something.</p>'}
      </section>`;
  }

  function renderEditor() {
    const a = st.editing;
    const ro = !can('kb.write');
    body().innerHTML = `
      <p><button class="link-btn" data-kb-back>‹ All articles</button></p>
      <form id="kb-form" class="email-form kb-editor" novalidate>
        <fieldset class="plain-fieldset" ${ro ? 'disabled' : ''}>
        <label>Title <input name="title" maxlength="150" required value="${esc(a.title ?? '')}"></label>
        <div class="grid-3">
          <label>Category <input name="category" maxlength="40" value="${esc(a.category ?? 'General')}" list="kb-categories"></label>
          <label>Visible to <select name="visibility">${Object.entries(VISIBILITY).map(([v, l]) => `<option value="${v}" ${(a.visibility ?? 'customers') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Status <select name="status"><option value="draft" ${a.status !== 'published' ? 'selected' : ''}>Draft</option><option value="published" ${a.status === 'published' ? 'selected' : ''}>Published</option></select></label>
        </div>
        <datalist id="kb-categories">${[...new Set((st.kb?.articles ?? []).map((x) => x.category))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="segmented" role="tablist" aria-label="Editor">
          <button type="button" role="tab" aria-selected="${!st.preview}" aria-pressed="${!st.preview}" data-kb-mode="write">Write</button>
          <button type="button" role="tab" aria-selected="${st.preview}" aria-pressed="${st.preview}" data-kb-mode="preview">Preview</button>
        </div>
        <label ${st.preview ? 'hidden' : ''}><span class="sr-only">Text (Markdown)</span>
          <textarea name="body" rows="18" class="mono">${esc(a.body ?? '')}</textarea></label>
        <div class="md kb-article kb-preview" ${st.preview ? '' : 'hidden'}>${markdown(a.body ?? '')}</div>
        ${a.sourceTicket ? `<p class="small warn-text">Drafted from ticket #${a.sourceTicket}: remove names, addresses and anything personal before publishing.</p>` : ''}
        <div class="row">
          <button class="btn primary">Save</button>
          ${a.id ? '<button type="button" class="btn danger" data-kb-delete>Delete</button>' : ''}
          ${a.id && a.status === 'published' ? `<span class="muted small">Link for replies: <span class="mono">#help/${esc(a.slug)}</span></span>` : ''}
        </div>
        </fieldset>
      </form>`;
  }

  const formArticle = (f) => {
    const el = f.elements;
    return { title: el.title.value.trim(), category: el.category.value.trim() || 'General', visibility: el.visibility.value, status: el.status.value, body: el.body.value };
  };

  // ---- events ------------------------------------------------------------------------
  // ---- AI assistant: what customers asked, what it did, where it handed over ----------
  function renderAi() {
    const a = st.ai;
    const t = a.totals;
    const rated = t.helpful + t.notHelpful;
    body().innerHTML = `
      ${a.settings.enabled ? '' : '<p class="notice"><span>The assistant is off. Set up the provider under <strong>Settings → AI assistant</strong>.</span></p>'}
      <div class="kpi-row">
        <div class="kpi"><span class="muted small">Conversations (${a.days} days)</span><strong>${t.conversations}</strong></div>
        <div class="kpi"><span class="muted small">Questions</span><strong>${t.questions}</strong></div>
        <div class="kpi"><span class="muted small">Handed over as tickets</span><strong>${t.handovers}</strong></div>
        <div class="kpi"><span class="muted small">Rated helpful</span><strong>${rated ? `${Math.round((t.helpful / rated) * 100)}%` : '–'}</strong></div>
        <div class="kpi"><span class="muted small">Tokens in / out</span><strong class="small-num">${t.tokensIn.toLocaleString()} / ${t.tokensOut.toLocaleString()}</strong></div>
      </div>
      <div class="desk">
        <div class="desk-list" role="list">
          ${a.conversations.length ? a.conversations.map((c) => `
            <button type="button" class="desk-item" role="listitem" data-open-ai="${c.id}" aria-current="${st.aiConv?.id === c.id}">
              <span class="desk-item-top"><span class="muted small">${esc(c.email)}</span>
                ${c.ticketNumber ? `<span class="tag">ticket #${c.ticketNumber}</span>` : ''}${c.worstRating === -1 ? '<span class="tag warn">not helpful</span>' : ''}</span>
              <strong>${esc(c.title)}</strong>
              <span class="muted small">${c.questions} question${c.questions === 1 ? '' : 's'} · ${esc(when(c.updatedAt))}</span>
            </button>`).join('') : '<p class="muted">No conversations yet.</p>'}
        </div>
        <div class="desk-detail">${st.aiConv ? aiConversationView(st.aiConv) : '<p class="muted">Choose a conversation to see what the assistant looked up and answered.</p>'}</div>
      </div>`;
  }

  function aiConversationView(c) {
    return `
      <header class="desk-head"><h2 class="h2">${esc(c.title)}</h2>
        <p class="muted small">${esc(c.email)} · ${esc(when(c.createdAt))}${c.ticketNumber ? ` · became ticket <span class="mono">#${c.ticketNumber}</span>` : ''}</p></header>
      <ol class="conversation">
        ${c.messages.map((m) => {
          if (m.role === 'tool') return `<li class="msg msg-tool"><details><summary class="small muted">Tool result: ${esc(m.toolName)}</summary><pre class="activity-json">${esc(m.content)}</pre></details></li>`;
          if (m.role === 'assistant' && !m.content && m.toolCalls.length) {
            return `<li class="msg msg-tool small muted">Looked up: ${m.toolCalls.map((x) => `<span class="mono">${esc(x.name)}(${esc(JSON.stringify(x.input))})</span>`).join(', ')}</li>`;
          }
          return `<li class="msg msg-${m.role === 'user' ? 'customer' : 'agent'}">
            <div class="msg-head"><strong>${m.role === 'user' ? 'Customer' : 'Assistant'}</strong>
              <span class="muted small">${m.rating === 1 ? '👍 ' : m.rating === -1 ? '👎 ' : ''}${esc(when(m.createdAt))}</span></div>
            <div class="msg-body md">${markdown(m.content)}</div>
            ${m.toolCalls.length ? `<p class="small muted">Looked up: ${m.toolCalls.map((x) => `<span class="mono">${esc(x.name)}</span>`).join(', ')}</p>` : ''}
            ${m.handover ? `<p class="small">Proposed ticket: <strong>${esc(m.handover.subject)}</strong> (${esc(m.handover.category)}, ${esc(m.handover.priority)})</p>` : ''}
          </li>`;
        }).join('')}
      </ol>`;
  }

  async function onClick(e, tab) {
    const t = e.target.closest('button');
    if (!t) return false;
    const d = t.dataset;
    if (tab === 'tickets') {
      if (d.openTicket) { await openTicket(Number(d.openTicket)); return true; }
      if (d.assign) {
        try {
          st.ticket = await api(`/api/admin/support/tickets/${st.ticket.number}`, { method: 'PATCH', body: { assigneeId: d.assign === 'me' ? getMe().id : null } });
          await loadList(); renderTickets();
        } catch (err) { fail(err); }
        return true;
      }
      if (d.kbDraft !== undefined) {
        try {
          const a = await api(`/api/admin/support/tickets/${st.ticket.number}/kb-draft`, { method: 'POST' });
          toast('Draft article created under Knowledge base');
          st.editing = await api(`/api/admin/kb/${a.id}`);
          st.preview = false;
          st.kb = await api('/api/admin/kb');
          root.querySelector('[data-admin-tab="kb"]')?.click();
        } catch (err) { fail(err); }
        return true;
      }
      if (d.insertArticle) {
        const ta = root.querySelector('#desk-reply textarea');
        if (ta) { ta.value = `${ta.value ? `${ta.value.trimEnd()}\n\n` : ''}See: [${d.title}](#help/${d.insertArticle})`; ta.focus(); }
        return true;
      }
    }
    if (tab === 'ai' && d.openAi) {
      try { st.aiConv = await api(`/api/admin/ai/conversations/${d.openAi}`); renderAi(); } catch (err) { fail(err); }
      return true;
    }
    if (tab === 'kb') {
      if (d.kbNew !== undefined || d.kbGap !== undefined) {
        st.editing = { title: d.kbGap ? d.kbGap.charAt(0).toUpperCase() + d.kbGap.slice(1) : '', category: 'General', visibility: 'customers', status: 'draft', body: '' };
        st.preview = false; renderEditor(); return true;
      }
      if (d.kbEdit) {
        try { st.editing = await api(`/api/admin/kb/${d.kbEdit}`); st.preview = false; renderEditor(); } catch (err) { fail(err); }
        return true;
      }
      if (d.kbBack !== undefined) { st.editing = null; await refresh('kb'); return true; }
      if (d.kbMode) {
        const f = root.querySelector('#kb-form');
        st.editing = { ...st.editing, ...formArticle(f) };
        st.preview = d.kbMode === 'preview';
        renderEditor(); return true;
      }
      if (d.kbDelete !== undefined) {
        if (!(await confirmAction(`Delete “${st.editing.title}”? Links to it stop working.`, 'Delete'))) return true;
        try { await api(`/api/admin/kb/${st.editing.id}`, { method: 'DELETE' }); toast('Article deleted'); st.editing = null; await refresh('kb'); } catch (err) { fail(err); }
        return true;
      }
    }
    return false;
  }

  async function onChange(e, tab) {
    if (tab === 'tickets' && e.target.dataset.ticketField) {
      try {
        st.ticket = await api(`/api/admin/support/tickets/${st.ticket.number}`, { method: 'PATCH', body: { [e.target.dataset.ticketField]: e.target.value } });
        toast('Ticket updated');
        await loadList(); renderTickets();
      } catch (err) { fail(err); }
    }
  }

  async function onSubmit(e, tab) {
    const f = e.target;
    if (f.id === 'desk-filter') {
      const el = f.elements;
      st.filter = { status: el.status.value, queue: el.queue.value, q: el.q.value.trim(), mine: el.mine.checked };
      await refresh('tickets');
    }
    if (f.id === 'desk-reply') {
      const el = f.elements;
      const text = el.body.value.trim();
      if (!text) return;
      f.querySelector('.btn.primary').disabled = true;
      try {
        st.ticket = await api(`/api/admin/support/tickets/${st.ticket.number}/messages`, {
          method: 'POST', body: { body: text, internal: el.internal.checked, ...(el.status.value ? { status: el.status.value } : {}) },
        });
        toast(el.internal.checked ? 'Note added' : 'Reply sent');
        await loadList(); renderTickets();
      } catch (err) { fail(err); f.querySelector('.btn.primary').disabled = false; }
    }
    if (f.id === 'kb-form') {
      const data = formArticle(f);
      try {
        const saved = st.editing.id
          ? await api(`/api/admin/kb/${st.editing.id}`, { method: 'PUT', body: data })
          : await api('/api/admin/kb', { method: 'POST', body: data });
        toast(saved.status === 'published' ? 'Article published' : 'Draft saved');
        st.editing = saved;
        st.kb = await api('/api/admin/kb');
        renderEditor();
      } catch (err) { fail(err); }
    }
  }

  return {
    setPermissions(list) { st.perms = new Set(list); },
    tabs: () => TABS.filter(([, , perm]) => can(perm)).map(([id, label]) => [id, label]),
    handles: (tab) => TABS.some(([id]) => id === tab),
    load, render, onClick, onChange, onSubmit,
  };
}
