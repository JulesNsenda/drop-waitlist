'use strict';

(function () {
  // ── state ──────────────────────────────────────────────────────────────────
  const dirty = { confirmation: false, invite: false };

  // ── elements ───────────────────────────────────────────────────────────────
  const tok         = document.getElementById('tok');
  const barMsg      = document.getElementById('bar-msg');
  const placeholder = document.getElementById('placeholder');
  const content     = document.getElementById('content');

  // ── token persistence ──────────────────────────────────────────────────────
  const savedTok = sessionStorage.getItem('drop-admin-tok');
  if (savedTok) tok.value = savedTok;

  // ── helpers ────────────────────────────────────────────────────────────────
  function authHeaders(extra) {
    return { Authorization: 'Bearer ' + tok.value, ...extra };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function showMsg(type, text, isErr) {
    const el = document.getElementById('msg-' + type);
    el.textContent = text;
    el.className = 'save-msg ' + (isErr ? 'err-msg' : 'ok-msg');
    if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString() : null;
  }

  // ── subject char counter ───────────────────────────────────────────────────
  ['confirmation', 'invite'].forEach((type) => {
    document.getElementById('subj-' + type).addEventListener('input', function () {
      document.getElementById('subj-count-' + type).textContent = this.value.length + '/200';
      dirty[type] = true;
    });
    document.getElementById('html-' + type).addEventListener('input', () => { dirty[type] = true; });
  });

  // ── populate a template editor ─────────────────────────────────────────────
  function populateTemplate(type, data) {
    document.getElementById('subj-' + type).value = data.subject;
    document.getElementById('subj-count-' + type).textContent = data.subject.length + '/200';
    document.getElementById('html-' + type).value = data.html;
    document.getElementById('meta-' + type).textContent = data.savedAt
      ? 'Last saved: ' + fmtDate(data.savedAt)
      : 'Using built-in default — not yet customized.';
    dirty[type] = false;
  }

  // ── load settings + entries ────────────────────────────────────────────────
  async function load() {
    if ((dirty.confirmation || dirty.invite) &&
        !confirm('You have unsaved template changes. Load anyway?')) return;

    barMsg.textContent = '';

    try {
      const [sRes, eRes] = await Promise.all([
        fetch('/api/admin/settings', { headers: authHeaders() }),
        fetch('/api/admin/entries',  { headers: authHeaders() }),
      ]);

      if (sRes.status === 403 || eRes.status === 403) {
        barMsg.textContent = 'Forbidden — check token.';
        return;
      }

      const s = await sRes.json();
      const e = await eRes.json();
      if (!s.ok || !e.ok) { barMsg.textContent = 'Failed to load.'; return; }

      sessionStorage.setItem('drop-admin-tok', tok.value);
      placeholder.style.display = 'none';
      content.style.display = '';

      // email config
      document.getElementById('config-grid').innerHTML =
        '<span class="config-label">Resend</span>' +
        (s.emailConfigured
          ? '<span class="ok">✓ configured</span>'
          : '<span class="err">✗ not set — set RESEND_API_KEY in your environment to enable email</span>') +
        '<span class="config-label">Sender</span><span>' + esc(s.emailFrom) + '</span>' +
        '<span class="config-label">Invites</span>' +
        (s.invitesEnabled
          ? '<span class="ok">enabled</span>'
          : '<span class="warn">disabled — set WAITLIST_INVITES_ENABLED=true once Docker isolation is on</span>');

      // dim invite editor when invites are off
      const inviteNote = document.getElementById('invite-disabled-note');
      const inviteCard = document.getElementById('card-invite');
      if (s.invitesEnabled) {
        inviteNote.style.display = 'none';
        inviteCard.classList.remove('dimmed');
      } else {
        inviteNote.style.display = '';
        inviteCard.classList.add('dimmed');
      }

      populateTemplate('confirmation', s.templates.confirmation);
      populateTemplate('invite', s.templates.invite);

      // waitlist table
      document.getElementById('invite-gate').textContent = s.invitesEnabled
        ? ''
        : 'Invites are DISABLED — approving only marks entries; no accounts are created until WAITLIST_INVITES_ENABLED=true.';

      const rows = document.getElementById('rows');
      rows.innerHTML = '';
      for (const entry of e.entries) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(entry.email) + '</td>' +
          '<td>' + esc(entry.name || '') + '</td>' +
          '<td><span class="pill ' + entry.status + '">' + entry.status + '</span>' +
          (entry.username ? ' ' + esc(entry.username) : '') + '</td>' +
          '<td>' + new Date(entry.createdAt).toLocaleDateString() + '</td>' +
          '<td></td>';
        const actionCell = tr.lastChild;
        if (entry.status !== 'invited') {
          const btn = document.createElement('button');
          btn.textContent = 'Approve & invite';
          btn.onclick = () => approve(entry.id, btn);
          actionCell.appendChild(btn);
        }
        rows.appendChild(tr);
      }

    } catch {
      barMsg.textContent = 'Failed to load.';
    }
  }

  // ── approve ────────────────────────────────────────────────────────────────
  async function approve(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const r = await fetch('/api/admin/approve', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id }),
      });
      const j = await r.json();
      if (!j.ok) {
        alert(j.error || 'Failed');
        btn.disabled = false;
        btn.textContent = 'Approve & invite';
        return;
      }
      if (j.created && !j.emailSent) {
        alert('Account created (' + j.username + ') but email not sent.\nTemp password: ' + j.tempPassword);
      } else if (j.created) {
        alert('Invited ' + j.username + ' — welcome email sent.');
      } else {
        alert(j.message || 'Marked approved.');
      }
      load();
    } catch {
      alert('Request failed');
      btn.disabled = false;
      btn.textContent = 'Approve & invite';
    }
  }

  // ── save template ──────────────────────────────────────────────────────────
  function makeSaveHandler(type) {
    return async function () {
      const subject = document.getElementById('subj-' + type).value;
      const html    = document.getElementById('html-' + type).value;

      if (type === 'invite') {
        const missing = ['{{tempPassword}}', '{{dashboardUrl}}'].filter((v) => !html.includes(v));
        if (missing.length &&
            !confirm('Warning: template is missing ' + missing.join(', ') + '. Users may not receive login credentials. Save anyway?')) return;
      }

      const btn = document.getElementById('save-' + type);
      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        const r = await fetch('/api/admin/templates', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ type, subject, html }),
        });
        const j = await r.json();
        if (!j.ok) {
          showMsg(type, j.error || 'Save failed.', true);
        } else {
          document.getElementById('meta-' + type).textContent = 'Last saved: ' + fmtDate(j.savedAt);
          dirty[type] = false;
          showMsg(type, 'Saved.', false);
        }
      } catch {
        showMsg(type, 'Save failed — network error.', true);
      }

      btn.disabled = false;
      btn.textContent = 'Save';
    };
  }

  // ── reset template ─────────────────────────────────────────────────────────
  function makeResetHandler(type) {
    return async function () {
      if (!confirm('Discard your saved template and restore the built-in default?')) return;
      const btn = document.getElementById('reset-' + type);
      btn.disabled = true;
      try {
        const r = await fetch('/api/admin/templates/reset', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ type }),
        });
        const j = await r.json();
        if (!j.ok) {
          showMsg(type, j.error || 'Reset failed.', true);
        } else {
          populateTemplate(type, { subject: j.subject, html: j.html, savedAt: null });
          showMsg(type, 'Reset to default.', false);
        }
      } catch {
        showMsg(type, 'Reset failed — network error.', true);
      }
      btn.disabled = false;
    };
  }

  // ── wire up ────────────────────────────────────────────────────────────────
  document.getElementById('load-btn').addEventListener('click', load);
  tok.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

  document.getElementById('save-confirmation').addEventListener('click', makeSaveHandler('confirmation'));
  document.getElementById('save-invite').addEventListener('click', makeSaveHandler('invite'));
  document.getElementById('reset-confirmation').addEventListener('click', makeResetHandler('confirmation'));
  document.getElementById('reset-invite').addEventListener('click', makeResetHandler('invite'));

  // auto-load if token was remembered from last session
  if (tok.value) load();
})();
