/** Shared API client with JWT + refresh */
const CresAPI = (() => {
  const ACCESS_KEY = 'cres_access_token';
  const REFRESH_KEY = 'cres_refresh_token';
  const USER_KEY = 'cres_user';

  function getAccess() {
    return localStorage.getItem(ACCESS_KEY);
  }

  function getRefresh() {
    return localStorage.getItem(REFRESH_KEY);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function setSession({ accessToken, refreshToken, user }) {
    if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function request(path, options = {}, retry = true) {
    const headers = { ...(options.headers || {}) };
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;

    if (!isForm && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const token = getAccess();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let body = options.body;
    if (body !== undefined && !isForm && headers['Content-Type']?.includes('application/json')) {
      body = JSON.stringify(body);
    }

    const res = await fetch(path, {
      ...options,
      headers,
      body,
    });

    if (res.status === 401 && retry && getRefresh()) {
      const refreshed = await refresh();
      if (refreshed) return request(path, options, false);
      clearSession();
      if (!location.pathname.startsWith('/login')) location.href = '/login';
      throw new Error('Session expired');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data?.error?.code;
      err.details = data?.error?.details || null;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function login(email, password) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }, false);
    setSession(data.data);
    return data.data;
  }

  async function refresh() {
    try {
      const data = await request('/api/auth/refresh', {
        method: 'POST',
        body: { refreshToken: getRefresh() },
      }, false);
      setSession(data.data);
      return true;
    } catch {
      return false;
    }
  }

  async function logout() {
    try {
      await request('/api/auth/logout', {
        method: 'POST',
        body: { refreshToken: getRefresh() },
      }, false);
    } catch {
      // ignore
    }
    clearSession();
  }

  async function verify() {
    const data = await request('/api/auth/verify');
    const user = {
      id: data.data.user.id,
      name: data.data.user.name,
      email: data.data.user.email,
      phone: data.data.user.phone,
      role: data.data.user.role,
      status: data.data.user.status,
      avatar_url: data.data.user.avatar_url || null,
    };
    setSession({ user });
    return { user, permissions: data.data.permissions };
  }

  /** Authenticated blob download (CSV exports, invoice/receipt files, etc.) */
  async function download(path, filename) {
    const headers = {};
    const token = getAccess();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, { headers });
    if (res.status === 401 && getRefresh()) {
      const refreshed = await refresh();
      if (refreshed) return download(path, filename);
      clearSession();
      if (!location.pathname.startsWith('/login')) location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || `Download failed (${res.status})`);
    }

    // Force a real Save download. text/html blobs often open in a tab (looks like print).
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'application/octet-stream' });

    let name = filename || path.split('/').pop() || 'download';
    const cd = res.headers.get('Content-Disposition') || '';
    const m =
      /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(cd);
    if (m) {
      name = decodeURIComponent((m[1] || m[2] || m[3] || name).trim());
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return {
    getAccess,
    getRefresh,
    getUser,
    setSession,
    clearSession,
    request,
    download,
    login,
    logout,
    verify,
  };
})();
