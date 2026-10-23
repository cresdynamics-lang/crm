/**
 * Admin inbox (info@cresdynamics.com): read synced emails, let Jarvis draft a
 * reply as Cres Dynamics, edit it, then send. Nothing is sent without a click.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let status = 'active';
  let items = [];
  let current = null;

  function toast(msg, ok = true) {
    const el = document.createElement('div');
    el.className = `mt-toast${ok ? '' : ' err'}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };

  async function boot() {
    if (!CresAPI.getAccess()) return location.replace(`/login?next=${encodeURIComponent('/inbox')}`);
    let user;
    try {
      user = (await CresAPI.verify()).user || CresAPI.getUser();
    } catch {
      return location.replace(`/login?next=${encodeURIComponent('/inbox')}`);
    }
    if (user?.role !== 'admin') {
      $('ib-denied').hidden = false;
      return;
    }
    $('ib-main').hidden = false;
    bind();
    await loadList();
  }

  async function loadList() {
    try {
      const res = await CresAPI.request(`/api/admin/inbox?status=${encodeURIComponent(status)}`);
      items = res.data || [];
      const m = res.meta || {};
      $('ib-mailbox').textContent = m.imapConfigured ? 'info@cresdynamics.com' : 'Mailbox not configured';
      renderList();
    } catch (err) {
      $('ib-list').innerHTML = `<li class="mt-muted small ib-empty">${esc(err.message)}</li>`;
    }
  }

  function renderList() {
    if (!items.length) {
      $('ib-list').innerHTML = `<li class="mt-muted small ib-empty">${status === 'active' ? 'Nothing waiting. Press Sync now to fetch new mail.' : 'No emails here.'}</li>`;
      return;
    }
    $('ib-list').innerHTML = items
      .map(
        (m) => `<li class="ib-item${current?.id === m.id ? ' on' : ''}${m.status === 'pending' ? ' unread' : ''}" data-id="${esc(m.id)}">
          <div class="ib-item-top"><span class="ib-from">${esc(m.from_name || m.from_email)}</span><span class="ib-when">${when(m.received_at || m.created_at)}</span></div>
          <div class="ib-subj">${m.has_attachments ? '📎 ' : ''}${esc(m.subject || '(no subject)')}</div>
          <div class="ib-snip">${esc((m.ai_summary || m.body_text || '').replace(/\s+/g, ' ').slice(0, 120))}</div>
          ${m.status !== 'pending' ? `<span class="ib-chip ${esc(m.status)}">${m.status === 'drafted' ? 'Draft ready' : esc(m.status)}</span>` : ''}
        </li>`
      )
      .join('');
  }

  async function openMessage(id) {
    try {
      current = (await CresAPI.request(`/api/admin/inbox/${id}`)).data;
    } catch (err) {
      return toast(err.message, false);
    }
    renderList();
    $('ib-placeholder').hidden = true;
    $('ib-message').hidden = false;
    $('ib-subject').textContent = current.subject || '(no subject)';
    const cc = (current.cc_emails || []).join(', ');
    $('ib-meta').innerHTML = `<b>${esc(current.from_name || '')}</b> &lt;${esc(current.from_email)}&gt;
      <span class="mt-muted"> · ${esc(new Date(current.received_at || current.created_at).toLocaleString())}</span>
      ${cc ? `<div class="mt-muted small">Cc: ${esc(cc)}</div>` : ''}`;
    $('ib-summary').hidden = !current.ai_summary;
    $('ib-summary').textContent = current.ai_summary ? `✦ ${current.ai_summary}` : '';
    $('ib-body').textContent = current.body_text || '(no text)';
    const atts = Array.isArray(current.attachment_summaries) ? current.attachment_summaries : [];
    $('ib-attach').hidden = !atts.length;
    $('ib-attach').innerHTML = atts.length
      ? `<div class="mt-side-label">Attachments</div>${atts
          .map((a) => `<div class="ib-att"><b>📎 ${esc(a.name || 'file')}</b>${a.summary ? `<div class="mt-muted small">${esc(a.summary)}</div>` : ''}</div>`)
          .join('')}`
      : '';
    const closed = ['sent', 'ignored'].includes(current.status);
    $('ib-reply').hidden = closed;
    $('ib-closed').hidden = !closed;
    $('ib-closed').innerHTML = closed
      ? current.status === 'sent'
        ? `<div class="mt-side-label">Reply sent</div><div class="ib-sent">${esc(current.final_body || current.ai_draft || '')}</div>`
        : '<div class="mt-muted">This email was ignored.</div>'
      : '';
    $('ib-draft-body').value = current.ai_draft || '';
    $('ib-instructions').value = current.ai_instructions || '';
    $('ib-cc').value = '';
    $('ib-drafted-by').textContent = current.ai_draft ? 'Draft ready, review before sending' : '';
    $('ib-detail').scrollTop = 0;
  }

  async function draftWithJarvis() {
    if (!current) return;
    const btn = $('ib-draft');
    btn.disabled = true;
    btn.textContent = '✦ Jarvis is writing…';
    try {
      const res = await CresAPI.request(`/api/admin/inbox/${current.id}/regenerate`, {
        method: 'POST',
        body: { instructions: $('ib-instructions').value.trim() },
        idempotencyKey: `ib-draft-${current.id}-${Date.now()}`,
        timeoutMs: 90000,
      });
      current = res.data;
      $('ib-draft-body').value = current.ai_draft || '';
      $('ib-drafted-by').textContent = res.meta?.draftedBy === 'jarvis' ? 'Drafted by Jarvis, review before sending' : 'Drafted (backup AI), review before sending';
      if (current.ai_summary) {
        $('ib-summary').hidden = false;
        $('ib-summary').textContent = `✦ ${current.ai_summary}`;
      }
      const i = items.findIndex((x) => x.id === current.id);
      if (i >= 0) items[i] = current;
      renderList();
    } catch (err) {
      toast(err.message || 'Jarvis could not draft a reply', false);
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Draft with Jarvis';
    }
  }

  async function sendReply() {
    if (!current) return;
    const body = $('ib-draft-body').value.trim();
    if (!body) return toast('Write a reply or draft one with Jarvis first.', false);
    if (!confirm(`Send this reply to ${current.from_email}?`)) return;
    const btn = $('ib-send');
    btn.disabled = true;
    try {
      await CresAPI.request(`/api/admin/inbox/${current.id}/approve`, {
        method: 'POST',
        body: { body, cc: $('ib-cc').value.trim() },
        idempotencyKey: `ib-send-${current.id}`,
        timeoutMs: 60000,
      });
      toast(`Reply sent to ${current.from_email}`);
      current = null;
      $('ib-message').hidden = true;
      $('ib-placeholder').hidden = false;
      await loadList();
    } catch (err) {
      toast(err.message || 'Could not send', false);
    } finally {
      btn.disabled = false;
    }
  }

  async function ignore() {
    if (!current) return;
    try {
      await CresAPI.request(`/api/admin/inbox/${current.id}/ignore`, {
        method: 'POST',
        idempotencyKey: `ib-ignore-${current.id}`,
      });
      current = null;
      $('ib-message').hidden = true;
      $('ib-placeholder').hidden = false;
      await loadList();
    } catch (err) {
      toast(err.message, false);
    }
  }

  async function sync() {
    const btn = $('ib-sync');
    btn.disabled = true;
    btn.textContent = '⟳ Syncing…';
    try {
      const res = await CresAPI.request('/api/admin/inbox/sync', {
        method: 'POST',
        body: { limit: 20 },
        idempotencyKey: `ib-sync-${Date.now()}`,
        timeoutMs: 120000,
      });
      toast(res.data?.synced ? `${res.data.synced} new email(s)` : 'No new email');
      await loadList();
    } catch (err) {
      toast(err.message || 'Sync failed', false);
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Sync now';
    }
  }

  function bind() {
    $('ib-list').addEventListener('click', (e) => {
      const li = e.target.closest('.ib-item');
      if (li) openMessage(li.dataset.id);
    });
    $('ib-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-status]');
      if (!b) return;
      status = b.dataset.status;
      $('ib-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      loadList();
    });
    $('ib-sync').addEventListener('click', sync);
    $('ib-draft').addEventListener('click', draftWithJarvis);
    $('ib-send').addEventListener('click', sendReply);
    $('ib-ignore').addEventListener('click', ignore);
    $('ib-instructions').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') draftWithJarvis();
    });
  }

  boot();
})();
