// Applies the saved theme before first paint (kept as an external file so the strict CSP can forbid inline scripts).
try {
  var t = localStorage.getItem('lanshare.theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
