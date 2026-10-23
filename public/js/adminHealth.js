/**
 * Admin — system + website + CRM health monitor. Live socket feed from the sampler.
 */
const CresAdminHealth = (() => {
  let chart = null;
  let timer = null;
  let socketAttached = false;

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fnum(n, d = 1) {
    return n == null ? '—' : Number(n).toFixed(d);
  }

  function fmtUptime(sec) {
    if (sec == null) return '—';
    const s = Math.floor(sec);
    const days = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return days ? `${days}d ${h}h` : `${h}h ${m}m`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function pill(status) {
    const cls = status === 'up' ? 'paid' : status === 'degraded' ? '' : 'overdue';
    return `<span class="status-pill ${cls}">${esc(status || 'unknown')}</span>`;
  }

  function okFor(entities) {
    return (entities || []).every((e) => e.status === 'up');
  }

  function handle(data) {
    render(data);
  }

  function render(d) {
    el('health-last-updated').textContent =
      `Last sampled ${fmtTime(d.asOf)} (${d.timezone}) · sampler runs every ~60s · live socket feed active`;

    const sys = d.system || {};
    const websiteOk = okFor(d.groups.website);
    const crmOk = okFor(d.groups.crm);
    el('health-cards').innerHTML = `
      <div class="settings-section" style="max-width:none;margin:0;padding:14px;">
        <div class="kpi-label">Website</div>
        <div style="margin-top:4px;">${pill(websiteOk ? 'up' : 'degraded')}</div>
        <div class="meta" style="margin-top:6px;">${(d.groups.website || []).length} endpoints probed</div>
      </div>
      <div class="settings-section" style="max-width:none;margin:0;padding:14px;">
        <div class="kpi-label">CRM API</div>
        <div style="margin-top:4px;">${pill(crmOk ? 'up' : 'degraded')}</div>
        <div class="meta" style="margin-top:6px;">${(d.groups.crm || []).length} features · db ${d.dbHealth ? 'up' : 'down'} · redis ${d.redisHealth ? 'up' : 'down'} · queue ${d.queueHealth ? 'up' : 'down'}</div>
      </div>
      <div class="settings-section" style="max-width:none;margin:0;padding:14px;">
        <div class="kpi-label">Server load</div>
        <div style="margin-top:4px;"><strong>${fnum(sys.load1)}</strong> load · mem <strong>${fnum(sys.memUsedPct, 0)}%</strong> · disk <strong>${fnum(sys.diskUsedPct, 0)}%</strong></div>
        <div class="meta" style="margin-top:6px;">${fnum(sys.memUsedMb, 0)} / ${fnum(sys.memTotalMb, 0)} MB · ${esc(sys.hostname || '')} · up ${fmtUptime(sys.uptimeSec)}</div>
      </div>
      <div class="settings-section" style="max-width:none;margin:0;padding:14px;">
        <div class="kpi-label">Website DB bridge</div>
        <div style="margin-top:4px;">${d.websiteDb?.ok ? pill('up') : pill('down')}</div>
        <div class="meta" style="margin-top:6px;">crm_reader → cresdynamics</div>
      </div>`;

    const series = [
      ...(d.groups.website || []).map((e) => ({ ...e, group: 'website' })),
      ...(d.groups.crm || []).map((e) => ({ ...e, group: 'crm' })),
    ];
    el('health-entities').innerHTML = series.map((e) => `
      <li class="engagement-item">
        <div class="engagement-content">
          <div class="engagement-title">${esc(e.name)} <span class="meta">· ${esc(e.group)}</span></div>
        </div>
        <span>${pill(e.status)}${e.latencyMs ? `<span class="meta" style="margin-left:6px;">${e.latencyMs}ms</span>` : ''}</span>
      </li>`).join('');

    el('health-processes').innerHTML = (d.processes || []).map((p) => `
      <tr>
        <td><strong>${esc(p.name)}</strong>${p.pid ? `<br><span class="meta">pid ${p.pid}</span>` : ''}</td>
        <td>${pill(p.status)}</td>
        <td>${p.restarts}</td>
        <td>${fnum(p.cpu, 0)}%</td>
        <td>${fnum(p.memMb, 0)} MB</td>
        <td>${fmtUptime(p.uptimeSec)}</td>
      </tr>`).join('');
  }

  async function refreshBattery() {
    const flash = el('health-flash');
    try {
      const res = await CresAPI.request('/api/admin/health/live');
      handle(res.data);
      flash.textContent = '';
    } catch (e) {
      flash.textContent = e.message;
    }
  }

  async function loadHistory() {
    try {
      const res = await CresAPI.request('/api/admin/health/overview');
      drawHistory(res.data);
    } catch {
      // non-fatal — chart fills in as snapshots accumulate
    }
  }

  function drawHistory(d) {
    const rows = (d.history || []).sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
    const byTime = new Map();
    for (const r of rows) {
      if (r.category !== 'system.cpu' && r.category !== 'system.memory') continue;
      const t = fmtTime(r.checkedAt);
      const item = byTime.get(t) || { t, cpu: null, mem: null };
      if (r.category === 'system.cpu') item.cpu = r.detail?.cpuPercent;
      if (r.category === 'system.memory') item.mem = r.detail?.memUsedPct;
      byTime.set(t, item);
    }
    const arr = [...byTime.values()].slice(-40);
    if (chart) { chart.destroy(); chart = null; }
    chart = new Chart(el('health-cpu-chart').getContext('2d'), {
      type: 'line',
      data: {
        labels: arr.map((r) => r.t),
        datasets: [
          { label: 'CPU %', data: arr.map((r) => r.cpu), borderColor: '#d64545', tension: 0.3, pointRadius: 0 },
          { label: 'Memory %', data: arr.map((r) => r.mem), borderColor: '#2ea36c', tension: 0.3, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { min: 0, max: 100 } },
        plugins: { legend: { labels: { boxWidth: 10 } } },
      },
    });
  }

  function attachSocket() {
    if (socketAttached) return;
    socketAttached = true;
    const sock = CresRealtime.getSocket();
    if (sock) sock.on('health:live', handle);
  }

  async function mount(faceId, user) {
    if (faceId !== 'health' || user.role !== 'admin') {
      clearInterval(timer);
      timer = null;
      return;
    }
    attachSocket();
    await loadHistory();
    await refreshBattery();
    clearInterval(timer);
    timer = setInterval(refreshBattery, 10000);
  }

  return { mount };
})();