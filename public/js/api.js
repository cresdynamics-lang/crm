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
    clearCache(true);
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function rawRequest(path, options = {}, retry = true) {
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

    const timeoutMs = options.timeoutMs ?? 15000;
    const controller = options.signal ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(path, {
        ...options,
        headers,
        body,
        signal: options.signal || controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (res.status === 401 && retry && getRefresh()) {
      const refreshed = await refresh();
      if (refreshed) return rawRequest(path, options, false);
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

  // --- Pop-up feedback for actions ------------------------------------------
  // [method, path pattern, what the action is ("create the invoice"), success title, detail(data, body)]
  // A null success title = no success pop-up (the screen already shows the result),
  // but failures still pop up.
  const ACTIONS = [
    // Finance
    ['POST', /^\/api\/invoices$/, 'create the invoice', 'Invoice created', (d) =>
      d?.data?.to ? (d.data.emailed ? `Invoice ${d.data.invoice_number || ''} is being emailed to ${d.data.to}.` : `Saved, but the email to ${d.data.to} did not queue. Use Resend.`) : 'The client has no email on file, so nothing was emailed.'],
    ['PATCH', /^\/api\/invoices\/[^/]+\/client$/, 'update the invoice client', 'Invoice client updated', (d) =>
      d?.data?.emailed ? `A copy is being emailed to ${d.data.to}.` : null],
    ['POST', /^\/api\/invoices\/[^/]+\/resend$/, 'resend the invoice', 'Invoice resend queued', (d) => d?.data?.to ? `Sending to ${d.data.to}.` : null],
    ['POST', /^\/api\/invoices\/[^/]+\/receipt\/send$/, 'email the invoice', 'Invoice email queued', (d) => d?.data?.to ? `Sending to ${d.data.to}.` : null],
    ['POST', /^\/api\/invoices\/followups\/[^/]+\/followed-up$/, 'mark the follow-up', 'Follow-up marked done'],
    ['POST', /^\/api\/payments$/, 'record the payment', 'Payment recorded', (d) =>
      d?.data?.receipt_emailed ? `Receipt is being emailed to ${d.data.receipt_to}.` : d?.data?.receipt_to ? 'Saved, but the receipt email did not go out. Send it again from the payment.' : 'Saved. The client has no email, so no receipt was sent.'],
    ['POST', /^\/api\/payments\/[^/]+\/receipt\/send$/, 'email the receipt', 'Receipt email queued', (d) => d?.data?.to ? `Sending to ${d.data.to}.` : null],
    ['POST', /^\/api\/expenses$/, 'submit the expense', 'Expense submitted', () => 'It is waiting for approval.'],
    ['POST', /^\/api\/expenses\/[^/]+\/(approve|finance-approve)$/, 'approve the expense', 'Expense approved'],
    ['POST', /^\/api\/expenses\/[^/]+\/reject$/, 'reject the expense', 'Expense rejected'],
    ['POST', /^\/api\/expenses\/flag-invoice$/, 'flag the invoice', 'Invoice flagged'],
    ['POST', /^\/api\/salaries\/[^/]+\/settle$/, 'settle the salary', 'Salary settled'],
    ['POST', /^\/api\/salaries\/funding$/, 'send the funding request', 'Funding request sent', () => 'You will be notified as it is approved.'],
    ['POST', /^\/api\/salaries\/funding\/[^/]+\/(admin-approve|finance-approve)$/, 'approve the funding request', 'Funding request approved'],
    ['POST', /^\/api\/salaries\/funding\/[^/]+\/reject$/, 'reject the funding request', 'Funding request rejected'],
    // People
    ['POST', /^\/api\/users$/, 'create the user', 'User created', (d, b) => b?.email ? `Sign-in details are being emailed to ${b.email}.` : null],
    ['PATCH', /^\/api\/users\/[^/]+$/, 'update the user', 'User updated'],
    ['DELETE', /^\/api\/users\/[^/]+$/, 'remove the user', 'User removed'],
    ['POST', /^\/api\/salaries\/employees$/, 'create the employee', 'Employee created', (d, b) => b?.email ? `Sign-in details are being emailed to ${b.email}.` : null],
    ['PATCH', /^\/api\/salaries\/employees\/[^/]+$/, 'update the employee', 'Employee updated'],
    ['DELETE', /^\/api\/salaries\/employees\/[^/]+$/, 'remove the employee', 'Employee removed'],
    ['POST', /^\/api\/hr\/applicants$/, 'add the applicant', 'Applicant added'],
    ['PATCH', /^\/api\/hr\/applicants\/[^/]+$/, 'update the applicant', 'Applicant updated'],
    ['PUT', /^\/api\/hr\/onboarding\/[^/]+$/, 'save onboarding', 'Onboarding saved'],
    ['POST', /^\/api\/invites\/invite$/, 'send the invite', 'Invite sent'],
    ['POST', /^\/api\/leave$/, 'submit the leave request', 'Leave request submitted', () => 'HR will review it.'],
    ['POST', /^\/api\/leave\/[^/]+\/decide$/, 'decide the leave request', 'Leave decision saved'],
    // Sales / CRM
    ['POST', /^\/api\/leads$/, 'add the lead', 'Lead added'],
    ['POST', /^\/api\/leads\/bulk$/, 'import the leads', 'Leads imported'],
    ['PATCH', /^\/api\/leads\/[^/]+$/, 'update the lead', 'Lead updated'],
    ['DELETE', /^\/api\/leads\/[^/]+$/, 'delete the lead', 'Lead deleted'],
    ['POST', /^\/api\/leads\/[^/]+\/engagements$/, 'log the contact', 'Contact logged'],
    ['POST', /^\/api\/leads\/[^/]+\/messages$/, 'save the message', 'Message saved'],
    ['POST', /^\/api\/leads\/[^/]+\/messages\/[^/]+\/send$/, 'send the message', 'Message queued to send'],
    ['POST', /^\/api\/leads\/[^/]+\/win$/, 'mark the lead as won', 'Lead won', () => 'Nice work. It is now a client.'],
    ['POST', /^\/api\/clients$/, 'add the client', 'Client added'],
    ['PATCH', /^\/api\/clients\/[^/]+$/, 'update the client', 'Client updated'],
    ['DELETE', /^\/api\/clients\/[^/]+$/, 'delete the client', 'Client deleted'],
    ['POST', /^\/api\/emails$/, 'send the email', 'Email queued to send'],
    // Projects
    ['POST', /^\/api\/projects$/, 'create the project', 'Project submitted', () => 'It is waiting for Director approval.'],
    ['DELETE', /^\/api\/projects\/[^/]+$/, 'delete the project', 'Project deleted'],
    ['POST', /^\/api\/projects\/[^/]+\/approve$/, 'approve the project', 'Project approved'],
    ['POST', /^\/api\/projects\/[^/]+\/reject$/, 'reject the project', 'Project sent back'],
    ['PATCH', /^\/api\/projects\/[^/]+\/resubmit$/, 'resubmit the project', 'Project resubmitted'],
    ['PATCH', /^\/api\/projects\/[^/]+\/progress$/, 'save the progress update', 'Progress saved', (d) => {
      const n = d?.data?.completed_milestones?.length;
      return n ? `${n} milestone(s) completed. The client is being emailed.` : null;
    }],
    ['POST', /^\/api\/projects\/[^/]+\/blocked$/, 'flag the project as blocked', 'Blocker reported'],
    ['POST', /^\/api\/projects\/[^/]+\/messages$/, 'send the message', null],
    ['POST', /^\/api\/projects\/[^/]+\/change-requests\/[^/]+\/decide$/, 'decide the change request', 'Change request decided'],
    ['POST', /^\/api\/assignments$/, 'assign the work', 'Assigned'],
    ['POST', /^\/api\/assignments\/[^/]+\/accept$/, 'accept the assignment', 'Assignment accepted'],
    ['POST', /^\/api\/assignments\/[^/]+\/reject$/, 'decline the assignment', 'Assignment declined'],
    ['POST', /^\/api\/assignments\/[^/]+\/swap$/, 'swap the assignment', 'Assignment swapped'],
    ['POST', /^\/api\/tasks$/, 'create the task', 'Task created'],
    ['PATCH', /^\/api\/tasks\/[^/]+$/, 'update the task', 'Task updated'],
    ['DELETE', /^\/api\/tasks\/[^/]+$/, 'delete the task', 'Task deleted'],
    // Reports
    ['POST', /^\/api\/reports$/, 'submit your report', 'Report submitted', () => 'Sent to the Director.'],
    ['POST', /^\/api\/reports\/delay-notes$/, 'file the delay reason', 'Delay reason filed', () => 'Sent to the Director and kept on record.'],
    ['POST', /^\/api\/reports\/[^/]+\/review$/, 'review the report', 'Report reviewed'],
    ['POST', /^\/api\/reports\/[^/]+\/forward$/, 'forward the report', 'Report forwarded'],
    ['POST', /^\/api\/reports\/[^/]+\/(remarks|director-note)$/, 'save your note', 'Note saved'],
    ['POST', /^\/api\/reports\/[^/]+\/reply$/, 'send your reply', 'Reply sent'],
    // Client portal
    ['POST', /^\/api\/client\/change-requests$/, 'send your change request', 'Change request sent', () => 'The team will get back to you.'],
    ['POST', /^\/api\/client\/documents$/, 'upload the document', 'Document uploaded'],
    ['POST', /^\/api\/client\/invoices\/[^/]+\/mpesa$/, 'start the M-Pesa payment', 'Check your phone', () => 'Enter your M-Pesa PIN to complete the payment.'],
    ['POST', /^\/api\/client\/projects\/[^/]+\/signoffs$/, 'sign off', 'Signed off', () => 'Thank you.'],
    // Meetings
    ['POST', /^\/api\/meetings$/, 'schedule the meeting', 'Meeting scheduled', () => 'Invites are being sent.'],
    ['POST', /^\/api\/meetings\/[^/]+\/invite$/, 'send the invite', 'Invite sent'],
    ['POST', /^\/api\/meetings\/[^/]+\/end$/, 'end the meeting', 'Meeting ended'],
    // Settings / admin
    ['PATCH', /^\/api\/settings\/profile$/, 'save your profile', 'Profile saved'],
    ['POST', /^\/api\/settings\/password$/, 'change your password', 'Password changed'],
    ['PATCH', /^\/api\/settings\/notifications$/, 'save notification settings', 'Notification settings saved'],
    ['POST', /^\/api\/settings\/avatar$/, 'upload your photo', 'Photo updated'],
    ['DELETE', /^\/api\/settings\/avatar$/, 'remove your photo', 'Photo removed'],
    ['PATCH', /^\/api\/admin\/system\/[^/]+$/, 'save the setting', 'Setting saved'],
    ['POST', /^\/api\/admin\/failed-jobs\/[^/]+\/retry$/, 'retry the job', 'Job retried'],
    ['DELETE', /^\/api\/admin\/failed-jobs\/[^/]+$/, 'dismiss the job', 'Job dismissed'],
    ['POST', /^\/api\/admin\/inbox\/[^/]+\/approve$/, 'send the reply', 'Reply sent', (d) => d?.data?.to ? `Sent to ${d.data.to}.` : null],
    ['POST', /^\/api\/admin\/inbox\/[^/]+\/ignore$/, 'ignore the email', 'Email ignored'],
    ['POST', /^\/api\/admin\/inbox\/sync$/, 'sync the inbox', 'Inbox synced'],
    ['POST', /^\/api\/admin\/inbox\/[^/]+\/decline$/, 'send the decline', 'Decline sent'],
    ['POST', /^\/api\/admin\/inbox\/bulk$/, 'update the selected emails', 'Done'],
    ['POST', /^\/api\/admin\/inbox\/[^/]+\/scam$/, 'update the scam flag', 'Updated'],
    ['DELETE', /^\/api\/admin\/inbox\/[^/]+$/, 'delete the email', 'Email deleted'],
    ['PATCH', /^\/api\/admin\/inbox\/[^/]+\/draft$/, 'save the draft', null],
    ['POST', /^\/api\/mail\/forward$/, 'forward the email', 'Forwarded'],
    ['POST', /^\/api\/mail\/send$/, 'send the email', 'Email sent'],
    ['POST', /^\/api\/mail\/[^/]+\/reply$/, 'send the reply', 'Reply sent'],
    ['POST', /^\/api\/mail\/[^/]+\/done$/, 'update the email', 'Done'],
  ];

  // Background / chatty calls: no pop-ups at all (they show results in place).
  const SILENT = [
    /^\/api\/auth\//,
    /^\/api\/notifications\//,
    /^\/api\/messages\//,
    /^\/api\/jarvis\//,
    /^\/api\/ops\/(ask|ingest)/,
    /\/voice-capture$/,
    /\/(ai-review|remarks-ai|regenerate)$/,
    /^\/api\/mail\/[^/]+\/draft$/,
    /^\/api\/meetings\/[^/]+\/(admit|request)$/,
    /^\/api\/attendance\/(heartbeat|ping)/,
  ];

  function describe(method, path) {
    const clean = path.split('?')[0];
    if (SILENT.some((re) => re.test(clean))) return null;
    const hit = ACTIONS.find(([m, re]) => m === method && re.test(clean));
    if (hit) return { what: hit[2], title: hit[3], detail: hit[4] };
    return {
      what: method === 'DELETE' ? 'delete this' : 'save your changes',
      title: method === 'DELETE' ? 'Deleted' : 'Saved',
      detail: null,
    };
  }

  function friendlyFailure(err, what, method) {
    const status = err?.status || 0;
    const serverMsg = err?.message && !/^Request failed \(\d+\)$/.test(err.message) ? err.message : '';
    if (!status) {
      const timedOut = /timed out/i.test(err?.message || '');
      return {
        title: `Couldn't ${what}`,
        detail: timedOut
          ? (method === 'POST'
            ? 'The server took too long to answer. It may or may not have saved, so check before trying again in a few minutes.'
            : 'The server took too long to answer. Try again in a few minutes.')
          : (navigator.onLine === false
            ? 'You are offline. Check your connection and try again.'
            : 'The server could not be reached. Nothing was saved. Try again in a few minutes.'),
        retryable: true,
      };
    }
    if (status === 429) return { title: `Couldn't ${what}`, detail: serverMsg || 'Too many attempts. Wait a few minutes and try again.', retryable: false };
    if (status >= 500) return { title: `Couldn't ${what}`, detail: 'Something went wrong on our side. Nothing was saved. Try again in a few minutes; if it keeps failing, tell Admin.', retryable: true };
    if (status === 403) return { title: `You can't ${what}`, detail: serverMsg && !/^forbidden|missing permission/i.test(serverMsg) ? serverMsg : 'Your role does not allow this. Ask Admin if you need access.', retryable: false };
    if (status === 404) return { title: `Couldn't ${what}`, detail: 'That item no longer exists. Refresh the page.', retryable: false };
    if (status === 409) return { title: `Couldn't ${what}`, detail: serverMsg || 'This was already done, or someone changed it first. Refresh and check.', retryable: false };
    return { title: `Couldn't ${what}`, detail: serverMsg || 'Check the form and try again.', retryable: false };
  }

  function emit(name) {
    try {
      window.dispatchEvent(new Event(name));
    } catch {
      /* old browser */
    }
  }

  /**
   * Wraps request() for POST/PATCH/PUT/DELETE: pops up success or failure.
   * options.toast === false  → no pop-ups (caller handles it)
   * options.toastSuccess     → custom success title (string) or false for none
   */
  async function requestWithFeedback(path, options = {}, retry = true) {
    const method = String(options.method || 'GET').toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD';
    const toastApi = typeof CresToast !== 'undefined' ? CresToast : null;
    const info = mutating && options.toast !== false && toastApi ? describe(method, path) : null;
    if (mutating) emit('cres:request-start');
    try {
      const data = await rawRequest(path, options, retry);
      if (info) {
        const title = options.toastSuccess === false ? null : options.toastSuccess || info.title;
        if (title) {
          let detail = null;
          try {
            const plainBody = typeof FormData !== 'undefined' && options.body instanceof FormData ? null : options.body;
            detail = info.detail ? info.detail(data, plainBody) : null;
          } catch {
            detail = null;
          }
          toastApi.success(title, { detail });
        }
      }
      return data;
    } catch (err) {
      if (info && err?.message !== 'Session expired') {
        const f = friendlyFailure(err, info.what, method);
        // Safe to repeat: PATCH/PUT/DELETE, or a POST carrying an idempotency key.
        const canRepeat = f.retryable && (method !== 'POST' || options.idempotencyKey);
        toastApi.error(f.title, {
          detail: f.detail,
          action: canRepeat
            ? { label: 'Try again', onClick: () => requestWithFeedback(path, options, retry).catch(() => {}) }
            : undefined,
        });
        err.toasted = true;
      }
      throw err;
    } finally {
      if (mutating) emit('cres:request-end');
    }
  }

  // --- Faster navigation + fallback for reads ------------------------------
  // GET results are kept briefly (15s) so moving between pages is instant, and
  // identical requests made at the same moment share one network call. Any
  // change (POST/PATCH/PUT/DELETE) clears the cache so nothing stale shows.
  // If the server can't be reached, the last good copy is shown instead of an
  // error, with a notice that it may be out of date.
  const CACHE_MS = 15000;
  const cache = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> promise
  const LAST_GOOD_PREFIX = 'cres_lg:';
  const NO_CACHE = [/^\/api\/auth\//, /^\/api\/jarvis\//, /^\/api\/health/, /^\/api\/meetings\/config/];
  let staleNoticeAt = 0;

  function cacheKey(path) {
    const u = getUser();
    return `${u?.id || 'anon'}|${path}`;
  }

  function clearCache(all = false) {
    cache.clear();
    if (all) {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(LAST_GOOD_PREFIX)) sessionStorage.removeItem(k);
        }
      } catch {
        /* storage unavailable */
      }
    }
  }

  function rememberGood(key, data) {
    try {
      const raw = JSON.stringify(data);
      if (raw.length < 150000) sessionStorage.setItem(LAST_GOOD_PREFIX + key, raw);
    } catch {
      /* quota or private mode: memory only */
    }
  }

  function lastGood(key) {
    const mem = cache.get(key);
    if (mem) return mem.data;
    try {
      const raw = sessionStorage.getItem(LAST_GOOD_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function cachedGet(path, options, retry) {
    const clean = path.split('?')[0];
    const cacheable = !options.noCache && !options.signal && !NO_CACHE.some((re) => re.test(clean));
    if (!cacheable) return rawRequest(path, options, retry);
    const key = cacheKey(path);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    if (inflight.has(key)) return inflight.get(key);
    const p = rawRequest(path, options, retry)
      .then((data) => {
        cache.set(key, { at: Date.now(), data });
        rememberGood(key, data);
        return data;
      })
      .catch((err) => {
        const unreachable = !err.status || err.status >= 500;
        const saved = unreachable && err.message !== 'Session expired' ? lastGood(key) : null;
        if (!saved) throw err;
        if (Date.now() - staleNoticeAt > 60000 && typeof CresToast !== 'undefined') {
          staleNoticeAt = Date.now();
          CresToast.warning('Showing saved data', { detail: "Couldn't reach the server, so you're seeing the last copy. It refreshes by itself when the connection is back." });
        }
        return { ...saved, stale: true };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function request(path, options = {}, retry = true) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'GET') return cachedGet(path, options, retry);
    const result = await requestWithFeedback(path, options, retry);
    clearCache();
    return result;
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
    clearCache,
    download,
    login,
    logout,
    refresh,
    verify,
  };
})();
