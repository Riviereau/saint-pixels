/**
 * public/android.js — Android WebView / Chrome mobile helper
 *
 * What it does
 * ────────────
 * Detects Android browsers and applies targeted fixes for the three
 * issues that only surface on Android:
 *
 *  1. GESTURE NAV BAR — Android 10+ gesture navigation can cover the
 *     bottom of the page even when `env(safe-area-inset-bottom)` reports
 *     0 px (common on Chrome < 117 and many OEM WebViews).  This script
 *     detects the gap and injects a CSS custom property
 *     `--android-nav-extra` that mobile.css consumers can add to their
 *     bottom offsets.
 *
 *  2. AUTH OVERLAY TOUCH BLOCK — The Alpine auth overlay uses
 *     `x-cloak` + `display:none` once Alpine boots, but between DOM
 *     paint and Alpine initialisation the overlay is visible and
 *     intercepts touches at z-index 2147483647.  On Android the
 *     Alpine CDN script occasionally loads slowly (throttled background
 *     tabs, low-end devices), leaving the invisible-but-blocking overlay
 *     in place for several seconds.  This script watches for Alpine boot
 *     and forcibly removes the blocking style if the overlay should be
 *     hidden.
 *
 *  3. GUEST BANNER TIMEOUT ACCELERATION — Android's Doze/battery-saver
 *     mode can freeze `setTimeout` callbacks for several seconds when the
 *     tab is not in the foreground immediately after load.  The `guest.js`
 *     3-second fallback that shows the observer banner therefore fires
 *     late or not at all.  This script fires `sp-guest-nudge` once the
 *     page becomes visible, so guest.js can re-evaluate whether to show
 *     the banner.
 *
 * Drop  <script src="/android.js"></script>  after ios.js in index.html.
 * Requires android.css (linked in <head> after ios.css).
 *
 * No Android-specific CSS file is required; fixes are injected inline or
 * via CSS custom properties on <html>.
 */

