// Customer portal: chat with the AI assistant.
import { $, api, esc, toast, fail, confirmAction } from '/shared/ui.js';
import { icon } from '/shared/icons.js';
import { markdown } from '/shared/markdown.js';

const STARTERS = [
  'My website is not reachable after a restart',
  'How do I take a snapshot before an update?',
  'How are my servers doing?',
  'What is the status of my tickets?',
];
const CATEGORY = { server: 'Server', network: 'Network', storage: 'Storage', billing: 'Billing', account: 'Account', security: 'Security', other: 'Other' };

/** ctx: { state, renderList, setView(view, hash), openTicket(number) } */
export function createAssistant(ctx) {
  const detail = () => $('#detail');
  let status = { enabled: false };
  let conv = null;          // current conversation
  let list = [];
  let busy = false;

  async function loadStatus() {
    try { status = await api('/api/assistant'); } catch { status = { enabled: false }; }
    ctx.state.assistantEnabled = status.enabled;
    return status;
  }

  async function open(id = null) {
    ctx.setView('assistant', id ? `#assistant/${id}` : '#assistant');
    await loadStatus();
    if (!status.enabled) {
      detail().innerHTML = '<div class="page"><div class="empty"><h2>The assistant is not available</h2><p class="muted">Please use the <a href="#help">help center</a> or <a href="#support/new">open a ticket</a>.</p></div></div>';
      return;
    }
    try {
      list = await api('/api/assistant/conversations');
      conv = id ? await api(`/api/assistant/conversations/${id}`) : null;
    } catch (err) { fail(err); conv = null; }
    render();
  }

  function messageHtml(m) {
    if (m.role === 'user') return `<li class="chat-msg chat-user"><div class="chat-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></li>`;
    return `
      <li class="chat-msg chat-assistant" data-message="${m.id}">
        <div class="chat-bubble md">${markdown(m.content)}</div>
        ${m.sources.length ? `<p class="chat-sources small">Sources: ${m.sources.map((s) => `<a href="#help/${esc(s.slug)}">${esc(s.title)}</a>`).join(' · ')}</p>` : ''}
        ${m.handover ? `
          <div class="handover-card">
            <p><strong>Ticket for the support team</strong><br>${esc(m.handover.subject)}
              <span class="muted small">· ${esc(CATEGORY[m.handover.category] ?? m.handover.category)}${m.handover.vmid ? ` · server ${m.handover.vmid}` : ''}</span></p>
            <p class="small muted">${esc(m.handover.summary)}</p>
            ${conv.ticketNumber ? `<a class="btn" href="#support/${conv.ticketNumber}">Open ticket #${conv.ticketNumber}</a>`
              : `<button class="btn primary" data-handover="${m.id}">Create ticket</button> <span class="muted small">The conversation is attached.</span>`}
          </div>` : ''}
        <div class="chat-rate" role="group" aria-label="Was this answer helpful?">
          <button class="icon-btn" data-rate="up" aria-pressed="${m.rating === 1}" title="Helpful" aria-label="Helpful">👍</button>
          <button class="icon-btn" data-rate="down" aria-pressed="${m.rating === -1}" title="Not helpful" aria-label="Not helpful">👎</button>
        </div>
      </li>`;
  }

  function render() {
    const msgs = conv?.messages ?? [];
    detail().innerHTML = `
      <div class="page assistant-page">
        <header class="page-head">
          <div><h1>AI assistant</h1>
            <p class="lede">Answers from the help center and your own servers. It can't change anything; for a person, ask it or <a href="#support/new">open a ticket</a>.</p></div>
          <div class="row"><button class="btn" data-new-chat>${icon('plus')}<span>New conversation</span></button></div>
        </header>
        <div class="assistant">
          <nav class="chat-list" aria-label="Conversations">
            ${list.length ? list.map((c) => `
              <button class="chat-list-item" data-open-chat="${c.id}" aria-current="${conv?.id === c.id}">
                <span>${esc(c.title)}</span>${c.ticketNumber ? `<span class="tag">#${c.ticketNumber}</span>` : ''}
              </button>`).join('') : '<p class="muted small">No conversations yet.</p>'}
          </nav>
          <section class="chat" aria-label="Conversation">
            <ol class="chat-log" aria-live="polite">
              ${msgs.length ? msgs.map(messageHtml).join('') : `
                <li class="chat-empty"><p class="muted">Ask anything about your servers, the panel or your tickets. For example:</p>
                  <div class="chips">${STARTERS.map((s) => `<button class="chip" data-starter="${esc(s)}">${esc(s)}</button>`).join('')}</div></li>`}
              ${busy ? '<li class="chat-msg chat-assistant"><div class="chat-bubble muted"><span class="spinner" aria-hidden="true"></span> Thinking…</div></li>' : ''}
            </ol>
            <form id="chat-form" class="chat-form">
              <label class="sr-only" for="chat-input">Your question</label>
              <textarea id="chat-input" name="message" rows="2" maxlength="2000" placeholder="Type your question… (Enter to send, Shift+Enter for a new line)" ${busy ? 'disabled' : ''}></textarea>
              <button class="btn primary" ${busy ? 'disabled' : ''}>Send</button>
            </form>
            <p class="muted small chat-foot">${status.usedToday ?? 0} of ${status.dailyLimit} questions today. Answers can be wrong; check important steps. Never share passwords here.</p>
          </section>
        </div>
      </div>`;
    const log = detail().querySelector('.chat-log');
    log.scrollTop = log.scrollHeight;
    if (!busy) detail().querySelector('#chat-input')?.focus();
  }

  async function send(text) {
    const message = text.trim();
    if (!message || busy) return;
    busy = true;
    conv = conv ?? { id: null, messages: [] };
    conv.messages = [...conv.messages, { role: 'user', content: message }];
    render();
    try {
      conv = conv.id
        ? await api(`/api/assistant/conversations/${conv.id}/messages`, { method: 'POST', body: { message } })
        : await api('/api/assistant/conversations', { method: 'POST', body: { message } });
      history.replaceState(null, '', `#assistant/${conv.id}`);
      list = await api('/api/assistant/conversations').catch(() => list);
      status.usedToday = (status.usedToday ?? 0) + 1;
    } catch (err) {
      fail(err);
      conv.messages = conv.messages.slice(0, -1);
      if (!conv.id) conv = null;
    }
    busy = false;
    render();
  }

  detail().addEventListener('click', async (e) => {
    if (ctx.state.view !== 'assistant') return;
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.starter) return send(t.dataset.starter);
    if (t.hasAttribute('data-new-chat')) { conv = null; history.replaceState(null, '', '#assistant'); return render(); }
    if (t.dataset.openChat) return open(Number(t.dataset.openChat));
    if (t.dataset.rate) {
      const id = Number(t.closest('[data-message]').dataset.message);
      try {
        await api(`/api/assistant/messages/${id}/rating`, { method: 'POST', body: { helpful: t.dataset.rate === 'up' } });
        const m = conv.messages.find((x) => x.id === id);
        if (m) m.rating = t.dataset.rate === 'up' ? 1 : -1;
        render();
        toast('Thanks for your feedback');
      } catch (err) { fail(err); }
      return;
    }
    if (t.dataset.handover) {
      if (!(await confirmAction('Send this to the support team as a ticket? The conversation is attached.', 'Create ticket'))) return;
      t.disabled = true;
      try {
        const ticket = await api(`/api/assistant/conversations/${conv.id}/handover`, { method: 'POST', body: { messageId: Number(t.dataset.handover) } });
        toast(`Ticket #${ticket.number} created`);
        ctx.openTicket(ticket.number);
      } catch (err) { fail(err); t.disabled = false; }
    }
  });
  detail().addEventListener('submit', (e) => {
    if (e.target.id !== 'chat-form') return;
    e.preventDefault();
    send(e.target.elements.message.value);
  });
  detail().addEventListener('keydown', (e) => {
    if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(e.target.value);
    }
  });

  function route(hash) {
    const m = /^#assistant(?:\/(\d+))?$/.exec(hash);
    if (!m) return false;
    open(m[1] ? Number(m[1]) : null);
    return true;
  }

  return { open, route, loadStatus };
}
