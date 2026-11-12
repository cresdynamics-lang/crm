/**
 * Admin inbox (company mailbox): live list of incoming mail, scam warnings,
 * Jarvis-drafted replies the admin can edit, and actions one by one or in bulk:
 * send, decline, ignore, delete / restore, mark scam / not scam, read / unread.
 * Nothing is sent without the admin pressing a button.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = () => (typeof CresToast !== 'undefined' ? CresToast : { success() {}, error() {}, info() {}, warning() {} });

  let status = 'active';
  let search = '';
  let items = [];
  let current = null;
  let declining = false;
  const picked = new Set();
  let socket = null;
  let reloadTimer = null;
  let saveTimer = null;

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
    connectLive();
    await loadList();
    // Fallback refresh if the live connection is down (or a push was missed)
    setInterval(() => {
      if (document.visibilityState === 'visible') loadList({ quiet: true });
    }, socket?.connected ? 120000 : 45000);
  }

  // ---------------------------------------------------------------- live
  function connectLive() {
    if (typeof io === 'undefined') return setLive(false);
    socket = io({
      path: '/socket.io',
      auth: (cb) => cb({ token: CresAPI.getAccess() }),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelayMax: 10000,
    });
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('inbox:new', (p) => {
      T().info(`${p.count} new email${p.count === 1 ? '' : 's'}`, { detail: 'Jarvis is drafting replies.' });
      if (typeof CresAlerts !== 'undefined') CresAlerts.notify({ id: `inbox-${Date.now()}`, kind: 'mail', title: 'Company inbox', body: `${p.count} new email${p.count === 1 ? '' : 's'}`, href: '/inbox' });
      scheduleReload();
    });
    socket.on('inbox:updated', (p) => {
      scheduleReload();
      if (current && p?.ids?.includes(current.id) && p.action !== 'read') refreshCurrent();
    });
    // Keep the token fresh for long sessions
    setInterval(() => CresAPI.request('/api/auth/verify').catch(() => {}), 4 * 60 * 1000);
  }

  function setLive(on) {
    $('ib-live').classList.toggle('on', on);
    $('ib-live').title = on ? 'Live: new mail appears automatically' : 'Reconnecting… (refreshing every 45s meanwhile)';
    $('ib-live').querySelector('span').textContent = on ? 'Live' : 'Offline';
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadList({ quiet: true }), 400);
  }

  // ---------------------------------------------------------------- list
  async function loadList({ quiet = false } = {}) {
    try {
      const qs = new URLSearchParams({ status });
      if (search) qs.set('q', search);
      const res = await CresAPI.request(`/api/admin/inbox?${qs}`);
      items = res.data || [];
      const m = res.meta || {};
      $('ib-mailbox').textContent = m.imapConfigured ? m.mailbox || 'Company mailbox' : 'Mailbox not configured';
      for (const [k, v] of Object.entries(m.counts || {})) {
        const el = document.querySelector(`[data-count="${k}"]`);
        if (el) el.textContent = v ? String(v) : '';
      }
      // Drop selections that are no longer visible
      for (const id of [...picked]) if (!items.some((x) => x.id === id)) picked.delete(id);
      renderList();
    } catch (err) {
      if (!quiet) $('ib-list').innerHTML = `<li class="mt-muted small ib-empty">${esc(err.message)}<br><button type="button" class="mt-btn sm" id="ib-retry">Try again</button></li>`;
      $('ib-retry')?.addEventListener('click', () => loadList());
    }
  }

  function chip(m) {
    if (m.deleted_at) return '<span class="ib-chip deleted">Deleted</span>';
    if (m.is_scam) return '<span class="ib-chip scam">Spam</span>';
    if (m.status === 'drafted' || (m.has_draft && m.status === 'pending')) return '<span class="ib-chip drafted">Draft ready</span>';
    if (m.status !== 'pending') return `<span class="ib-chip ${esc(m.status)}">${esc(m.status)}</span>`;
    return '';
  }

  function renderList() {
    if (!items.length) {
      const empty = {
        active: 'Nothing waiting. New mail appears here by itself.',
        unread: 'All read.',
        scam: 'No spam.',
        read: 'Nothing read yet.',
        deleted: 'Nothing deleted.',
      }[status] || 'No emails here.';
      $('ib-list').innerHTML = `<li class="mt-muted small ib-empty">${empty}</li>`;
    } else {
      $('ib-list').innerHTML = items
        .map(
          (m) => `<li class="ib-item${current?.id === m.id ? ' on' : ''}${!m.is_read ? ' unread' : ''}${m.is_scam ? ' scam' : ''}${picked.has(m.id) ? ' picked' : ''}" data-id="${esc(m.id)}">
            <input type="checkbox" class="ib-pick" data-pick="${esc(m.id)}" ${picked.has(m.id) ? 'checked' : ''} aria-label="Select email" />
            <div class="ib-item-top"><span class="ib-from">${esc(m.from_name || m.from_email)}</span><span class="ib-when">${when(m.received_at || m.created_at)}</span></div>
            <div class="ib-subj">${m.has_attachments ? '📎 ' : ''}${esc(m.subject || '(no subject)')}</div>
            <div class="ib-snip">${esc((m.ai_summary || m.body_text || '').replace(/\s+/g, ' ').slice(0, 120))}</div>
            ${chip(m)}
          </li>`
        )
        .join('');
    }
    paintBulk();
  }

  function paintBulk() {
    const n = picked.size;
    $('ib-selected').textContent = n ? `${n} selected` : 'Select';
    $('ib-check-all').checked = n > 0 && n === items.length;
    $('ib-check-all').indeterminate = n > 0 && n < items.length;
    $('ib-bulk-actions').hidden = n === 0;
    document.querySelectorAll('#ib-bulk-actions [data-bulk]').forEach((b) => {
      const hide = (b.dataset.hideIn || '').split(',').includes(status);
      const showIn = b.dataset.showIn ? b.dataset.showIn.split(',').includes(status) : true;
      b.hidden = hide || !showIn;
    });
  }

  async function bulk(action) {
    const ids = [...picked];
    if (!ids.length) return;
    if (action === 'purge' && !confirm(`Delete ${ids.length} email(s) forever? This cannot be undone.`)) return;
    if (action === 'delete' && ids.length > 5 && !confirm(`Delete ${ids.length} emails? You can restore them from Deleted.`)) return;
    const labels = { read: 'Marked read', unread: 'Marked unread', scam: 'Moved to Spam', not_scam: 'Moved out of Spam', ignore: 'Ignored', delete: 'Deleted', restore: 'Restored', purge: 'Deleted forever' };
    try {
      const res = await CresAPI.request('/api/admin/inbox/bulk', {
        method: 'POST',
        body: { ids, action },
        toastSuccess: `${labels[action] || 'Done'}: ${ids.length} email${ids.length === 1 ? '' : 's'}`,
      });
      if (['delete', 'purge', 'restore', 'ignore', 'scam', 'not_scam'].includes(action) && current && ids.includes(current.id)) closeMessage();
      picked.clear();
      await loadList();
      return res;
    } catch {
      /* pop-up already shown */
    }
  }

  // ---------------------------------------------------------------- message
  async function openMessage(id) {
    try {
      current = (await CresAPI.request(`/api/admin/inbox/${id}`)).data;
    } catch {
      return;
    }
    declining = false;
    const it = items.find((x) => x.id === id);
    if (it) it.is_read = true;
    renderList();
    paintMessage();
    $('ib-main').classList.add('reading');
    $('ib-detail').scrollTop = 0;
  }

  async function refreshCurrent() {
    if (!current) return;
    try {
      const fresh = (await CresAPI.request(`/api/admin/inbox/${current.id}`)).data;
      const editing = document.activeElement === $('ib-draft-body');
      current = fresh;
      if (!editing) paintMessage();
    } catch {
      /* keep what is on screen */
    }
  }

  function paintMessage() {
    const m = current;
    $('ib-placeholder').hidden = true;
    $('ib-message').hidden = false;
    $('ib-subject').textContent = m.subject || '(no subject)';
    const cc = (m.cc_emails || []).join(', ');
    $('ib-meta').innerHTML = `<b>${esc(m.from_name || '')}</b> &lt;${esc(m.from_email)}&gt;
      <span class="mt-muted"> · ${esc(new Date(m.received_at || m.created_at).toLocaleString())}</span>
      ${m.reply_to_email && m.reply_to_email !== m.from_email ? `<div class="mt-muted small">Reply-To: ${esc(m.reply_to_email)}</div>` : ''}
      ${cc ? `<div class="mt-muted small">Cc: ${esc(cc)}</div>` : ''}
      ${m.routed_to ? `<div class="ib-routed">↪ Auto-forwarded to ${esc(m.routed_to_name || 'the staff member who emailed this person')}${
        m.routed_by === 'header' ? ' (matched the email thread)'
        : m.routed_by === 'reference' ? ' (matched the Ref code)'
        : m.routed_by === 'sender' ? ' (matched the sender)'
        : m.routed_by === 'hr' ? ' (job / employment → HR)'
        : m.routed_by === 'director' ? ' (inquiry / quote / change → Director)'
        : ''
      }</div>` : ''}`;

    const reasons = Array.isArray(m.scam_reasons) ? m.scam_reasons : [];
    $('ib-scam').hidden = !(m.is_scam || m.scam_score >= 40);
    $('ib-scam').innerHTML = m.is_scam
      ? `<b>⚠ This looks like spam or a scam.</b> Don't click its links, open attachments or send money or passwords.${reasons.length ? `<ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`
      : `<b>Be careful.</b> Some warning signs:${reasons.length ? `<ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`;

    $('ib-summary').hidden = !m.ai_summary;
    $('ib-summary').textContent = m.ai_summary ? `✦ ${m.ai_summary}` : '';
    $('ib-body').textContent = m.body_text || '(no text)';
    const atts = Array.isArray(m.attachment_summaries) ? m.attachment_summaries : [];
    $('ib-attach').hidden = !atts.length;
    $('ib-attach').innerHTML = atts.length
      ? `<div class="mt-side-label">Attachments</div>${atts
          .map((a, i) => `<div class="ib-att"><div><b>📎 ${esc(a.name || 'file')}</b>${a.summary ? `<div class="mt-muted small">${esc(a.summary)}</div>` : ''}</div><button type="button" class="mt-btn sm" data-dl="${i}" data-name="${esc(a.name || 'attachment')}">Download</button></div>`)
          .join('')}`
      : '';

    // Header actions
    $('ib-act-scam').textContent = m.is_scam ? 'Not spam' : 'Mark spam';
    $('ib-act-forward').hidden = Boolean(m.deleted_at);
    $('ib-act-delete').hidden = Boolean(m.deleted_at);
    $('ib-act-restore').hidden = !m.deleted_at;

    const closed = ['sent', 'ignored', 'declined'].includes(m.status) || Boolean(m.deleted_at);
    $('ib-reply').hidden = closed;
    $('ib-closed').hidden = !closed;
    $('ib-closed').innerHTML = !closed
      ? ''
      : m.deleted_at
        ? '<div class="mt-muted">This email is in Deleted. Restore it to reply.</div>'
        : m.status === 'ignored'
          ? '<div class="mt-muted">This email was ignored.</div>'
          : `<div class="mt-side-label">${m.status === 'declined' ? 'Decline sent' : 'Reply sent'}</div><div class="ib-sent">${esc(m.final_body || m.ai_draft || '(declined without a reply)')}</div>`;

    $('ib-draft-body').value = m.ai_draft || '';
    $('ib-instructions').value = m.ai_instructions || '';
    $('ib-cc').value = '';
    $('ib-saved').textContent = '';
    $('ib-drafted-by').textContent = m.ai_draft ? 'Draft ready - edit anything, then send' : '';
    paintMode();
  }

  function paintMode() {
    $('ib-reply').classList.toggle('declining', declining);
    $('ib-reply-title').textContent = declining ? 'Decline' : 'Reply';
    $('ib-send').textContent = declining ? 'Send decline' : 'Send reply';
    $('ib-decline').hidden = declining;
    $('ib-decline-cancel').hidden = !declining;
  }

  function closeMessage() {
    current = null;
    declining = false;
    $('ib-message').hidden = true;
    $('ib-placeholder').hidden = false;
    $('ib-main').classList.remove('reading');
  }

  async function draft(mode = 'reply') {
    if (!current) return;
    const btn = $('ib-draft');
    btn.disabled = true;
    btn.textContent = mode === 'decline' ? '✦ Writing a decline…' : '✦ Jarvis is writing…';
    try {
      const res = await CresAPI.request(`/api/admin/inbox/${current.id}/regenerate`, {
        method: 'POST',
        body: { instructions: $('ib-instructions').value.trim(), mode },
        idempotencyKey: `ib-draft-${current.id}-${Date.now()}`,
        timeoutMs: 90000,
        toast: false,
      });
      current = res.data;
      $('ib-draft-body').value = current.ai_draft || '';
      $('ib-drafted-by').textContent = res.meta?.draftedBy === 'jarvis' ? 'Drafted by Jarvis - edit anything, then send' : 'Drafted (backup AI) - review before sending';
      if (current.ai_summary) {
        $('ib-summary').hidden = false;
        $('ib-summary').textContent = `✦ ${current.ai_summary}`;
      }
      scheduleReload();
    } catch (err) {
      T().error('Jarvis could not write a draft', { detail: `${err.message || 'The AI did not answer'}. Write the reply yourself or try again in a minute.` });
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Draft with Jarvis';
    }
  }

  function autosave() {
    clearTimeout(saveTimer);
    $('ib-saved').textContent = '';
    saveTimer = setTimeout(async () => {
      if (!current) return;
      try {
        await CresAPI.request(`/api/admin/inbox/${current.id}/draft`, {
          method: 'PATCH',
          body: { body: $('ib-draft-body').value },
          toast: false,
        });
        $('ib-saved').textContent = 'Draft saved';
      } catch {
        $('ib-saved').textContent = 'Not saved';
      }
    }, 1200);
  }

  async function send() {
    if (!current) return;
    const body = $('ib-draft-body').value.trim();
    if (!body) return T().warning('Nothing to send', { detail: 'Write a reply or draft one with Jarvis first.' });
    const to = current.reply_to_email && !current.is_scam ? current.reply_to_email : current.from_email;
    if (current.is_scam && !confirm('This email was flagged as a likely scam. Reply anyway?')) return;
    if (!confirm(`${declining ? 'Send this decline' : 'Send this reply'} to ${to}?`)) return;
    const btn = $('ib-send');
    btn.disabled = true;
    try {
      await CresAPI.request(`/api/admin/inbox/${current.id}/${declining ? 'decline' : 'approve'}`, {
        method: 'POST',
        body: { body, cc: $('ib-cc').value.trim() },
        idempotencyKey: `ib-send-${current.id}`,
        timeoutMs: 60000,
        toastSuccess: declining ? `Decline sent to ${to}` : `Reply sent to ${to}`,
      });
      closeMessage();
      await loadList();
    } catch {
      /* pop-up already shown */
    } finally {
      btn.disabled = false;
    }
  }

  async function single(path, opts, after = 'close') {
    if (!current) return;
    try {
      await CresAPI.request(`/api/admin/inbox/${current.id}${path}`, opts);
      if (after === 'close') closeMessage();
      else await refreshCurrent();
      await loadList({ quiet: true });
    } catch {
      /* pop-up already shown */
    }
  }

  async function sync() {
    const btn = $('ib-sync');
    btn.disabled = true;
    btn.textContent = '⟳ Checking…';
    try {
      const res = await CresAPI.request('/api/admin/inbox/sync', {
        method: 'POST',
        body: { limit: 30 },
        idempotencyKey: `ib-sync-${Date.now()}`,
        timeoutMs: 120000,
        toastSuccess: false,
      });
      T().success(res.data?.synced ? `${res.data.synced} new email(s)` : 'No new email');
      await loadList();
    } catch {
      /* pop-up already shown */
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Sync';
    }
  }

  // ---------------------------------------------------------------- wiring
  function bind() {
    $('ib-list').addEventListener('click', (e) => {
      const box = e.target.closest('[data-pick]');
      if (box) {
        e.stopPropagation();
        const id = box.dataset.pick;
        if (box.checked) picked.add(id);
        else picked.delete(id);
        box.closest('.ib-item')?.classList.toggle('picked', box.checked);
        return paintBulk();
      }
      const li = e.target.closest('.ib-item');
      if (li) openMessage(li.dataset.id);
    });
    $('ib-check-all').addEventListener('change', (e) => {
      picked.clear();
      if (e.target.checked) items.forEach((m) => picked.add(m.id));
      renderList();
    });
    $('ib-bulk-actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-bulk]');
      if (b) bulk(b.dataset.bulk);
    });
    $('ib-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-status]');
      if (!b) return;
      status = b.dataset.status;
      picked.clear();
      $('ib-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      closeMessage();
      loadList();
    });
    let searchTimer;
    $('ib-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        search = e.target.value.trim();
        loadList();
      }, 300);
    });
    $('ib-sync').addEventListener('click', sync);
    $('ib-draft').addEventListener('click', () => draft(declining ? 'decline' : 'reply'));
    $('ib-send').addEventListener('click', send);
    $('ib-draft-body').addEventListener('input', autosave);
    $('ib-ignore').addEventListener('click', () =>
      single('/ignore', { method: 'POST', idempotencyKey: `ib-ignore-${current?.id}`, toastSuccess: 'Email ignored' })
    );
    $('ib-decline').addEventListener('click', async () => {
      declining = true;
      paintMode();
      await draft('decline');
    });
    $('ib-decline-cancel').addEventListener('click', () => {
      declining = false;
      paintMode();
    });
    $('ib-act-unread').addEventListener('click', async () => {
      const id = current?.id;
      if (!id) return;
      try {
        await CresAPI.request('/api/admin/inbox/bulk', { method: 'POST', body: { ids: [id], action: 'unread' }, toastSuccess: 'Marked unread' });
        closeMessage();
        await loadList({ quiet: true });
      } catch {
        /* shown */
      }
    });
    $('ib-act-scam').addEventListener('click', () => {
      const toScam = !current?.is_scam;
      single('/scam', { method: 'POST', body: { scam: toScam }, toastSuccess: toScam ? 'Moved to Spam' : 'Moved out of Spam' }, toScam ? 'close' : 'stay');
    });
    $('ib-act-forward').addEventListener('click', () => {
      if (!current) return;
      const when = new Date(current.received_at || current.created_at).toLocaleString();
      const quoted = `---------- Email received ----------\nFrom: ${current.from_name ? `${current.from_name} <${current.from_email}>` : current.from_email}\nDate: ${when}\nSubject: ${current.subject || ''}\n\n${current.body_text || ''}`;
      CresForward.open({
        source: { inbox_message_id: current.id },
        subject: `Fwd: ${current.subject || ''}`,
        body: quoted,
        onDone: () => loadList({ quiet: true }),
      });
    });
    $('ib-attach').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      if (b && current) CresAPI.download(`/api/admin/inbox/${current.id}/attachments/${b.dataset.dl}`, b.dataset.name).catch((err) => T().error('Could not download', { detail: err.message }));
    });
    $('ib-act-delete').addEventListener('click', () =>
      single('', { method: 'DELETE', toastSuccess: 'Email deleted', toast: true })
    );
    $('ib-act-restore').addEventListener('click', () =>
      CresAPI.request('/api/admin/inbox/bulk', { method: 'POST', body: { ids: [current.id], action: 'restore' }, toastSuccess: 'Email restored' })
        .then(() => {
          closeMessage();
          loadList();
        })
        .catch(() => {})
    );
    $('ib-back').addEventListener('click', closeMessage);
    $('ib-instructions').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') draft(declining ? 'decline' : 'reply');
    });
  }

  boot();
})();
