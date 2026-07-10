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
})();
