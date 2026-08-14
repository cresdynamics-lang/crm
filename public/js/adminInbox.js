/**
 * Admin Inbox AI — IMAP sync, AI draft, approve / regenerate / ignore.
 */
const CresAdminInbox = (() => {
  let selectedId = null;
  let bound = false;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function flash(msg, ok = true) {
    const el = document.getElementById('inbox-ai-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 4500);
  }

  function statusPill(s) {
    return `<span class="status-pill ${esc(s || '')}">${esc((s || '').replace(/_/g, ' '))}</span>`;
  }

  function bind() {
    if (bound) return;
    bound = true;
    document.getElementById('btn-inbox-sync')?.addEventListener('click', async () => {
      try {
        const res = await CresAPI.request('/api/admin/inbox/sync', {
          method: 'POST',
          body: { limit: 25 },
          idempotencyKey: `inbox-sync-${Date.now()}`,
        });
        flash(`Synced ${res.data?.synced ?? 0} new message(s)`);
        await mount();
      } catch (err) {
        flash(err.message, false);
      }
    });
    document.getElementById('inbox-ai-filter')?.addEventListener('change', () => mount());
    document.getElementById('btn-inbox-regen-cancel')?.addEventListener('click', () => {
      const panel = document.getElementById('inbox-regen-panel');
      if (panel) panel.hidden = true;
    });
    document.getElementById('btn-inbox-regen-run')?.addEventListener('click', async () => {
      if (!selectedId) return;
      const instructions = document.getElementById('inbox-regen-instructions')?.value?.trim() || '';
      try {
        await CresAPI.request(`/api/admin/inbox/${selectedId}/regenerate`, {
          method: 'POST',
          body: { instructions },
          idempotencyKey: `inbox-regen-${selectedId}-${Date.now()}`,
        });
        flash('Draft regenerated');
        const panel = document.getElementById('inbox-regen-panel');
        if (panel) panel.hidden = true;
        await mount(selectedId);
      } catch (err) {
        flash(err.message, false);
      }
    });
  }

  function renderDetail(msg) {
    const host = document.getElementById('inbox-ai-detail');
    if (!host || !msg) {
      if (host) host.innerHTML = `<div class="empty-state">Select a message.</div>`;
      return;
    }
    const atts = (msg.attachment_summaries || [])
      .map(
        (a) =>
          `<li><strong>${esc(a.name)}</strong> — ${esc((a.summary || '').slice(0, 400))}${
            (a.summary || '').length > 400 ? '…' : ''
          }</li>`
      )
      .join('');
    const closed = ['sent', 'ignored'].includes(msg.status);
    host.innerHTML = `
      <div class="toolbar" style="margin-bottom:8px;">
        <strong>${esc(msg.subject || '(no subject)')}</strong>
        <div class="spacer"></div>
        ${statusPill(msg.status)}
      </div>
      <p class="meta" style="margin:0 0 10px;">
        From ${esc(msg.from_name || '')} &lt;${esc(msg.from_email)}&gt;
        · ${msg.received_at ? new Date(msg.received_at).toLocaleString() : ''}
      </p>
      ${msg.ai_summary ? `<p><em>AI summary:</em> ${esc(msg.ai_summary)}</p>` : ''}
      <div class="settings-section" style="max-width:none;margin:12px 0;">
        <h4 style="margin:0 0 6px;font-size:0.85rem;">Incoming</h4>
        <pre style="white-space:pre-wrap;max-height:180px;overflow:auto;margin:0;font-size:0.85rem;">${esc(
          (msg.body_text || '').slice(0, 6000)
        )}</pre>
      </div>
      ${
        atts
          ? `<div style="margin:10px 0;"><h4 style="margin:0 0 6px;font-size:0.85rem;">Attachments</h4><ul>${atts}</ul></div>`
          : ''
      }
      <div class="settings-section" style="max-width:none;margin:12px 0;">
        <h4 style="margin:0 0 6px;font-size:0.85rem;">AI draft reply</h4>
        <textarea id="inbox-draft-edit" rows="10" style="width:100%;">${esc(msg.ai_draft || '')}</textarea>
      </div>
      ${
        closed
          ? `<p class="meta">This message is ${esc(msg.status)}.</p>`
          : `<div class="toolbar" style="gap:8px;flex-wrap:wrap;">
              <button type="button" class="btn btn-primary" id="btn-inbox-approve">Approve &amp; send</button>
              <button type="button" class="btn btn-ghost" id="btn-inbox-regen">Regenerate</button>
              <button type="button" class="btn btn-ghost" id="btn-inbox-ignore">Ignore</button>
            </div>`
      }
    `;

    document.getElementById('btn-inbox-approve')?.addEventListener('click', async () => {
      const body = document.getElementById('inbox-draft-edit')?.value || '';
      try {
        await CresAPI.request(`/api/admin/inbox/${msg.id}/approve`, {
          method: 'POST',
          body: { body },
          idempotencyKey: `inbox-approve-${msg.id}-${Date.now()}`,
        });
        flash('Reply sent to recipient (with CC where applicable)');
        await mount(msg.id);
      } catch (err) {
        flash(err.message, false);
      }
    });
    document.getElementById('btn-inbox-regen')?.addEventListener('click', () => {
      const panel = document.getElementById('inbox-regen-panel');
      if (panel) {
        panel.hidden = false;
        document.getElementById('inbox-regen-instructions')?.focus();
      }
    });
    document.getElementById('btn-inbox-ignore')?.addEventListener('click', async () => {
      try {
        await CresAPI.request(`/api/admin/inbox/${msg.id}/ignore`, {
          method: 'POST',
          body: {},
          idempotencyKey: `inbox-ignore-${msg.id}-${Date.now()}`,
        });
        flash('Message ignored');
        selectedId = null;
        await mount();
      } catch (err) {
        flash(err.message, false);
      }
    });
  }

  async function mount(keepId) {
    const list = document.getElementById('inbox-ai-list');
    if (!list) return;
    if (keepId) selectedId = keepId;

    const filter = document.getElementById('inbox-ai-filter')?.value || 'active';
    try {
      const res = await CresAPI.request(
        `/api/admin/inbox?status=${encodeURIComponent(filter)}`
      );
      const rows = res.data || [];
      const meta = document.getElementById('inbox-ai-meta');
      if (meta) {
        const m = res.meta || {};
        meta.textContent = [
          m.imapConfigured ? 'IMAP ready' : 'IMAP missing',
          m.groqConfigured ? 'Groq ready' : 'Groq missing',
          m.resendConfigured ? 'Resend ready' : 'Resend missing',
        ].join(' · ');
      }

      list.innerHTML = rows.length
        ? rows
            .map(
              (r) => `<tr data-inbox-id="${esc(r.id)}" style="cursor:pointer;" class="${
                r.id === selectedId ? 'is-selected' : ''
              }">
                <td>${esc(r.from_name || r.from_email)}</td>
                <td>${esc(r.subject || '(no subject)')}</td>
                <td>${statusPill(r.status)}</td>
              </tr>`
            )
            .join('')
        : `<tr><td colspan="3" class="empty-state">No messages. Sync inbox to pull mail.</td></tr>`;

      list.querySelectorAll('[data-inbox-id]').forEach((tr) => {
        tr.addEventListener('click', async () => {
          selectedId = tr.dataset.inboxId;
          try {
            const detail = await CresAPI.request(`/api/admin/inbox/${selectedId}`);
            renderDetail(detail.data);
            list.querySelectorAll('tr').forEach((row) => row.classList.remove('is-selected'));
            tr.classList.add('is-selected');
          } catch (err) {
            flash(err.message, false);
          }
        });
      });

      if (selectedId) {
        const still = rows.find((r) => r.id === selectedId);
        if (still) {
          const detail = await CresAPI.request(`/api/admin/inbox/${selectedId}`);
          renderDetail(detail.data);
        } else {
          renderDetail(null);
        }
      } else {
        renderDetail(null);
      }
    } catch (err) {
      list.innerHTML = `<tr><td colspan="3">${esc(err.message)}</td></tr>`;
    }
  }

  return { bind, mount };
})();
