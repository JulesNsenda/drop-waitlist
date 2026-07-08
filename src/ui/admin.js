'use strict';

(function () {
  const ROUTES = ['waitlist', 'emails', 'system'];
  const TOKEN_KEY = 'drop-admin-tok';

  // A private sentinel thrown by api() on 403 — every caller treats it as
  // "stop silently" because the central handler already showed the gate.
  const SENTINEL_ABORT = Symbol('admin-api-abort');

  // Sample values used to render the live template preview.
  const SAMPLE_VARS = {
    confirmation: { name: 'Ada Lovelace', email: 'ada@example.com' },
    invite: {
      name: 'Ada Lovelace', email: 'ada@example.com', username: 'ada',
      tempPassword: 'Xk3-temp-pw', dashboardUrl: 'https://example.com/dashboard',
    },
  };

  // ── state ──────────────────────────────────────────────────────────────────
  const state = {
    token: '',
    loggedIn: false,
    settings: null,
    entries: [],
    invitesEnabled: false,
    currentRoute: 'waitlist',
    waitlistFilter: 'all',
    searchText: '',
    lastUpdated: null,
    renderGen: 0,
  };
  const dirty = { confirmation: false, invite: false };

  // ── elements ───────────────────────────────────────────────────────────────
  const gateEl      = document.getElementById('gate');
  const gateForm     = document.getElementById('gate-form');
  const gateTokInput = document.getElementById('gate-tok');
  const gateSubmit    = document.getElementById('gate-submit');
  const gateMsg       = document.getElementById('gate-msg');

  const shellEl = document.getElementById('shell');
  const navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-item[data-route]'));
  const navPendingBadge = document.getElementById('nav-pending-badge');
  const logoutBtn = document.getElementById('logout-btn');

  const views = {
    waitlist: document.getElementById('view-waitlist'),
    emails:   document.getElementById('view-emails'),
    system:   document.getElementById('view-system'),
  };

  const waitlistUpdatedEl = document.getElementById('waitlist-updated');
  const statCardButtons = Array.prototype.slice.call(document.querySelectorAll('.stat-card[data-filter]'));
  const statNums = {
    all:      document.getElementById('stat-total-num'),
    pending:  document.getElementById('stat-pending-num'),
    approved: document.getElementById('stat-approved-num'),
    invited:  document.getElementById('stat-invited-num'),
    recent:   document.getElementById('stat-recent-num'),
  };
  const invitesBanner = document.getElementById('invites-banner');
  const searchInput = document.getElementById('search-input');
  const exportCsvBtn = document.getElementById('export-csv-btn');
  const rowsEl = document.getElementById('rows');
  const emptyStateEl = document.getElementById('empty-state');

  const resendBanner = document.getElementById('resend-banner');
  const inviteEditorBanner = document.getElementById('invite-editor-banner');
  const subjInputs   = { confirmation: document.getElementById('subj-confirmation'), invite: document.getElementById('subj-invite') };
  const subjCountEls = { confirmation: document.getElementById('subj-count-confirmation'), invite: document.getElementById('subj-count-invite') };
  const htmlInputs   = { confirmation: document.getElementById('html-confirmation'), invite: document.getElementById('html-invite') };
  const metaEls      = { confirmation: document.getElementById('meta-confirmation'), invite: document.getElementById('meta-invite') };
  const saveButtons  = { confirmation: document.getElementById('save-confirmation'), invite: document.getElementById('save-invite') };
  const resetButtons = { confirmation: document.getElementById('reset-confirmation'), invite: document.getElementById('reset-invite') };
  const msgEls       = { confirmation: document.getElementById('msg-confirmation'), invite: document.getElementById('msg-invite') };
  const previewFrames = { confirmation: document.getElementById('preview-confirmation'), invite: document.getElementById('preview-invite') };

  const systemGrid = document.getElementById('system-grid');

  const toastEl = document.getElementById('toast');

  const confirmDialogEl     = document.getElementById('confirm-dialog');
  const confirmDialogMsgEl  = document.getElementById('confirm-dialog-msg');
  const confirmDialogOkBtn  = document.getElementById('confirm-dialog-ok');
  const confirmDialogCancelBtn = document.getElementById('confirm-dialog-cancel');

  const credsDialogEl   = document.getElementById('creds-dialog');
  const credsUsernameEl = document.getElementById('creds-username');
  const credsPasswordEl = document.getElementById('creds-password');
  const credsCopyBtn    = document.getElementById('creds-copy-btn');
  const credsEmailErrorEl = document.getElementById('creds-email-error');
  const credsCloseBtn  = document.getElementById('creds-close-btn');

  // ── helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDateSafe(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '—';
  }

  function fmtDateTimeSafe(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
  }

  function fmtTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function isEmailsDirty() {
    return dirty.confirmation || dirty.invite;
  }

  function parseRoute(hash) {
    const m = /^#\/(\w+)/.exec(hash || '');
    const r = m ? m[1] : '';
    return ROUTES.indexOf(r) !== -1 ? r : null;
  }

  // ── central api() wrapper ──────────────────────────────────────────────────
  // Used by every authenticated call, including the CSV blob fetch (opts.raw).
  // On 403: clears the token, remembers the current route, shows the gate with
  // a session-invalid message, and throws SENTINEL_ABORT — callers just stop.
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + state.token });
    let res;
    try {
      res = await fetch(path, Object.assign({}, opts, { headers }));
    } catch {
      throw new Error('Network error — server unreachable.');
    }
    if (res.status === 403) {
      handleForbidden();
      throw SENTINEL_ABORT;
    }
    if (opts.raw) return res;
    let body = null;
    try { body = await res.json(); } catch { /* body stays null */ }
    if (body === null) throw new Error('Unexpected server response.');
    return body;
  }

  function handleForbidden() {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.loggedIn = false;
    showGate('Session invalid — re-enter token.');
  }

  // ── toast (approve outcomes) ───────────────────────────────────────────────
  let toastTimer = null;
  function showToast(message, isErr) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (isErr ? ' toast-err' : ' toast-ok');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  function showSaveMsg(type, text, isErr) {
    const el = msgEls[type];
    el.textContent = text;
    el.className = 'save-msg ' + (isErr ? 'err-msg' : 'ok-msg');
    if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  // ── reusable confirm dialog (4 call sites: reset, missing-vars, dirty nav, dirty logout) ──
  function confirmDialog(message, okLabel) {
    return new Promise((resolve) => {
      confirmDialogMsgEl.textContent = message;
      confirmDialogOkBtn.textContent = okLabel || 'Confirm';
      let settled = false;

      function settle(result) {
        if (settled) return;
        settled = true;
        confirmDialogOkBtn.removeEventListener('click', onOk);
        confirmDialogCancelBtn.removeEventListener('click', onCancel);
        confirmDialogEl.removeEventListener('close', onClose);
        confirmDialogEl.removeEventListener('click', onBackdrop);
        resolve(result);
      }
      function onOk() { settle(true); confirmDialogEl.close(); }
      function onCancel() { settle(false); confirmDialogEl.close(); }
      function onClose() { settle(false); }
      function onBackdrop(e) { if (e.target === confirmDialogEl) onCancel(); }

      confirmDialogOkBtn.addEventListener('click', onOk);
      confirmDialogCancelBtn.addEventListener('click', onCancel);
      confirmDialogEl.addEventListener('close', onClose);
      confirmDialogEl.addEventListener('click', onBackdrop);
      confirmDialogEl.showModal();
    });
  }

  // ── credentials dialog (body-level, non-dismissable) ──────────────────────
  function openCredsDialog(data) {
    credsUsernameEl.textContent = data.username;
    credsPasswordEl.textContent = data.tempPassword;
    if (data.emailError) {
      credsEmailErrorEl.textContent = 'Email could not be sent: ' + data.emailError;
      credsEmailErrorEl.hidden = false;
    } else {
      credsEmailErrorEl.textContent = '';
      credsEmailErrorEl.hidden = true;
    }
    credsCopyBtn.textContent = 'Copy';
    credsDialogEl.showModal();
  }

  function closeCredsDialog() {
    credsDialogEl.close();
    credsPasswordEl.textContent = '';
  }

  // ── login gate ─────────────────────────────────────────────────────────────
  function showGate(message) {
    state.loggedIn = false;
    shellEl.style.display = 'none';
    gateEl.style.display = '';
    gateMsg.textContent = message || '';
    gateTokInput.value = '';
    gateTokInput.focus();
  }

  function setGateLoading(isLoading) {
    gateSubmit.disabled = isLoading;
    gateSubmit.textContent = isLoading ? 'Checking…' : 'Enter';
  }

  async function handleGateSubmit(e) {
    e.preventDefault();
    const val = gateTokInput.value.trim();
    if (!val) return;

    gateMsg.textContent = '';
    setGateLoading(true);

    let res;
    try {
      res = await fetch('/api/admin/settings', { headers: { Authorization: 'Bearer ' + val } });
    } catch {
      gateMsg.textContent = 'Server unreachable — check your connection.';
      setGateLoading(false);
      return;
    }
    if (res.status === 403) {
      gateMsg.textContent = 'Invalid token — note: an unset admin token on the server forbids every request (check WAITLIST_ADMIN_TOKEN).';
      setGateLoading(false);
      return;
    }
    if (!res.ok) {
      gateMsg.textContent = 'Server error — please try again.';
      setGateLoading(false);
      return;
    }

    state.token = val;
    localStorage.setItem(TOKEN_KEY, val);
    const result = await loadAll();
    setGateLoading(false);
    if (result.ok) {
      enterShell();
    } else if (!result.silent) {
      gateMsg.textContent = result.message || 'Failed to load admin data — please try again.';
    }
  }

  async function attemptAutoLogin() {
    const result = await loadAll();
    if (result.ok) {
      enterShell();
    } else if (!result.silent) {
      showGate(result.message || 'Failed to load — please try again.');
    }
    // else: handleForbidden() already showed the gate with the right message.
  }

  function enterShell() {
    state.loggedIn = true;
    gateEl.style.display = 'none';
    shellEl.style.display = '';
    gateTokInput.value = '';

    const target = ROUTES.indexOf(state.currentRoute) !== -1 ? state.currentRoute : 'waitlist';
    if (location.hash !== '#/' + target) {
      location.hash = '#/' + target; // triggers hashchange -> navigateRoute
    } else {
      navigateRoute(target); // hash already correct, hashchange won't fire
    }
  }

  function doLogout() {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.settings = null;
    state.entries = [];
    history.replaceState(null, '', '#/waitlist');
    state.currentRoute = 'waitlist';
    showGate('');
  }

  async function handleLogoutClick() {
    if (isEmailsDirty()) {
      const confirmed = await confirmDialog(
        'You have unsaved template changes. Logging out will discard them.', 'Log out'
      );
      if (!confirmed) return;
      dirty.confirmation = false;
      dirty.invite = false;
    }
    doLogout();
  }

  // ── data loading ───────────────────────────────────────────────────────────
  // One load on login: settings + entries in parallel.
  async function loadAll() {
    const gen = ++state.renderGen;
    try {
      const [settings, entriesRes] = await Promise.all([
        api('/api/admin/settings'),
        api('/api/admin/entries'),
      ]);
      if (gen !== state.renderGen) return { ok: false, silent: true }; // superseded
      if (!settings.ok || !entriesRes.ok) {
        // Non-403 error body (e.g. 500) — never enter the shell with it as state.
        return { ok: false, silent: false, message: settings.error || entriesRes.error || 'Failed to load admin data.' };
      }
      state.settings = settings;
      state.entries = entriesRes.entries;
      state.invitesEnabled = entriesRes.invitesEnabled;
      state.lastUpdated = new Date();
      return { ok: true };
    } catch (err) {
      if (err === SENTINEL_ABORT) return { ok: false, silent: true };
      return { ok: false, silent: false, message: err.message };
    }
  }

  // Refetch entries only (settings don't change at runtime) — used on
  // visibilitychange -> visible and on navigating into Waitlist.
  async function refreshEntries() {
    const gen = ++state.renderGen;
    try {
      const entriesRes = await api('/api/admin/entries');
      if (gen !== state.renderGen) return; // a fresher request/render superseded this
      if (!entriesRes.ok) return; // error body — leave current state untouched
      state.entries = entriesRes.entries;
      state.invitesEnabled = entriesRes.invitesEnabled;
      state.lastUpdated = new Date();
      if (state.currentRoute === 'waitlist') renderWaitlistView();
    } catch (err) {
      if (err === SENTINEL_ABORT) return;
      // background refresh failure — leave the current view intact, no toast noise
    }
  }

  // ── router ─────────────────────────────────────────────────────────────────
  function navigateRoute(route) {
    state.currentRoute = route;
    views.waitlist.hidden = route !== 'waitlist';
    views.emails.hidden   = route !== 'emails';
    views.system.hidden   = route !== 'system';
    navLinks.forEach((a) => a.classList.toggle('active', a.dataset.route === route));

    if (route === 'waitlist') {
      renderWaitlistView();
      refreshEntries();
    } else if (route === 'emails') {
      renderEmailsView(); // always repopulates from state, resets dirty flags
    } else if (route === 'system') {
      renderSystemView();
    }
  }

  // Runs the dirty guard for a leave-Emails move. Resolves true when it is
  // safe to proceed (clearing the dirty flags on a consented discard).
  async function guardLeaveEmails(target) {
    if (!(state.currentRoute === 'emails' && target !== 'emails' && isEmailsDirty())) return true;
    const confirmed = await confirmDialog(
      'You have unsaved template changes. Leaving will discard them.', 'Discard'
    );
    if (!confirmed) return false;
    dirty.confirmation = false;
    dirty.invite = false;
    return true;
  }

  // Nav-link clicks run the guard BEFORE location.hash is touched: on Cancel
  // the URL never changed, so no history surgery is ever needed.
  async function onNavClick(e, a) {
    e.preventDefault();
    const target = a.dataset.route;
    if (!(await guardLeaveEmails(target))) return; // cancelled — URL untouched
    location.hash = '#/' + target; // normal push; hashchange finds a clean state
  }

  // Reached while dirty only via browser back/forward or a manual hash edit —
  // the hash has already changed, so Cancel restores the URL with replaceState
  // (fires no hashchange — no loops) and Discard navigates directly (the hash
  // is already the target, so setting it again would fire nothing).
  function onHashChange() {
    if (!state.loggedIn) return; // router no-ops while the gate is shown

    const target = parseRoute(location.hash);

    if (!target) {
      history.replaceState(null, '', '#/waitlist'); // fires no hashchange
      navigateRoute('waitlist'); // so render manually
      return;
    }

    if (state.currentRoute === 'emails' && target !== 'emails' && isEmailsDirty()) {
      guardLeaveEmails(target).then((proceed) => {
        if (proceed) {
          navigateRoute(target);
        } else {
          history.replaceState(null, '', '#/emails'); // restore URL, keep the view
        }
      });
      return;
    }

    navigateRoute(target);
  }

  // ── Waitlist view ──────────────────────────────────────────────────────────
  function computeStats(entries) {
    const total = entries.length;
    const pending = entries.filter((e) => e.status === 'pending').length;
    const approved = entries.filter((e) => e.status === 'approved').length;
    const invited = entries.filter((e) => e.status === 'invited').length;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = entries.filter((e) => {
      const t = new Date(e.createdAt).getTime();
      return Number.isFinite(t) && t >= weekAgo;
    }).length;
    return { total, pending, approved, invited, recent };
  }

  function getFilteredEntries() {
    let list = state.entries;
    if (state.waitlistFilter !== 'all') {
      list = list.filter((e) => e.status === state.waitlistFilter);
    }
    const q = state.searchText.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => e.email.toLowerCase().includes(q) || (e.name && e.name.toLowerCase().includes(q)));
    }
    return list;
  }

  function buildRow(entry) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + esc(entry.email) + '</td>' +
      '<td>' + esc(entry.name || '') + '</td>' +
      '<td><span class="pill ' + esc(entry.status) + '">' + esc(entry.status) + '</span></td>' +
      '<td>' + esc(fmtDateSafe(entry.createdAt)) + '</td>' +
      '<td></td>';
    const actionCell = tr.lastChild;

    if (entry.status === 'invited') {
      const info = document.createElement('span');
      info.className = 'invited-info';
      info.textContent = (entry.username || '') + (entry.invitedAt ? ' · ' + fmtDateSafe(entry.invitedAt) : '');
      actionCell.appendChild(info);
    } else if (entry.status === 'pending' || (entry.status === 'approved' && state.invitesEnabled)) {
      const btn = document.createElement('button');
      btn.textContent = entry.status === 'pending'
        ? (state.invitesEnabled ? 'Approve & invite' : 'Approve')
        : 'Send invite';
      btn.addEventListener('click', () => handleApprove(entry.id, btn));
      actionCell.appendChild(btn);
    }
    // 'approved' with invites disabled: no button — nothing left to do until invites are on.

    return tr;
  }

  function renderWaitlistView() {
    if (!state.settings) return;
    const stats = computeStats(state.entries);
    statNums.all.textContent      = String(stats.total);
    statNums.pending.textContent  = String(stats.pending);
    statNums.approved.textContent = String(stats.approved);
    statNums.invited.textContent  = String(stats.invited);
    statNums.recent.textContent   = String(stats.recent);

    statCardButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === state.waitlistFilter);
    });

    if (stats.pending > 0) {
      navPendingBadge.textContent = String(stats.pending);
      navPendingBadge.hidden = false;
    } else {
      navPendingBadge.hidden = true;
    }

    invitesBanner.hidden = state.invitesEnabled;

    const filtered = getFilteredEntries();
    rowsEl.textContent = '';
    filtered.forEach((entry) => rowsEl.appendChild(buildRow(entry)));

    const searchText = state.searchText.trim();
    if (state.entries.length === 0) {
      emptyStateEl.textContent = 'No signups yet';
      emptyStateEl.hidden = false;
    } else if (searchText && filtered.length === 0) {
      emptyStateEl.textContent = "No matches for '" + searchText + "'";
      emptyStateEl.hidden = false;
    } else if (!searchText && state.waitlistFilter !== 'all' && filtered.length === 0) {
      emptyStateEl.textContent = 'Nothing ' + state.waitlistFilter;
      emptyStateEl.hidden = false;
    } else {
      emptyStateEl.hidden = true;
    }

    waitlistUpdatedEl.textContent = state.lastUpdated ? 'Updated ' + fmtTime(state.lastUpdated) : '';
  }

  async function handleApprove(entryId, btnEl) {
    const originalLabel = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = '…';
    try {
      const result = await api('/api/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entryId }),
      });
      if (!result.ok) {
        showToast(result.error || 'Approve failed.', true);
        btnEl.disabled = false;
        btnEl.textContent = originalLabel;
        return;
      }

      const entry = state.entries.find((e) => e.id === entryId);
      if (entry) {
        if (result.created) {
          entry.status = 'invited';
          entry.username = result.username;
          entry.invitedAt = new Date().toISOString();
        } else {
          entry.status = 'approved';
        }
      }
      renderWaitlistView();

      if (result.created && !result.emailSent) {
        openCredsDialog({ username: result.username, tempPassword: result.tempPassword, emailError: result.emailError });
      } else if (result.created) {
        showToast('Invited ' + result.username + ' — welcome email sent.', false);
      } else {
        showToast(result.message || 'Marked approved.', false);
      }
    } catch (err) {
      if (err === SENTINEL_ABORT) return;
      showToast(err.message || 'Approve failed — network error.', true);
      btnEl.disabled = false;
      btnEl.textContent = originalLabel;
    }
  }

  async function downloadCsv() {
    const originalLabel = exportCsvBtn.textContent;
    exportCsvBtn.disabled = true;
    exportCsvBtn.textContent = 'Exporting…';
    try {
      const res = await api('/api/admin/export.csv', { raw: true });
      if (!res.ok) {
        showToast('Export failed.', true);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'waitlist.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err === SENTINEL_ABORT) return;
      showToast(err.message || 'Export failed — network error.', true);
    } finally {
      exportCsvBtn.disabled = false;
      exportCsvBtn.textContent = originalLabel;
    }
  }

  // ── Emails view ────────────────────────────────────────────────────────────
  function substituteVars(html, vars) {
    return html.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));
  }

  function updatePreview(type) {
    previewFrames[type].srcdoc = substituteVars(htmlInputs[type].value, SAMPLE_VARS[type]);
  }

  function populateTemplateEditor(type, data) {
    subjInputs[type].value = data.subject;
    subjCountEls[type].textContent = data.subject.length + '/200';
    htmlInputs[type].value = data.html;
    metaEls[type].textContent = data.savedAt
      ? 'Last saved: ' + fmtDateTimeSafe(data.savedAt)
      : 'Using built-in default — not yet customized.';
    dirty[type] = false;
    updatePreview(type);
  }

  function renderEmailsView() {
    const templates = state.settings.templates;
    populateTemplateEditor('confirmation', templates.confirmation);
    populateTemplateEditor('invite', templates.invite);
    resendBanner.hidden = state.settings.emailConfigured;
    inviteEditorBanner.hidden = state.invitesEnabled;
  }

  function makeSaveHandler(type) {
    return async function () {
      const subject = subjInputs[type].value;
      const html = htmlInputs[type].value;

      if (type === 'invite') {
        const missing = ['{{tempPassword}}', '{{dashboardUrl}}'].filter((v) => !html.includes(v));
        if (missing.length) {
          const proceed = await confirmDialog(
            'This template is missing ' + missing.join(', ') + '. Users may not receive their login credentials.',
            'Save anyway'
          );
          if (!proceed) return;
        }
      }

      const btn = saveButtons[type];
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const result = await api('/api/admin/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, subject, html }),
        });
        if (!result.ok) {
          showSaveMsg(type, result.error || 'Save failed.', true);
        } else {
          state.settings.templates[type] = { subject, html, savedAt: result.savedAt };
          metaEls[type].textContent = 'Last saved: ' + fmtDateTimeSafe(result.savedAt);
          dirty[type] = false;
          showSaveMsg(type, 'Saved.', false);
        }
      } catch (err) {
        if (err !== SENTINEL_ABORT) showSaveMsg(type, err.message || 'Save failed — network error.', true);
      } finally {
        // Re-enable on every exit path, including the 403-sentinel abort —
        // otherwise a mid-save token invalidation leaves "Saving…" stuck.
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    };
  }

  function makeResetHandler(type) {
    return async function () {
      const proceed = await confirmDialog('Discard your saved template and restore the built-in default?', 'Reset');
      if (!proceed) return;

      const btn = resetButtons[type];
      btn.disabled = true;
      try {
        const result = await api('/api/admin/templates/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type }),
        });
        if (!result.ok) {
          showSaveMsg(type, result.error || 'Reset failed.', true);
        } else {
          state.settings.templates[type] = { subject: result.subject, html: result.html, savedAt: null };
          populateTemplateEditor(type, state.settings.templates[type]);
          showSaveMsg(type, 'Reset to default.', false);
        }
      } catch (err) {
        if (err !== SENTINEL_ABORT) showSaveMsg(type, err.message || 'Reset failed — network error.', true);
      } finally {
        btn.disabled = false; // every exit path, including the 403-sentinel abort
      }
    };
  }

  function wireEmailsView() {
    ['confirmation', 'invite'].forEach((type) => {
      subjInputs[type].addEventListener('input', () => {
        subjCountEls[type].textContent = subjInputs[type].value.length + '/200';
        dirty[type] = true;
      });
      htmlInputs[type].addEventListener('input', () => {
        dirty[type] = true;
        updatePreview(type);
      });
      saveButtons[type].addEventListener('click', makeSaveHandler(type));
      resetButtons[type].addEventListener('click', makeResetHandler(type));
    });

    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const targetId = chip.closest('.chips').dataset.target;
        const textarea = document.getElementById(targetId);
        const varText = chip.dataset.var;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.slice(0, start) + varText + value.slice(end);
        const newPos = start + varText.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.focus();
        const type = targetId === 'html-confirmation' ? 'confirmation' : 'invite';
        dirty[type] = true;
        updatePreview(type);
      });
    });
  }

  // ── System view ────────────────────────────────────────────────────────────
  function renderSystemView() {
    const s = state.settings;
    systemGrid.innerHTML =
      '<span class="system-label">Resend</span>' +
      (s.emailConfigured
        ? '<span class="ok">Configured</span><span class="system-hint"></span>'
        : '<span class="err">Not configured</span><span class="system-hint">Set RESEND_API_KEY in the server environment to enable outgoing email.</span>') +
      '<span class="system-label">Sender address</span>' +
      '<span>' + esc(s.emailFrom) + '</span>' +
      '<span class="system-hint">Set EMAIL_FROM to change the "from" address on outgoing email.</span>' +
      '<span class="system-label">Invites</span>' +
      (state.invitesEnabled
        ? '<span class="ok">Enabled</span><span class="system-hint"></span>'
        : '<span class="warn">Disabled</span><span class="system-hint">Set WAITLIST_INVITES_ENABLED=true once Docker isolation is on.</span>');
  }

  // ── wire up ────────────────────────────────────────────────────────────────
  gateForm.addEventListener('submit', handleGateSubmit);
  logoutBtn.addEventListener('click', handleLogoutClick);
  navLinks.forEach((a) => a.addEventListener('click', (e) => onNavClick(e, a)));
  statCardButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.waitlistFilter = btn.dataset.filter;
      renderWaitlistView();
    });
  });
  searchInput.addEventListener('input', () => {
    state.searchText = searchInput.value;
    renderWaitlistView();
  });
  exportCsvBtn.addEventListener('click', downloadCsv);
  wireEmailsView();

  credsDialogEl.addEventListener('cancel', (e) => e.preventDefault()); // block Esc dismissal
  credsCloseBtn.addEventListener('click', closeCredsDialog);
  credsCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(credsPasswordEl.textContent);
      credsCopyBtn.textContent = 'Copied!';
      setTimeout(() => { credsCopyBtn.textContent = 'Copy'; }, 2000);
    } catch {
      // Clipboard API unavailable/denied — password remains visible for manual copy.
    }
  });

  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (e) => {
    if (isEmailsDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loggedIn && state.currentRoute === 'waitlist') {
      refreshEntries();
    }
  });

  // ── init ───────────────────────────────────────────────────────────────────
  (function init() {
    const initial = parseRoute(location.hash);
    if (!initial) {
      history.replaceState(null, '', '#/waitlist');
      state.currentRoute = 'waitlist';
    } else {
      state.currentRoute = initial; // remembered as the post-login target (deep link)
    }

    const savedTok = localStorage.getItem(TOKEN_KEY);
    if (savedTok) {
      state.token = savedTok;
      attemptAutoLogin();
    } else {
      showGate('');
    }
  })();
})();
