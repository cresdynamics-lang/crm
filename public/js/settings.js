const CresSettings = (() => {
  const PREFS = [
    { key: 'notify_project_update', label: 'Project updates', desc: 'Approvals, progress, and status changes' },
    { key: 'notify_invoice_paid', label: 'Invoice paid', desc: 'When a linked invoice is marked paid' },
    { key: 'notify_new_message', label: 'New messages', desc: 'Community chat messages (if your role has chat)' },
    { key: 'notify_daily_report', label: 'Daily reports', desc: 'When reports are submitted to your hub' },
    { key: 'notify_system', label: 'System events', desc: 'Automated system notices (Finance feed, etc.)' },
    { key: 'email_digest', label: 'Email digest', desc: 'Optional email summary - in-app still works' },
  ];

  function flash(msg, ok = true) {
    const el = document.getElementById('settings-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3200);
  }

  function initials(name) {
    return (name || '?')
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  function escAttr(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  /** Render avatar (photo or initials) — use across CRM */
  function avatarHtml(person, className = 'avatar') {
    const name = person?.name || person?.author_name || '?';
    const url = person?.avatar_url || person?.author_avatar_url || null;
    if (url) {
      return `<span class="${className} has-photo" title="${escAttr(name)}"><img src="${escAttr(url)}" alt="" /></span>`;
    }
    return `<span class="${className}" title="${escAttr(name)}">${initials(name)}</span>`;
  }

  function paintShellAvatar(user) {
    const el = document.getElementById('profile-avatar');
    if (!el || !user) return;
    if (user.avatar_url) {
      el.classList.add('has-photo');
      el.innerHTML = `<img src="${escAttr(user.avatar_url)}" alt="" />`;
    } else {
      el.classList.remove('has-photo');
      el.textContent = initials(user.name);
    }
  }

  function paintSettingsPreview(user) {
    const el = document.getElementById('set-avatar-preview');
    if (!el) return;
    if (user?.avatar_url) {
      el.classList.add('has-photo');
      el.innerHTML = `<img src="${escAttr(user.avatar_url)}" alt="" />`;
    } else {
      el.classList.remove('has-photo');
      el.textContent = initials(user?.name);
    }
  }

  async function load() {
    const [profile, prefs] = await Promise.all([
      CresAPI.request('/api/settings/profile'),
      CresAPI.request('/api/settings/notifications'),
    ]);

    document.getElementById('set-name').value = profile.data.name || '';
    document.getElementById('set-email').value = profile.data.email || '';
    document.getElementById('set-phone').value = profile.data.phone || '';
    paintSettingsPreview(profile.data);

    const box = document.getElementById('settings-prefs');
    box.innerHTML = PREFS.map((p) => {
      const checked = prefs.data[p.key] ? 'checked' : '';
      return `<div class="pref-row">
        <div>
          <span class="pref-label">${p.label}</span>
          <span class="pref-desc">${p.desc}</span>
        </div>
        <label class="toggle">
          <input type="checkbox" data-pref="${p.key}" ${checked} />
          <span></span>
        </label>
      </div>`;
    }).join('');

    box.querySelectorAll('input[data-pref]').forEach((input) => {
      input.addEventListener('change', async () => {
        try {
          await CresAPI.request('/api/settings/notifications', {
            method: 'PATCH',
            body: { [input.dataset.pref]: input.checked },
          });
          flash('Preference saved');
        } catch (err) {
          input.checked = !input.checked;
          flash(err.message, false);
        }
      });
    });
  }

  function bind() {
    document.getElementById('settings-profile-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await CresAPI.request('/api/settings/profile', {
          method: 'PATCH',
          body: {
            name: document.getElementById('set-name').value,
            phone: document.getElementById('set-phone').value,
          },
        });
        const prev = CresAPI.getUser() || {};
        CresAPI.setSession({
          user: {
            ...prev,
            name: data.data.name,
            phone: data.data.phone,
            avatar_url: data.data.avatar_url || prev.avatar_url || null,
          },
        });
        document.getElementById('profile-name').textContent = data.data.name;
        paintShellAvatar(CresAPI.getUser());
        paintSettingsPreview(data.data);
        flash('Profile updated');
      } catch (err) {
        flash(err.message, false);
      }
    });

    document.getElementById('set-avatar-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        flash('Profile picture must be 5 MB or less', false);
        e.target.value = '';
        return;
      }
      try {
        const fd = new FormData();
        fd.append('avatar', file);
        const data = await CresAPI.request('/api/settings/avatar', { method: 'POST', body: fd });
        const prev = CresAPI.getUser() || {};
        CresAPI.setSession({
          user: { ...prev, avatar_url: data.data.avatar_url, name: data.data.name || prev.name },
        });
        paintShellAvatar(CresAPI.getUser());
        paintSettingsPreview(data.data);
        flash('Profile picture updated');
      } catch (err) {
        flash(err.message, false);
      } finally {
        e.target.value = '';
      }
    });

    document.getElementById('set-avatar-remove')?.addEventListener('click', async () => {
      try {
        const data = await CresAPI.request('/api/settings/avatar', { method: 'DELETE' });
        const prev = CresAPI.getUser() || {};
        CresAPI.setSession({ user: { ...prev, avatar_url: null } });
        paintShellAvatar(CresAPI.getUser());
        paintSettingsPreview({ ...data.data, avatar_url: null });
        flash('Profile picture removed');
      } catch (err) {
        flash(err.message, false);
      }
    });

    document.getElementById('settings-password-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await CresAPI.request('/api/settings/password', {
          method: 'POST',
          body: {
            currentPassword: document.getElementById('set-current-pw').value,
            newPassword: document.getElementById('set-new-pw').value,
          },
        });
        e.target.reset();
        flash('Password updated');
      } catch (err) {
        flash(err.message, false);
      }
    });
  }

  return { load, bind, initials, avatarHtml, paintShellAvatar };
})();
