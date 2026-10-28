// Runs before the page paints, so there's no flash of the wrong theme.
// Light by default; Settings → Appearance can pick dark, or follow the phone (auto).
(function () {
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function pick() { var m = 'light'; try { m = JSON.parse(localStorage.getItem('pt_theme')) || 'light'; } catch (e) {} return m; }
  function apply() {
    var m = pick(), dark = m === 'dark' || (m === 'auto' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var meta = document.getElementById('themeColor'); if (meta) meta.content = dark ? '#08090D' : '#F4F5F7';
    document.dispatchEvent(new Event('pt-theme'));
  }
  window.ptTheme = { apply: apply, pick: pick };
  mq.addEventListener ? mq.addEventListener('change', apply) : mq.addListener(apply);
  apply();
})();
