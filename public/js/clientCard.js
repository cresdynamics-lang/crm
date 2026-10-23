/**
 * Shared client card: contact, projects, balance (when the role can see money).
 */
const CresClientCard = (() => {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render(c, { showMoney = false } = {}) {
    const phone = c.phone || '';
    const wa = CresFormat.waLink(phone);
    const tel = CresFormat.telLink(phone);
    const projects = c.projects || [];
    return `
      <div class="client-card">
        <h3 style="margin:0 0 4px;">${esc(c.name)}</h3>
        <p class="meta" style="margin:0 0 12px;">${esc(c.business_name || 'No business name')}</p>
        <div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          ${tel ? `<a class="btn btn-ghost btn-sm" href="${esc(tel)}">Call</a>` : ''}
          ${wa ? `<a class="btn btn-primary btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          ${c.email ? `<a class="btn btn-ghost btn-sm" href="mailto:${esc(c.email)}">Email</a>` : ''}
        </div>
        <p style="margin:0 0 8px;">${esc(phone || 'No phone')} · ${esc(c.email || 'No email')}</p>
        ${
          showMoney
            ? `<div class="kpi-grid" style="margin:12px 0;">
                <div class="kpi-card"><div class="kpi-label">Invoiced</div><div class="kpi-value" style="font-size:1.1rem;">${CresFormat.money(c.invoiced || 0)}</div></div>
                <div class="kpi-card"><div class="kpi-label">Paid</div><div class="kpi-value" style="font-size:1.1rem;">${CresFormat.money(c.paid || 0)}</div></div>
                <div class="kpi-card"><div class="kpi-label">Balance</div><div class="kpi-value" style="font-size:1.1rem;">${CresFormat.money(c.balance || 0)}</div></div>
              </div>`
            : ''
        }
        <h4 style="margin:16px 0 8px;font-size:0.9rem;">Projects</h4>
        ${
          projects.length
            ? `<ul class="engagement-list">${projects
                .map(
                  (p) =>
                    `<li><a href="#/projects">${esc(p.name)}</a> · ${esc((p.status || '').replace(/_/g, ' '))}</li>`
                )
                .join('')}</ul>`
            : '<p class="meta">No projects yet.</p>'
        }
      </div>`;
  }

  async function open(clientId) {
    const modal = document.getElementById('client-card-modal');
    const body = document.getElementById('client-card-body');
    if (!modal || !body) return;
    body.innerHTML = '<p class="meta">Loading…</p>';
    modal.classList.add('open');
    try {
      const res = await CresAPI.request(`/api/clients/${clientId}`);
      const me = CresAPI.getUser();
      const showMoney = ['admin', 'finance', 'director', 'sales'].includes(me?.role);
      body.innerHTML = render(res.data, { showMoney });
    } catch (err) {
      body.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  function bind() {
    document.querySelectorAll('[data-close-client-card]').forEach((btn) => {
      btn.addEventListener('click', () => document.getElementById('client-card-modal')?.classList.remove('open'));
    });
  }

  return { open, render, bind };
})();
