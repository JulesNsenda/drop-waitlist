'use strict';

(function () {
  // Theme toggle — the current theme is set on <html data-theme> before first
  // paint by the inline head script; this just flips and persists it.
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', () => {
    const next = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('drop-theme', next); } catch { /* private mode */ }
  });

  const form = document.getElementById('f');
  const msg  = document.getElementById('m');
  const btn  = document.getElementById('b');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'msg';
    msg.textContent = '';
    btn.disabled = true;
    const originalBtnText = btn.textContent;
    btn.textContent = 'Joining…';

    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:   document.getElementById('email').value,
          name:    document.getElementById('name').value,
          company: document.getElementById('contact_pref_x').value,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        msg.className = 'msg ok';
        msg.textContent = "You're on the list — we'll be in touch.";
        form.reset();
      } else {
        msg.className = 'msg err';
        msg.textContent = data.error || 'Something went wrong.';
      }
    } catch {
      msg.className = 'msg err';
      msg.textContent = 'Could not reach the server.';
    }

    btn.disabled = false;
    btn.textContent = originalBtnText;
  });
})();
