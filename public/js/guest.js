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
// 2. GUEST SESSION (300 free pixels, 180-minute window)
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
//   • window.__guestMode.syncPixels(remaining) — call this in the pixel POST
//     success handler with data.guestPixelsRemaining so the HUD stays in sync
//     with the server. Avoids the double-count from sp-pixel-placed firing
//     twice (once on send, once on SSE echo).
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
  const GUEST_PIXEL_BUDGET   = 300;
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
    // Ensure banner is always above the auth overlay (which may still be
    // rendering on slow devices / Alpine-delayed Android) and above chat/lb panels
    banner.style.zIndex = '2147483647';
    banner.innerHTML = `
      <span class="gm-obs-eye" aria-hidden="true">👁</span>
      <span class="gm-obs-text">You're watching live. Want to leave your mark?</span>
      <button id="gm-try-guest-btn"  class="gm-btn gm-btn--primary" type="button">
        Try 300 free pixels
      </button>
      <button id="gm-signup-btn" class="gm-btn gm-btn--ghost" type="button">
        Login / Sign up
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

    // Tell Alpine the observer banner is active so the auth overlay steps aside
    if (typeof dispatchStateChange === 'function') {
      dispatchStateChange({ guestObserver: true });
    }
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
    // Let Alpine know the observer layer is gone so auth overlay can resume normal behaviour
    if (typeof dispatchStateChange === 'function') {
      dispatchStateChange({ guestObserver: false });
    }
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
          <div class="gm-pixel-bar-wrap" aria-hidden="true">
            <div id="gm-pixel-bar" class="gm-pixel-bar"></div>
          </div>
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

  function updatePixelBar() {
    const bar = document.getElementById('gm-pixel-bar');
    if (!bar) return;
    const pct = Math.min(100, (_pixelsUsed / GUEST_PIXEL_BUDGET) * 100);
    bar.style.width = pct + '%';
    // Shift to amber when ≥ 80 % used, red when exhausted
    bar.classList.toggle('gm-pixel-bar--warn',  pct >= 80 && pct < 100);
    bar.classList.toggle('gm-pixel-bar--empty', pct >= 100);
  }

  function updateHUD() {
    updatePixelBar();
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
      ? "You've used all 300 free pixels!"
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
    // Primary path: Alpine listens for sp-open-auth and sets showAuth = true,
    // which makes the overlay visible regardless of currentUser/guestObserver.
    window.dispatchEvent(new CustomEvent('sp-open-auth'));

    // Fallback for Android / slow Alpine: if the overlay still isn't visible
    // 150 ms later, force-show it by removing display:none directly.
    setTimeout(() => {
      const overlay = document.getElementById('authOverlay');
      if (!overlay) return;
      const computed = window.getComputedStyle(overlay).display;
      if (computed === 'none') {
        overlay.style.removeProperty('display');
        overlay.style.zIndex = '2147483647';
        overlay.style.pointerEvents = 'auto';
        // Hide the guest banner so it doesn't sit on top
        const banner = document.getElementById('gm-observer-banner');
        if (banner) banner.style.zIndex = '500';
      }
    }, 150);
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
        tryBtn.textContent = 'Try 300 free pixels';
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

    // Budget tracking is handled via syncPixelsFromServer(), called by
    // the pixel POST response handler with the server-returned remaining count.

    // Mark the <html> so CSS can suppress erase / certain tools for guests
    document.documentElement.setAttribute('data-guest', '1');

    console.info(`[guest] Session active: ${username}, expires in ${Math.round(remaining / 60000)} min`);
  }

  // ── Track pixel use — server-authoritative ────────────────────────────────
  // Called by the pixel POST handler (via window.__guestMode.syncPixels) with
  // the guestPixelsRemaining value the server returns in the response body.
  // This avoids the double-count that occurred when sp-pixel-placed fired once
  // on send and again when the SSE echo arrived, incrementing _pixelsUsed twice.

  function syncPixelsFromServer(remaining) {
    if (!_guestActive) return;
    _pixelsUsed = Math.max(_pixelsUsed, GUEST_PIXEL_BUDGET - remaining);
    ssSet(GUEST_PIXELS_KEY, String(_pixelsUsed));
    updateHUD();

    if (_pixelsUsed >= GUEST_PIXEL_BUDGET) {
      setTimeout(() => expireGuestSession('pixels'), 600);
    }
  }

  // ── Expire / end the session ───────────────────────────────────────────────

  function expireGuestSession(reason) {
    if (!_guestActive) return; // already expired
    _guestActive = false;

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
      }
      if (!isGuest) {
        // Also remove the observer banner if it was shown while waiting for
        // auth to resolve (it may have appeared without _guestActive being set,
        // e.g. when the mobile.js fallback fired during a slow auth fetch).
        removeObserverBanner();
        // Clean up any lingering conversion prompts
        const conv = document.getElementById('gm-conversion-overlay');
        if (conv) conv.remove();
        const strip = document.getElementById('gm-upgrade-strip');
        if (strip) strip.remove();
      }
    }

    // User logged out of a real account — re-show the observer banner.
    // Guard against stale mobile.js / android.js fallback dispatches that fire
    // { currentUser: null } as a last resort even when a real user is already
    // signed in (e.g. mobile.js fires at 7 s to nudge guest.js on slow networks).
    // We cross-check window.currentUser so those spurious nulls can't trigger
    // the banner while a signed-in session is active.
    if (detail.currentUser === null && !_guestActive) {
      const liveUser = window.currentUser;
      const liveUserIsReal = !!(liveUser && !/^Guest \d{7}$/.test(liveUser));
      if (liveUserIsReal) return; // spurious null — a real user is still active
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

    // Wait for the main app to report auth state before deciding whether to
    // show the observer banner. We track whether auth has resolved and whether
    // the resolved user is a real (non-guest) account so both the event handler
    // and the fallback timer use the same logic.
    let _authResolved  = false; // true once sp-state-change fires with currentUser
    let _userIsReal    = false; // true if the resolved user is a signed-in account

    function onAuthResolved(username) {
      _authResolved = true;
      // A real (non-guest) username means the user is signed in — do nothing.
      _userIsReal = !!(username && !/^Guest \d{7}$/.test(username));
      if (_userIsReal) return;
      // null or a guest username means nobody is signed in yet.
      if (!_guestActive) showObserverMode();
    }

    // sp-state-change fires when updateAuthState resolves. We keep listening
    // (don't removeEventListener) because updateAuthState can fire once with
    // null (token missing) and then again after a retry with the real username.
    // We stop acting on it once a real user has been confirmed.
    window.addEventListener('sp-state-change', function onFirst(e) {
      if (!e.detail || !('currentUser' in e.detail)) return;
      const u = e.detail.currentUser;
      const isReal = !!(u && !/^Guest \d{7}$/.test(u));
      if (isReal) {
        // Signed-in user confirmed — stop listening, ensure no banner shows.
        window.removeEventListener('sp-state-change', onFirst);
        _authResolved = true;
        _userIsReal   = true;
        return;
      }
      if (u === null && !_authResolved) {
        // Confirmed logged-out (no token) — but verify window.currentUser hasn't
        // been set by a concurrent updateAuthState() response before acting.
        // mobile.js / android.js fire { currentUser: null } as a fallback nudge;
        // if the real user is already known we must not show the observer banner.
        const liveUser = window.currentUser;
        if (liveUser && !/^Guest \d{7}$/.test(liveUser)) {
          // A real user resolved concurrently — treat as signed in.
          window.removeEventListener('sp-state-change', onFirst);
          _authResolved = true;
          _userIsReal   = true;
          return;
        }
        // Show the observer banner once.
        window.removeEventListener('sp-state-change', onFirst);
        onAuthResolved(null);
      }
    });

    // Fallback: if no state change fires within 3 s (e.g. network timeout),
    // only show the banner when we have no confirmed real user.
    // Also cross-check window.currentUser in case updateAuthState() resolved
    // the token and set the user but hasn't dispatched sp-state-change yet.
    setTimeout(() => {
      if (_userIsReal || _guestActive) return;
      const liveUser = window.currentUser;
      if (liveUser && !/^Guest \d{7}$/.test(liveUser)) return; // real user active
      if (!_authResolved) showObserverMode();
    }, 3000);

    // Android Doze / background tab can delay setTimeout.  android.js fires
    // sp-guest-nudge when the tab becomes visible so we re-check promptly.
    window.addEventListener('sp-guest-nudge', function onNudge() {
      if (_userIsReal || _guestActive) {
        window.removeEventListener('sp-guest-nudge', onNudge);
        return;
      }
      if (!_authResolved) {
        // Auth hasn't resolved yet — treat it as logged-out and show banner.
        _authResolved = true;
        showObserverMode();
      } else if (!document.getElementById('gm-observer-banner') && !_guestActive) {
        // Auth resolved as logged-out but banner was never injected — try again.
        showObserverMode();
      }
      window.removeEventListener('sp-guest-nudge', onNudge);
    });

    // Also handle visibility change directly in case android.js isn't loaded.
    function onVisibilityVisible() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisibilityVisible);
      if (_userIsReal || _guestActive) return;
      setTimeout(() => {
        if (!_userIsReal && !_guestActive && !document.getElementById('gm-observer-banner')) {
          showObserverMode();
        }
      }, 500);
    }
    document.addEventListener('visibilitychange', onVisibilityVisible);
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Expose for debugging / manual testing ──────────────────────────────────
  window.__guestMode = {
    start:      startGuestSession,
    expire:     (reason = 'pixels') => expireGuestSession(reason),
    status:     () => ({ active: _guestActive, pixelsUsed: _pixelsUsed, expiresAt: _expiresAt }),
    // Called by the pixel POST success handler with the server-returned remaining count.
    // This is the authoritative update path — avoids the sp-pixel-placed double-fire issue.
    syncPixels: (remaining) => syncPixelsFromServer(remaining),
  };

})();
