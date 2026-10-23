/**
 * Jarvis side panel — read-only assistant for every role, including the client portal.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'cres_jarvis_chat';
  const STARTERS = {
    sales: [
      'Which leads need follow-up today?',
      'What does my pipeline look like?',
      'Which of my projects are in progress?',
      'Any new notifications?',
    ],
    finance: [
      'What invoices are overdue?',
      'How is cash flow this month?',
      'What expenses are pending?',
      'Show me the finance overview.',
    ],
    developer: [
      'What are my open tasks?',
      'Which projects am I assigned to?',
      'Any pending assignments?',
      'What updates are expected from me?',
    ],
    pm: [
      'Which projects are behind schedule?',
      'Who hasn\'t submitted a report today?',
      'What is the team workload?',
      'Show my project list.',
    ],
    hr: [
      'Who hasn\'t submitted a report today?',
      'Who is on leave?',
      'Any new applicants?',
      'Show the HR dashboard.',
    ],
    director: [
      'Give me today\'s summary.',
      'What needs my approval?',
      'Which invoices are overdue?',
      'How is the team looking today?',
    ],
    admin: [
      'Give me today\'s summary.',
      'What needs my approval?',
      'How is the system looking?',
      'Any failed jobs?',
    ],
    client: [
      'What\'s the status of my project?',
      'What invoices do I have?',
      'Any change requests?',
      'Show my dashboard.',
    ],
  };
  const FALLBACK_STARTERS = [
    'What\'s on my plate today?',
    'Any pending approvals?',
    'Show my notifications.',
  ];

  let enabled = true;
  let busy = false;
  let speakOn = false;
  let recognition = null;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function renderSafe(text) {
    return esc(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\n)- /g, '$1• ')
      .replace(/\n/g, '<br>');
  }

  function storageKey() {
    const user = CresAPI.getUser?.();
    return user?.id ? `${STORAGE_KEY}:${user.id}` : STORAGE_KEY;
  }

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(storageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveHistory(messages) {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(messages.slice(-40)));
    } catch {
      // ignore quota / private mode
    }
  }

  function clearHistory() {
    try {
      sessionStorage.removeItem(storageKey());
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function wrapLogout() {
    if (!window.CresAPI) return;
    const origLogout = CresAPI.logout;
    const origClear = CresAPI.clearSession;
    CresAPI.logout = async function wrappedLogout() {
      clearHistory();
      return origLogout.apply(this, arguments);
    };
    CresAPI.clearSession = function wrappedClear() {
      clearHistory();
      return origClear.apply(this, arguments);
    };
  }

  function startersFor(role) {
    return STARTERS[role] || FALLBACK_STARTERS;
  }

  function els() {
    return {
      root: document.getElementById('jarvis-root'),
      panel: document.getElementById('jarvis-panel'),
      fab: document.getElementById('jarvis-fab'),
      close: document.getElementById('jarvis-close'),
      backdrop: document.getElementById('jarvis-backdrop'),
      log: document.getElementById('jarvis-log'),
      chips: document.getElementById('jarvis-chips'),
      input: document.getElementById('jarvis-input'),
      send: document.getElementById('jarvis-send'),
      mic: document.getElementById('jarvis-mic'),
      speak: document.getElementById('jarvis-speak'),
      status: document.getElementById('jarvis-status'),
    };
  }

  function setOpen(open) {
    const { root, input, fab } = els();
    if (!root) return;
    root.classList.toggle('open', open);
    document.body.classList.toggle('jarvis-open', open);
    if (open) {
      input?.focus();
    } else {
      fab?.focus();
    }
  }

  function setBusy(next) {
    busy = next;
    const { send, input, mic } = els();
    if (send) send.disabled = next || !enabled;
    if (input) input.disabled = !enabled;
    if (mic) mic.disabled = next || !enabled;
  }

  function setStatus(text) {
    const { status } = els();
    if (status) status.textContent = text || '';
  }

  function appendBubble(role, text, extraClass) {
    const { log } = els();
    if (!log) return;
    const div = document.createElement('div');
    div.className = `jarvis-bubble jarvis-bubble-${role}${extraClass ? ` ${extraClass}` : ''}`;
    if (role === 'user') {
      div.textContent = text;
    } else {
      div.innerHTML = renderSafe(text);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function renderLog(messages) {
    const { log, chips } = els();
    if (!log) return;
    log.innerHTML = '';
    messages.forEach((m) => appendBubble(m.role === 'user' ? 'user' : 'assistant', m.content));
    if (chips) chips.hidden = messages.length > 0;
  }

  function renderChips() {
    const { chips } = els();
    if (!chips) return;
    const role = CresAPI.getUser?.()?.role || '';
    chips.innerHTML = startersFor(role)
      .slice(0, 4)
      .map((q) => `<button type="button" class="jarvis-chip" data-q="${esc(q)}">${esc(q)}</button>`)
      .join('');
    chips.querySelectorAll('[data-q]').forEach((btn) => {
      btn.addEventListener('click', () => ask(btn.dataset.q));
    });
  }

  function speak(text) {
    if (!speakOn || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-KE';
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }

  async function loadCapabilities() {
    const { input, send, mic } = els();
    try {
      const res = await CresAPI.request('/api/jarvis/capabilities');
      enabled = Boolean(res.data?.enabled);
      if (!enabled) {
        setStatus('Jarvis isn\'t switched on yet.');
        if (input) input.disabled = true;
        if (send) send.disabled = true;
        if (mic) mic.disabled = true;
      } else {
        setStatus('');
        if (input) input.disabled = false;
        if (send) send.disabled = busy;
        if (mic) mic.disabled = busy;
      }
    } catch {
      enabled = false;
      setStatus('Jarvis isn\'t switched on yet.');
      if (input) input.disabled = true;
      if (send) send.disabled = true;
    }
  }

  async function ask(preset) {
    const { input, log, chips } = els();
    const text = (preset || input?.value || '').trim();
    if (!text || busy || !enabled) return;
    if (input) input.value = '';

    const history = loadHistory();
    history.push({ role: 'user', content: text });
    saveHistory(history);
    if (chips) chips.hidden = true;
    appendBubble('user', text);

    setBusy(true);
    const thinking = appendBubble('assistant', 'Thinking…', 'jarvis-thinking');
    try {
      const res = await CresAPI.request('/api/jarvis/ask', {
        method: 'POST',
        body: {
          message: text,
          history: history.slice(0, -1).slice(-10),
        },
        timeoutMs: 90000,
      });
      const answer = res.data?.answer || '';
      if (thinking) thinking.remove();
      appendBubble('assistant', answer);
      history.push({ role: 'assistant', content: answer });
      saveHistory(history);
      speak(answer);
    } catch (err) {
      if (thinking) thinking.remove();
      const msg =
        err.status === 429 || err.status === 503
          ? err.message
          : 'Jarvis couldn\'t answer just now.';
      appendBubble('assistant', msg, 'jarvis-error');
      history.push({ role: 'assistant', content: msg });
      saveHistory(history);
    } finally {
      setBusy(false);
      input?.focus();
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  function setupMic() {
    const { mic, input } = els();
    const Ctor = window.webkitSpeechRecognition;
    if (!mic) return;
    if (!Ctor) {
      mic.hidden = true;
      return;
    }
    recognition = new Ctor();
    recognition.lang = 'en-KE';
    recognition.interimResults = false;
    recognition.onresult = (ev) => {
      const said = ev.results?.[0]?.[0]?.transcript || '';
      if (input && said) {
        input.value = (input.value ? `${input.value} ` : '') + said;
        input.focus();
      }
      mic.classList.remove('listening');
    };
    recognition.onerror = () => mic.classList.remove('listening');
    recognition.onend = () => mic.classList.remove('listening');
    mic.addEventListener('click', () => {
      if (busy || !enabled) return;
      try {
        if (mic.classList.contains('listening')) {
          recognition.stop();
          mic.classList.remove('listening');
        } else {
          recognition.start();
          mic.classList.add('listening');
        }
      } catch {
        mic.classList.remove('listening');
      }
    });
  }

  function setupSpeak() {
    const { speak: btn } = els();
    if (!btn) return;
    if (!window.speechSynthesis) {
      btn.hidden = true;
      return;
    }
    btn.addEventListener('click', () => {
      speakOn = !speakOn;
      btn.classList.toggle('on', speakOn);
      btn.setAttribute('aria-pressed', speakOn ? 'true' : 'false');
      if (!speakOn) {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      }
    });
  }

  function mount() {
    if (document.getElementById('jarvis-root')) return;
    const root = document.createElement('div');
    root.id = 'jarvis-root';
    root.innerHTML = `
      <button type="button" class="jarvis-fab" id="jarvis-fab" aria-label="Open Jarvis">
        <img src="/brand/logo-mark.png" alt="" />
      </button>
      <div class="jarvis-backdrop" id="jarvis-backdrop"></div>
      <aside class="jarvis-panel" id="jarvis-panel" role="dialog" aria-labelledby="jarvis-title" aria-modal="true">
        <header class="jarvis-head">
          <div>
            <h2 id="jarvis-title">JARVIS</h2>
            <p>Ask about your work</p>
          </div>
          <div class="jarvis-head-actions">
            <button type="button" id="jarvis-speak" class="jarvis-icon-btn" aria-label="Read answers aloud" aria-pressed="false" title="Read answers aloud">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>
            </button>
            <button type="button" id="jarvis-close" class="jarvis-icon-btn" aria-label="Close Jarvis">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </header>
        <div class="jarvis-chips" id="jarvis-chips"></div>
        <div class="jarvis-log" id="jarvis-log" aria-live="polite"></div>
        <p class="jarvis-status" id="jarvis-status"></p>
        <form class="jarvis-composer" id="jarvis-form">
          <button type="button" id="jarvis-mic" class="jarvis-icon-btn" aria-label="Dictate question">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
          </button>
          <textarea id="jarvis-input" rows="1" placeholder="Ask Jarvis…" aria-label="Ask Jarvis"></textarea>
          <button type="submit" id="jarvis-send" class="jarvis-send" aria-label="Send">Send</button>
        </form>
      </aside>
    `;
    document.body.appendChild(root);

    const { fab, close, backdrop, input } = els();
    fab.addEventListener('click', async () => {
      if (!loadHistory().length) renderChips();
      setOpen(true);
      await loadCapabilities();
    });
    close.addEventListener('click', () => setOpen(false));
    backdrop.addEventListener('click', () => setOpen(false));
    document.getElementById('jarvis-form').addEventListener('submit', (e) => {
      e.preventDefault();
      ask();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('jarvis-root')?.classList.contains('open')) {
        setOpen(false);
      }
    });

    setupMic();
    setupSpeak();
    renderChips();
    renderLog(loadHistory());
  }

  wrapLogout();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
