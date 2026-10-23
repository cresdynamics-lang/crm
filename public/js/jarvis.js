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
      'Who logged in and what did the team do?',
      'Which invoices are still pending?',
      'Which payments were receipted recently?',
    ],
    admin: [
      'Give me today\'s company summary.',
      'Who logged in and what did they do?',
      'How are finance, HR, and projects looking?',
      'What did developers update?',
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
      workspace: document.getElementById('jarvis-workspace'),
      fab: document.getElementById('jarvis-fab'),
      log: document.getElementById('jarvis-log'),
      chips: document.getElementById('jarvis-chips'),
      input: document.getElementById('jarvis-input'),
      send: document.getElementById('jarvis-send'),
      mic: document.getElementById('jarvis-mic'),
      speak: document.getElementById('jarvis-speak'),
      status: document.getElementById('jarvis-status'),
    };
  }

  function goToJarvis() {
    if (location.hash !== '#/jarvis') location.hash = '#/jarvis';
  }

  async function show() {
    goToJarvis();
    if (!loadHistory().length) renderChips();
    else {
      const { chips } = els();
      if (chips) chips.hidden = true;
      renderLog(loadHistory());
    }
    await loadCapabilities();
    els().input?.focus();
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

  function mountFab() {
    if (document.getElementById('jarvis-fab')) return;
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'jarvis-fab';
    fab.id = 'jarvis-fab';
    fab.setAttribute('aria-label', 'Open Jarvis');
    fab.innerHTML = '<img src="/brand/logo-mark.png" alt="" />';
    fab.addEventListener('click', () => {
      goToJarvis();
    });
    document.body.appendChild(fab);
  }

  function mount() {
    if (document.getElementById('jarvis-form')?.dataset.bound === '1') {
      mountFab();
      return;
    }
    const { input } = els();
    const form = document.getElementById('jarvis-form');
    if (!form) {
      mountFab();
      return;
    }
    form.dataset.bound = '1';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ask();
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask();
      }
    });

    setupMic();
    setupSpeak();
    renderChips();
    renderLog(loadHistory());
    mountFab();
  }

  wrapLogout();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.CresJarvis = { show, open: show, mount };
})();
