'use strict';

(function () {
  const form = document.getElementById('f');
  const msg  = document.getElementById('m');
  const btn  = document.getElementById('b');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    btn.disabled = true;

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
  });
})();
