/**
 * public/ios.js — iOS hard-reset helper
 *
 * What it does
 * ────────────
 * Detects iOS / iPadOS and, when found:
 *  1. Sets <html data-ios="1"> so ios.css reveals the button.
 *  2. Injects a "Reset" button into the scrolling topbar strip (next to
 *     the other mob-* buttons).
 *  3. On click, shows a confirmation modal explaining exactly what
 *     the reset clears and what it keeps.
 *  4. On confirmation, performs a hard reset of THIS TAB ONLY:
 *       • Clears all caches via the Cache Storage API (if available).
 *       • Appends a unique ?v= query-string to force the browser to fetch
 *         a fresh copy of index.html from the Railway container, bypassing
 *         any cached version iOS WebKit is holding on to.
 *       • Does NOT touch localStorage (settings / volume / achievements
 *         are preserved across the reload).
 *
 * Why query-string busting instead of location.reload(true)?
 * ──────────────────────────────────────────────────────────
 * Safari on iOS ignores the `forceGet` argument of location.reload() and
 * serves the page from its disk cache regardless.  Navigating to a fresh
 * URL (with a unique timestamp query-string) forces a real network request
 * to the server, which is the only reliable way to guarantee the current
 * deployment is loaded.
 *
 * Drop  <script src="/ios.js"></script>  after settings.js in index.html.
 * Requires ios.css to be linked in <head>.
 */

(function () {
  'use strict';

  // ── 1. iOS / iPadOS detection ──────────────────────────────────────────────
  //
  // iPadOS 13+ reports itself as "Macintosh" in the UA but exposes touch
  // support, so we also check navigator.maxTouchPoints.
  const ua = navigator.userAgent || '';
  const isIOS =
    /iP(hone|od|ad)/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (!isIOS) return; // nothing to do on non-iOS platforms

  // Mark the root element so CSS can reveal iOS-only UI
  document.documentElement.setAttribute('data-ios', '1');

  // ── 2. Inject the topbar button ────────────────────────────────────────────
  //
  // We target the same scrolling strip that holds mob-contribute-btn,
  // mob-discord-btn, mob-settings-btn, etc.  That strip is the first child
  // flex container inside <header>.
  const topbarStrip = document.querySelector('header .flex.flex-row.flex-nowrap');

  const resetBtn = document.createElement('button');
  resetBtn.id        = 'ios-reset-btn';
  resetBtn.type      = 'button';
  resetBtn.title     = 'Hard Reset (iOS update fix)';
  resetBtn.setAttribute('aria-label', 'Hard reset — reload latest version');
  resetBtn.innerHTML =
    // Reload icon (Lucide "refresh-cw")
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="23 4 23 10 17 10"/>' +
      '<polyline points="1 20 1 14 7 14"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' +
    '</svg>' +
    'Reset';

  if (topbarStrip) {
    // Insert right before the mob-settings-btn so it stays grouped with
    // the utility buttons, not the social links.
    const settingsBtn = document.getElementById('mob-settings-btn');
    if (settingsBtn) {
      topbarStrip.insertBefore(resetBtn, settingsBtn);
    } else {
      topbarStrip.appendChild(resetBtn);
    }
  }

  // ── 3. Build the confirmation modal ───────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'ios-reset-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Confirm hard reset');
  overlay.innerHTML = `
    <div id="ios-reset-modal">

      <div class="ios-modal-header">
        <div class="ios-modal-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </div>
        <span class="ios-modal-title">Hard Reset</span>
      </div>

      <p class="ios-modal-body">
        Forces <strong>this tab</strong> to download the latest version of
        Saint-Pixels from the server, bypassing iOS's cached copy.
        Use this if you're seeing an older version after a recent update.
      </p>

      <div class="ios-modal-chips">
        <div class="ios-chip resets">
          <span class="ios-chip-dot" aria-hidden="true"></span>
          <span>Clears cached page assets (JS, CSS, HTML) for this tab</span>
        </div>
        <div class="ios-chip keeps">
          <span class="ios-chip-dot" aria-hidden="true"></span>
          <span>Keeps your login session, settings, volume &amp; achievements</span>
        </div>
      </div>

      <p id="ios-reset-status"></p>

      <div class="ios-modal-actions">
        <button id="ios-cancel-btn"  type="button">Cancel</button>
        <button id="ios-confirm-btn" type="button">Reset &amp; Reload</button>
      </div>

    </div>
  `;
  document.body.appendChild(overlay);

  const statusEl   = document.getElementById('ios-reset-status');
  const confirmBtn = document.getElementById('ios-confirm-btn');
  const cancelBtn  = document.getElementById('ios-cancel-btn');

  // ── 4. Open / close helpers ────────────────────────────────────────────────

  function openModal() {
    statusEl.textContent = '';
    statusEl.className   = '';
    confirmBtn.disabled  = false;
    overlay.classList.add('visible');
    confirmBtn.focus();
  }

  function closeModal() {
    overlay.classList.remove('visible');
  }

  resetBtn.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', closeModal);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) closeModal();
  });

  // ── 5. Hard reset sequence ─────────────────────────────────────────────────

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;

    // Show spinner on the topbar button icon
    const icon = resetBtn.querySelector('svg');
    if (icon) icon.classList.add('ios-spin');

    // Step 1 — Clear Cache Storage (service worker / PWA caches)
    setStatus('Clearing caches…');
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {
      // Cache API might be unavailable in some contexts — not fatal
      console.warn('[ios-reset] Cache clear skipped:', e);
    }

    // Step 2 — Navigate to a fresh URL with a cache-busting timestamp.
    //
    // We do NOT use location.reload(true) because iOS Safari ignores the
    // forceGet flag and serves from disk cache anyway.
    //
    // We navigate to the same origin root ('/') with a unique query string
    // so WebKit treats it as a new resource and must fetch it from the
    // network, giving us whatever is currently deployed on Railway.
    setStatus('Loading latest version…');
    try {
      // Short pause so the user can read the status message
      await delay(400);
      window.location.href = '/?_v=' + Date.now();
    } catch (e) {
      setStatus('Reload failed — please refresh manually.', 'err');
      confirmBtn.disabled = false;
      if (icon) icon.classList.remove('ios-spin');
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className   = cls || '';
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

})();
