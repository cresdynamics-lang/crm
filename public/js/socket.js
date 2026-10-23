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

    socket = io({
      path: '/socket.io',
      auth: { token },
      transports: ['websocket'],
      timeout: 4000,
      reconnection: true,
      reconnectionAttempts: 6,
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

    socket.on('connect_error', () => {
      setStatus('degraded');
      startPollFallback(2000);
    });

    socket.on('notification:new', (n) => emitLocal('notification', n));
    socket.on('message:new', (m) => emitLocal('message', m));
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

  return {
    connect,
    disconnect,
    on,
    joinConversation,
    leaveConversation,
    sendMessage,
    getStatus,
    getSocket,
    startPollFallback,
    stopPollFallback,
  };
})();
