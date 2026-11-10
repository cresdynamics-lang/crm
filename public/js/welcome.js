(function () {
  const token = location.pathname.split('/').pop();
  const $ = (id) => document.getElementById(id);
  const show = (name) => ['loading', 'hidden', 'shown', 'gone'].forEach((n) => ($(`w-${n}`).hidden = n !== name));
  let timer = null;

  async function api(path, method) {
    const res = await fetch(`/api/welcome/${token}${path}`, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error?.message || 'Could not load'), { status: res.status });
    return body.data;
  }

  function reveal(data) {
    $('w-pw').textContent = data.password;
    $('w-hint').textContent = data.emailHint;
    $('w-login').href = `/login?hint=${encodeURIComponent(data.emailHint)}`;
    let left = Number(data.secondsLeft || 900);
    const tick = () => {
      const m = Math.floor(left / 60);
      $('w-left').textContent = left > 0 ? `Shown for ${m} more minute${m === 1 ? '' : 's'}, then it is erased.` : 'This password has been erased. Use "Forgot password" to get a new one.';
      if (left <= 0) { clearInterval(timer); $('w-pw').textContent = '••••••••••'; return; }
      left -= 20;
    };
    tick();
    timer = setInterval(tick, 20000);
    show('shown');
  }

  async function boot() {
    try {
      const st = await api('');
      if (!st.valid) return show('gone');
      $('w-hello').textContent = `Hi ${st.firstName}, your account is ready.`;
      show('hidden');
    } catch (e) {
      show('gone');
    }
  }

  $('w-show').addEventListener('click', async () => {
    const btn = $('w-show');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      reveal(await api('/reveal', 'POST'));
    } catch (e) {
      show('gone');
    }
  });

  $('w-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('w-pw').textContent);
      $('w-copy').textContent = 'Copied';
      setTimeout(() => ($('w-copy').textContent = 'Copy'), 1800);
    } catch {
      const r = document.createRange(); r.selectNodeContents($('w-pw'));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  });

  boot();
})();
