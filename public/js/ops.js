/**
 * Cres Ops — RAG-powered knowledge assistant side panel.
 * Every role gets guided questions + free-form Q&A backed by
 * the knowledge base and system audit trail.
 */
(function () {
  'use strict';

  let guidedQuestions = [];
  let conversationHistory = [];

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function flash(el, msg, ok) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'flash' + (ok === false ? ' flash-error' : ok ? ' flash-success' : '');
    setTimeout(() => { el.textContent = ''; el.className = 'flash'; }, 5000);
  }

  function renderMarkdown(text) {
    return esc(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n- /g, '\n\u2022 ')
      .replace(/\n(\d+)\. /g, '\n$1. ')
      .replace(/\n/g, '<br>');
  }

  async function loadGuided() {
    try {
      const res = await CresAPI.request('/api/ops/guided');
      guidedQuestions = res.data?.questions || [];
      renderGuided();
    } catch { /* ignore */ }
  }

  function renderGuided() {
    const host = document.getElementById('ops-guided');
    if (!host) return;
    host.innerHTML = guidedQuestions.length
      ? guidedQuestions.map((q) =>
        `<button type="button" class="ops-guided-btn" data-q="${esc(q)}">${esc(q)}</button>`
      ).join('')
      : '<p style="color:var(--text-muted);font-size:0.82rem;">No guided questions available.</p>';

    host.querySelectorAll('[data-q]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('ops-question');
        if (input) { input.value = btn.dataset.q; input.focus(); }
        handleAsk(btn.dataset.q);
      });
    });
  }

  async function handleAsk(question) {
    if (!question) {
      const input = document.getElementById('ops-question');
      question = input?.value.trim();
    }
    if (!question) return;

    const askBtn = document.getElementById('ops-ask-btn');
    const answerBox = document.getElementById('ops-answer');
    const sourcesBox = document.getElementById('ops-sources');
    const historyBox = document.getElementById('ops-history');

    if (askBtn) { askBtn.disabled = true; askBtn.textContent = 'Thinking...'; }
    if (answerBox) { answerBox.innerHTML = '<span style="color:var(--text-muted);">Searching knowledge base...</span>'; }
    if (sourcesBox) sourcesBox.innerHTML = '';

    try {
      const res = await CresAPI.request('/api/ops/ask', {
        method: 'POST',
        body: { question },
      });

      const data = res.data;
      if (answerBox) answerBox.innerHTML = renderMarkdown(data.answer || 'No answer available.');

      if (data.blocked && data.redirectRole) {
        if (answerBox) answerBox.innerHTML += `<div class="ops-redirect">Contact <strong>${esc(data.redirectRole)}</strong> directly for this information.</div>`;
      }

      if (sourcesBox && data.sources?.length) {
        sourcesBox.innerHTML = '<strong style="font-size:0.78rem;">Sources:</strong> ' +
          data.sources.map((s) => `<span class="ops-source-tag">${esc(s.title)}</span>`).join(' ');
      }

      // Add to conversation history display
      if (historyBox) {
        const entry = document.createElement('div');
        entry.className = 'ops-history-entry';
        entry.innerHTML = `<div class="ops-history-q">Q: ${esc(question)}</div><div class="ops-history-a">${renderMarkdown(data.answer || '')}</div>`;
        historyBox.prepend(entry);
      }
    } catch (err) {
      if (answerBox) answerBox.innerHTML = `<span style="color:var(--error);">Error: ${esc(err.message)}</span>`;
    } finally {
      if (askBtn) { askBtn.disabled = false; askBtn.textContent = 'Ask'; }
    }
  }

  // Admin ingest
  function renderIngestUI() {
    const host = document.getElementById('ops-ingest');
    if (!host) return;
    const user = CresAPI.getUser?.();
    if (!user || !['admin', 'director'].includes(user.role)) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';
  }

  async function handleIngestText() {
    const title = document.getElementById('ingest-title')?.value.trim();
    const content = document.getElementById('ingest-content')?.value.trim();
    const category = document.getElementById('ingest-category')?.value || 'general';
    if (!title || !content) return;

    const flashEl = document.getElementById('ingest-flash');
    try {
      await CresAPI.request('/api/ops/ingest', {
        method: 'POST',
        body: { title, content, category, sourceType: 'text' },
      });
      flash(flashEl, 'Knowledge entry added', true);
      document.getElementById('ingest-title').value = '';
      document.getElementById('ingest-content').value = '';
      loadGuided(); // refresh
    } catch (err) {
      flash(flashEl, err.message, false);
    }
  }

  async function handleIngestVoice() {
    const btn = document.getElementById('ingest-voice-btn');
    const flashEl = document.getElementById('ingest-flash');

    if (!navigator.mediaDevices?.getUserMedia) {
      flash(flashEl, 'Voice recording not supported', false);
      return;
    }

    if (btn.dataset.recording === '1') {
      // Stop
      btn.dataset.recording = '0';
      btn.textContent = 'Stop & save';
      btn.classList.remove('btn-danger');
      // The actual stop is handled by the MediaRecorder below — we need state
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      btn.dataset.recording = '1';
      btn.textContent = 'Stop & save';
      btn.classList.add('btn-danger');
      recorder.start();

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (blob.size < 500) { flash(flashEl, 'Recording too short', false); return; }

        const title = document.getElementById('ingest-title')?.value.trim() || `Voice note — ${new Date().toLocaleDateString()}`;
        const category = document.getElementById('ingest-category')?.value || 'general';
        const fd = new FormData();
        fd.append('audio', blob, `voice-${Date.now()}.webm`);
        fd.append('title', title);
        fd.append('category', category);

        try {
          await CresAPI.request('/api/ops/ingest/voice', { method: 'POST', body: fd });
          flash(flashEl, 'Voice note transcribed and saved to knowledge base', true);
        } catch (err) {
          flash(flashEl, err.message, false);
        }
        btn.textContent = 'Record voice note';
        btn.dataset.recording = '0';
      };
    } catch {
      flash(flashEl, 'Microphone access denied', false);
    }
  }

  async function mount() {
    const user = CresAPI.getUser?.();
    if (!user) return;

    // Update role badge
    const roleBadge = document.getElementById('ops-role-badge');
    if (roleBadge) roleBadge.textContent = user.role;

    // Load conversation history
    try {
      const ctx = await CresAPI.request('/api/ops/context');
      conversationHistory = [];
      const historyBox = document.getElementById('ops-history');
      if (historyBox) historyBox.innerHTML = '';
    } catch { /* ignore */ }

    await loadGuided();
    renderIngestUI();
  }

  function bind() {
    // Ask button
    document.getElementById('ops-ask-btn')?.addEventListener('click', () => handleAsk());
    // Enter key
    document.getElementById('ops-question')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); }
    });
    // Ingest text
    document.getElementById('ingest-save-btn')?.addEventListener('click', handleIngestText);
    // Ingest voice
    document.getElementById('ingest-voice-btn')?.addEventListener('click', handleIngestVoice);
  }

  window.CresOps = { mount, bind };
})();
