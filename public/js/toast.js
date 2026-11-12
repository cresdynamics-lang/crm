/**
 * CresToast — pop-up notifications for screen actions.
 *
 *   CresToast.success('Invoice created', { detail: 'Emailed to client@x.com' })
 *   CresToast.error('Couldn't record the payment', { detail: '…', action: { label: 'Try again', onClick } })
 *   CresToast.info(...) / CresToast.warning(...)
 *
 * Also:
 *  - window.alert() becomes a non-blocking warning toast (same message twice in a
 *    few seconds is shown once, so an API error toast + an alert don't double up).
 *  - Submit buttons show "Saving…" and are disabled while the form's request runs,
 *    so people can't double-submit and can see something is happening.
 *  - Going offline / back online is announced.
 */
const CresToast = (() => {
  const MAX = 4;
  const recent = []; // { text, at }
  let host;

  const ICONS = {
    success: '<path d="M5 10.5l3.2 3.2L15 7" />',
    error: '<path d="M10 6v5M10 14h.01" /><circle cx="10" cy="10" r="7.5" />',
    warning: '<path d="M10 3.5l7 12.5H3z" /><path d="M10 8.5v3.5M10 14.2h.01" />',
    info: '<circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6.2h.01" />',
  };

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.className = 'cres-toasts';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(host);
    return host;
  }

  function isDuplicate(text) {
    const now = Date.now();
    while (recent.length && now - recent[0].at > 4000) recent.shift();
    const t = String(text || '').trim().toLowerCase();
    if (!t) return true;
    return recent.some((r) => r.text.includes(t) || t.includes(r.text));
  }

  function dismiss(el) {
    if (!el || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }

  /**
   * show(type, title, { detail, action: { label, onClick }, duration })
   * duration: ms before auto-close (0 = stays until closed). Errors stay longer.
   */
  function show(type, title, opts = {}) {
    const text = [title, opts.detail].filter(Boolean).join(' ');
    if (!opts.force && isDuplicate(text)) return null;
    recent.push({ text: text.toLowerCase(), at: Date.now() });

    const root = ensureHost();
    while (root.children.length >= MAX) root.firstElementChild.remove();

    const el = document.createElement('div');
    el.className = `cres-toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add('cres-toast-icon');
    icon.innerHTML = ICONS[type] || ICONS.info;

    const body = document.createElement('div');
    body.className = 'cres-toast-body';
    const t = document.createElement('div');
    t.className = 'cres-toast-title';
    t.textContent = title;
    body.appendChild(t);
    if (opts.detail) {
      const d = document.createElement('div');
      d.className = 'cres-toast-detail';
      d.textContent = opts.detail;
      body.appendChild(d);
    }
    if (opts.action?.label && typeof opts.action.onClick === 'function') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cres-toast-action';
      b.textContent = opts.action.label;
      b.addEventListener('click', () => {
        dismiss(el);
        opts.action.onClick();
      });
      body.appendChild(b);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cres-toast-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => dismiss(el));

    el.append(icon, body, close);
    root.appendChild(el);

    const duration = opts.duration ?? (type === 'error' ? 9000 : type === 'warning' ? 7000 : 4500);
    if (duration > 0) {
      let timer = setTimeout(() => dismiss(el), duration);
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', () => {
        timer = setTimeout(() => dismiss(el), 2500);
      });
    }
    return el;
  }

  const api = {
    show,
    success: (title, opts) => show('success', title, opts),
    error: (title, opts) => show('error', title, opts),
    warning: (title, opts) => show('warning', title, opts),
    info: (title, opts) => show('info', title, opts),
  };

  // --- alert() → toast -----------------------------------------------------
  const nativeAlert = window.alert ? window.alert.bind(window) : null;
  window.alert = (msg) => {
    try {
      api.warning(String(msg ?? ''));
    } catch {
      nativeAlert?.(msg);
    }
  };

  // --- Busy state on submit buttons ---------------------------------------
  // A submit marks its button busy; CresAPI fires cres:request-end when the
  // mutating requests settle. If no request starts (client-side validation), the
  // button is released straight away.
  let pending = null; // { btn, label, started, timer }

  function release() {
    if (!pending) return;
    const { btn, label, timer } = pending;
    clearTimeout(timer);
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-busy');
    if (label != null) btn.textContent = label;
    pending = null;
  }

  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || form.dataset.noBusy != null) return;
      const btn = e.submitter || form.querySelector('button[type="submit"], button:not([type])');
      if (!btn || btn.disabled) return;
      release();
      pending = { btn, label: null, started: 0, timer: null };
      // After the page's own submit handler runs, see whether it started a request.
      setTimeout(() => {
        if (!pending || pending.btn !== btn) return;
        if (!pending.started) return release();
        pending.label = btn.textContent;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.classList.add('is-busy');
        btn.textContent = /delete|remove/i.test(pending.label) ? 'Working…' : 'Saving…';
        pending.timer = setTimeout(release, 45000); // never leave a button stuck
      }, 0);
    },
    true
  );

  let inflight = 0;
  window.addEventListener('cres:request-start', () => {
    inflight += 1;
    if (pending) pending.started += 1;
  });
  window.addEventListener('cres:request-end', () => {
    inflight = Math.max(0, inflight - 1);
    if (pending && inflight === 0) release();
  });

  // --- Connection status ----------------------------------------------------
  window.addEventListener('offline', () =>
    api.warning('You are offline', {
      detail: 'Changes will not save until your connection is back.',
      duration: 0,
      force: true,
    })
  );
  window.addEventListener('online', () => {
    document.querySelectorAll('.cres-toast.warning').forEach((el) => {
      if (/offline/i.test(el.textContent)) dismiss(el);
    });
    api.success('Back online', { detail: 'You can carry on.', force: true });
  });

  return api;
})();
