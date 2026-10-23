/**
 * Community shell - WhatsApp Web pattern.
 * Contact list from server matrix; Socket.io + REST poll failover.
 */
const CresCommunity = (() => {
  let usersById = {};
  let conversations = [];
  let activeId = null;
  let messages = [];
  let ctxConversationId = null;
  let messagePoll = null;
  let peerCache = {};
  let activePeer = null;
  let onlineIds = new Set();
  let editingId = null;
  let msgMenuId = null;
  let readTimer = null;
  const EDIT_WINDOW_MS = 30 * 60 * 1000;

  function me() {
    return CresAPI.getUser();
  }

  function initials(name) {
    return CresSettings.initials(name);
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  async function loadDirectory() {
    // Directory for resolving peer names in conversations
    try {
      const res = await CresAPI.request('/api/messages/contacts');
      usersById = {};
      (res.data || []).forEach((u) => {
        usersById[u.id] = u;
      });
      // include self
      const self = me();
      usersById[self.id] = {
        id: self.id,
        name: self.name,
        role: self.role,
        avatar_url: self.avatar_url || null,
      };
    } catch {
      usersById = {};
    }
  }

  function peerForConversation(conv) {
    const selfId = me().id;
    const otherId = (conv.participant_ids || []).find((id) => id !== selfId);
    return usersById[otherId] || peerCache[otherId] || { id: otherId, name: 'Teammate', role: '' };
  }

  async function loadConversations() {
    const res = await CresAPI.request('/api/messages/conversations');
    conversations = res.data || [];
    renderConversationList();
  }

  function peerAvatar(peer) {
    return CresSettings.avatarHtml(peer, 'cavatar');
  }

  /**
   * The sidebar shows everyone: your chats first, then every other staff member
   * (online first, then A-Z). Clicking someone without a chat starts one.
   */
  function renderConversationList() {
    const list = document.getElementById('conv-list');
    const selfId = me().id;
    const q = (document.getElementById('conv-search')?.value || '').trim().toLowerCase();
    const match = (u) => !q || String(u.name || '').toLowerCase().includes(q) || String(u.role || '').toLowerCase().includes(q);
    const dot = (id) => (onlineIds.has(id) ? '<span class="online-dot" title="Online"></span>' : '');

    const chats = conversations.map((c) => ({ c, peer: peerForConversation(c) })).filter(({ peer }) => match(peer));
    const withChat = new Set(conversations.flatMap((c) => c.participant_ids || []));
    const people = Object.values(usersById)
      .filter((u) => u.id !== selfId && !withChat.has(u.id) && match(u))
      .sort((a, b) => Number(onlineIds.has(b.id)) - Number(onlineIds.has(a.id)) || String(a.name).localeCompare(String(b.name)));

    const chatRows = chats.map(({ c, peer }) => `<li class="conv-item ${c.id === activeId ? 'active' : ''}" data-id="${c.id}">
          <span class="avatar-wrap">${peerAvatar(peer)}${dot(peer.id)}</span>
          <div class="cinfo">
            <div class="cname">${escapeHtml(peer.name)}</div>
            <div class="cpreview">${onlineIds.has(peer.id) ? 'online' : escapeHtml(peer.role || '')}</div>
          </div>
        </li>`);
    const peopleRows = people.map((u) => `<li class="conv-item person" data-user="${u.id}">
          <span class="avatar-wrap">${peerAvatar(u)}${dot(u.id)}</span>
          <div class="cinfo">
            <div class="cname">${escapeHtml(u.name)}</div>
            <div class="cpreview">${onlineIds.has(u.id) ? 'online' : escapeHtml(u.role || '')}</div>
          </div>
        </li>`);

    list.innerHTML =
      (chatRows.length ? `<li class="conv-section">Chats</li>${chatRows.join('')}` : '') +
      (peopleRows.length ? `<li class="conv-section">Everyone (${peopleRows.length})</li>${peopleRows.join('')}` : '') ||
      `<li style="padding:16px;color:var(--text-muted);font-size:0.85rem;">${q ? 'No one matches.' : 'No one else here yet.'}</li>`;

    list.querySelectorAll('.conv-item[data-id]').forEach((el) => {
      el.addEventListener('click', () => openConversation(el.dataset.id));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, el.dataset.id);
      });
    });
    list.querySelectorAll('.conv-item[data-user]').forEach((el) => {
      el.addEventListener('click', () => startConversation(el.dataset.user).catch((err) => alert(err.message)));
    });
  }

  async function openConversation(id) {
    if (activeId) CresRealtime.leaveConversation(activeId);
    activeId = id;
    renderConversationList();

    document.getElementById('chat-empty').hidden = true;
    document.getElementById('chat-active').hidden = false;

    const conv = conversations.find((c) => c.id === id);
    const peer = conv ? peerForConversation(conv) : { name: '-', role: '' };
    const header = document.querySelector('#chat-active .chat-header');
    if (header) {
      let av = header.querySelector('.cavatar');
      if (!av) {
        header.insertAdjacentHTML('afterbegin', peerAvatar(peer));
      } else {
        av.outerHTML = peerAvatar(peer);
      }
    }
    document.getElementById('chat-peer-name').textContent = peer.name;
    document.getElementById('chat-peer-role').textContent = peer.role || '';
    activePeer = peer;
    cancelEdit();
    updatePeerStatus();

    await CresRealtime.joinConversation(id);
    await loadMessages();
    markRead();
    startMessagePollIfNeeded();
  }

  async function loadMessages() {
    if (!activeId) return;
    const res = await CresAPI.request(`/api/messages/conversations/${activeId}/messages`);
    messages = res.data || [];
    renderMessages();
  }

  function renderMessages() {
    const box = document.getElementById('chat-messages');
    const selfId = me().id;
    // Telegram-style: a date divider when the day changes, and runs of messages
    // from the same sender grouped so only the last one carries the bubble tail.
    let lastDay = '';
    box.innerHTML = messages
      .map((m, i) => {
        const mine = m.sender_id === selfId;
        const day = dayLabel(m.sent_at);
        const divider = day && day !== lastDay ? `<div class="chat-day"><span>${day}</span></div>` : '';
        if (day) lastDay = day;
        const next = messages[i + 1];
        const last = !next || next.sender_id !== m.sender_id || dayLabel(next.sent_at) !== day;
        const deleted = Boolean(m.deleted_at);
        const text = deleted
          ? `<span class="btext bdeleted">${mine ? 'You deleted this message' : 'This message was deleted'}</span>`
          : `<span class="btext">${escapeHtml(m.content)}</span>`;
        const edited = m.edited_at && !deleted ? '<span class="bedited">edited</span> ' : '';
        return `${divider}<div class="bubble ${mine ? 'mine' : 'theirs'}${last ? ' tail' : ''}${deleted ? ' deleted' : ''}" data-id="${m.id}">
          ${text}<span class="btime">${edited}${formatTime(m.sent_at)}${mine && !deleted ? ' ' + tickHtml(m) : ''}</span>
        </div>`;
      })
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  function onRealtimeMessage(msg) {
    if (!msg || msg.__poll) return;
    if (msg.conversation_id === activeId) {
      if (!messages.some((m) => m.id === msg.id)) {
        messages.push(msg);
        renderMessages();
      }
      if (msg.sender_id !== me().id) markRead();
    }
    // refresh list order lightly
    loadConversations().catch(() => {});
  }

  /** ✓ sent (recipient offline) · ✓✓ delivered · blue ✓✓ seen */
  function tickHtml(m) {
    if (m.read_at) return '<span class="btick read" title="Seen">✓✓</span>';
    if (m.delivered_at) return '<span class="btick" title="Delivered">✓✓</span>';
    return '<span class="btick" title="Sent">✓</span>';
  }

  function updatePeerStatus() {
    const el = document.getElementById('chat-peer-role');
    if (!el || !activePeer) return;
    const online = activePeer.id && onlineIds.has(activePeer.id);
    el.textContent = online ? 'online' : activePeer.role || '';
    el.classList.toggle('is-online', Boolean(online));
  }

  /** Mark the open chat as seen, once the page is actually visible. */
  function markRead() {
    if (!activeId || document.hidden) return;
    const id = activeId;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const unread = messages.some((m) => m.sender_id !== me().id && !m.read_at && !m.deleted_at);
      if (!unread) return;
      CresAPI.request(`/api/messages/conversations/${id}/read`, { method: 'POST' })
        .then(() => {
          const now = new Date().toISOString();
          messages.forEach((m) => {
            if (m.sender_id !== me().id && !m.read_at) m.read_at = now;
          });
        })
        .catch(() => {});
    }, 300);
  }

  function onMessageStatus(p) {
    if (!p || p.conversationId !== activeId) return;
    const ids = new Set(p.ids || []);
    let changed = false;
    messages.forEach((m) => {
      if (!ids.has(m.id)) return;
      if (p.delivered_at && !m.delivered_at) {
        m.delivered_at = p.delivered_at;
        changed = true;
      }
      if (p.read_at && !m.read_at) {
        m.read_at = p.read_at;
        changed = true;
      }
    });
    if (changed) renderMessages();
  }

  function onMessageUpdate(updated) {
    if (!updated || updated.conversation_id !== activeId) return;
    const i = messages.findIndex((m) => m.id === updated.id);
    if (i < 0) return;
    messages[i] = { ...messages[i], ...updated };
    if (editingId === updated.id && updated.deleted_at) cancelEdit();
    renderMessages();
  }

  function onPresence(p) {
    if (!p) return;
    if (Array.isArray(p.list)) onlineIds = new Set(p.list);
    else if (p.userId) p.online ? onlineIds.add(p.userId) : onlineIds.delete(p.userId);
    updatePeerStatus();
    renderConversationList();
    // A peer coming online receives everything waiting for them.
    if (p.online && activeId) loadMessages().catch(() => {});
  }

  // ----- Message actions: copy, edit (30 min), delete for me / for everyone -----

  function msgMenu() {
    let menu = document.getElementById('msg-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'msg-menu';
      menu.className = 'ctx-menu msg-menu';
      document.body.appendChild(menu);
      menu.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (btn) runMsgAction(btn.dataset.act, msgMenuId);
        hideMsgMenu();
      });
    }
    return menu;
  }

  function showMsgMenu(x, y, id) {
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    const mine = m.sender_id === me().id;
    const canEdit = mine && !m.deleted_at && Date.now() - new Date(m.sent_at).getTime() < EDIT_WINDOW_MS;
    const items = [];
    if (!m.deleted_at) items.push('<button type="button" data-act="copy">Copy text</button>');
    if (canEdit) items.push('<button type="button" data-act="edit">Edit</button>');
    items.push('<button type="button" data-act="delete-me">Delete for me</button>');
    if (mine && !m.deleted_at) items.push('<button type="button" data-act="delete-all" class="danger">Delete for everyone</button>');
    msgMenuId = id;
    const menu = msgMenu();
    menu.innerHTML = items.join('');
    menu.classList.add('open');
    const w = menu.offsetWidth || 170;
    const h = menu.offsetHeight || 140;
    menu.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  }

  function hideMsgMenu() {
    document.getElementById('msg-menu')?.classList.remove('open');
  }

  async function runMsgAction(act, id) {
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    try {
      if (act === 'copy') {
        await navigator.clipboard?.writeText(m.content || '');
      } else if (act === 'edit') {
        startEdit(m);
      } else if (act === 'delete-me') {
        await CresAPI.request(`/api/messages/${id}?scope=me`, { method: 'DELETE' });
        messages = messages.filter((x) => x.id !== id);
        renderMessages();
      } else if (act === 'delete-all') {
        if (!confirm('Delete this message for everyone?')) return;
        const res = await CresAPI.request(`/api/messages/${id}?scope=everyone`, { method: 'DELETE' });
        onMessageUpdate(res.data);
      }
    } catch (err) {
      alert(err.message || 'That did not work');
    }
  }

  function startEdit(m) {
    editingId = m.id;
    const input = document.getElementById('chat-input');
    input.value = m.content;
    input.focus();
    let bar = document.getElementById('chat-edit-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'chat-edit-bar';
      bar.className = 'chat-edit-bar';
      document.getElementById('chat-composer').before(bar);
    }
    bar.innerHTML = `<span>✎ Editing message</span><button type="button" aria-label="Cancel edit">✕</button>`;
    bar.querySelector('button').addEventListener('click', cancelEdit);
    bar.hidden = false;
    document.getElementById('chat-send').textContent = 'Save';
  }

  function cancelEdit() {
    if (!editingId) return;
    editingId = null;
    const bar = document.getElementById('chat-edit-bar');
    if (bar) bar.hidden = true;
    const input = document.getElementById('chat-input');
    if (input) input.value = '';
    const send = document.getElementById('chat-send');
    if (send) send.textContent = 'Send';
  }

  function startMessagePollIfNeeded() {
    stopMessagePoll();
    if (CresRealtime.getStatus() === 'online') return;
    messagePoll = setInterval(() => {
      if (activeId) loadMessages().catch(() => {});
    }, 5000);
  }

  function stopMessagePoll() {
    if (messagePoll) {
      clearInterval(messagePoll);
      messagePoll = null;
    }
  }

  function showContextMenu(x, y, conversationId) {
    ctxConversationId = conversationId;
    const menu = document.getElementById('ctx-menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('open');
  }

  function hideContextMenu() {
    document.getElementById('ctx-menu').classList.remove('open');
    ctxConversationId = null;
  }

  async function openNewChatModal() {
    const modal = document.getElementById('new-chat-modal');
    const list = document.getElementById('contact-list');
    const res = await CresAPI.request('/api/messages/contacts');
    const contacts = res.data || [];
    contacts.forEach((u) => {
      usersById[u.id] = u;
    });

    if (!contacts.length) {
      list.innerHTML = `<li style="padding:16px;color:var(--text-muted);">No permitted contacts.</li>`;
    } else {
      list.innerHTML = contacts
        .map(
          (u) => `<li>
            <button type="button" data-id="${u.id}">
              ${peerAvatar(u)}
              <span>${escapeHtml(u.name)}</span>
              <span class="role-tag">${escapeHtml(u.role)}</span>
            </button>
          </li>`
        )
        .join('');
      list.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => startConversation(btn.dataset.id));
      });
    }
    modal.classList.add('open');
  }

  async function startConversation(participantId) {
    const res = await CresAPI.request('/api/messages/conversations', {
      method: 'POST',
      body: { participant_id: participantId },
      idempotencyKey: `conv-${me().id}-${participantId}`,
    });
    document.getElementById('new-chat-modal').classList.remove('open');
    await loadConversations();
    await openConversation(res.data.id);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updatePollBanner(status) {
    const banner = document.getElementById('chat-poll-banner');
    if (!banner) return;
    const onCommunity = document.getElementById('face-community')?.classList.contains('active');
    if (!onCommunity) {
      banner.classList.remove('visible');
      stopMessagePoll();
      return;
    }
    if (status === 'online') {
      banner.classList.remove('visible');
      stopMessagePoll();
    } else {
      banner.classList.add('visible');
      startMessagePollIfNeeded();
    }
  }

  function bind() {
    function startPeerCall(kind) {
      if (!activePeer?.id) return;
      if (typeof CresCalls === 'undefined') {
        alert('Calling is not available.');
        return;
      }
      CresCalls.startCall({
        peerId: activePeer.id,
        peerName: activePeer.name,
        kind,
        conversationId: activeId,
      });
    }
    document.getElementById('btn-call-audio')?.addEventListener('click', () => startPeerCall('audio'));
    document.getElementById('btn-call-video')?.addEventListener('click', () => startPeerCall('video'));
    document.getElementById('btn-call-screen')?.addEventListener('click', () => startPeerCall('screen'));

    document.getElementById('conv-search')?.addEventListener('input', () => renderConversationList());
    document.getElementById('new-chat-btn')?.addEventListener('click', () => {
      openNewChatModal().catch((err) => alert(err.message));
    });
    document.getElementById('new-chat-close')?.addEventListener('click', () => {
      document.getElementById('new-chat-modal').classList.remove('open');
    });
    document.getElementById('new-chat-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'new-chat-modal') e.target.classList.remove('open');
    });

    document.getElementById('chat-composer')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const content = input.value.trim();
      if (!content || !activeId) return;
      const btn = document.getElementById('chat-send');
      btn.disabled = true;
      if (editingId) {
        try {
          const res = await CresAPI.request(`/api/messages/${editingId}`, { method: 'PATCH', body: { content } });
          onMessageUpdate(res.data);
          cancelEdit();
        } catch (err) {
          alert(err.message || 'Could not edit');
        } finally {
          btn.disabled = false;
          input.focus();
        }
        return;
      }
      try {
        const msg = await CresRealtime.sendMessage(activeId, content);
        input.value = '';
        if (!messages.some((m) => m.id === msg.id)) {
          messages.push(msg);
          renderMessages();
        }
      } catch (err) {
        alert(err.message || 'Failed to send');
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });

    document.getElementById('ctx-menu')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || !ctxConversationId) return;
      const id = ctxConversationId;
      const action = btn.dataset.action;
      hideContextMenu();
      try {
        if (action === 'mute') {
          await CresAPI.request(`/api/messages/conversations/${id}/mute`, { method: 'POST' });
        } else if (action === 'archive') {
          await CresAPI.request(`/api/messages/conversations/${id}/archive`, { method: 'POST' });
          if (activeId === id) {
            activeId = null;
            document.getElementById('chat-active').hidden = true;
            document.getElementById('chat-empty').hidden = false;
          }
          await loadConversations();
        } else if (action === 'clear') {
          if (!confirm('Clear this chat for you? The other person keeps their copy.')) return;
          await CresAPI.request(`/api/messages/conversations/${id}/clear`, { method: 'POST' });
          if (activeId === id) {
            messages = [];
            renderMessages();
          }
        }
      } catch (err) {
        alert(err.message);
      }
    });

    const box = document.getElementById('chat-messages');
    box?.addEventListener('contextmenu', (e) => {
      const bubble = e.target.closest('.bubble[data-id]');
      if (!bubble) return;
      e.preventDefault();
      showMsgMenu(e.clientX, e.clientY, bubble.dataset.id);
    });
    // Touch: long-press a bubble for the same menu.
    let pressTimer = null;
    box?.addEventListener('touchstart', (e) => {
      const bubble = e.target.closest('.bubble[data-id]');
      if (!bubble) return;
      const t = e.touches[0];
      pressTimer = setTimeout(() => showMsgMenu(t.clientX, t.clientY, bubble.dataset.id), 500);
    }, { passive: true });
    ['touchend', 'touchmove'].forEach((ev) => box?.addEventListener(ev, () => clearTimeout(pressTimer)));
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancelEdit();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) markRead();
    });

    document.addEventListener('click', () => {
      hideContextMenu();
      hideMsgMenu();
    });
    CresRealtime.on('message', onRealtimeMessage);
    CresRealtime.on('messageStatus', onMessageStatus);
    CresRealtime.on('messageUpdate', onMessageUpdate);
    CresRealtime.on('presence', onPresence);
    CresRealtime.on('status', updatePollBanner);
  }

  async function mount() {
    await loadDirectory();
    await loadConversations();
    CresAPI.request('/api/messages/presence')
      .then((res) => onPresence({ list: res.data || [] }))
      .catch(() => {});
    updatePollBanner(CresRealtime.getStatus());
  }

  return { bind, mount };
})();
