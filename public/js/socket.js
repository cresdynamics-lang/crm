/**
 * Realtime socket + REST poll fallback for chat/notifications.
 */
const CresRealtime = (() => {
  let socket = null;
  let status = 'offline';
  let pollTimer = null;
  const listeners = {
    status: [],
    notification: [],
    message: [],
    messageStatus: [],
    messageUpdate: [],
    presence: [],
    call: [],
  };

  function on(event, fn) {
    listeners[event]?.push(fn);
    return () => {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    };
  }

  function emitLocal(event, payload) {
    (listeners[event] || []).forEach((fn) => fn(payload));
  }

  function setStatus(next) {
    status = next;
    emitLocal('status', status);
  }

  function connect() {
    const token = CresAPI.getAccess();
    if (!token || typeof io === 'undefined') {
      setStatus('degraded');
      startPollFallback();
      return;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    setStatus('connecting');
    socket = io({
      path: '/socket.io',
      // A function, so every reconnect uses the latest (refreshed) token.
      auth: (cb) => cb({ token: CresAPI.getAccess() }),
      // Polling first so nginx that does not upgrade websockets still goes Live,
      // then upgrade to websocket when the proxy allows it.
      transports: ['polling', 'websocket'],
      timeout: 8000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => {
      setStatus('online');
      stopPollFallback();
    });

    socket.on('disconnect', () => {
      setStatus('degraded');
      startPollFallback(2000);
    });

    socket.on('reconnect_failed', () => {
      setStatus('offline');
      startPollFallback();
    });

    socket.on('connect_error', async (err) => {
      setStatus('degraded');
      startPollFallback(2000);
      // Expired token (access tokens last 1 hour): refresh it and reconnect.
      if (/AUTH_TOKEN_INVALID|AUTH_REQUIRED/.test(err?.message || '')) {
        const ok = await CresAPI.refresh().catch(() => false);
        if (ok && socket && !socket.connected) setTimeout(() => socket?.connect(), 500);
      }
    });

    socket.on('notification:new', (n) => emitLocal('notification', n));
    socket.on('message:new', (m) => emitLocal('message', m));
    socket.on('message:status', (p) => emitLocal('messageStatus', p));
    socket.on('message:update', (m) => emitLocal('messageUpdate', m));
    socket.on('presence:list', (ids) => emitLocal('presence', { list: ids || [] }));
    socket.on('presence:update', (p) => emitLocal('presence', p));
    ['call:invite', 'call:accept', 'call:reject', 'call:offer', 'call:answer', 'call:ice', 'call:hangup'].forEach(
      (event) => {
        socket.on(event, (payload) => emitLocal('call', { event, ...payload }));
      }
    );
  }

  function disconnect() {
    stopPollFallback();
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    setStatus('offline');
  }

  function joinConversation(id) {
    return new Promise((resolve) => {
      if (!socket?.connected) return resolve({ ok: false });
      socket.emit('conversation:join', id, resolve);
    });
  }

  function leaveConversation(id) {
    if (socket?.connected) socket.emit('conversation:leave', id);
  }

  function sendMessage(conversationId, content) {
    return new Promise((resolve, reject) => {
      if (socket?.connected) {
        socket.emit('message:send', { conversationId, content }, (ack) => {
          if (ack?.ok) resolve(ack.data);
          else reject(new Error(ack?.error || 'Send failed'));
        });
        return;
      }
      // REST fallback when socket is down
      CresAPI.request(`/api/messages/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { content },
      })
        .then((res) => resolve(res.data))
        .catch(reject);
    });
  }

  let pollDelay = null;
  function startPollFallback(delayMs = 0) {
    if (pollTimer || pollDelay) return;
    const begin = () => {
      pollDelay = null;
      if (pollTimer || status === 'online') return;
      pollTimer = setInterval(async () => {
        try {
          const res = await CresAPI.request('/api/notifications?unread=true');
          emitLocal('notification', { __poll: true, items: res.data || [] });
        } catch {
          // ignore transient poll errors
        }
      }, 8000);
    };
    if (delayMs > 0) pollDelay = setTimeout(begin, delayMs);
    else begin();
  }

  function stopPollFallback() {
    if (pollDelay) {
      clearTimeout(pollDelay);
      pollDelay = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function getStatus() {
    return status;
  }

  function getSocket() {
    return socket;
  }

  function emitCall(event, payload) {
    if (!socket?.connected) return false;
    socket.emit(event, payload);
    return true;
  }

  return {
    connect,
    disconnect,
    on,
    joinConversation,
    leaveConversation,
    sendMessage,
    emitCall,
    getStatus,
    getSocket,
    startPollFallback,
    stopPollFallback,
  };
})();
