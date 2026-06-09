// ═══════════════════════════════════════════════════════════════════
// guest.js — Observer mode + Guest pixel-trial session
//
// TWO MODES
// ─────────
// 1. OBSERVER (no action needed)
//    Anyone who lands on the page can immediately see the live canvas
//    and read the chat. SSE is already open. This file shows a small
//    passive banner: "You're watching. Place pixels — sign up free."
//
// 2. GUEST SESSION (3 free pixels, 180-minute window)
//    Clicking "Try as guest" calls POST /api/guest/session which
//    returns a short-lived Bearer token + a username like "guest-a7k2".
//    The guest token is stored in sessionStorage (not localStorage so
//    it dies with the tab, keeping the backend clean).
//    After 3 pixels, or after 180 minutes, a soft conversion prompt
//    appears. The guest can keep watching; they just can't place more.
//
// INTEGRATION POINTS (all calls go through existing app.js globals)
// ─────────────────────────────────────────────────────────────────
//   • setCurrentUser(username, skipFetch)  — promotes guest into the
//     main app session so every existing module (cooldown, broadcast,
//     leaderboard, etc.) works without modification.
//   • setAuthToken(token)                  — wires the Bearer token into
//     window.__token and localStorage so broadcast.js/chat.js pick it up.
//   • dispatchStateChange({ currentUser }) — keeps Alpine reactive.
//   • connectSSE()                         — already running; guest
//     receives the same stream, no change needed.
//
// BACKEND CONTRACT (implement in your API layer)
// ──────────────────────────────────────────────
//   POST /api/guest/session
//     Body:  {}
//     Response 200: { token: string, username: string, expiresAt: number }
//     • token      — short-lived JWT / opaque token (TTL: 180 min)
//     • username   — server-assigned e.g. "guest-a7k2"
//     • expiresAt  — Unix ms timestamp of expiry
//     Rate-limit: 10 guest sessions / IP / hour to prevent abuse.
//
//   POST /api/pixel (existing endpoint)
//     Guest tokens are accepted with a server-side pixel cap of 3.
//     On the 4th attempt the server returns 403 { error: 'guest_limit' }.
//     The guest cooldown is the same as registered users (3 s).
//
//   POST /api/erase (existing endpoint)
//     Guest tokens are REJECTED — erasing requires a registered account.
//     Server returns 403 { error: 'guest_no_erase' }.
//
// DEPENDENCIES
// ────────────
//   app.js    — currentUser, setCurrentUser, setAuthToken, dispatchStateChange
//   auth.js   — updateAuthState (called after real registration to clean up)
//   cooldown.js — updateCooldownLabel
//   broadcast.js — broadcastEvent (pixel posting already respects window.__token)
//
// Drop  <script src="/guest.js"></script>  after app.js in index.html.
// Link  <link rel="stylesheet" href="/guest.css"> in <head>.
// ═══════════════════════════════════════════════════════════════════

