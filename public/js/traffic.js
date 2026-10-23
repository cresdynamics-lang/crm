/**
 * Director / Admin — website traffic analytics (cresdynamics.com).
 * Live geo/device/page breakdown across 3d/7d/1m/3m/6m windows, times shown in EAT.
 */
const CresTraffic = (() => {
  let chart = null;
  let timer = null;
  let period = 'm1';

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function growthPct(v) {
    if (v == null) return '<span class="meta">new</span>';
    const up = v >= 0;
    return `<span style="color:${up ? 'var(--green, #2ea36c)' : 'var(--red, #d64545)'};font-weight:600;">${up ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}%</span>`;
  }

  function fmtCount(n) {
    return (n || 0).toLocaleString();
  }

  function lastVisitEat(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function setPeriod(next) {
    period = next;
    document.querySelectorAll('.traffic-period').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.period === next);
      b.classList.toggle('btn-ghost', b.dataset.period !== next);
    });
  }

  function setConnected(connected) {
    const off = el('traffic-disconnected');
    const on = el('traffic-connected');
    if (off) off.hidden = connected;
    if (on) on.hidden = !connected;
  }

  async function refresh() {
    const flash = el('traffic-flash');
    try {
      const [sum, live] = await Promise.all([
        CresAPI.request(`/api/analytics/summary?period=${period}`),
        CresAPI.request('/api/analytics/live'),
      ]);
      if (sum.connected === false || sum.data?.connected === false) {
        setConnected(false);
        flash.textContent = '';
        return;
      }
      setConnected(true);
      renderSummary(sum.data);
      renderLive(live.data);
      flash.textContent = '';
    } catch (e) {
      setConnected(false);
      flash.textContent = '';
    }
  }

  function renderSummary(d) {
    el('traffic-last-updated').textContent =
      `Updated ${d.asOf} (${d.timezone}) · period ${d.period} · ${d.bucket === 'hour' ? 'hourly' : 'daily'} buckets`;

    const c = d.current;
    el('traffic-summary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Visits</div><div class="kpi-value" style="font-size:1.45rem;">${fmtCount(c.visits)}</div><div style="font-size:0.8rem;">${growthPct(d.growth.visitsPct)} vs previous period</div></div>
        <div class="kpi-card"><div class="kpi-label">Unique visitors</div><div class="kpi-value" style="font-size:1.45rem;">${fmtCount(c.visitors)}</div><div style="font-size:0.8rem;">${growthPct(d.growth.visitorsPct)} vs previous period</div></div>
        <div class="kpi-card"><div class="kpi-label">Live now</div><div class="kpi-value" style="font-size:1.45rem;">${fmtCount(c.liveNow)}</div><div class="kpi-label">last 5 minutes</div></div>
        <div class="kpi-card"><div class="kpi-label">Last visit</div><div class="kpi-value" style="font-size:1rem;">${esc(lastVisitEat(c.lastVisit))} <span class="meta">EAT</span></div></div>
      </div>`;

    const series = d.series || [];
    if (chart) { chart.destroy(); chart = null; }
    chart = new Chart(el('traffic-series').getContext('2d'), {
      type: 'line',
      data: {
        labels: series.map((s) => s.bucket),
        datasets: [{
          label: 'Visits',
          data: series.map((s) => Number(s.visits)),
          borderColor: '#5865f2',
          backgroundColor: 'rgba(88,101,242,0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxTicksLimit: d.bucket === 'hour' ? 12 : 10 } } },
      },
    });

    el('traffic-pages').innerHTML = (d.topPages || []).map((p) => `
      <li class="engagement-item">
        <div class="engagement-content"><div class="engagement-title">${esc(p.path)}</div></div>
        <span class="meta">${fmtCount(p.visits)} visits</span>
      </li>`).join('') || '<li class="meta">No page views in this period.</li>';

    el('traffic-devices').innerHTML = (d.devices || []).map((x) => `
      <li class="engagement-item">
        <div class="engagement-content"><div class="engagement-title">${esc(x.device_type || 'unknown')}</div></div>
        <span class="meta">${fmtCount(x.count)}</span>
      </li>`).join('') || '<li class="meta">No device data.</li>';

    el('traffic-geo').innerHTML = (d.geo || []).map((g, i) => {
      const place = [g.city, g.country_name || g.country_code].filter(Boolean).join(', ') || 'Unknown';
      return `<li class="engagement-item">
        <div class="engagement-content"><div class="engagement-title">${i + 1}. ${esc(place)}</div></div>
        <span class="meta">${fmtCount(g.visits)} visits</span>
      </li>`;
    }).join('') || '<li class="meta">No location data yet.</li>';
  }

  function renderLive(d) {
    el('traffic-live-n').textContent = `${d.total} activity events`;
    el('traffic-live').innerHTML = (d.visits || []).map((v) => `
      <tr>
        <td>${esc(v.at_eat)}</td>
        <td>${esc(v.path)}</td>
        <td>${esc(v.city || '—')}</td>
        <td>${esc(v.country_code || '—')}</td>
        <td>${esc(v.device_type || '—')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="meta">No visits in the last 15 minutes.</td></tr>';
  }

  async function mount(faceId, user) {
    if (faceId !== 'traffic' || !['director', 'admin'].includes(user.role)) {
      clearInterval(timer);
      timer = null;
      return;
    }
    document.querySelectorAll('.traffic-period').forEach((b) => {
      b.onclick = () => { setPeriod(b.dataset.period); refresh(); };
    });
    setPeriod('m1');
    await refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 15000);
  }

  return { mount };
})();