(function () {
  const state = {
    panel: 'login',
    email: '',
    resetToken: '',
  };

  const errorEl = document.getElementById('login-error');
  const okEl = document.getElementById('login-ok');
  const subtitle = document.getElementById('login-subtitle');

  const subtitles = {
    login: 'Business Operating System - sign in to continue',
    forgot: 'We’ll email a one-time code to reset your password',
    verify: 'Confirm the code from your inbox',
    reset: 'Choose a new password',
    invite: 'Set a password to activate your invite',
  };

  function showError(msg) {
    okEl.classList.remove('visible');
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('visible', Boolean(msg));
  }

  function showOk(msg) {
    errorEl.classList.remove('visible');
    okEl.textContent = msg || '';
    okEl.classList.toggle('visible', Boolean(msg));
  }

  function showPanel(name) {
    state.panel = name;
    document.querySelectorAll('.panel').forEach((el) => {
      el.hidden = el.dataset.panel !== name;
    });
    subtitle.textContent = subtitles[name] || subtitles.login;
    showError('');
  }

  /** Where to go after signing in: a same-site path from ?next=, else the dashboard. */
  function nextPath() {
    const next = new URLSearchParams(location.search).get('next') || '';
    return /^\/(?!\/)[\w\-./#?=&%]*$/.test(next) ? next : '/dashboard';
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    const inviteToken = params.get('invite');

    if (CresAPI.getAccess() && !inviteToken) {
      try {
        await CresAPI.verify();
        location.replace(nextPath());
        return;
      } catch {
        CresAPI.clearSession();
      }
    }
    bind();
    // Arriving from the "see your password" page: remind them which email to type (a masked hint, never the full address)
    const hint = params.get('hint') || '';
    if (/^[\w.\-+]{1,3}\.{5}[\w.\-+]{0,3}@[\w.\-]+$/.test(hint)) {
      const el = document.getElementById('email-hint');
      el.textContent = `Enter your email. Hint: ${hint}`;
      el.hidden = false;
      document.getElementById('email').focus();
    }
    if (inviteToken) {
      state.inviteToken = inviteToken;
      showPanel('invite');
    }
  }

  let resendTimer = null;
  function startResendCooldown(seconds = 45) {
    const btn = document.getElementById('resend-code');
    let left = seconds;
    clearInterval(resendTimer);
    btn.disabled = true;
    const tick = () => {
      btn.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
      if (left <= 0) { clearInterval(resendTimer); btn.disabled = false; }
      left -= 1;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  function bind() {
    document.getElementById('resend-code').addEventListener('click', async () => {
      const btn = document.getElementById('resend-code');
      btn.disabled = true;
      try {
        await CresAPI.request('/api/auth/forgot-password', { method: 'POST', body: { email: state.email } }, false);
        showOk('A new code is on its way. The old one no longer works.');
        startResendCooldown();
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });

    document.getElementById('goto-forgot').addEventListener('click', () => {
      const email = document.getElementById('email').value.trim();
      if (email) document.getElementById('forgot-email').value = email;
      showPanel('forgot');
    });

    document.querySelectorAll('[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => showPanel(btn.dataset.back));
    });

    document.getElementById('panel-invite')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const pw = document.getElementById('invite-password').value;
      const confirm = document.getElementById('invite-confirm').value;
      if (pw !== confirm) {
        showError('Passwords do not match');
        return;
      }
      const btn = document.getElementById('invite-btn');
      btn.disabled = true;
      try {
        const data = await CresAPI.request('/api/invites/accept-invite', {
          method: 'POST',
          body: { token: state.inviteToken, password: pw },
        }, false);
        showPanel('login');
        showOk('Password set. Sign in with your email.');
        if (data.data?.email) document.getElementById('email').value = data.data.email;
        history.replaceState({}, '', '/login');
      } catch (err) {
        showError(err.message || 'Invalid or expired invite');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('panel-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const btn = document.getElementById('login-btn');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        await CresAPI.login(
          document.getElementById('email').value.trim(),
          document.getElementById('password').value
        );
        location.href = nextPath();
      } catch (err) {
        showError(err.message || 'Invalid email or password');
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });

    document.getElementById('panel-forgot').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('forgot-btn');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        state.email = document.getElementById('forgot-email').value.trim();
        await CresAPI.request('/api/auth/forgot-password', {
          method: 'POST',
          body: { email: state.email },
        }, false);
        document.getElementById('verify-email-label').textContent = state.email;
        showPanel('verify');
        showOk('If that email is registered, a 6-digit code is on its way. It can take a minute.');
        startResendCooldown();
        document.getElementById('otp-code').focus();
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send reset code';
      }
    });

    document.getElementById('panel-verify').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('verify-btn');
      btn.disabled = true;
      try {
        const data = await CresAPI.request('/api/auth/verify-reset-code', {
          method: 'POST',
          body: {
            email: state.email,
            code: document.getElementById('otp-code').value.trim(),
          },
        }, false);
        state.resetToken = data.data.resetToken;
        showPanel('reset');
      } catch (err) {
        showError(err.message || 'Invalid or expired code');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('panel-reset').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('new-password').value;
      const confirm = document.getElementById('confirm-password').value;
      if (pw !== confirm) {
        showError('Passwords do not match');
        return;
      }
      const btn = document.getElementById('reset-btn');
      btn.disabled = true;
      try {
        await CresAPI.request('/api/auth/reset-password', {
          method: 'POST',
          body: {
            email: state.email,
            resetToken: state.resetToken,
            newPassword: pw,
          },
        }, false);
        // Straight into the system with the new password
        try {
          await CresAPI.login(state.email, pw);
          location.href = nextPath();
          return;
        } catch {
          showPanel('login');
          showOk('Password updated. Sign in with your new password.');
          document.getElementById('email').value = state.email;
        }
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  boot();
})();