(function () {
  'use strict';

  // ── 1. Android / Chrome-mobile detection ──────────────────────────────────
  const ua = navigator.userAgent || '';

  const isAndroid = /Android/i.test(ua);
  // Also catches Chrome on Android, Samsung Internet, Firefox for Android
  if (!isAndroid) return;

  // Mark root for CSS selectors (mirrors ios.js pattern)
  document.documentElement.setAttribute('data-android', '1');

  // ── 2. Gesture navigation bar height fix ──────────────────────────────────
  // Android gesture nav can add 20–48 px of unusable space at the bottom
  // that `env(safe-area-inset-bottom)` doesn't always account for on older
  // Chromium builds or OEM forks.
  //
  // Strategy: compare `window.innerHeight` with `screen.height`.  The delta
  // on most gesture-nav Android devices is 20–56 px.  If it looks like a
  // nav-bar gap (> 16 px, < 80 px) we publish it as a CSS variable.
  function measureNavBar() {
    // `visualViewport.height` is the most reliable source on Android Chrome 61+
    const vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const gap = window.innerHeight - vvh;
    // Gap from screen vs viewport (independent of zoom / keyboard)
    const rawGap = screen.height - window.innerHeight;
    const navExtra = Math.max(0, Math.min(gap > 8 ? gap : rawGap, 80));
    document.documentElement.style.setProperty('--android-nav-extra', navExtra + 'px');
  }

  measureNavBar();
  window.addEventListener('resize', measureNavBar, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', measureNavBar, { passive: true });
  }

  // ── 3. Auth overlay Alpine timing fix ─────────────────────────────────────
  // Before Alpine boots, [x-cloak] hides the auth overlay via CSS.
  // That's correct — but if Alpine's CDN script is delayed (slow network,
  // background tab, low-end device), [x-cloak] never gets removed and
  // the overlay stays invisible yet still blocks all pointer events.
  //
  // Fix: once the page is interactive (DOMContentLoaded), check whether
  // Alpine has set `_x_dataStack` on the body.  If not, watch every 100 ms
  // until it has (or until 8 s pass), then let Alpine handle visibility
  // correctly by forcing a re-check.

  function waitForAlpine(cb, maxWait) {
    const start = Date.now();
    function check() {
      // Alpine 3 stores data stack on the element it initialises
      const body = document.body;
      if (body && body._x_dataStack) {
        cb();
        return;
      }
      if (Date.now() - start < (maxWait || 8000)) {
        setTimeout(check, 100);
      } else {
        // Alpine never booted — apply the emergency fallback
        cb();
      }
    }
    check();
  }

  document.addEventListener('DOMContentLoaded', function () {
    waitForAlpine(function () {
      const overlay = document.getElementById('authOverlay');
      if (!overlay) return;

      // If Alpine has hidden the overlay properly, nothing to do
      if (overlay.style.display === 'none' || overlay.style.display === '') return;

      // If the overlay is visible but currentUser is set (or guestObserver is
      // true in Alpine), the overlay should be hidden.  We can't read Alpine
      // state directly, so we read the rendered display value.
      // If x-cloak was already stripped and the overlay is display:none, fine.
      // If somehow the overlay has display:block/grid when it shouldn't, hide it.
      const computed = window.getComputedStyle(overlay).display;
      if (computed !== 'none') {
        // Check if a real user or guest session is active
        const hasUser  = !!(window.currentUser || window.__username);
        const hasToken = !!(window.__token);
        if (hasUser || hasToken) {
          overlay.style.display = 'none';
          overlay.style.pointerEvents = 'none';
          console.info('[android] Auth overlay force-hidden (Alpine delayed, user present)');
        }
      }
    }, 8000);
  });

  // ── 4. Guest observer banner — visibility page event ──────────────────────
  // Android Doze can delay setTimeout by minutes in background tabs.
  // When the user switches back to the tab, fire `sp-guest-nudge` so
  // guest.js can check whether the observer banner should be shown.

  let _nudgeFired = false;

  function fireGuestNudge() {
    if (_nudgeFired) return;
    _nudgeFired = true;
    window.dispatchEvent(new CustomEvent('sp-guest-nudge'));
  }

  // visibilitychange fires when the user switches back to the tab
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // Small delay so the JS thread can process any pending timers first
      setTimeout(fireGuestNudge, 400);
    }
  });

  // Also fire once the page is fully loaded in case we're already visible
  window.addEventListener('load', function () {
    setTimeout(fireGuestNudge, 1200);
  });

  // ── 5. Leaderboard + chat toggle touch-area fix ───────────────────────────
  // On some Android devices, fixed-position elements at the screen edge
  // get their touch events swallowed by the browser's swipe-back gesture
  // recogniser.  Applying `touch-action: pan-y` to the toggle buttons
  // prevents the browser from claiming the horizontal swipe for navigation.

  document.addEventListener('DOMContentLoaded', function () {
    // Leaderboard toggle (left edge)
    const lbToggle = document.getElementById('lb-toggle');
    if (lbToggle) {
      lbToggle.style.touchAction = 'manipulation';
      // Increase tap target slightly
      lbToggle.style.minWidth   = '36px';
      lbToggle.style.minHeight  = '64px';
    }

    // Chat/Clan toggle (right edge)
    const ccToggle = document.getElementById('chatclan-toggle-btn');
    if (ccToggle) {
      ccToggle.style.touchAction = 'manipulation';
      ccToggle.style.minWidth    = '36px';
      ccToggle.style.minHeight   = '64px';
    }
  });

  // ── 6. Observer banner Android safe-area padding ──────────────────────────
  // On Android the observer banner's bottom position must account for the
  // gesture nav bar.  We listen for the banner being added and patch its
  // bottom style with --android-nav-extra.

  function patchBannerPosition() {
    const banner = document.getElementById('gm-observer-banner');
    if (!banner) return;
    // The mobile.css bottom value is already set; we only need to augment it
    // on Android where the safe-area env() may under-report by ~20 px.
    const navExtra = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--android-nav-extra') || '0',
      10
    );
    if (navExtra > 0) {
      const current = parseInt(getComputedStyle(banner).bottom, 10) || 0;
      banner.style.bottom = (current + navExtra) + 'px';
    }
  }

  // Watch for the banner to appear (guest.js injects it dynamically)
  const _bannerObserver = new MutationObserver(function (mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.id === 'gm-observer-banner' || node.id === 'gm-hud') {
          patchBannerPosition();
        }
      }
    }
  });
  document.addEventListener('DOMContentLoaded', function () {
    _bannerObserver.observe(document.body, { childList: true });
    // In case banner was already injected (restored session)
    patchBannerPosition();
  });

  console.info('[android] Android helper active');
})();
