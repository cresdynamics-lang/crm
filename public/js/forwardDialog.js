/**
 * "Forward inside CRES OS" dialog, shared by the company inbox and Team mail.
 * Pick people and/or whole teams, edit the subject and text, add a note.
 * The copy lands in their Team mail page - never in a personal mailbox.
 *
 *   CresForward.open({ source: { inbox_message_id } | { mail_id }, subject, body, onDone })
 */
const CresForward = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let people = null;

  async function loadPeople() {
    if (people) return people;
    const res = await CresAPI.request('/api/mail/people');
    people = res.data;
    return people;
  }

  function close(el) {
    el.remove();
    document.body.classList.remove('modal-open');
  }

  async function open({ source, subject = '', body = '', onDone } = {}) {
    let data;
    try {
      data = await loadPeople();
    } catch {
      return;
    }
    const el = document.createElement('div');
    el.className = 'fw-backdrop';
    el.innerHTML = `
      <div class="fw-modal" role="dialog" aria-modal="true" aria-labelledby="fw-title">
        <div class="fw-head"><h3 id="fw-title">Forward inside CRES OS</h3><button type="button" class="mt-btn sm" data-close>Close</button></div>
        <p class="fw-hint">It goes to their <b>Team mail</b> page in CRES OS, not to their personal email.</p>
        <div class="fw-label">Send to a team</div>
        <div class="fw-chips">${data.teams.map((t) => `<label class="fw-chip"><input type="checkbox" name="team" value="${esc(t.role)}" /> ${esc(t.label)} <span>${t.members}</span></label>`).join('') || '<span class="fw-hint">No teams</span>'}</div>
        <div class="fw-label">…or to people</div>
        <div class="fw-people">${data.people.map((p) => `<label><input type="checkbox" name="person" value="${esc(p.id)}" /> ${esc(p.name)} <span>${esc(p.role)}</span></label>`).join('') || '<span class="fw-hint">No one else yet</span>'}</div>
        <label class="fw-label" for="fw-subject">Subject</label>
        <input id="fw-subject" type="text" value="${esc(subject)}" />
        <label class="fw-label" for="fw-body">Email (you can edit before forwarding)</label>
        <textarea id="fw-body" rows="8">${esc(body)}</textarea>
        <label class="fw-label" for="fw-note">Note to them (optional)</label>
        <input id="fw-note" type="text" placeholder="e.g. Please reply to this client today and copy me" />
        <div class="fw-actions"><span class="fw-err" role="alert"></span><button type="button" class="mt-btn" data-close>Cancel</button><button type="button" class="mt-btn primary" data-send>Forward</button></div>
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add('modal-open');
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-close]')) close(el);
    });
    el.querySelector('[data-send]').addEventListener('click', async (e) => {
      const teams = [...el.querySelectorAll('input[name="team"]:checked')].map((i) => i.value);
      const user_ids = [...el.querySelectorAll('input[name="person"]:checked')].map((i) => i.value);
      const err = el.querySelector('.fw-err');
      if (!teams.length && !user_ids.length) {
        err.textContent = 'Choose a team or at least one person.';
        return;
      }
      e.target.disabled = true;
      try {
        const res = await CresAPI.request('/api/mail/forward', {
          method: 'POST',
          body: {
            ...source,
            teams,
            user_ids,
            subject: el.querySelector('#fw-subject').value,
            body: el.querySelector('#fw-body').value,
            note: el.querySelector('#fw-note').value.trim(),
          },
          toastSuccess: false,
        });
        const names = res.data?.to || [];
        if (typeof CresToast !== 'undefined') {
          CresToast.success('Forwarded inside CRES OS', { detail: names.length > 3 ? `${names.length} people` : names.join(', ') });
        }
        close(el);
        onDone?.(res.data);
      } catch {
        e.target.disabled = false;
      }
    });
    el.querySelector('#fw-subject').focus();
  }

  return { open };
})();
