/**
 * Voice form-fill module — voice-record narration, transcribe via Groq Whisper,
 * then LLM-parse into structured fields for New Project and New Task forms.
 *
 * Shared across Sales and Developer faces.
 */
(function () {
  'use strict';

  let mediaStream = null;
  let recorder = null;
  let audioChunks = [];
  let timerInterval = null;
  let elapsed = 0;
  let latestResult = null;
  let currentTarget = null; // 'project' or 'task'

  function flash(el, msg, ok) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'flash' + (ok === false ? ' flash-error' : ok ? ' flash-success' : '');
    setTimeout(() => { el.textContent = ''; el.className = 'flash'; }, 5000);
  }

  function formatTime(s) {
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  async function startRecording() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    recorder.start();
    elapsed = 0;
    timerInterval = setInterval(() => {
      elapsed++;
      const el = document.getElementById('vf-timer');
      if (el) el.textContent = formatTime(elapsed);
    }, 1000);
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
    fd.append('audio', blob, `voice-form-${Date.now()}.webm`);
    const endpoint = currentTarget === 'project'
      ? '/api/projects/voice-capture'
      : '/api/tasks/voice-capture';
    const res = await CresAPI.request(endpoint, {
      method: 'POST',
      body: fd,
      idempotencyKey: `vf-${currentTarget}-${Date.now()}`,
    });
    if (!res.ok) throw new Error(res.error?.message || 'Voice capture failed');
    return res.data;
  }

  function showRecorderUI() {
    const ui = document.getElementById('vf-recorder-ui');
    const ts = document.getElementById('vf-transcript-section');
    const ps = document.getElementById('vf-preview-section');
    const wi = document.getElementById('vf-working');
    if (ui) ui.style.display = '';
    if (ts) ts.style.display = 'none';
    if (ps) ps.style.display = 'none';
    if (wi) wi.style.display = 'none';
    const timer = document.getElementById('vf-timer');
    if (timer) timer.textContent = '00:00';
    latestResult = null;
  }

  function renderPreview(data) {
    const preview = document.getElementById('vf-preview');
    if (!preview) return;
    if (currentTarget === 'project') {
      const lines = [];
      if (data.name) lines.push(`Name: ${data.name}`);
      if (data.description) lines.push(`Description: ${data.description}`);
      if (data.value_amount) lines.push(`Value: ${data.value_amount}`);
      if (data.client_name) lines.push(`Client: ${data.client_name}`);
      if (data.developer_name) lines.push(`Developer: ${data.developer_name}`);
      if (data.milestones?.length) {
        lines.push('Milestones:');
        data.milestones.forEach((m) => lines.push(`  - ${m}`));
      }
      preview.textContent = lines.join('\n') || data.transcript || '(no content)';
    } else {
      const lines = [];
      if (data.title) lines.push(`Title: ${data.title}`);
      if (data.description) lines.push(`Description: ${data.description}`);
      if (data.due_date) lines.push(`Due: ${data.due_date}`);
      if (data.project_name) lines.push(`Project: ${data.project_name}`);
      preview.textContent = lines.join('\n') || data.transcript || '(no content)';
    }
  }

  function fillProjectForm(data) {
    if (data.name) document.getElementById('proj-name').value = data.name;
    if (data.description) document.getElementById('proj-description').value = data.description;
    if (data.value_amount) document.getElementById('proj-value').value = data.value_amount;
    if (data.client_name) document.getElementById('proj-manual-client').value = data.client_name;
    if (data.developer_name) {
      const sel = document.getElementById('proj-developer');
      if (sel) {
        for (const opt of sel.options) {
          if (opt.textContent.toLowerCase().includes(data.developer_name.toLowerCase())) {
            sel.value = opt.value; break;
          }
        }
      }
    }
    if (data.milestones?.length) {
      const list = document.getElementById('milestone-list');
      if (list) {
        list.innerHTML = '';
        data.milestones.forEach((title) => {
          const row = document.createElement('div');
          row.className = 'milestone-row';
          row.innerHTML = `<input placeholder="Milestone title" value="${escHtml(title)}" /><button type="button" class="btn btn-ghost" data-remove-ms style="padding:6px 10px;">&#10005;</button>`;
          list.appendChild(row);
          row.querySelector('[data-remove-ms]').addEventListener('click', () => row.remove());
        });
      }
    }
  }

  function fillTaskForm(data) {
    if (data.title) document.getElementById('task-title').value = data.title;
    if (data.description) document.getElementById('task-description').value = data.description;
    if (data.due_date) document.getElementById('task-due').value = data.due_date;
    if (data.project_name) {
      // Try to match project in assignee or other selects if present
      const projSel = document.getElementById('task-project');
      if (projSel) {
        for (const opt of projSel.options) {
          if (opt.textContent.toLowerCase().includes(data.project_name.toLowerCase())) {
            projSel.value = opt.value; break;
          }
        }
      }
    }
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  async function handleRecord() {
    const btn = document.getElementById('btn-vf-record');
    const flashEl = document.getElementById('vf-flash');
    const wi = document.getElementById('vf-working');

    if (!recorder || recorder.state === 'inactive') {
      try {
        btn.textContent = 'Stop recording';
        btn.classList.add('btn-danger');
        await startRecording();
      } catch {
        flash(flashEl, 'Microphone access denied', false);
        btn.textContent = 'Start recording';
        btn.classList.remove('btn-danger');
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Processing...';
    const blob = await stopRecording();
    if (!blob || blob.size < 1000) {
      flash(flashEl, 'Recording too short — try again', false);
      btn.textContent = 'Start recording';
      btn.disabled = false;
      btn.classList.remove('btn-danger');
      return;
    }

    document.getElementById('vf-recorder-ui').style.display = 'none';
    wi.style.display = '';

    try {
      const data = await transcribeAndParse(blob);
      latestResult = data;
      document.getElementById('vf-transcript').textContent = data.transcript || '(no transcript)';
      document.getElementById('vf-transcript-section').style.display = '';
      renderPreview(data);
      document.getElementById('vf-preview-section').style.display = '';
      flash(flashEl, 'Parsed — review below, then click "Use this"', true);
    } catch (err) {
      flash(flashEl, err.message || 'Failed to process audio', false);
      showRecorderUI();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start recording';
      btn.classList.remove('btn-danger');
      wi.style.display = 'none';
    }
  }

  function handleRetry() {
    latestResult = null;
    showRecorderUI();
  }

  function handleUse() {
    if (!latestResult) return;
    if (currentTarget === 'project') {
      fillProjectForm(latestResult);
      document.getElementById('new-project-modal')?.classList.remove('open');
      flash(document.getElementById('projects-flash'), 'Project form populated from voice — review and submit', true);
    } else {
      fillTaskForm(latestResult);
      const taskForm = document.getElementById('task-form');
      if (taskForm) taskForm.style.display = '';
      document.getElementById('voice-form-modal')?.classList.remove('open');
      flash(document.getElementById('tasks-flash'), 'Task form populated from voice — review and submit', true);
    }
  }

  function openModal(target) {
    currentTarget = target;
    const modal = document.getElementById('voice-form-modal');
    const title = modal?.querySelector('h3');
    if (title) title.textContent = target === 'project' ? 'Voice: describe your project' : 'Voice: describe your task';
    const hint = document.getElementById('vf-hint');
    if (hint) hint.textContent = target === 'project'
      ? 'Describe the project: name, what it is, the client, value, milestones, developer to assign.'
      : 'Describe the task: title, what needs to be done, when it is due, which project it belongs to.';
    showRecorderUI();
    modal?.classList.add('open');
  }

  function initVoiceForms() {
    const modal = document.getElementById('voice-form-modal');
    const btnRecord = document.getElementById('btn-vf-record');
    const btnRetry = document.getElementById('btn-vf-retry');
    const btnUse = document.getElementById('btn-vf-use');
    const btnClose = modal?.querySelector('[data-close-modal]');

    if (btnClose) btnClose.addEventListener('click', () => modal.classList.remove('open'));
    if (btnRecord) btnRecord.addEventListener('click', handleRecord);
    if (btnRetry) btnRetry.addEventListener('click', handleRetry);
    if (btnUse) btnUse.addEventListener('click', handleUse);

    // New task button
    const btnNewTask = document.getElementById('btn-new-task');
    const taskForm = document.getElementById('task-form');
    if (btnNewTask && taskForm) {
      taskForm.style.display = 'none';
      btnNewTask.addEventListener('click', () => {
        const isHidden = taskForm.style.display === 'none';
        taskForm.style.display = isHidden ? '' : 'none';
        btnNewTask.textContent = isHidden ? 'Close form' : 'New task';
      });
    }

    // Voice buttons on project and task forms
    document.getElementById('btn-vf-project')?.addEventListener('click', () => openModal('project'));
    document.getElementById('btn-vf-task')?.addEventListener('click', () => openModal('task'));
  }

  window.CresVoiceForms = { initVoiceForms, openModal };
})();
