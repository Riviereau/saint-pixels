(function () {
  var win   = document.getElementById('sp-rules-window');
  var openBtn  = document.getElementById('topbarRulesBtn');
  var closeX   = document.getElementById('sp-rules-close-x');
  var closeBtn = document.getElementById('sp-rules-close-btn');

  /* Also wire the auth-form "community rules" link to this window */
  var authLink = document.getElementById('authRulesLink');

  function openRules(e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    win.style.display = 'flex';
  }
  function closeRules() {
    win.style.display = 'none';
  }

  openBtn.addEventListener('click', openRules);
  if (authLink) authLink.addEventListener('click', openRules);
  closeX.addEventListener('click', closeRules);
  closeBtn.addEventListener('click', closeRules);

  /* Close on backdrop click */
  win.addEventListener('click', function (e) {
    if (e.target === win) closeRules();
  });

  /* Close on Escape */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && win.style.display === 'flex') closeRules();
  });

  /* Hover style polish for close-x */
  closeX.addEventListener('mouseenter', function () {
    closeX.style.color = '#f1f5f9';
    closeX.style.background = 'rgba(255,255,255,0.08)';
  });
  closeX.addEventListener('mouseleave', function () {
    closeX.style.color = '#94a3b8';
    closeX.style.background = 'none';
  });

  /* Hover style for Got it button */
  closeBtn.addEventListener('mouseenter', function () {
    closeBtn.style.background = 'rgba(56,189,248,0.25)';
  });
  closeBtn.addEventListener('mouseleave', function () {
    closeBtn.style.background = 'rgba(56,189,248,0.12)';
  });
})();
