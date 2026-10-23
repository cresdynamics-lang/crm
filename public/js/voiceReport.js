/**
 * Voice report module — shared across Sales, Developer, and Director faces.
 *
 * Sales / Developer: record narration → Whisper → LLM structured report →
 *   fill the existing #report-content textarea + auto-select project.
 * Director: press-to-talk mic next to remarks textarea → Whisper → fill textarea.
 */
(function () {
  'use strict';

  let mediaStream = null;
  let recorder = null;
  let audioChunks = [];
  let timerInterval = null;
  let elapsed = 0;
  let latestResult = null;
  let lastRenderedPreview = '';

  function withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
    ]);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function flash(el, msg, ok) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'flash' + (ok === false ? ' flash-error' : ok ? ' flash-success' : '');
    setTimeout(() => { el.textContent = ''; el.className = 'flash'; }, 4000);
  }

  function formatTime(s) {
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  function pauseBtn() {
    return document.getElementById('btn-vr-pause');
  }

  function setPauseBtn(visible) {
    const b = pauseBtn();
    if (!b) return;
    b.style.display = visible ? '' : 'none';
    b.textContent = 'Pause';
  }

  function handlePause() {
    if (!recorder) return;
    const b = pauseBtn();
    if (!b) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      clearInterval(timerInterval);
      timerInterval = null;
      b.textContent = 'Resume';
    } else if (recorder.state === 'paused') {
      recorder.resume();
      timerInterval = setInterval(() => {
        elapsed++;
        const el = document.getElementById('vr-timer');
        if (el) el.textContent = formatTime(elapsed);
      }, 1000);
      b.textContent = 'Pause';
    }
  }

  async function startRecording() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    recorder.start();
    elapsed = 0;
    timerInterval = setInterval(() => { elapsed++; const el = document.getElementById('vr-timer'); if (el) el.textContent = formatTime(elapsed); }, 1000);
  }

  function stopRecording() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') { resolve(null); return; }
      recorder.onstop = () => {
        clearInterval(timerInterval);
        if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        audioChunks = [];
        resolve(blob);
      };
      recorder.stop();
    });
  }

  async function transcribeAndParse(blob) {
    const fd = new FormData();
    fd.append('audio', blob, `recording-${Date.now()}.webm`);
    const res = await withTimeout(
      CresAPI.request('/api/reports/voice-capture', {
        method: 'POST',
        body: fd,
        idempotencyKey: `vr-capture-${Date.now()}`,
      }),
      250000,
      'AI is taking too long — please retry or shorten the recording'
    );
    if (!res.ok) throw new Error(res.error?.message || 'Voice capture failed');
    return res.data;
  }

  async function reparseText() {
    const ts = document.getElementById('vr-transcript');
    const flashEl = document.getElementById('vr-flash');
    const wi = document.getElementById('vr-working-indicator');
    const text = String(ts?.value || '').trim();
    if (!text) {
      flash(flashEl, 'Nothing to re-parse — the transcript is empty', false);
      return;
    }
    const reparseBtn = document.getElementById('btn-vr-reparse');
    if (reparseBtn) { reparseBtn.disabled = true; reparseBtn.textContent = 'Re-parsing...'; }
    if (wi) wi.style.display = '';
    try {
      const res = await withTimeout(
        CresAPI.request('/api/reports/voice-capture', {
          method: 'POST',
          body: { text },
          idempotencyKey: `vr-reparse-${Date.now()}`,
        }),
        120000,
        'AI is taking too long — please retry'
      );
      if (!res.ok) throw new Error(res.error?.message || 'Re-parse failed');
      latestResult = res.data;
      if (ts) ts.value = res.data.transcript || text;
      renderReportPreview(res.data);
      flash(flashEl, 'Re-parsed from your corrected text — review below', true);
    } catch (err) {
      flash(flashEl, err.message || 'Failed to re-parse', false);
    } finally {
      if (reparseBtn) { reparseBtn.disabled = false; reparseBtn.textContent = 'Re-parse edited text'; }
      if (wi) wi.style.display = 'none';
    }
  }

  function showRecorderUI() {
    const ui = document.getElementById('vr-recorder-ui');
    const ts = document.getElementById('vr-transcript-section');
    const rs = document.getElementById('vr-report-section');
    const wi = document.getElementById('vr-working-indicator');
    if (ui) ui.style.display = '';
    if (ts) ts.style.display = 'none';
    if (rs) rs.style.display = 'none';
    if (wi) wi.style.display = 'none';
    const timer = document.getElementById('vr-timer');
    if (timer) timer.textContent = '00:00';
    latestResult = null;
    setPauseBtn(false);
  }

  function renderReportPreview(data) {
    const preview = document.getElementById('vr-report-preview');
    if (!preview) return;
    const lines = [];
    if (data.done?.length) {
      lines.push('What was done:');
      data.done.forEach((d) => lines.push('  \u2022 ' + d));
    }
    if (data.blockers?.length) {
      lines.push('', 'Blockers:');
      data.blockers.forEach((b) => lines.push('  \u2022 ' + b));
    }
    if (data.next_steps?.length) {
      lines.push('', 'Next steps:');
      data.next_steps.forEach((s) => lines.push('  \u2022 ' + s));
    }
    preview.value = lines.join('\n') || data.content || '(no content)';
    lastRenderedPreview = preview.value;
    const matchEl = document.getElementById('vr-project-match');
    if (matchEl) {
      if (data.project_name) {
        matchEl.style.display = '';
        matchEl.textContent = `Matched project: ${data.project_name}`;
      } else {
        matchEl.style.display = 'none';
      }
    }
  }

  async function handleRecord() {
    const btn = document.getElementById('btn-vr-record');
    const flashEl = document.getElementById('vr-flash');
    const wi = document.getElementById('vr-working-indicator');

    if (!recorder || recorder.state === 'inactive') {
      try {
        btn.textContent = 'Stop recording';
        btn.classList.add('btn-danger');
        await startRecording();
        setPauseBtn(true);
      } catch (err) {
        flash(flashEl, 'Microphone access denied', false);
        btn.textContent = 'Start recording';
        btn.classList.remove('btn-danger');
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Processing...';
    setPauseBtn(false);
    const blob = await stopRecording();
    if (!blob || blob.size < 1000) {
      flash(flashEl, 'Recording too short — try again', false);
      btn.textContent = 'Start recording';
      btn.disabled = false;
      btn.classList.remove('btn-danger');
      return;
    }

    showRecorderUI();
    document.getElementById('vr-recorder-ui').style.display = 'none';
    wi.style.display = '';

    try {
      const data = await transcribeAndParse(blob);
      latestResult = data;

      document.getElementById('vr-transcript').textContent = data.transcript || '(no transcript)';
      document.getElementById('vr-transcript-section').style.display = '';
      renderReportPreview(data);
      document.getElementById('vr-report-section').style.display = '';
      flash(flashEl, 'Report parsed — review below, then click "Use this report"', true);
    } catch (err) {
      flash(flashEl, err.message || 'Failed to process audio', false);
      showRecorderUI();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start recording';
      btn.classList.remove('btn-danger');
      wi.style.display = 'none';
      setPauseBtn(false);
    }
  }

  function handleRetry() {
    latestResult = null;
    showRecorderUI();
  }

  function handleUse() {
    if (!latestResult) return;
    let content = latestResult.content || '';
    const preview = document.getElementById('vr-report-preview');
    if (preview && preview.value && preview.value.trim() !== lastRenderedPreview.trim()) {
      content = preview.value;
    }
    const ta = document.getElementById('report-content');
    if (ta) ta.value = content;
    // Fill HR/well-being sections
    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    setVal('report-blockers', latestResult.blockers_text || (latestResult.blockers || []).join('\n'));
    setVal('report-attention', latestResult.needs_attention);
    setVal('report-hard', latestResult.hard_today);
    setVal('report-easy', latestResult.easy_today);
    setVal('report-happiness', latestResult.happiness);
    setVal('report-concerns', latestResult.concerns);
    const projSel = document.getElementById('report-project');
    if (projSel && latestResult.project_id) {
      for (const opt of projSel.options) {
        if (opt.value === latestResult.project_id) { projSel.value = latestResult.project_id; break; }
      }
    }
    // Close modal
    document.getElementById('voice-report-modal')?.classList.remove('open');
    flash(document.getElementById('reports-flash'), 'Report populated from voice — review and submit', true);
  }

  /** Bind the voice-report modal controls. Call once from bindModals(). */
  function initVoiceReport() {
    const btnOpen = document.getElementById('btn-voice-report');
    const modal = document.getElementById('voice-report-modal');
    const btnRecord = document.getElementById('btn-vr-record');
    const btnRetry = document.getElementById('btn-vr-retry');
    const btnUse = document.getElementById('btn-vr-use');
    const btnClose = modal?.querySelector('[data-close-modal]');

    if (btnOpen) {
      btnOpen.addEventListener('click', () => {
        showRecorderUI();
        modal.classList.add('open');
      });
    }
    if (btnClose) btnClose.addEventListener('click', () => modal.classList.remove('open'));
    if (btnRecord) btnRecord.addEventListener('click', handleRecord);
    if (btnRetry) btnRetry.addEventListener('click', handleRetry);
    if (btnUse) btnUse.addEventListener('click', handleUse);
    document.getElementById('btn-vr-pause')?.addEventListener('click', handlePause);
    document.getElementById('btn-vr-reparse')?.addEventListener('click', reparseText);
  }

  /** Director remarks: add a mic button next to a remarks textarea. */
  function initRemarkMic(textareaId, reportId) {
    const ta = document.getElementById(textareaId);
    if (!ta || ta.dataset.micBound) return;
    ta.dataset.micBound = '1';

    const wrapper = document.createElement('span');
    wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:6px;vertical-align:middle;';

    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'btn btn-ghost btn-sm';
    micBtn.style.cssText = 'padding:3px 10px;font-size:0.78rem;';
    micBtn.textContent = '\uD83C\uDF99 Speak';
    wrapper.appendChild(micBtn);
    ta.parentNode.insertBefore(wrapper, ta.nextSibling);

    let remarkStream = null;
    let remarkRecorder = null;
    let remarkChunks = [];

    micBtn.addEventListener('click', async () => {
      if (remarkRecorder && remarkRecorder.state === 'recording') {
        micBtn.textContent = '\uD83C\uDF99 Speak';
        micBtn.classList.remove('btn-danger');
        const blob = await new Promise((resolve) => {
          remarkRecorder.onstop = () => {
            remarkStream?.getTracks().forEach((t) => t.stop());
            resolve(new Blob(remarkChunks, { type: 'audio/webm' }));
          };
          remarkRecorder.stop();
        });
        remarkChunks = [];
        if (!blob || blob.size < 500) return;
        micBtn.disabled = true;
        micBtn.textContent = '...';
        try {
          const fd = new FormData();
          fd.append('audio', blob, `remark-${Date.now()}.webm`);
          const res = await CresAPI.request('/api/reports/voice-capture', {
            method: 'POST',
            body: fd,
          });
          if (res.ok && res.data?.content) {
            ta.value = (ta.value ? ta.value + '\n' : '') + res.data.content;
          }
        } catch { /* ignore */ }
        micBtn.disabled = false;
        micBtn.textContent = '\uD83C\uDF99 Speak';
        return;
      }
      try {
        remarkStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        remarkChunks = [];
        remarkRecorder = new MediaRecorder(remarkStream, { mimeType: 'audio/webm;codecs=opus' });
        remarkRecorder.ondataavailable = (e) => { if (e.data.size > 0) remarkChunks.push(e.data); };
        remarkRecorder.start();
        micBtn.textContent = '\u23F9 Stop';
        micBtn.classList.add('btn-danger');
      } catch { /* mic denied */ }
    });
  }

  window.CresVoiceReport = { initVoiceReport, initRemarkMic };
})();
