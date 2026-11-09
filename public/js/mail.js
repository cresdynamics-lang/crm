/**
 * Team mail: emails forwarded to you inside CRES OS (and replies from people
 * you emailed). Reply to the outside sender as "<You> - <Team>, Cres Dynamics
 * Ltd" (their reply comes back to info@ and is routed to you), forward inside,
 * or write a new email.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = () => (typeof CresToast !== 'undefined' ? CresToast : { success() {}, error() {}, info() {}, warning() {} });
  const STAFF = ['admin', 'director', 'sales', 'developer', 'finance', 'hr', 'pm'];

  let box = 'inbox';
  let items = [];
  let current = null;
  let me = { from: '', replyTo: 'info@cresdynamics.com' };

  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date().toDateString() === d.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };

  async function boot() {
    if (!CresAPI.getAccess()) return location.replace(`/login?next=${encodeURIComponent('/mail')}`);
    let user;
    try {
      user = (await CresAPI.verify()).user || CresAPI.getUser();
    } catch {
      return location.replace(`/login?next=${encodeURIComponent('/mail')}`);
    }
    if (!STAFF.includes(user?.role)) {
      $('ml-denied').hidden = false;
      return;
    }
    $('ml-main').hidden = false;
    bind();
    live();
    await loadList();
    setInterval(() => document.visibilityState === 'visible' && loadList({ quiet: true }), 60000);
  }

  function live() {
    if (typeof io === 'undefined') return;
    const socket = io({ path: '/socket.io', auth: (cb) => cb({ token: CresAPI.getAccess() }), transports: ['websocket', 'polling'] });
    socket.on('mail:new', (p) => {
      T().info('New team mail', { detail: p.subject || '' });
      loadList({ quiet: true });
    });
  }

  async function loadList({ quiet = false } = {}) {
    try {
      const res = await CresAPI.request(`/api/mail?box=${box}`, { noCache: true });
      items = res.data || [];
      if (res.meta?.me) me = res.meta.me;
      $('ml-identity').textContent = me.from ? `You send as: ${me.from}` : '';
      const c = res.meta?.counts;
      if (c) document.querySelector('[data-count="inbox"]').textContent = c.unread ? String(c.unread) : '';
      render();
    } catch (err) {
      if (!quiet) $('ml-list').innerHTML = `<li class="mt-muted small ib-empty">${esc(err.message)}</li>`;
    }
  }

  function render() {
    if (!items.length) {
      $('ml-list').innerHTML = `<li class="mt-muted small ib-empty">${box === 'sent' ? 'You have not sent any emails yet.' : box === 'done' ? 'Nothing marked done.' : 'No team mail. Emails forwarded to you appear here.'}</li>`;
      return;
    }
    $('ml-list').innerHTML = items
      .map((m) => {
        if (box === 'sent') {
          return `<li class="ib-item" data-id="${esc(m.id)}"><div class="ib-item-top"><span class="ib-from">To ${esc(m.to_email)}</span><span class="ib-when">${when(m.created_at)}</span></div>
            <div class="ib-subj">${esc(m.subject)}</div><div class="ib-snip">${esc(m.body)}</div>${m.status === 'failed' ? '<span class="ib-chip scam">Not sent</span>' : ''}</li>`;
        }
        const who = m.auto_routed ? `${m.original_from_name || m.original_from_email}` : `${m.from_user_name || 'CRES OS'} → you${m.to_team ? ' (team)' : ''}`;
        return `<li class="ib-item${m.status === 'unread' ? ' unread' : ''}${current?.id === m.id ? ' on' : ''}" data-id="${esc(m.id)}">
          <div class="ib-item-top"><span class="ib-from">${esc(who)}</span><span class="ib-when">${when(m.created_at)}</span></div>
          <div class="ib-subj">${m.attachment_count ? '📎 ' : ''}${esc(m.subject)}</div>
          <div class="ib-snip">${esc(m.note || m.body || '')}</div>
          ${m.auto_routed ? '<span class="ib-chip auto">Reply to your email</span>' : ''}
        </li>`;
      })
      .join('');
  }

  async function open(id) {
    if (box === 'sent') {
      const m = items.find((x) => x.id === id);
      if (!m) return;
      $('ml-placeholder').hidden = true;
      $('ml-message').hidden = true;
      $('ml-sent-view').hidden = false;
      $('ml-sent-subject').textContent = m.subject;
      $('ml-sent-meta').innerHTML = `To <b>${esc(m.to_email)}</b>${m.cc?.length ? ` · Cc ${esc(m.cc.join(', '))}` : ''} · ${esc(new Date(m.created_at).toLocaleString())} · as ${esc(m.team_label)}${m.status === 'failed' ? ` · <span style="color:var(--danger)">Not sent: ${esc(m.error || '')}</span>` : ''}`;
      $('ml-sent-body').textContent = m.body;
      $('ml-main').classList.add('reading');
      return;
    }
    try {
      current = (await CresAPI.request(`/api/mail/${id}`, { noCache: true })).data;
    } catch {
      return;
    }
    if (current.me) me = current.me;
    const it = items.find((x) => x.id === id);
    if (it) it.status = 'read';
    render();
    $('ml-placeholder').hidden = true;
    $('ml-sent-view').hidden = true;
    $('ml-message').hidden = false;
    $('ml-main').classList.add('reading');
    $('ml-subject').textContent = current.subject;
    const orig = current.original_from_email
      ? `<div>Originally from <b>${esc(current.original_from_name || '')}</b> &lt;${esc(current.original_from_email)}&gt;${current.original_received_at ? ` · ${esc(new Date(current.original_received_at).toLocaleString())}` : ''}</div>`
      : '';
    $('ml-meta').innerHTML = `${orig}<div class="mt-muted small">${current.auto_routed ? 'Routed to you because you emailed this person.' : `Forwarded by ${esc(current.from_user_name || 'a colleague')} · ${esc(new Date(current.created_at).toLocaleString())}`}</div>`;
    $('ml-note').hidden = !current.note;
    $('ml-note').textContent = current.note ? `✎ ${current.note}` : '';
    $('ml-body').textContent = current.body || '(no text)';
    const atts = current.attachments || [];
    $('ml-attach').hidden = !atts.length;
    $('ml-attach').innerHTML = atts.length
      ? `<div class="mt-side-label">Attachments</div>${atts.map((a, i) => `<div class="ib-att"><div><b>📎 ${esc(a.name || 'file')}</b>${a.summary ? `<div class="mt-muted small">${esc(a.summary)}</div>` : ''}</div><button type="button" class="mt-btn sm" data-dl="${a.index ?? i}" data-name="${esc(a.name || 'attachment')}">Download</button></div>`).join('')}`
      : '';
    const replies = current.replies || [];
    $('ml-replies').hidden = !replies.length;
    $('ml-replies').innerHTML = replies.map((r) => `<div class="mt-side-label">You replied · ${esc(new Date(r.created_at).toLocaleString())}${r.status === 'failed' ? ' (not sent)' : ''}</div><div class="ib-sent">${esc(r.body)}</div>`).join('');
    const canReply = Boolean(current.original_from_email);
    $('ml-reply').hidden = !canReply;
    $('ml-reply-to').textContent = current.original_from_email || '';
    $('ml-from').textContent = `Sends as “${me.from}” · replies come back to ${me.replyTo}`;
    $('ml-draft-body').value = '';
    $('ml-drafted-by').textContent = '';
    $('ml-done').textContent = current.status === 'done' ? 'Move back to inbox' : 'Mark done';
  }

  function closeView() {
    current = null;
    $('ml-message').hidden = true;
    $('ml-sent-view').hidden = true;
    $('ml-placeholder').hidden = false;
    $('ml-main').classList.remove('reading');
  }

  async function draft() {
    if (!current) return;
    const btn = $('ml-draft');
    btn.disabled = true;
    btn.textContent = '✦ Jarvis is writing…';
    try {
      const res = await CresAPI.request(`/api/mail/${current.id}/draft`, {
        method: 'POST',
        body: { instructions: $('ml-instructions').value.trim() },
        timeoutMs: 90000,
        toast: false,
      });
      $('ml-draft-body').value = res.data?.draft || '';
      $('ml-drafted-by').textContent = 'Drafted by Jarvis - edit anything, then send';
    } catch (err) {
      T().error('Jarvis could not write a draft', { detail: `${err.message}. Write it yourself or try again in a minute.` });
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Draft with Jarvis';
    }
  }

  async function sendReply() {
    if (!current) return;
    const body = $('ml-draft-body').value.trim();
    if (!body) return T().warning('Nothing to send', { detail: 'Write the reply or draft it with Jarvis.' });
    if (!confirm(`Send this reply to ${current.original_from_email} as "${me.from}"?`)) return;
    const btn = $('ml-send');
    btn.disabled = true;
    try {
      await CresAPI.request(`/api/mail/${current.id}/reply`, {
        method: 'POST',
        body: { body, cc: $('ml-cc').value.trim() },
        timeoutMs: 60000,
        toastSuccess: `Reply sent to ${current.original_from_email}`,
      });
      closeView();
      await loadList();
    } catch {
      /* pop-up shown */
    } finally {
      btn.disabled = false;
    }
  }

  function openCompose() {
    $('ml-compose-from').textContent = `Sends as “${me.from}”. Replies come back to ${me.replyTo} and are routed to you here.`;
    $('mc-err').textContent = '';
    $('ml-compose-modal').hidden = false;
    document.body.classList.add('modal-open');
    $('mc-to').focus();
  }

  function closeCompose() {
    $('ml-compose-modal').hidden = true;
    document.body.classList.remove('modal-open');
  }

  async function sendCompose() {
    const to = $('mc-to').value.trim();
    const subject = $('mc-subject').value.trim();
    const body = $('mc-body').value.trim();
    if (!to || !subject || !body) {
      $('mc-err').textContent = 'Fill in To, Subject and the message.';
      return;
    }
    const btn = $('mc-send');
    btn.disabled = true;
    try {
      await CresAPI.request('/api/mail/send', {
        method: 'POST',
        body: { to, cc: $('mc-cc').value.trim(), subject, body },
        timeoutMs: 60000,
        toastSuccess: `Email sent to ${to}`,
      });
      ['mc-to', 'mc-cc', 'mc-subject', 'mc-body'].forEach((id) => ($(id).value = ''));
      closeCompose();
      if (box === 'sent') loadList();
    } catch (err) {
      $('mc-err').textContent = err.message || 'Not sent';
    } finally {
      btn.disabled = false;
    }
  }

  function bind() {
    $('ml-list').addEventListener('click', (e) => {
      const li = e.target.closest('.ib-item');
      if (li) open(li.dataset.id);
    });
    $('ml-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-box]');
      if (!b) return;
      box = b.dataset.box;
      $('ml-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      closeView();
      loadList();
    });
    $('ml-draft').addEventListener('click', draft);
    $('ml-send').addEventListener('click', sendReply);
    $('ml-back').addEventListener('click', closeView);
    $('ml-back2').addEventListener('click', closeView);
    $('ml-forward').addEventListener('click', () => {
      if (!current) return;
      CresForward.open({ source: { mail_id: current.id }, subject: current.subject, body: current.body });
    });
    $('ml-done').addEventListener('click', async () => {
      if (!current) return;
      const done = current.status !== 'done';
      try {
        await CresAPI.request(`/api/mail/${current.id}/done`, { method: 'POST', body: { done }, toastSuccess: done ? 'Marked done' : 'Moved back to inbox' });
        closeView();
        loadList({ quiet: true });
      } catch {
        /* shown */
      }
    });
    $('ml-attach').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      if (b && current) CresAPI.download(`/api/mail/${current.id}/attachments/${b.dataset.dl}`, b.dataset.name).catch((err) => T().error('Could not download', { detail: err.message }));
    });
    $('ml-compose').addEventListener('click', openCompose);
    document.querySelectorAll('[data-close-compose]').forEach((b) => b.addEventListener('click', closeCompose));
    $('mc-send').addEventListener('click', sendCompose);
  }

  boot();
})();
