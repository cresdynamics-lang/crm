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

  function renderConversationList() {
    const list = document.getElementById('conv-list');
    if (!conversations.length) {
      list.innerHTML = `<li style="padding:16px;color:var(--text-muted);font-size:0.85rem;">No conversations yet.</li>`;
      return;
    }

    list.innerHTML = conversations
      .map((c) => {
        const peer = peerForConversation(c);
        const active = c.id === activeId ? 'active' : '';
        return `<li class="conv-item ${active}" data-id="${c.id}">
          ${peerAvatar(peer)}
          <div class="cinfo">
            <div class="cname">${escapeHtml(peer.name)}</div>
            <div class="cpreview">${escapeHtml(peer.role || '')}</div>
          </div>
        </li>`;
      })
      .join('');

    list.querySelectorAll('.conv-item').forEach((el) => {
      el.addEventListener('click', () => openConversation(el.dataset.id));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, el.dataset.id);
      });
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

    await CresRealtime.joinConversation(id);
    await loadMessages();
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
    box.innerHTML = messages
      .map((m) => {
        const mine = m.sender_id === selfId;
        return `<div class="bubble ${mine ? 'mine' : 'theirs'}">
          ${escapeHtml(m.content)}
          <span class="btime">${formatTime(m.sent_at)}</span>
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
    }
    // refresh list order lightly
    loadConversations().catch(() => {});
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
    if (status === 'online') {
      banner.classList.remove('visible');
      stopMessagePoll();
    } else {
      banner.classList.add('visible');
      startMessagePollIfNeeded();
    }
  }

  function bind() {
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
          if (!confirm('Clear all messages in this chat?')) return;
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

    document.addEventListener('click', () => hideContextMenu());
    CresRealtime.on('message', onRealtimeMessage);
    CresRealtime.on('status', updatePollBanner);
  }

  async function mount() {
    await loadDirectory();
    await loadConversations();
    updatePollBanner(CresRealtime.getStatus());
  }

  return { bind, mount };
})();
