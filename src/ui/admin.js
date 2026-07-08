'use strict';

(function () {
  const ROUTES = ['waitlist', 'emails', 'settings'];
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
    settings: null, // full GET /api/admin/settings body: templates, email, invites, env flags
    entries: [],
    invitesEnabled: false,
    currentRoute: 'waitlist',
    waitlistFilter: 'all',
    searchText: '',
    lastUpdated: null,
    renderGen: 0,
  };
  const dirty = { confirmation: false, invite: false, emailSettings: false };

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
    settings: document.getElementById('view-settings'),
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

  const emailConfigBanner = document.getElementById('email-config-banner');
  const inviteEditorBanner = document.getElementById('invite-editor-banner');
  const subjInputs   = { confirmation: document.getElementById('subj-confirmation'), invite: document.getElementById('subj-invite') };
  const subjCountEls = { confirmation: document.getElementById('subj-count-confirmation'), invite: document.getElementById('subj-count-invite') };
  const htmlInputs   = { confirmation: document.getElementById('html-confirmation'), invite: document.getElementById('html-invite') };
  const metaEls      = { confirmation: document.getElementById('meta-confirmation'), invite: document.getElementById('meta-invite') };
  const saveButtons  = { confirmation: document.getElementById('save-confirmation'), invite: document.getElementById('save-invite') };
  const resetButtons = { confirmation: document.getElementById('reset-confirmation'), invite: document.getElementById('reset-invite') };
  const msgEls       = { confirmation: document.getElementById('msg-confirmation'), invite: document.getElementById('msg-invite') };
  const previewFrames = { confirmation: document.getElementById('preview-confirmation'), invite: document.getElementById('preview-invite') };

  // Settings view — email delivery card
  const providerSelect      = document.getElementById('email-provider');
  const emailGroupResend    = document.getElementById('email-group-resend');
  const emailGroupSmtp      = document.getElementById('email-group-smtp');
  const emailGroupFrom      = document.getElementById('email-group-from');
  const resendKeyStatusEl   = document.getElementById('resend-key-status');
  const smtpHostInput       = document.getElementById('smtp-host');
  const smtpPortInput       = document.getElementById('smtp-port');
  const smtpUsernameInput   = document.getElementById('smtp-username');
  const smtpPasswordInput   = document.getElementById('smtp-password');
  const fromNameInput       = document.getElementById('from-name');
  const fromAddressInput    = document.getElementById('from-address');
  const fromMismatchWarning = document.getElementById('from-mismatch-warning');
  const emailMetaEl         = document.getElementById('meta-email-settings');
  const saveEmailBtn        = document.getElementById('save-email-settings');
  const resetEmailBtn       = document.getElementById('reset-email-settings');
  const emailMsgEl          = document.getElementById('msg-email-settings');
  const testEmailInput      = document.getElementById('test-email-to');
  const testEmailBtn        = document.getElementById('test-email-btn');
  const testEmailResultEl   = document.getElementById('test-email-result');
  // Settings view — invites + environment cards
  const invitesToggle     = document.getElementById('invites-toggle');
  const invitesToggleText = document.getElementById('invites-toggle-text');
  const invitesMetaEl     = document.getElementById('meta-invites');
  const dropKeyWarning    = document.getElementById('drop-key-warning');
  const envDropKeyEl      = document.getElementById('env-drop-key');
  const envResendKeyEl    = document.getElementById('env-resend-key');

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

  // Dirty tracking covers the Emails template editors and the Settings
  // email-delivery card — each guarded when leaving its own view.
  function isRouteDirty(route) {
    if (route === 'emails') return dirty.confirmation || dirty.invite;
    if (route === 'settings') return dirty.emailSettings;
    return false;
  }

  function isAnythingDirty() {
    return dirty.confirmation || dirty.invite || dirty.emailSettings;
  }

  function clearRouteDirty(route) {
    if (route === 'emails') { dirty.confirmation = false; dirty.invite = false; }
    if (route === 'settings') dirty.emailSettings = false;
  }

  function parseRoute(hash) {
    const m = /^#\/(\w+)/.exec(hash || '');
    let r = m ? m[1] : '';
    if (r === 'system') r = 'settings'; // legacy alias — the System view became Settings
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

  function showInlineMsg(el, text, isErr) {
    el.textContent = text;
    el.className = 'save-msg ' + (isErr ? 'err-msg' : 'ok-msg');
    if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  function showSaveMsg(type, text, isErr) {
    showInlineMsg(msgEls[type], text, isErr);
  }

  // ── reusable confirm dialog (resets, missing-vars, dirty nav/logout, invites enable) ──
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
    if (isAnythingDirty()) {
      const confirmed = await confirmDialog(
        'You have unsaved changes. Logging out will discard them.', 'Log out'
      );
      if (!confirmed) return;
      dirty.confirmation = false;
      dirty.invite = false;
      dirty.emailSettings = false;
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

  // Refetch entries only — used on visibilitychange -> visible and on
  // navigating into Waitlist. (Settings and templates update through their
  // own save flows, which patch state.settings in place.)
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
    views.settings.hidden = route !== 'settings';
    navLinks.forEach((a) => a.classList.toggle('active', a.dataset.route === route));

    if (route === 'waitlist') {
      renderWaitlistView();
      refreshEntries();
    } else if (route === 'emails') {
      renderEmailsView(); // always repopulates from state, resets dirty flags
    } else if (route === 'settings') {
      renderSettingsView(); // always repopulates from state, resets the email-card dirty flag
    }
  }

  // Runs the dirty guard for leaving a view with unsaved edits (Emails
  // template editors or the Settings email card). Resolves true when it is
  // safe to proceed (clearing the dirty flags on a consented discard).
  async function guardLeaveDirtyView(target) {
    if (target === state.currentRoute || !isRouteDirty(state.currentRoute)) return true;
    const what = state.currentRoute === 'emails' ? 'template changes' : 'email settings';
    const confirmed = await confirmDialog(
      'You have unsaved ' + what + '. Leaving will discard them.', 'Discard'
    );
    if (!confirmed) return false;
    clearRouteDirty(state.currentRoute);
    return true;
  }

  // Nav-link clicks run the guard BEFORE location.hash is touched: on Cancel
  // the URL never changed, so no history surgery is ever needed.
  async function onNavClick(e, a) {
    e.preventDefault();
    const target = a.dataset.route;
    if (!(await guardLeaveDirtyView(target))) return; // cancelled — URL untouched
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

    // Normalize alias hashes (#/system → #/settings) without firing hashchange.
    if (location.hash !== '#/' + target) history.replaceState(null, '', '#/' + target);

    if (target !== state.currentRoute && isRouteDirty(state.currentRoute)) {
      const from = state.currentRoute;
      guardLeaveDirtyView(target).then((proceed) => {
        if (proceed) {
          navigateRoute(target);
        } else {
          history.replaceState(null, '', '#/' + from); // restore URL, keep the view
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

  // Provider-aware "email won't send" copy shared by the Emails banner.
  function emailNotConfiguredMessage() {
    const provider = state.settings.email ? state.settings.email.provider : 'none';
    if (provider === 'resend') {
      return 'Email sending is not working — Resend is selected but RESEND_API_KEY is not set in the server environment.';
    }
    if (provider === 'smtp') {
      return 'Email sending is not working — SMTP settings are incomplete. Finish setup in Settings.';
    }
    return 'Email sending is not configured — set it up in Settings.';
  }

  function renderEmailsView() {
    const templates = state.settings.templates;
    populateTemplateEditor('confirmation', templates.confirmation);
    populateTemplateEditor('invite', templates.invite);
    emailConfigBanner.hidden = state.settings.emailConfigured;
    if (!state.settings.emailConfigured) emailConfigBanner.textContent = emailNotConfiguredMessage();
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

  // ── Settings view ──────────────────────────────────────────────────────────
  // The email card is a form over state.settings.email; the SMTP password is
  // write-only: the input is always rendered empty, the server never echoes
  // the stored value, and the POST includes it only when the user typed one.
  let testEmailSending = false;

  function parseFromField(from) {
    const m = /^(.*)<([^>]*)>\s*$/.exec(from || '');
    if (m) return { name: m[1].trim().replace(/^"(.*)"$/, '$1'), address: m[2].trim() };
    return { name: '', address: String(from || '').trim() };
  }

  function composeFromField() {
    const name = fromNameInput.value.trim();
    const address = fromAddressInput.value.trim();
    return name ? name + ' <' + address + '>' : address;
  }

  // Mirrors the server's provider-aware "email is usable" rule so banners
  // update immediately after a save; the next loadAll re-syncs regardless.
  function computeEmailConfigured(s) {
    if (s.email.provider === 'resend') return !!s.resendKeyConfigured;
    if (s.email.provider === 'smtp') return !!(s.email.smtp.host && s.email.smtp.username && s.email.smtp.hasPassword);
    return false;
  }

  function updateProviderGroups() {
    const p = providerSelect.value;
    emailGroupResend.hidden = p !== 'resend';
    emailGroupSmtp.hidden   = p !== 'smtp';
    emailGroupFrom.hidden   = p === 'none';
    updateFromMismatchWarning();
  }

  function updateFromMismatchWarning() {
    const addr = fromAddressInput.value.trim().toLowerCase();
    const user = smtpUsernameInput.value.trim().toLowerCase();
    fromMismatchWarning.hidden = !(providerSelect.value === 'smtp' && addr && user && addr !== user);
  }

  function updateTestEmailButton() {
    testEmailBtn.disabled = dirty.emailSettings || testEmailSending;
    testEmailBtn.title = dirty.emailSettings ? 'Save your settings first' : '';
  }

  function markEmailSettingsDirty() {
    dirty.emailSettings = true;
    updateFromMismatchWarning();
    updateTestEmailButton();
  }

  function showTestEmailResult(text, isErr) {
    testEmailResultEl.textContent = text;
    testEmailResultEl.className = 'test-email-result ' + (isErr ? 'err' : 'ok');
  }

  function renderSettingsView() {
    if (!state.settings) return;
    const s = state.settings;
    const email = s.email;

    providerSelect.value = email.provider;
    smtpHostInput.value = email.smtp.host || '';
    smtpPortInput.value = String(email.smtp.port || 465);
    smtpUsernameInput.value = email.smtp.username || '';
    smtpPasswordInput.value = ''; // write-only — never render the stored value
    smtpPasswordInput.placeholder = email.smtp.hasPassword ? '(unchanged)' : '(not set)';
    const from = parseFromField(email.from);
    fromNameInput.value = from.name;
    fromAddressInput.value = from.address;
    emailMetaEl.textContent = email.savedAt
      ? 'Last saved: ' + fmtDateTimeSafe(email.savedAt)
      : 'Using server env/defaults.';
    emailMsgEl.textContent = '';
    testEmailResultEl.textContent = '';

    resendKeyStatusEl.textContent = s.resendKeyConfigured
      ? 'Configured ✓'
      : 'Not set — set RESEND_API_KEY in the environment';
    resendKeyStatusEl.className = 'static-value ' + (s.resendKeyConfigured ? 'ok' : 'warn');

    dirty.emailSettings = false;
    updateProviderGroups();
    updateTestEmailButton();
    renderInvitesCard();
    renderEnvCard();
  }

  function renderInvitesCard() {
    const inv = state.settings.invites;
    invitesToggle.checked = inv.enabled;
    invitesToggleText.textContent = inv.enabled
      ? 'Invites are enabled — Approve provisions a DROP account and emails the user their credentials.'
      : 'Invites are disabled — Approve only marks the entry as approved; no account is created and nothing is emailed.';
    invitesMetaEl.textContent = inv.savedAt
      ? 'Last saved: ' + fmtDateTimeSafe(inv.savedAt)
      : 'Using server env/defaults.';
    dropKeyWarning.hidden = inv.dropKeyConfigured;
  }

  function renderEnvCard() {
    const s = state.settings;
    const dropOk = s.invites.dropKeyConfigured;
    envDropKeyEl.textContent = dropOk ? 'Configured ✓' : 'Not set ✗';
    envDropKeyEl.className = dropOk ? 'ok' : 'err';
    const resendOk = s.resendKeyConfigured;
    envResendKeyEl.textContent = resendOk ? 'Configured ✓' : 'Not set ✗';
    envResendKeyEl.className = resendOk ? 'ok' : 'err';
  }

  async function handleSaveEmailSettings() {
    const provider = providerSelect.value;
    const port = Number(smtpPortInput.value);
    const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
    if (provider === 'smtp' && !portValid) {
      showInlineMsg(emailMsgEl, 'Port must be a whole number between 1 and 65535.', true);
      return;
    }

    const smtp = {
      host: smtpHostInput.value.trim(),
      port: portValid ? port : 465,
      username: smtpUsernameInput.value.trim(),
    };
    if (smtpPasswordInput.value) smtp.password = smtpPasswordInput.value; // omitted = keep existing

    saveEmailBtn.disabled = true;
    saveEmailBtn.textContent = 'Saving…';
    try {
      const result = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: { provider, from: composeFromField(), smtp } }),
      });
      if (!result.ok) {
        showInlineMsg(emailMsgEl, result.error || 'Save failed.', true);
      } else {
        state.settings.email = result.email;
        state.settings.emailConfigured = computeEmailConfigured(state.settings);
        renderSettingsView(); // repopulates from the fresh server view; clears the password input
        showInlineMsg(emailMsgEl, 'Saved.', false);
      }
    } catch (err) {
      if (err !== SENTINEL_ABORT) showInlineMsg(emailMsgEl, err.message || 'Save failed — network error.', true);
    } finally {
      // Re-enable on every exit path, including the 403-sentinel abort.
      saveEmailBtn.disabled = false;
      saveEmailBtn.textContent = 'Save';
    }
  }

  async function handleResetEmailSettings() {
    const proceed = await confirmDialog('Discard saved email settings and return to server env/defaults?', 'Reset');
    if (!proceed) return;

    resetEmailBtn.disabled = true;
    try {
      const result = await api('/api/admin/settings/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'email' }),
      });
      if (!result.ok) {
        showInlineMsg(emailMsgEl, result.error || 'Reset failed.', true);
      } else {
        state.settings.email = result.email;
        state.settings.emailConfigured = computeEmailConfigured(state.settings);
        renderSettingsView();
        showInlineMsg(emailMsgEl, 'Reset to env/defaults.', false);
      }
    } catch (err) {
      if (err !== SENTINEL_ABORT) showInlineMsg(emailMsgEl, err.message || 'Reset failed — network error.', true);
    } finally {
      resetEmailBtn.disabled = false; // every exit path, including the 403-sentinel abort
    }
  }

  async function handleSendTestEmail() {
    const to = testEmailInput.value.trim();
    if (!to) {
      showTestEmailResult('Enter a recipient address first.', true);
      return;
    }

    testEmailSending = true;
    updateTestEmailButton();
    testEmailBtn.textContent = 'Sending…';
    try {
      const result = await api('/api/admin/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      if (result.ok && result.sent) {
        showTestEmailResult('Test email sent to ' + to, false);
      } else {
        showTestEmailResult(result.error || 'Test email failed.', true);
      }
    } catch (err) {
      if (err !== SENTINEL_ABORT) showTestEmailResult(err.message || 'Test email failed — network error.', true);
    } finally {
      testEmailSending = false;
      testEmailBtn.textContent = 'Send test';
      updateTestEmailButton();
    }
  }

  async function handleInvitesToggle() {
    const wantEnabled = invitesToggle.checked;
    if (wantEnabled) {
      const proceed = await confirmDialog(
        'Enabling invites means Approve provisions a REAL account on your DROP server and emails credentials to the user. Enable?',
        'Enable'
      );
      if (!proceed) {
        invitesToggle.checked = false; // cancelled — revert without posting
        return;
      }
    }

    invitesToggle.disabled = true;
    try {
      const result = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitesEnabled: wantEnabled }),
      });
      if (!result.ok) {
        invitesToggle.checked = !wantEnabled;
        showToast(result.error || 'Could not update invites.', true);
      } else {
        state.settings.invites = result.invites;
        state.settings.invitesEnabled = result.invites.enabled;
        // Waitlist banner/buttons and the Emails invite banner read this; they
        // re-render from state when their views are entered.
        state.invitesEnabled = result.invites.enabled;
        renderInvitesCard();
      }
    } catch (err) {
      if (err === SENTINEL_ABORT) return;
      invitesToggle.checked = !wantEnabled;
      showToast(err.message || 'Could not update invites — network error.', true);
    } finally {
      invitesToggle.disabled = false;
    }
  }

  function wireSettingsView() {
    providerSelect.addEventListener('change', () => {
      markEmailSettingsDirty();
      updateProviderGroups();
    });
    [smtpHostInput, smtpPortInput, smtpUsernameInput, smtpPasswordInput, fromNameInput, fromAddressInput]
      .forEach((el) => el.addEventListener('input', markEmailSettingsDirty));
    saveEmailBtn.addEventListener('click', handleSaveEmailSettings);
    resetEmailBtn.addEventListener('click', handleResetEmailSettings);
    testEmailBtn.addEventListener('click', handleSendTestEmail);
    invitesToggle.addEventListener('change', handleInvitesToggle);
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
  wireSettingsView();

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
    if (isAnythingDirty()) { e.preventDefault(); e.returnValue = ''; }
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
