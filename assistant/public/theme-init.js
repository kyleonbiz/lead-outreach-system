// Applies the saved theme before first paint (external file so a strict Content-Security-Policy can forbid inline scripts).
try {
  var t = localStorage.getItem('theme')
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark')
  }
} catch (e) {}
