/**
 * CRES OS alerts: sound, ring, vibration and system notifications when something arrives
 * (notifications, community messages, team mail, company inbox, calls).
 *
 *  - Sounds are synthesised in the browser (no files), so they work offline.
 *  - Browsers only allow sound after the person has touched the page once; the first tap/click unlocks it.
 *  - When the tab is hidden a system notification is shown (laptop and phone) and the tab title counts up.
 *  - There is no on-screen switch: the device's own notification and volume settings decide.
 *  - A phone can only ring while the app is open or in the background. Ringing with the app closed
 *    needs Web Push, which is a separate step.
 */
const CresAlerts = (() => {
  const KEY = 'cres.alerts';
  let ctx = null;
  let ringTimer = null;
  let unseen = 0;
  const baseTitle = document.title;
  const seen = new Set();
  let firstPollDone = false;

  function prefs() {
    try {
      return { sound: true, desktop: true, volume: 0.6, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      return { sound: true, desktop: true, volume: 0.6 };
    }
  }
  function savePrefs(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
  }

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /** First touch unlocks sound (autoplay rules on phones and laptops). */
  function unlock() {
    audio();
    ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.removeEventListener(e, unlock, true));
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.addEventListener(e, unlock, true));

  function tone(freq, start, dur, vol = 0.5, type = 'sine') {
    const c = audio();
    if (!c || c.state !== 'running') return;
    const o = c.createOscillator();
    const g = c.createGain();
    const t0 = c.currentTime + start;
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    const v = Math.max(0.01, vol * prefs().volume);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  const SOUNDS = {
    notify: () => { tone(880, 0, 0.22); tone(1320, 0.16, 0.35); },
    message: () => { tone(660, 0, 0.12, 0.45, 'triangle'); tone(990, 0.1, 0.22, 0.45, 'triangle'); },
    mail: () => { tone(523, 0, 0.18); tone(659, 0.15, 0.18); tone(784, 0.3, 0.4); },
    alert: () => { for (let i = 0; i < 3; i++) { tone(1000, i * 0.34, 0.16, 0.7, 'square'); tone(760, i * 0.34 + 0.17, 0.16, 0.7, 'square'); } },
  };

  function play(kind = 'notify') {
    if (!prefs().sound) return;
    (SOUNDS[kind] || SOUNDS.notify)();
  }

  /** Phone-style ring until stopRing(): two bursts every two seconds. */
  function startRing() {
    if (ringTimer || !prefs().sound) return;
    const burst = () => {
      tone(440, 0, 0.4, 0.6, 'sine'); tone(480, 0, 0.4, 0.6, 'sine');
      tone(440, 0.5, 0.4, 0.6, 'sine'); tone(480, 0.5, 0.4, 0.6, 'sine');
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    };
    burst();
    ringTimer = setInterval(burst, 2200);
    setTimeout(stopRing, 45000); // never ring forever
  }
  function stopRing() {
    if (ringTimer) clearInterval(ringTimer);
    ringTimer = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  async function showSystem(title, body, { tag, href } = {}) {
    const p = prefs();
    if (!p.desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const opts = { body: body || '', tag: tag || undefined, icon: '/icons/cres-os-192.png', badge: '/icons/cres-os-192.png', data: { href: href || '/' }, renotify: Boolean(tag) };
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg?.showNotification) return await reg.showNotification(title, opts); // works on phones too
      new Notification(title, opts); // eslint-disable-line no-new
    } catch { /* best effort */ }
  }

  function bumpTitle() {
    if (!document.hidden) return;
    unseen += 1;
    document.title = `(${unseen}) ${baseTitle}`;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unseen = 0; document.title = baseTitle; }
  });

  /** Main entry: kind = notify | message | mail | alert. Duplicate ids are ignored. */
  function notify({ id, kind = 'notify', title = 'CRES OS', body = '', href, always = false } = {}) {
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 500) seen.delete(seen.values().next().value);
    }
    if (document.hidden || always) {
      showSystem(title, body, { tag: id ? String(id) : undefined, href });
      bumpTitle();
      if (navigator.vibrate && kind !== 'message') navigator.vibrate(kind === 'alert' ? [300, 100, 300, 100, 300] : [200]);
    }
    play(kind);
  }

  const URGENT = /(overdue|urgent|alert|spike|security|penalty|suspend|failed|declin|reject|deadline|abuse)/i;
  function kindFor(n) {
    const text = `${n?.type || ''} ${n?.content || ''}`;
    if (/mail/i.test(n?.type || '')) return 'mail';
    return URGENT.test(text) ? 'alert' : 'notify';
  }

  function wire() {
    if (typeof CresRealtime === 'undefined') return;
    const me = () => (typeof CresAPI !== 'undefined' ? CresAPI.getUser() : null);

    CresRealtime.on('notification', (n) => {
      if (!n) return;
      if (n.__poll) {
        // Poll fallback: ring only for items we have not seen; the first poll just learns what exists
        (n.items || []).forEach((it) => {
          if (!firstPollDone) { if (it.id) seen.add(it.id); return; }
          if (!it.read_at) notify({ id: it.id, kind: kindFor(it), title: 'CRES OS', body: it.content, href: it.meta?.href });
        });
        firstPollDone = true;
        return;
      }
      if (n.read_at) return;
      notify({ id: n.id, kind: kindFor(n), title: 'CRES OS', body: n.content, href: n.meta?.href });
    });

    CresRealtime.on('message', (m) => {
      if (!m || m.__poll || m.sender_id === me()?.id) return;
      notify({ id: `msg-${m.id}`, kind: 'message', title: m.sender_name || 'New message', body: String(m.body || m.content || '').slice(0, 140), href: '/dashboard' });
    });

    CresRealtime.on('call', (msg) => {
      if (msg?.event === 'call:invite') {
        notify({ id: `call-${msg.callId || msg.from || Date.now()}`, kind: 'alert', title: 'Incoming call', body: msg.fromName || msg.from_name || '', always: true });
        startRing();
      } else if (['call:accept', 'call:reject', 'call:hangup'].includes(msg?.event)) {
        stopRing();
      }
    });
  }

  /**
   * No in-app switches: sound and pop-ups follow the device. The first time the person touches the page
   * after signing in, the browser or phone itself asks "Allow notifications?"; their answer (and the
   * phone's own volume / silent / focus settings) decide the rest.
   */
  function askPermissionOnce() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    try { if (localStorage.getItem('cres.alerts.asked')) return; } catch { /* private mode: ask anyway */ }
    const ask = () => {
      ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.removeEventListener(e, ask, true));
      if (typeof CresAPI !== 'undefined' && !CresAPI.getAccess()) return;
      try { localStorage.setItem('cres.alerts.asked', '1'); } catch { /* ignore */ }
      Notification.requestPermission().catch(() => {});
    };
    ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.addEventListener(e, ask, true));
  }

  function init() {
    wire();
    askPermissionOnce();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { notify, play, startRing, stopRing };
})();
