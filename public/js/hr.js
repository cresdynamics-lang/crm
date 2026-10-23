/**
 * Step 6b - HR module faces (salary data only)
 */
const CresHR = (() => {
  let payrollChart = null;
  let selectedEmployeeId = null;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtMoney(n) {
    return CresFormat.money(n);
  }

  function statusPill(s) {
    const label = (s || 'owed').replace(/_/g, ' ');
    return `<span class="status-pill ${esc(s || 'owed')}">${esc(label)}</span>`;
  }

  function flash(el, msg, ok = true) {
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  function chartOpts() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8b9aab' } } },
      scales: {
        x: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    };
  }

  function fundingStatusLabel(status) {
    const map = {
      pending_finance: 'Awaiting Finance',
      finance_approved: 'Escalated to Admin',
      admin_approved: 'Admin approved — settle unlocked',
      rejected: 'Rejected',
    };
    return map[status] || status || 'None';
  }

  async function paintFundingBox(month, funding, expectedTotal) {
    const box = document.getElementById('hr-funding-box');
    if (!box) return;
    if (!funding) {
      box.innerHTML = `
        <h3>Salary funding — ${esc(month)}</h3>
        <p style="margin:0 0 12px;color:var(--text-muted);font-size:0.9rem;">
          Request the expected total (${fmtMoney(expectedTotal)}) from Finance. Finance adds/approves and escalates to Admin. After Admin approval, you can settle.
        </p>
        <button type="button" class="btn btn-primary" id="btn-request-funding">Request funding from Finance</button>`;
      document.getElementById('btn-request-funding')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-request-funding');
        btn.disabled = true;
        try {
          await CresAPI.request('/api/salaries/funding', {
            method: 'POST',
            body: { month, amount_requested: expectedTotal },
            idempotencyKey: `fund-${month}-${Date.now()}`,
          });
          flash(document.getElementById('hr-dashboard')?.previousElementSibling || null, 'Funding request sent to Finance');
          await mountHome();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
      return;
    }
    box.innerHTML = `
      <h3>Salary funding — ${esc(month)}</h3>
      <p style="margin:0;color:var(--text-muted);font-size:0.9rem;">
        Status: <strong>${esc(fundingStatusLabel(funding.status))}</strong><br/>
        Requested: ${fmtMoney(funding.amount_requested)}
        ${funding.amount_funded != null ? ` · Funded: ${fmtMoney(funding.amount_funded)}` : ''}
      </p>`;
  }

  async function mountHome() {
    const host = document.getElementById('hr-dashboard');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/hr/dashboard');
      const d = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Expected this month</div>
            <div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.expectedThisMonth)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total owed</div>
            <div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.owedThisMonth)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total settled</div>
            <div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.settledThisMonth)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Employees</div>
            <div class="kpi-value">${d.kpis.employeeCount}</div>
          </div>
        </div>
        <div class="chart-panel" style="max-width:720px;margin-top:16px;">
          <h3>Settled · Owed · Expected (${esc(d.month)} and prior)</h3>
          <div class="chart-wrap"><canvas id="hr-payroll-chart"></canvas></div>
        </div>
        <div class="settings-section" style="max-width:720px;margin-top:16px;" id="hr-funding-box"></div>
        <p style="margin-top:14px;color:var(--text-muted);font-size:0.85rem;">
          Expected (blue) is the full salary total. Settling requires Admin-approved funding — salaries are not expenses.
        </p>`;

      if (payrollChart) payrollChart.destroy();
      payrollChart = new Chart(document.getElementById('hr-payroll-chart'), {
        type: 'bar',
        data: {
          labels: d.chart.labels,
          datasets: [
            { label: 'Settled', data: d.chart.settled, backgroundColor: 'rgba(0,168,197,0.65)', borderRadius: 6 },
            { label: 'Owed', data: d.chart.owed, backgroundColor: 'rgba(224,90,90,0.55)', borderRadius: 6 },
            { label: 'Expected', data: d.chart.expected, backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 6 },
          ],
        },
        options: chartOpts(),
      });

      await paintFundingBox(d.month, d.funding, d.kpis.expectedThisMonth);
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountEmployees() {
    const tbody = document.getElementById('employees-tbody');
    if (!tbody) return;
    try {
      const res = await CresAPI.request('/api/salaries/employees');
      const rows = res.data || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">No employees yet. Add one to get started.</td></tr>';
        return;
      }
      const me = CresAPI.getUser();
      const canRemove = ['hr', 'admin', 'director'].includes(me.role);
      tbody.innerHTML = rows
        .map(
          (e) => `
        <tr data-id="${esc(e.id)}" class="clickable-row">
          <td>${esc(e.name)}</td>
          <td>${esc(e.position || '-')}</td>
          <td>${esc(e.pay_cycle || '-')}</td>
          <td>${statusPill(e.current_salary_status || 'owed')}${e.user_status === 'inactive' ? ' · removed' : ''}</td>
          <td>
            <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(e.id)}">Edit</button>
            ${
              canRemove && e.user_status !== 'inactive' && e.user_id !== me.id
                ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-emp="${esc(e.id)}" style="color:#ffb4b4;">Remove</button>`
                : ''
            }
          </td>
        </tr>`
        )
        .join('');

      tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-edit]')) return;
          location.hash = `#/salaries/${tr.dataset.id}`;
        });
      });
      tbody.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openEmployeeForm(btn.dataset.edit);
        });
      });
      tbody.querySelectorAll('[data-remove-emp]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const row = rows.find((x) => x.id === btn.dataset.removeEmp);
          if (!row) return;
          if (!confirm(`Remove ${row.name}? They will lose access. Payroll history stays.`)) return;
          try {
            await CresAPI.request(`/api/salaries/employees/${row.id}`, { method: 'DELETE' });
            await mountEmployees();
          } catch (err) {
            alert(err.message);
          }
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`;
    }
  }

  async function openEmployeeForm(id) {
    const modal = document.getElementById('employee-modal');
    const title = document.getElementById('employee-modal-title');
    const form = document.getElementById('employee-form');
    form.reset();
    form.dataset.id = id || '';
    title.textContent = id ? 'Edit employee' : 'Add employee';

    const pwdField = document.getElementById('emp-password-wrap');
    const roleField = document.getElementById('emp-role-wrap');
    if (pwdField) pwdField.hidden = !!id;
    if (roleField) roleField.hidden = !!id;
    const pwdInput = form.password;
    if (pwdInput) pwdInput.required = !id;

    if (id) {
      const res = await CresAPI.request(`/api/salaries/employees/${id}`);
      const e = res.data.employee;
      form.name.value = e.name || '';
      form.email.value = e.email || '';
      form.phone.value = e.phone || '';
      form.home_address.value = e.home_address || '';
      form.next_of_kin.value = e.next_of_kin || '';
      form.kra_pin.value = e.kra_pin || '';
      form.bank_account.value = e.bank_account || '';
      form.position.value = e.position || '';
      form.salary_amount.value = e.salary_amount ?? '';
      form.pay_cycle.value = e.pay_cycle || 'monthly';
      form.email.readOnly = true;
    } else {
      form.email.readOnly = false;
    }
    modal.classList.add('open');
  }

  function isPayrollManager(user) {
    return ['hr', 'admin'].includes(user?.role);
  }

  function canDecideLeave(user) {
    return ['hr', 'admin'].includes(user?.role);
  }

  function hashWantsMine() {
    const q = (location.hash.split('?')[1] || '');
    return new URLSearchParams(q).get('mine') === '1';
  }

  async function mountPayroll(employeeId, user) {
    selectedEmployeeId = employeeId || null;
    const listPanel = document.getElementById('payroll-list-panel');
    const detailPanel = document.getElementById('payroll-detail-panel');
    if (!listPanel || !detailPanel) return;

    const manage = isPayrollManager(user) && !hashWantsMine();
    const title = document.getElementById('payroll-hero-title');
    const copy = document.getElementById('payroll-hero-copy');
    const exportBtn = document.getElementById('btn-export-payroll');
    if (title) title.textContent = manage ? 'Payroll' : 'My payroll';
    if (copy) {
      copy.textContent = manage
        ? 'Per-employee salary history. Settling is unlocked only after Admin approves salary funding (HR → Finance → Admin).'
        : 'Track each payment month from your Cres Dynamics onboarding date.';
    }
    if (exportBtn) exportBtn.hidden = !manage;

    // Self-service: always show personal history
    if (!manage) {
      listPanel.hidden = true;
      detailPanel.hidden = false;
      document.getElementById('btn-payroll-back').hidden = true;
      try {
        const res = await CresAPI.request('/api/salaries/me');
        const { employee, payroll, currentMonth } = res.data;
        if (!employee) {
          const nameEl = document.getElementById('payroll-detail-name');
          const metaEl = document.getElementById('payroll-detail-meta');
          const currentBox = document.getElementById('payroll-current');
          const hist = document.getElementById('payroll-history-tbody');
          if (nameEl) nameEl.textContent = 'My pay';
          if (metaEl) metaEl.textContent = '';
          if (currentBox) {
            currentBox.innerHTML =
              '<div class="placeholder-card">No employee record yet. Ask HR to onboard you so payroll can appear here.</div>';
          }
          if (hist) hist.innerHTML = '';
          return;
        }
        document.getElementById('payroll-detail-name').textContent = employee.name;
        document.getElementById('payroll-detail-meta').textContent =
          `${employee.position || 'No position'} · ${employee.pay_cycle || 'monthly'} · ${fmtMoney(employee.salary_amount)} · onboarded ${CresFormat.date(employee.created_at)}`;

        const current = (payroll || []).find((p) => p.month === currentMonth);
        const currentBox = document.getElementById('payroll-current');
        if (current) {
          currentBox.innerHTML = `
            <div class="kpi-grid" style="margin:0;">
              <div class="kpi-card"><div class="kpi-label">Month</div><div class="kpi-value" style="font-size:1.1rem;">${esc(current.month)}</div></div>
              <div class="kpi-card"><div class="kpi-label">Expected</div><div class="kpi-value" style="font-size:1.1rem;">${fmtMoney(current.amount_expected)}</div></div>
              <div class="kpi-card"><div class="kpi-label">Status</div><div class="kpi-value" style="font-size:1.1rem;">${statusPill(current.status)}</div></div>
            </div>
            <p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">HR settles after Admin approves salary funding for the month.</p>`;
        } else {
          currentBox.innerHTML = '<p class="muted">No current month row yet.</p>';
        }

        const hist = document.getElementById('payroll-history-tbody');
        hist.innerHTML = (payroll || [])
          .map(
            (p) => `
          <tr>
            <td>${esc(p.month)}</td>
            <td>${fmtMoney(p.amount_expected)}</td>
            <td>${fmtMoney(p.amount_paid)}</td>
            <td>${statusPill(p.status)}</td>
            <td>${p.settled_at ? CresFormat.date(p.settled_at) : '-'}</td>
          </tr>`
          )
          .join('') || '<tr><td colspan="5" class="muted">No history</td></tr>';
      } catch (err) {
        detailPanel.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
      }
      return;
    }

    document.getElementById('btn-payroll-back').hidden = !employeeId;

    if (!employeeId) {
      listPanel.hidden = false;
      detailPanel.hidden = true;
      const tbody = document.getElementById('payroll-tbody');
      try {
        const month = new Date().toISOString().slice(0, 7);
        const [res, fundRes] = await Promise.all([
          CresAPI.request(`/api/salaries?month=${encodeURIComponent(month)}`),
          CresAPI.request(`/api/salaries/funding/summary?month=${encodeURIComponent(month)}`).catch(() => null),
        ]);
        const rows = res.data || [];
        document.getElementById('payroll-month-label').textContent = month;
        const fundBanner = document.getElementById('payroll-funding-banner');
        if (fundBanner && fundRes?.data) {
          const f = fundRes.data.funding;
          const canSettle = fundRes.data.canSettle;
          fundBanner.hidden = false;
          fundBanner.innerHTML = f
            ? `<strong>Funding:</strong> ${esc(fundingStatusLabel(f.status))}
               · requested ${fmtMoney(f.amount_requested)}
               ${f.amount_funded != null ? `· funded ${fmtMoney(f.amount_funded)}` : ''}
               ${canSettle ? ' · Settlements unlocked' : ' · Settlements locked until Admin approval'}
               ${!f || f.status === 'rejected' ? ` · <button type="button" class="btn btn-primary btn-sm" id="btn-payroll-request-funding">Request funding</button>` : ''}`
            : `No funding request for ${esc(month)} (expected ${fmtMoney(fundRes.data.expectedTotal)}).
               <button type="button" class="btn btn-primary btn-sm" id="btn-payroll-request-funding">Request funding from Finance</button>`;
          document.getElementById('btn-payroll-request-funding')?.addEventListener('click', async () => {
            try {
              await CresAPI.request('/api/salaries/funding', {
                method: 'POST',
                body: { month, amount_requested: fundRes.data.expectedTotal },
                idempotencyKey: `fund-${month}-${Date.now()}`,
              });
              flash(document.getElementById('payroll-flash'), 'Funding request sent to Finance');
              await mountPayroll(null, user);
            } catch (err) {
              flash(document.getElementById('payroll-flash'), err.message, false);
            }
          });
        }
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="muted">No payroll rows for this month yet. Open an employee to generate the current month.</td></tr>';
        } else {
          tbody.innerHTML = rows
            .map(
              (r) => `
            <tr data-emp="${esc(r.employee_id)}" class="clickable-row">
              <td>${esc(r.employee_name)}</td>
              <td>${esc(r.position || '-')}</td>
              <td>${fmtMoney(r.amount_expected)}</td>
              <td>${statusPill(r.status)}</td>
              <td>${fmtMoney(r.amount_paid)}</td>
            </tr>`
            )
            .join('');
          tbody.querySelectorAll('tr[data-emp]').forEach((tr) => {
            tr.addEventListener('click', () => {
              location.hash = `#/salaries/${tr.dataset.emp}`;
            });
          });
        }
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`;
      }
      return;
    }

    listPanel.hidden = true;
    detailPanel.hidden = false;
    try {
      const res = await CresAPI.request(`/api/salaries/employees/${employeeId}`);
      const { employee, payroll, currentMonth, canSettle } = res.data;
      let fundingOk = false;
      try {
        const fundRes = await CresAPI.request(
          `/api/salaries/funding/summary?month=${encodeURIComponent(currentMonth)}`
        );
        fundingOk = !!fundRes.data?.canSettle;
      } catch {
        fundingOk = false;
      }
      document.getElementById('payroll-detail-name').textContent = employee.name;
      document.getElementById('payroll-detail-meta').textContent =
        `${employee.position || 'No position'} · ${employee.pay_cycle} · ${fmtMoney(employee.salary_amount)}`;

      const current = (payroll || []).find((p) => p.month === currentMonth);
      const currentBox = document.getElementById('payroll-current');
      if (current) {
        const settleAllowed = canSettle !== false && fundingOk && current.status === 'owed';
        currentBox.innerHTML = `
          <div class="kpi-grid" style="margin:0;">
            <div class="kpi-card"><div class="kpi-label">Month</div><div class="kpi-value" style="font-size:1.1rem;">${esc(current.month)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Expected</div><div class="kpi-value" style="font-size:1.1rem;">${fmtMoney(current.amount_expected)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Status</div><div class="kpi-value" style="font-size:1.1rem;">${statusPill(current.status)}</div></div>
          </div>
          ${
            settleAllowed
              ? `<button type="button" class="btn btn-primary" id="btn-settle" data-id="${esc(current.id)}" style="margin-top:12px;">Mark settled</button>`
              : current.status === 'settled'
                ? `<p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">Settled ${current.settled_at ? CresFormat.datetime(current.settled_at) : ''}.</p>`
                : `<p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">Settling locked until Admin approves salary funding for ${esc(currentMonth)} (HR request → Finance → Admin).</p>`
          }`;
        document.getElementById('btn-settle')?.addEventListener('click', async () => {
          const btn = document.getElementById('btn-settle');
          btn.disabled = true;
          try {
            await CresAPI.request(`/api/salaries/${current.id}/settle`, {
              method: 'POST',
              body: {},
              idempotencyKey: `settle-${current.id}-${Date.now()}`,
            });
            flash(document.getElementById('payroll-flash'), 'Marked settled');
            await mountPayroll(employeeId, user);
          } catch (err) {
            flash(document.getElementById('payroll-flash'), err.message, false);
            btn.disabled = false;
          }
        });
      } else {
        currentBox.innerHTML = '<p class="muted">No current month row.</p>';
      }

      const hist = document.getElementById('payroll-history-tbody');
      hist.innerHTML = (payroll || [])
        .map(
          (p) => `
        <tr>
          <td>${esc(p.month)}</td>
          <td>${fmtMoney(p.amount_expected)}</td>
          <td>${fmtMoney(p.amount_paid)}</td>
          <td>${statusPill(p.status)}</td>
          <td>${p.settled_at ? CresFormat.date(p.settled_at) : '-'}</td>
        </tr>`
        )
        .join('') || '<tr><td colspan="5" class="muted">No history</td></tr>';
    } catch (err) {
      detailPanel.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  function bind() {
    document.getElementById('btn-add-employee')?.addEventListener('click', () => openEmployeeForm(null));

    document.getElementById('employee-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const id = form.dataset.id;
      const payload = {
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        phone: form.phone.value.trim() || null,
        home_address: form.home_address.value.trim() || null,
        next_of_kin: form.next_of_kin.value.trim() || null,
        kra_pin: form.kra_pin.value.trim() || null,
        bank_account: form.bank_account.value.trim() || null,
        position: form.position.value.trim() || null,
        salary_amount: Number(form.salary_amount.value) || 0,
        pay_cycle: form.pay_cycle.value,
      };
      try {
        if (id) {
          await CresAPI.request(`/api/salaries/employees/${id}`, { method: 'PATCH', body: payload });
          flash(document.getElementById('employees-flash'), 'Employee updated');
        } else {
          payload.password = form.password.value;
          payload.role = form.role.value || 'developer';
          if (!payload.password || payload.password.length < 8) {
            throw new Error('First-time password is required (min 8 characters)');
          }
          await CresAPI.request('/api/salaries/employees', {
            method: 'POST',
            body: payload,
            idempotencyKey: `emp-${payload.email}-${Date.now()}`,
          });
          flash(document.getElementById('employees-flash'), 'Employee created with login account');
        }
        document.getElementById('employee-modal').classList.remove('open');
        await mountEmployees();
      } catch (err) {
        flash(document.getElementById('employee-form-flash'), err.message, false);
      }
    });

    document.querySelectorAll('#employee-modal [data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => document.getElementById('employee-modal').classList.remove('open'));
    });

    document.getElementById('btn-add-applicant')?.addEventListener('click', () => openApplicantForm(null));
    document.getElementById('applicants-filter-stage')?.addEventListener('change', () => {
      mountApplicants().catch(console.error);
    });
    document.getElementById('applicant-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const id = form.dataset.id;
      const payload = {
        name: form.name.value.trim(),
        email: form.email.value.trim() || null,
        phone: form.phone.value.trim() || null,
        role_applied: form.role_applied.value.trim(),
        stage: form.stage.value,
        interview_date: form.interview_date.value || null,
        notes: form.notes.value.trim() || null,
      };
      try {
        if (id) {
          await CresAPI.request(`/api/hr/applicants/${id}`, { method: 'PATCH', body: payload });
          flash(document.getElementById('applicants-flash'), 'Applicant updated');
        } else {
          await CresAPI.request('/api/hr/applicants', {
            method: 'POST',
            body: payload,
            idempotencyKey: `app-${payload.email || payload.name}-${Date.now()}`,
          });
          flash(document.getElementById('applicants-flash'), 'Applicant added');
        }
        document.getElementById('applicant-modal')?.classList.remove('open');
        await mountApplicants();
      } catch (err) {
        flash(document.getElementById('applicant-form-flash'), err.message, false);
      }
    });
    document.querySelectorAll('#applicant-modal [data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => document.getElementById('applicant-modal')?.classList.remove('open'));
    });

    document.getElementById('btn-payroll-back')?.addEventListener('click', () => {
      location.hash = '#/salaries';
    });

    document.getElementById('btn-export-payroll')?.addEventListener('click', () => {
      CresAPI.download('/api/export/salary-payments.csv', 'salary-payments.csv').catch((err) =>
        alert(err.message)
      );
    });

    document.getElementById('btn-new-leave')?.addEventListener('click', () => {
      document.getElementById('new-leave-modal')?.classList.add('open');
    });
    document.getElementById('new-leave-form')?.addEventListener('submit', (e) =>
      createLeave(e).catch((err) => flash(document.getElementById('leave-flash'), err.message, false))
    );

    document.getElementById('btn-sf-select-all')?.addEventListener('click', () => {
      document.querySelectorAll('#sf-people-tbody input[type=checkbox]').forEach((c) => {
        c.checked = true;
      });
      updateSfTotal();
    });
    document.getElementById('btn-sf-clear')?.addEventListener('click', () => {
      document.querySelectorAll('#sf-people-tbody input[type=checkbox]').forEach((c) => {
        c.checked = false;
      });
      updateSfTotal();
    });
    document.getElementById('btn-salary-funding-request')?.addEventListener('click', async () => {
      const user = CresAPI.getUser();
      const month = document.getElementById('sf-month-label')?.dataset?.month || new Date().toISOString().slice(0, 7);
      const checked = [...document.querySelectorAll('#sf-people-tbody input[type=checkbox]:checked')];
      const employee_ids = checked.map((c) => c.value);
      const amount_requested = checked.reduce((s, c) => s + Number(c.dataset.amount || 0), 0);
      if (!employee_ids.length) {
        flash(document.getElementById('salary-funding-flash'), 'Select at least one person', false);
        return;
      }
      try {
        await CresAPI.request('/api/salaries/funding', {
          method: 'POST',
          body: { month, employee_ids, amount_requested },
          idempotencyKey: `fund-${month}-${Date.now()}`,
        });
        flash(document.getElementById('salary-funding-flash'), 'Funding request sent to Finance Approvals');
        await mountSalaryFunding(user);
      } catch (err) {
        flash(document.getElementById('salary-funding-flash'), err.message, false);
      }
    });
  }

  function updateSfTotal() {
    const checked = [...document.querySelectorAll('#sf-people-tbody input[type=checkbox]:checked')];
    const total = checked.reduce((s, c) => s + Number(c.dataset.amount || 0), 0);
    const label = document.getElementById('sf-total-label');
    if (label) {
      label.textContent = `Total: ${fmtMoney(total)} (${checked.length} people)`;
    }
  }

  async function mountLeave(user) {
    const manage = canDecideLeave(user) && !hashWantsMine();
    const copy = document.getElementById('leave-hero-copy');
    const heroH = document.querySelector('#face-leave .face-hero h2');
    if (heroH) heroH.textContent = manage ? 'Leave requests' : 'My leave';
    if (copy) {
      copy.textContent = manage
        ? 'Approve or reject pending leave. New requests notify HR.'
        : 'Request time off. HR reviews every request.';
    }

    const empWrap = document.getElementById('leave-employee-wrap');
    const empSel = document.getElementById('leave-employee');
    if (empWrap) empWrap.hidden = !manage;
    if (empSel) empSel.required = manage;

    const leaveRes = await CresAPI.request(manage ? '/api/leave' : '/api/leave/mine');
    if (manage) {
      const empRes = await CresAPI.request('/api/salaries/employees').catch(() => ({ data: [] }));
      if (empSel) {
        empSel.innerHTML =
          `<option value="">Select employee</option>` +
          (empRes.data || []).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
      }
    }

    const tbody = document.getElementById('leave-tbody');
    if (!tbody) return;
    const rows = leaveRes.data || [];
    tbody.innerHTML = rows.length
      ? rows
          .map(
            (r) => `<tr>
              <td>${esc(r.employee_name || '-')}</td>
              <td>${esc(r.leave_type || 'annual')}</td>
              <td>${esc(r.start_date)} → ${esc(r.end_date)}</td>
              <td>${statusPill(r.status)}</td>
              <td>${esc(r.reason || '-')}</td>
              <td>${
                manage && r.status === 'pending'
                  ? `<button type="button" class="btn btn-primary btn-sm" data-leave-ok="${esc(r.id)}">Approve</button>
                     <button type="button" class="btn btn-ghost btn-sm" data-leave-no="${esc(r.id)}">Reject</button>`
                  : '-'
              }</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="6" class="empty-state">${manage ? 'No leave requests yet.' : 'You have not requested leave yet.'}</td></tr>`;

    tbody.querySelectorAll('[data-leave-ok]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/leave/${btn.dataset.leaveOk}/decide`, {
            method: 'POST',
            body: { status: 'approved' },
          });
          flash(document.getElementById('leave-flash'), 'Leave approved');
          await mountLeave(user);
        } catch (err) {
          flash(document.getElementById('leave-flash'), err.message, false);
        }
      });
    });
    tbody.querySelectorAll('[data-leave-no]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/leave/${btn.dataset.leaveNo}/decide`, {
            method: 'POST',
            body: { status: 'rejected' },
          });
          flash(document.getElementById('leave-flash'), 'Leave rejected');
          await mountLeave(user);
        } catch (err) {
          flash(document.getElementById('leave-flash'), err.message, false);
        }
      });
    });
  }

  async function createLeave(e) {
    e.preventDefault();
    const user = CresAPI.getUser();
    const manage = canDecideLeave(user);
    const body = {
      start_date: document.getElementById('leave-start').value,
      end_date: document.getElementById('leave-end').value,
      leave_type: document.getElementById('leave-type').value || 'annual',
      reason: document.getElementById('leave-reason').value.trim() || undefined,
    };
    if (manage) {
      const empId = document.getElementById('leave-employee').value;
      if (empId) body.employee_id = empId;
    }
    await CresAPI.request(manage && body.employee_id ? '/api/leave' : '/api/leave/mine', {
      method: 'POST',
      body,
      idempotencyKey: `leave-${Date.now()}`,
    });
    document.getElementById('new-leave-modal')?.classList.remove('open');
    e.target.reset();
    flash(document.getElementById('leave-flash'), 'Leave request submitted to HR');
    await mountLeave(user);
  }

  async function mountSalaryFunding(user) {
    const tbody = document.getElementById('salary-funding-tbody');
    const peopleBody = document.getElementById('sf-people-tbody');
    const requestPanel = document.getElementById('salary-funding-request-panel');
    if (!tbody) return;

    const month = new Date().toISOString().slice(0, 7);
    const monthLabel = document.getElementById('sf-month-label');
    if (monthLabel) {
      monthLabel.textContent = month;
      monthLabel.dataset.month = month;
    }
    if (requestPanel) requestPanel.hidden = user.role !== 'hr';

    if (user.role === 'hr' && peopleBody) {
      try {
        const eligible = await CresAPI.request(
          `/api/salaries/funding/eligible?month=${encodeURIComponent(month)}`
        );
        const people = eligible.data || [];
        peopleBody.innerHTML = people.length
          ? people
              .map(
                (p) => `<tr>
                  <td><input type="checkbox" value="${esc(p.employee_id)}" data-amount="${esc(p.amount_expected)}" checked /></td>
                  <td>${esc(p.name)}</td>
                  <td>${esc(p.role)}</td>
                  <td>${fmtMoney(p.amount_expected)}</td>
                </tr>`
              )
              .join('')
          : `<tr><td colspan="4" class="empty-state">No active staff with payroll rows.</td></tr>`;
        peopleBody.querySelectorAll('input[type=checkbox]').forEach((c) => {
          c.addEventListener('change', updateSfTotal);
        });
        updateSfTotal();
      } catch (err) {
        peopleBody.innerHTML = `<tr><td colspan="4">${esc(err.message)}</td></tr>`;
      }
    }

    try {
      const res = await CresAPI.request('/api/salaries/funding');
      const rows = res.data || [];
      tbody.innerHTML = rows.length
        ? rows
            .map((r) => {
              const people =
                (r.people || []).map((p) => p.name).slice(0, 5).join(', ') +
                ((r.people || []).length > 5 ? '…' : '');
              return `<tr>
                <td>${esc(r.month)}</td>
                <td>${esc(people || '-')}</td>
                <td>${fmtMoney(r.amount_requested)}</td>
                <td>${r.amount_funded != null ? fmtMoney(r.amount_funded) : '-'}</td>
                <td>${statusPill(r.status)}</td>
                <td>${esc(r.requested_by_name || '-')}</td>
              </tr>`;
            })
            .join('')
        : `<tr><td colspan="6" class="empty-state">No salary funding requests yet.</td></tr>`;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6">${esc(err.message)}</td></tr>`;
    }
  }

  const APPLICANT_STAGES = [
    { id: 'applied', label: 'Applied' },
    { id: 'interview', label: 'Interview' },
    { id: 'offer', label: 'Offer' },
    { id: 'hired', label: 'Hired' },
    { id: 'rejected', label: 'Rejected' },
  ];

  function stageLabel(s) {
    return APPLICANT_STAGES.find((x) => x.id === s)?.label || s || 'Applied';
  }

  async function mountApplicants() {
    const tbody = document.getElementById('applicants-tbody');
    if (!tbody) return;
    const stage = document.getElementById('applicants-filter-stage')?.value || '';
    const qs = stage ? `?stage=${encodeURIComponent(stage)}` : '';
    try {
      const res = await CresAPI.request(`/api/hr/applicants${qs}`);
      const rows = res.data || [];
      tbody.innerHTML = rows.length
        ? rows
            .map(
              (a) => `<tr data-id="${esc(a.id)}">
                <td>${esc(a.name)}</td>
                <td>${esc(a.email || '—')}</td>
                <td>${esc(a.phone || '—')}</td>
                <td>${esc(a.role_applied)}</td>
                <td>${statusPill(a.stage)}</td>
                <td>${a.interview_date ? CresFormat.date(a.interview_date) : '—'}</td>
                <td>${esc(a.notes || '—')}</td>
                <td><button type="button" class="btn btn-ghost btn-sm" data-edit-applicant="${esc(a.id)}">Edit</button></td>
              </tr>`
            )
            .join('')
        : `<tr><td colspan="8" class="empty-state">No applicants yet.</td></tr>`;
      tbody.querySelectorAll('[data-edit-applicant]').forEach((btn) => {
        btn.addEventListener('click', () => openApplicantForm(rows.find((r) => r.id === btn.dataset.editApplicant)));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8">${esc(err.message)}</td></tr>`;
    }
  }

  function openApplicantForm(row) {
    const modal = document.getElementById('applicant-modal');
    const form = document.getElementById('applicant-form');
    const title = document.getElementById('applicant-modal-title');
    if (!modal || !form) return;
    form.reset();
    form.dataset.id = row?.id || '';
    if (title) title.textContent = row ? 'Edit applicant' : 'Add applicant';
    if (row) {
      form.name.value = row.name || '';
      form.email.value = row.email || '';
      form.phone.value = row.phone || '';
      form.role_applied.value = row.role_applied || '';
      form.stage.value = row.stage || 'applied';
      form.interview_date.value = row.interview_date ? String(row.interview_date).slice(0, 10) : '';
      form.notes.value = row.notes || '';
    }
    modal.classList.add('open');
  }

  async function mountOnboarding() {
    const host = document.getElementById('onboarding-list');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/hr/onboarding');
      const rows = res.data || [];
      const defaults = res.meta?.defaultItems || [];
      if (!rows.length) {
        host.innerHTML = `<div class="placeholder-card">Add employees first, then set their onboarding checklist and 30/60/90-day goals.</div>`;
        return;
      }
      host.innerHTML = rows
        .map((r) => {
          const items = r.items?.length ? r.items : defaults;
          const done = items.filter((i) => i.done).length;
          return `<div class="settings-section" style="max-width:none;margin-bottom:14px;" data-onboard="${esc(r.employee_id)}">
            <div class="toolbar" style="margin-bottom:8px;">
              <div>
                <strong>${esc(r.name)}</strong>
                <div class="meta">${esc(r.position || '—')} · ${done}/${items.length} complete</div>
              </div>
              <button type="button" class="btn btn-primary btn-sm" data-save-onboard="${esc(r.employee_id)}">Save</button>
            </div>
            <div class="onboard-items">
              ${items
                .map(
                  (i) => `<label class="onboard-item">
                    <input type="checkbox" data-item="${esc(i.id)}" ${i.done ? 'checked' : ''} />
                    <span>${esc(i.label)}</span>
                  </label>`
                )
                .join('')}
            </div>
            <div class="form-grid" style="margin-top:12px;">
              <div><label>30-day goal</label><textarea data-g30 rows="2" placeholder="What good looks like at 30 days">${esc(r.goal_30 || '')}</textarea></div>
              <div><label>60-day goal</label><textarea data-g60 rows="2" placeholder="What good looks like at 60 days">${esc(r.goal_60 || '')}</textarea></div>
              <div style="grid-column:1/-1;"><label>90-day goal</label><textarea data-g90 rows="2" placeholder="What good looks like at 90 days">${esc(r.goal_90 || '')}</textarea></div>
            </div>
          </div>`;
        })
        .join('');
      host.querySelectorAll('[data-save-onboard]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const card = host.querySelector(`[data-onboard="${btn.dataset.saveOnboard}"]`);
          if (!card) return;
          const items = [...card.querySelectorAll('.onboard-item')].map((lab) => ({
            id: lab.querySelector('input')?.dataset.item,
            label: lab.querySelector('span')?.textContent,
            done: lab.querySelector('input')?.checked,
          }));
          try {
            await CresAPI.request(`/api/hr/onboarding/${btn.dataset.saveOnboard}`, {
              method: 'PUT',
              body: {
                items,
                goal_30: card.querySelector('[data-g30]')?.value,
                goal_60: card.querySelector('[data-g60]')?.value,
                goal_90: card.querySelector('[data-g90]')?.value,
              },
            });
            flash(document.getElementById('onboarding-flash'), 'Onboarding saved');
            await mountOnboarding();
          } catch (err) {
            flash(document.getElementById('onboarding-flash'), err.message, false);
          }
        });
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mount(faceId, user, faceParam) {
    if (faceId === 'home' && user.role === 'hr') await mountHome();
    else if (faceId === 'employees' && ['hr', 'admin'].includes(user.role)) await mountEmployees();
    else if (faceId === 'salaries') await mountPayroll(faceParam || null, user);
    else if (faceId === 'leave') await mountLeave(user);
    else if (faceId === 'salary-funding') await mountSalaryFunding(user);
    else if (faceId === 'applicants' && ['hr', 'admin'].includes(user.role)) await mountApplicants();
    else if (faceId === 'onboarding' && ['hr', 'admin'].includes(user.role)) await mountOnboarding();
  }

  return { bind, mount, openEmployeeForm, mountSalaryFunding };
})();