(function GuestMode() {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const GUEST_PIXEL_BUDGET   = 3;
  const GUEST_SESSION_MS     = 180 * 60 * 1000; // 180 minutes
  const GUEST_TOKEN_KEY      = 'sp_guest_token';
  const GUEST_USER_KEY       = 'sp_guest_username';
  const GUEST_EXPIRES_KEY    = 'sp_guest_expires';
  const GUEST_PIXELS_KEY     = 'sp_guest_pixels_used';

  // ── State ──────────────────────────────────────────────────────────────────
  let _guestActive    = false;  // true while a guest session is live
  let _pixelsUsed     = 0;
  let _expiresAt      = 0;
  let _countdownTimer = null;
  let _sessionTimeout = null;

  // ── sessionStorage helpers ─────────────────────────────────────────────────
  // Using sessionStorage so the guest session dies with the tab. We never
  // persist guest tokens to localStorage to avoid polluting the main session.

  function ssGet(key)        { try { return sessionStorage.getItem(key); }    catch { return null; } }
  function ssSet(key, val)   { try { sessionStorage.setItem(key, val); }      catch {} }
  function ssDel(key)        { try { sessionStorage.removeItem(key); }        catch {} }

  function saveGuestSession(token, username, expiresAt, pixelsUsed) {
    ssSet(GUEST_TOKEN_KEY,   token);
    ssSet(GUEST_USER_KEY,    username);
    ssSet(GUEST_EXPIRES_KEY, String(expiresAt));
    ssSet(GUEST_PIXELS_KEY,  String(pixelsUsed ?? 0));
  }

  function clearGuestSession() {
    ssDel(GUEST_TOKEN_KEY);
    ssDel(GUEST_USER_KEY);
    ssDel(GUEST_EXPIRES_KEY);
    ssDel(GUEST_PIXELS_KEY);
  }

  function loadGuestSession() {
    const token     = ssGet(GUEST_TOKEN_KEY);
    const username  = ssGet(GUEST_USER_KEY);
    const expiresAt = parseInt(ssGet(GUEST_EXPIRES_KEY) ?? '0', 10);
    const pixels    = parseInt(ssGet(GUEST_PIXELS_KEY)  ?? '0', 10);
    if (!token || !username || Date.now() >= expiresAt) return null;
    return { token, username, expiresAt, pixelsUsed: pixels };
  }

  // ── Observer banner ────────────────────────────────────────────────────────
  // Always visible to logged-out, non-guest visitors.

  function buildObserverBanner() {
    if (document.getElementById('gm-observer-banner')) return;
    const banner = document.createElement('div');
    banner.id        = 'gm-observer-banner';
    banner.className = 'gm-observer-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <span class="gm-obs-eye" aria-hidden="true">👁</span>
      <span class="gm-obs-text">You're watching live. Want to leave your mark?</span>
      <button id="gm-try-guest-btn"  class="gm-btn gm-btn--primary" type="button">
        Try 3 free pixels
      </button>
      <button id="gm-signup-btn" class="gm-btn gm-btn--ghost" type="button">
        Sign up free
      </button>
      <button id="gm-obs-dismiss" class="gm-obs-dismiss" type="button" aria-label="Dismiss">✕</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('gm-try-guest-btn').addEventListener('click', startGuestSession);
    document.getElementById('gm-signup-btn').addEventListener('click', openAuthModal);
    document.getElementById('gm-obs-dismiss').addEventListener('click', () => {
      banner.classList.add('gm-dismissed');
      // Show the sticky mini-badge so they can get back
      showObserverBadge();
    });

    // Animate in after a short delay so it doesn't feel jarring on load
    requestAnimationFrame(() => {
      setTimeout(() => banner.classList.add('gm-visible'), 800);
    });
  }

  // Small persistent badge shown after the observer banner is dismissed
  function showObserverBadge() {
    if (document.getElementById('gm-observer-badge')) return;
    const badge = document.createElement('button');
    badge.id        = 'gm-observer-badge';
    badge.className = 'gm-observer-badge';
    badge.type      = 'button';
    badge.setAttribute('aria-label', 'Try placing a pixel');
    badge.innerHTML = `<span aria-hidden="true">🎨</span> Try it`;
    badge.addEventListener('click', () => {
      badge.remove();
      const b = document.getElementById('gm-observer-banner');
      if (b) { b.classList.remove('gm-dismissed'); }
      else    { buildObserverBanner(); }
    });
    document.body.appendChild(badge);
  }

  function removeObserverBanner() {
    const b = document.getElementById('gm-observer-banner');
    if (b) b.remove();
    const badge = document.getElementById('gm-observer-badge');
    if (badge) badge.remove();
  }

  // ── Guest HUD (pixel counter + timer + upgrade CTA) ───────────────────────

  function buildGuestHUD() {
    if (document.getElementById('gm-hud')) return;
    const hud = document.createElement('div');
    hud.id        = 'gm-hud';
    hud.className = 'gm-hud';
    hud.setAttribute('role', 'status');
    hud.setAttribute('aria-live', 'polite');
    hud.innerHTML = `
      <div class="gm-hud-inner">
        <span class="gm-hud-label">Guest session</span>
        <div class="gm-hud-pixels">
          <span id="gm-pixel-pips" class="gm-pixel-pips" aria-hidden="true"></span>
          <span id="gm-pixel-count" class="gm-pixel-count">0 / ${GUEST_PIXEL_BUDGET} pixels</span>
        </div>
        <div class="gm-hud-timer">
          <span class="gm-hud-timer-icon" aria-hidden="true">⏱</span>
          <span id="gm-timer-label" class="gm-timer-label">3:00:00</span>
        </div>
        <button id="gm-hud-signup-btn" class="gm-btn gm-btn--primary gm-btn--sm" type="button">
          Save your work — sign up
        </button>
      </div>
    `;
    document.body.appendChild(hud);
    document.getElementById('gm-hud-signup-btn').addEventListener('click', openAuthModal);
    updateHUD();
  }

  function updatePixelPips() {
    const pips = document.getElementById('gm-pixel-pips');
    if (!pips) return;
    pips.innerHTML = '';
    for (let i = 0; i < GUEST_PIXEL_BUDGET; i++) {
      const pip = document.createElement('span');
      pip.className = 'gm-pip' + (i < _pixelsUsed ? ' gm-pip--used' : '');
      pips.appendChild(pip);
    }
  }

  function updateHUD() {
    updatePixelPips();
    const countEl = document.getElementById('gm-pixel-count');
    if (countEl) {
      const remaining = Math.max(0, GUEST_PIXEL_BUDGET - _pixelsUsed);
      countEl.textContent = remaining === 0
        ? 'No pixels left'
        : `${remaining} pixel${remaining !== 1 ? 's' : ''} left`;
    }
  }

  function removeGuestHUD() {
    const hud = document.getElementById('gm-hud');
    if (hud) hud.remove();
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
  }

  // ── Countdown timer ────────────────────────────────────────────────────────

  function startCountdown() {
    if (_countdownTimer) clearInterval(_countdownTimer);
    _countdownTimer = setInterval(() => {
      const rem = Math.max(0, _expiresAt - Date.now());
      const timerEl = document.getElementById('gm-timer-label');
      if (timerEl) {
        const h = Math.floor(rem / 3600000);
        const m = Math.floor((rem % 3600000) / 60000);
        const s = Math.floor((rem % 60000) / 1000);
        timerEl.textContent =
          h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;

        // Warn when < 10 minutes remain
        if (rem < 10 * 60 * 1000) timerEl.classList.add('gm-timer--warn');
      }
      if (rem === 0) expireGuestSession('time');
    }, 1000);
  }

  // ── "Budget spent" or "time expired" conversion modal ─────────────────────

  function showConversionPrompt(reason) {
    // Don't show a second time
    if (document.getElementById('gm-conversion-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id        = 'gm-conversion-overlay';
    overlay.className = 'gm-conversion-overlay';

    const headline = reason === 'pixels'
      ? "You've used all 3 free pixels!"
      : 'Your guest session has ended.';
    const sub = reason === 'pixels'
      ? 'Sign up to keep placing pixels — it\'s free and takes 30 seconds.'
      : 'You can still watch, but placing pixels requires an account.';

    overlay.innerHTML = `
      <div class="gm-conversion-modal" role="dialog" aria-modal="true" aria-label="Create your account">
        <div class="gm-conv-art" aria-hidden="true">
          <div class="gm-conv-pixel gm-conv-pixel--a"></div>
          <div class="gm-conv-pixel gm-conv-pixel--b"></div>
          <div class="gm-conv-pixel gm-conv-pixel--c"></div>
          <div class="gm-conv-pixel gm-conv-pixel--d"></div>
        </div>
        <h2 class="gm-conv-headline">${headline}</h2>
        <p class="gm-conv-sub">${sub}</p>
        <ul class="gm-conv-perks">
          <li><span aria-hidden="true">♾️</span> Unlimited pixels</li>
          <li><span aria-hidden="true">🔥</span> Streaks &amp; achievements</li>
          <li><span aria-hidden="true">🏆</span> Leaderboard ranking</li>
          <li><span aria-hidden="true">💬</span> Global chat</li>
        </ul>
        <button id="gm-conv-signup"   class="gm-btn gm-btn--primary gm-btn--lg"  type="button">Create free account</button>
        <button id="gm-conv-continue" class="gm-btn gm-btn--ghost   gm-btn--sm"  type="button">Keep watching</button>
      </div>
    `;
    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(() => overlay.classList.add('gm-visible'));

    document.getElementById('gm-conv-signup').addEventListener('click', () => {
      overlay.remove();
      openAuthModal();
    });
    document.getElementById('gm-conv-continue').addEventListener('click', () => {
      overlay.classList.remove('gm-visible');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      setTimeout(() => { if (document.contains(overlay)) overlay.remove(); }, 400);
      // After dismissal show a persistent "upgrade" strip so they can come back to it
      showUpgradeStrip();
    });
  }

  // Persistent thin strip shown after conversion modal is dismissed
  function showUpgradeStrip() {
    if (document.getElementById('gm-upgrade-strip')) return;
    const strip = document.createElement('div');
    strip.id        = 'gm-upgrade-strip';
    strip.className = 'gm-upgrade-strip';
    strip.innerHTML = `
      <span>Pixels used up · <strong>Sign up free</strong> to keep painting</span>
      <button id="gm-strip-signup" class="gm-btn gm-btn--primary gm-btn--xs" type="button">Sign up</button>
      <button id="gm-strip-dismiss" class="gm-obs-dismiss" type="button" aria-label="Dismiss">✕</button>
    `;
    document.body.appendChild(strip);
    requestAnimationFrame(() => strip.classList.add('gm-visible'));
    document.getElementById('gm-strip-signup').addEventListener('click', openAuthModal);
    document.getElementById('gm-strip-dismiss').addEventListener('click', () => strip.remove());
  }

  // ── Auth modal open helper ─────────────────────────────────────────────────
  // Reuses the existing auth panel in the DOM. When a guest is active Alpine's
  // currentUser is set (to the guest username), so the overlay x-show="!currentUser"
  // keeps it hidden. We dispatch 'sp-open-auth' which the Alpine body handler
  // catches via @sp-open-auth.window and flips a dedicated showAuth flag,
  // making the overlay visible regardless of currentUser.

  function openAuthModal() {
    window.dispatchEvent(new CustomEvent('sp-open-auth'));
  }

  // ── Start guest session ────────────────────────────────────────────────────

  async function startGuestSession() {
    const tryBtn = document.getElementById('gm-try-guest-btn');
    if (tryBtn) { tryBtn.disabled = true; tryBtn.textContent = 'Starting…'; }

    try {
      const res = await fetch('/api/guest/session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      const { token, username, expiresAt } = await res.json();
      if (!token || !username || !expiresAt) throw new Error('Bad response from server');

      activateGuestSession(token, username, expiresAt, 0);

    } catch (err) {
      console.warn('[guest] Could not start session:', err.message);
      if (tryBtn) {
        tryBtn.disabled    = false;
        tryBtn.textContent = 'Try 3 free pixels';
      }
      // Surface a friendly error in the banner
      const banner = document.getElementById('gm-observer-banner');
      if (banner) {
        const errEl = banner.querySelector('.gm-obs-error') || document.createElement('span');
        errEl.className   = 'gm-obs-error';
        errEl.textContent = 'Could not start session — please try again.';
        banner.appendChild(errEl);
        setTimeout(() => errEl.remove(), 4000);
      }
    }
  }

  // ── Activate a guest session (new or restored from sessionStorage) ─────────

  function activateGuestSession(token, username, expiresAt, pixelsUsed) {
    _guestActive  = true;
    _pixelsUsed   = pixelsUsed;
    _expiresAt    = expiresAt;

    // Persist to sessionStorage so a page-refresh within the same tab restores it
    saveGuestSession(token, username, expiresAt, pixelsUsed);

    // Wire the token into the main app so broadcast.js / chat.js work
    if (typeof setAuthToken === 'function') setAuthToken(token);
    window.__token    = token;
    window.__username = username;

    // Promote into the main app session (skipFetch = true: don't hit /api/me)
    if (typeof setCurrentUser === 'function') {
      setCurrentUser(username, true /* skipFetch */);
    } else {
      // Fallback if setCurrentUser isn't available yet
      window.currentUser = username;
      if (typeof dispatchStateChange === 'function') {
        dispatchStateChange({ currentUser: username });
      }
    }

    // Remove the observer banner; show the guest HUD
    removeObserverBanner();
    buildGuestHUD();
    startCountdown();

    // Schedule automatic expiry
    const remaining = Math.max(0, expiresAt - Date.now());
    _sessionTimeout = setTimeout(() => expireGuestSession('time'), remaining);

    // Hook into the pixel-placed event to track budget
    window.addEventListener('sp-pixel-placed', onGuestPixelPlaced);

    // Mark the <html> so CSS can suppress erase / certain tools for guests
    document.documentElement.setAttribute('data-guest', '1');

    console.info(`[guest] Session active: ${username}, expires in ${Math.round(remaining / 60000)} min`);
  }

  // ── Track pixel use ────────────────────────────────────────────────────────

  function onGuestPixelPlaced() {
    if (!_guestActive) return;
    _pixelsUsed++;
    ssSet(GUEST_PIXELS_KEY, String(_pixelsUsed));
    updateHUD();

    if (_pixelsUsed >= GUEST_PIXEL_BUDGET) {
      // Let the last pixel animation finish, then prompt
      setTimeout(() => expireGuestSession('pixels'), 600);
    }
  }

  // ── Expire / end the session ───────────────────────────────────────────────

  function expireGuestSession(reason) {
    if (!_guestActive) return; // already expired
    _guestActive = false;

    window.removeEventListener('sp-pixel-placed', onGuestPixelPlaced);
    if (_countdownTimer)  { clearInterval(_countdownTimer);   _countdownTimer  = null; }
    if (_sessionTimeout)  { clearTimeout(_sessionTimeout);    _sessionTimeout  = null; }

    // Revoke the guest token in the main app so no more pixels can be posted
    if (typeof setAuthToken === 'function') setAuthToken(null);
    window.__token    = null;
    window.__username = null;

    // Revert the app user to null (but keep watching)
    if (typeof setCurrentUser === 'function') setCurrentUser(null, true);
    if (typeof dispatchStateChange === 'function') dispatchStateChange({ currentUser: null });

    // Clear session data
    clearGuestSession();
    document.documentElement.removeAttribute('data-guest');

    // Show the conversion prompt
    showConversionPrompt(reason);

    console.info(`[guest] Session ended: ${reason}`);
  }

  // ── Conversion: real account created ──────────────────────────────────────
  // Listen for a successful real login/registration so we can clean up the
  // guest chrome and not show the conversion prompt ever again.

  window.addEventListener('sp-state-change', (e) => {
    const detail = e?.detail;
    if (!detail) return;

    // A real login happened (non-guest username, token set)
    if (detail.currentUser && typeof detail.currentUser === 'string') {
      const isGuest = /^Guest \d{7}$/.test(detail.currentUser);
      if (!isGuest && _guestActive) {
        // User registered or logged in — clean up guest state silently
        _guestActive = false;
        clearGuestSession();
        removeGuestHUD();
        removeObserverBanner();
        document.documentElement.removeAttribute('data-guest');
        if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
        if (_sessionTimeout) { clearTimeout(_sessionTimeout);  _sessionTimeout = null; }
        window.removeEventListener('sp-pixel-placed', onGuestPixelPlaced);
      }
      if (!isGuest) {
        // Clean up any lingering conversion prompts
        const conv = document.getElementById('gm-conversion-overlay');
        if (conv) conv.remove();
        const strip = document.getElementById('gm-upgrade-strip');
        if (strip) strip.remove();
      }
    }

    // User logged out of a real account — re-show the observer banner
    if (detail.currentUser === null && !_guestActive) {
      // Small delay so auth.js finishes its teardown first
      setTimeout(showObserverMode, 300);
    }
  });

  // ── Entry point: decide which mode to show ─────────────────────────────────

  function showObserverMode() {
    // Don't show if already logged in as a real user
    if (window.currentUser && !/^Guest \d{7}$/.test(window.currentUser)) return;
    if (_guestActive) return;
    buildObserverBanner();
  }

  function init() {
    // Don't interfere if running in local-dev bypass mode
    if (typeof isLocalDev === 'function' && isLocalDev()) return;

    // Restore a live guest session from the same tab
    const saved = loadGuestSession();
    if (saved) {
      activateGuestSession(saved.token, saved.username, saved.expiresAt, saved.pixelsUsed);
      return;
    }

    // Wait for the main app to report auth state before deciding
    // whether to show the observer banner. If currentUser is already
    // set (e.g. returning user), do nothing.
    function checkAndShow() {
      if (window.currentUser) return; // already logged in
      showObserverMode();
    }

    // sp-state-change fires when updateAuthState resolves
    window.addEventListener('sp-state-change', function onFirst(e) {
      if (e.detail && 'currentUser' in e.detail) {
        window.removeEventListener('sp-state-change', onFirst);
        checkAndShow();
      }
    });

    // Fallback: if no state change fires within 3 s (e.g. network timeout),
    // show the observer banner anyway — it does no harm to logged-in users
    // because the sp-state-change listener above will clean it up.
    setTimeout(() => {
      if (!window.currentUser && !_guestActive) showObserverMode();
    }, 3000);
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Expose for debugging / manual testing ──────────────────────────────────
  window.__guestMode = {
    start:   startGuestSession,
    expire:  (reason = 'pixels') => expireGuestSession(reason),
    status:  () => ({ active: _guestActive, pixelsUsed: _pixelsUsed, expiresAt: _expiresAt }),
  };

})();
