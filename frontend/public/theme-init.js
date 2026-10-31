// Chargé de façon bloquante dans <head> (fichier à part et non script en ligne : la Content-Security-Policy
// n'autorise que les scripts servis par l'application).
// Thème appliqué avant le premier rendu (pas de flash) : réglage de ce navigateur, sinon celui du système.
try {
  var pref = localStorage.getItem('skipper.theme');
  var theme = pref === 'light' || pref === 'dark' ? pref : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-bs-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#eceef1' : '#0f0f0f');
  var cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', theme);
} catch (e) {}
