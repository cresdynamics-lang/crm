/**
 * Menu + bell for the standalone pages (company inbox, Team mail, meetings).
 *
 * Adds a small menu button that opens the same navigation as the dashboard
 * (filtered by role), and a bell with the real unread count. Opening a
 * notification marks it read. New notifications pop up while you're here.
 * Needs nav.js, api.js and (optionally) toast.js / socket.io on the page.
 */
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let notifs = [];
  let unread = 0;

  function linkFor(href) {
    return href && href.startsWith('#') ? `/dashboard${href}` : href;
  }

  function hrefForNotification(n) {
    let meta = n.meta;
    if (typeof meta === 'string') {
      try {
        meta = JSON.parse(meta);
      } catch {
        meta = {};
      }
    }
    meta = meta || {};
    if (meta.href) return linkFor(meta.href);
    if (meta.projectId) return `/dashboard#/projects/${meta.projectId}`;
    if (meta.invoiceId) return '/dashboard#/invoices';
    return '/dashboard';
  }

  function paintBadge() {
    const b = document.getElementById('ms-badge');
    if (!b) return;
    b.hidden = unread <= 0;
    b.textContent = unread > 99 ? '99+' : String(unread);
  }

  function renderList() {
    const list = document.getElementById('ms-notif-list');
    if (!list) return;
    const unreadOnly = notifs.filter((n) => !n.read_at); // read ones live in Notifications on the dashboard
    list.innerHTML = unreadOnly.length
      ? unreadOnly
          .slice(0, 30)
          .map((n) => `<button type="button" class="ms-notif${n.read_at ? '' : ' unread'}" data-id="${esc(n.id)}">
              <span>${esc(n.content)}</span>
              <small>${esc(new Date(n.created_at).toLocaleString())}</small>
            </button>`)
          .join('')
      : '<div class="ms-empty">You\'re all caught up.</div>';
    list.insertAdjacentHTML('beforeend', '<a class="ms-all" href="/dashboard#/notifications" style="display:block;padding:10px;text-align:center;">See all notifications</a>');
  }

  async function load() {
    try {
      const res = await CresAPI.request('/api/notifications?filter=unread&limit=100', { noCache: true });
      notifs = res.data || [];
      unread = Number(res.meta?.unread ?? notifs.filter((n) => !n.read_at).length);
      paintBadge();
      if (document.getElementById('ms-notif-panel')?.classList.contains('open')) renderList();
    } catch {
      /* the page still works without the bell */
    }
  }

  async function openNotification(n) {
    if (!n.read_at) {
      n.read_at = new Date().toISOString();
      unread = Math.max(0, unread - 1);
      paintBadge();
      CresAPI.request(`/api/notifications/${n.id}/read`, { method: 'POST', toast: false }).catch(() => {});
    }
    const href = hrefForNotification(n);
    if (href && href !== location.pathname + location.hash) location.href = href;
    else renderList();
  }

  function build(user, permissions) {
    const top = document.querySelector('.mt-top');
    if (!top || document.getElementById('ms-menu-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ms-menu-btn';
    btn.className = 'ms-menu-btn';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<span></span><span></span><span></span>';
    top.prepend(btn);

    // Back: to where you came from inside CRES OS, else the dashboard
    const back = document.createElement('button');
    back.type = 'button';
    back.id = 'ms-back-btn';
    back.className = 'ms-back';
    back.setAttribute('aria-label', 'Back');
    back.textContent = '‹';
    back.addEventListener('click', () => {
      const sameSite = document.referrer && new URL(document.referrer).origin === location.origin && !/\/login/.test(document.referrer);
      if (sameSite && history.length > 1) history.back();
      else location.href = '/dashboard';
    });
    top.prepend(back);

    const right = top.querySelector('.mt-top-right') || top;
    const bell = document.createElement('div');
    bell.className = 'ms-bell-wrap';
    bell.innerHTML = `<button type="button" class="ms-bell" id="ms-bell" aria-label="Notifications" title="Notifications">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5" /><path d="M9 17a3 3 0 0 0 6 0" /></svg>
        <span class="ms-badge" id="ms-badge" hidden>0</span>
      </button>
      <div class="ms-notif-panel" id="ms-notif-panel">
        <div class="ms-notif-head"><span>Notifications</span><button type="button" id="ms-read-all">Mark all read</button></div>
        <div id="ms-notif-list"></div>
      </div>`;
    right.prepend(bell);

    const drawer = document.createElement('div');
    drawer.className = 'ms-drawer';
    drawer.id = 'ms-drawer';
    drawer.innerHTML = `<div class="ms-drawer-panel" role="dialog" aria-label="Menu">
        <div class="ms-drawer-head"><img src="/icons/cres-os-192.png" alt="" /><div><strong>${esc(user.name)}</strong><small>${esc(user.role)}</small></div></div>
        <ul class="ms-nav" id="ms-nav"></ul>
      </div>`;
    document.body.appendChild(drawer);

    const nav = drawer.querySelector('#ms-nav');
    if (typeof CresNav !== 'undefined') {
      CresNav.render(nav, user, permissions, '#/__standalone'); // no dashboard item is 'active' here
      nav.querySelectorAll('a').forEach((a) => {
        const href = a.getAttribute('href');
        a.setAttribute('href', linkFor(href));
        if (href === location.pathname) a.classList.add('active');
      });
    }

    const closeAll = () => {
      drawer.classList.remove('open');
      document.getElementById('ms-notif-panel').classList.remove('open');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      drawer.classList.toggle('open');
    });
    drawer.addEventListener('click', (e) => {
      if (e.target === drawer) drawer.classList.remove('open');
    });
    document.getElementById('ms-bell').addEventListener('click', (e) => {
      e.stopPropagation();
      const p = document.getElementById('ms-notif-panel');
      p.classList.toggle('open');
      if (p.classList.contains('open')) renderList();
    });
    document.getElementById('ms-notif-panel').addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.ms-notif');
      if (item) {
        const n = notifs.find((x) => x.id === item.dataset.id);
        if (n) openNotification(n);
      }
    });
    document.getElementById('ms-read-all').addEventListener('click', async () => {
      await CresAPI.request('/api/notifications/read-all', { method: 'POST', toast: false }).catch(() => {});
      notifs.forEach((n) => (n.read_at = n.read_at || new Date().toISOString()));
      unread = 0;
      paintBadge();
      renderList();
    });
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll());
  }

  function live() {
    if (typeof io === 'undefined') return;
    const socket = io({ path: '/socket.io', auth: (cb) => cb({ token: CresAPI.getAccess() }), transports: ['websocket', 'polling'] });
    socket.on('notification:new', (n) => {
      if (!n?.id || notifs.some((x) => x.id === n.id)) return;
      notifs.unshift(n);
      if (!n.read_at) unread += 1;
      paintBadge();
      if (typeof CresToast !== 'undefined') {
        CresToast.info(n.content || 'New notification', { force: true, action: { label: 'Open', onClick: () => openNotification(n) } });
      }
    });
  }

  async function start() {
    if (!CresAPI.getAccess()) return;
    let v;
    try {
      v = await CresAPI.verify();
    } catch {
      return;
    }
    if (!v?.user || v.user.role === 'client') return;
    build(v.user, v.permissions || []);
    await load();
    live();
    setInterval(() => document.visibilityState === 'visible' && load(), 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
