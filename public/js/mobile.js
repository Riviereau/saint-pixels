/**
 * public/mobile.js — Mobile runtime fixes
 *
 * Loaded AFTER android.js. Runs on all mobile browsers (not just Android).
 * Targets three bugs that can't be fully fixed with CSS alone:
 *
 *  1. TOGGLE TAP-TARGET FIX — On Android Chrome, the browser's edge-swipe
 *     gesture (back / forward navigation) fires before touchstart on elements
 *     within ~20 px of the left or right screen edge, silently swallowing the
 *     tap before the button's click handler fires.
 *
 *     Fix: attach a capture-phase touchstart + touchend listener directly on
 *     each toggle button that (a) calls stopPropagation() to prevent the
 *     browser gesture from claiming the event, and (b) synthesises a click()
 *     on clean short taps so the action fires even if the normal click path
 *     is delayed by the gesture recogniser.
 *
 *  2. AUTH OVERLAY POINTER-EVENTS CLEANUP — Alpine's x-show directive sets
 *     display:none on #authOverlay when the user logs in, but on some
 *     Android Chrome builds the element retains pointer-events:auto from the
 *     Tailwind class "bg-black/75 grid place-items-center", leaving an invisible
 *     full-screen touch trap. We watch for style changes and strip pointer-events
 *     the instant Alpine hides the overlay. Also cleans up body.auth-open if
 *     it lingers after login.
 *
 *  3. GUEST BANNER FALLBACK — guest.js waits for sp-state-change with
 *     currentUser:null. If updateAuthState() never fires (network error, Doze
 *     mode, background-tab load), the banner never appears. We fire extra nudges
 *     at staggered intervals and dispatch sp-state-change directly as a last resort.
 *
 * Drop  <script src="/js/mobile.js"></script>  immediately after android.js in index.html.
 * No dependencies beyond the globals set by app.js / auth.js / guest.js.
 */

(function () {
  'use strict';

  // Only run on mobile-width viewports or touch devices
  const isMobileViewport = window.matchMedia('(max-width: 720px)').matches;
  const isTouchDevice    = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isMobileViewport && !isTouchDevice) return;

  // ── 1. TOGGLE TAP-TARGET FIX ──────────────────────────────────────────────
  //
  // Attaches capture-phase touch listeners that win the race against the
  // browser's edge-swipe gesture recogniser. Works on Android Chrome, Samsung
  // Internet, and Firefox for Android.
  //
  // We intentionally do NOT call preventDefault() on touchstart — that breaks
  // scroll inside the button on iOS. Instead we call it only on touchend for
  // clean taps (< 10 px movement, < 300 ms), which prevents the 300 ms ghost-
  // click delay without blocking scroll.

  function attachToggleFix(btn) {
    if (!btn) return;

    var _sx = null, _sy = null, _st = null;

    btn.addEventListener('touchstart', function (e) {
      // Stop the browser from beginning edge-swipe detection on this touch
      e.stopPropagation();
      _sx = e.touches[0].clientX;
      _sy = e.touches[0].clientY;
      _st = Date.now();
    }, { passive: true, capture: true });

    btn.addEventListener('touchend', function (e) {
      if (_sx === null) return;
      var dx = Math.abs(e.changedTouches[0].clientX - _sx);
      var dy = Math.abs(e.changedTouches[0].clientY - _sy);
      var dt = Date.now() - _st;
      if (dx < 12 && dy < 12 && dt < 350) {
        // Clean tap — prevent 300 ms delay and synthesize click immediately
        e.preventDefault();
        e.stopPropagation();
        // setTimeout(0) yields to the event loop so any in-progress transition finishes
        setTimeout(function () { btn.click(); }, 0);
      }
      _sx = _sy = _st = null;
    }, { passive: false, capture: true });
  }

  function initToggles() {
    attachToggleFix(document.getElementById('lb-toggle'));
    attachToggleFix(document.getElementById('chatclan-toggle-btn'));
  }

  // ── 2. AUTH OVERLAY POINTER-EVENTS CLEANUP ────────────────────────────────
  //
  // MutationObserver watches #authOverlay's style attribute. The instant Alpine
  // sets display:none, we also set pointer-events:none and visibility:hidden so
  // no invisible touch trap remains.
  //
  // Also removes body.auth-open if it somehow lingers after a successful login
  // (race condition between auth.js and Alpine's reactive update).

  function initAuthOverlayCleanup() {
    var overlay = document.getElementById('authOverlay');
    if (!overlay) return;

    function sync() {
      var display = window.getComputedStyle(overlay).display;
      if (display === 'none') {
        // Overlay is hidden — ensure it never catches touches
        overlay.style.pointerEvents = 'none';
        overlay.style.visibility    = 'hidden';
      } else {
        // Overlay is visible — restore normal behaviour
        overlay.style.pointerEvents = '';
        overlay.style.visibility    = '';
      }
    }

    // Observe style + class changes (Alpine uses both)
    new MutationObserver(sync)
      .observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });

    // Apply immediately in case overlay is already hidden
    sync();

    // Remove stale body.auth-open whenever a real user logs in
    window.addEventListener('sp-state-change', function (e) {
      if (!e || !e.detail || !e.detail.currentUser) return;
      // Give Alpine 300 ms to finish its reactive update first
      setTimeout(function () {
        var display = window.getComputedStyle(overlay).display;
        if (display === 'none' && document.body.classList.contains('auth-open')) {
          document.body.classList.remove('auth-open');
        }
        // Also strip pointer-events after login in case sync() hasn't fired yet
        if (display === 'none') {
          overlay.style.pointerEvents = 'none';
          overlay.style.visibility    = 'hidden';
        }
      }, 300);
    });
  }

  // ── 3. GUEST BANNER FALLBACK ──────────────────────────────────────────────
  //
  // Fires sp-guest-nudge at staggered intervals so guest.js can show the
  // observer banner even when Android Doze delays setTimeout or when the tab
  // loads in the background.
  //
  // Also dispatches sp-state-change{currentUser:null} as a last resort if
  // after 7 s there is still no user and no banner — this triggers guest.js's
  // main sp-state-change listener directly.

  function initGuestBannerFallback() {
    function hasRealUser() {
      return !!(window.currentUser && !/^Guest \d{7}$/.test(window.currentUser));
    }

    function nudge() {
      if (hasRealUser()) return;
      if (document.getElementById('gm-observer-banner')) return;
      window.dispatchEvent(new CustomEvent('sp-guest-nudge'));
    }

    function fallback() {
      if (hasRealUser()) return;
      if (window.__token) return; // guest session active
      if (document.getElementById('gm-observer-banner')) return;
      // Dispatch sp-state-change{currentUser:null} — triggers guest.js's
      // onFirst listener which calls onAuthResolved(null) → showObserverMode()
      window.dispatchEvent(new CustomEvent('sp-state-change', {
        detail: { currentUser: null }
      }));
    }

    // Staggered nudges: 1.5 s (fast network), 4 s (slow network), 8 s (Doze)
    setTimeout(nudge, 1500);
    setTimeout(nudge, 4000);
    setTimeout(nudge, 8000);

    // Direct fallback: if nothing has worked after 7 s, force the state event
    setTimeout(fallback, 7000);

    // Also nudge on visibilitychange (tab foregrounded after background load)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        setTimeout(nudge, 500);
      }
    });
  }

  // ── INIT ──────────────────────────────────────────────────────────────────

  function init() {
    initToggles();
    initAuthOverlayCleanup();
    initGuestBannerFallback();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
