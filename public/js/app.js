// ═══════════════════════════════════════════════════════════════════
// app.js — Thin orchestration shell
// Global state variables, utility helpers, and the load-time init
// sequence. All feature logic has been split into dedicated modules:
//   canvas.js   — buffer, paintPixel, grid, cursor, redraw, coords
//   ruler.js    — pixel-ruler engine
//   input.js    — mouse / touch / keyboard / wheel / pan / zoom
//   palette.js  — color palette state, variation picker, color helpers
//   auth.js     — login, register, logout, ban screen, password reset
//   cooldown.js — cooldown bar UI + canPlacePixel gate
//   broadcast.js — SSE real-time sync + pixel broadcast
//   events.js   — cooldown event system + streak / stats
//   achievements.js — achievement engine + attack detection
//   particles.js — pixel-place burst particle system
//   sfx.js      — sound effects engine
//   leaderboard.js  — leaderboard panel + profile modal
//
// Alpine.js component data is inlined in <body x-data="..."> in
// index.html. The canvas engine dispatches `sp-state-change` custom
// events; Alpine picks them up via @sp-state-change.window on <body>.
// ═══════════════════════════════════════════════════════════════════

// ── State dispatcher ─────────────────────────────────────────────────
/** Send reactive state updates to Alpine without touching the DOM. */
function dispatchStateChange(detail) {
  window.dispatchEvent(new CustomEvent('sp-state-change', { detail }));
}

// ── Shared global state ──────────────────────────────────────────────
// These variables are read and written by multiple modules.
// Declared here (at script-load time, before DOMContentLoaded) so
// every module can reference them without a temporal dead zone error.

let currentUser  = null;
let lastPlaceAt  = 0;
let color        = '#000000';
let cursorPosition = null; // set to board-center on first load in canvas.js

// ── Utility helpers ──────────────────────────────────────────────────

/** JSON.parse with a safe fallback. */
function safeParse(value, fallback) {
  try { return JSON.parse(value) || fallback; }
  catch { return fallback; }
}

/**
 * Returns true when the mobileDebug bypass should be active on the client.
 * Two conditions must both be true:
 *   1. The server injected data-local-bypass="1" on <html>.
 *   2. The browser hostname is a loopback or private-network address.
 */
function isLocalDev() {
  const { hostname } = window.location;

  // Fast path: genuine loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;

  // mobileDebug path: LAN IP + server confirmed bypass is active
  const serverBypass = document.documentElement.dataset.localBypass === '1';
  if (!serverBypass) return false;

  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  // IPv6 loopback / link-local
  if (hostname === '::1' || /^\[?fe80:/i.test(hostname)) return true;

  return false;
}

// ── Storage keys ─────────────────────────────────────────────────────
// Declared here so auth.js, broadcast.js, and input.js can all share them.
const EVENT_KEY         = 'sp_last_event';
const PIXEL_HISTORY_KEY = 'sp_pixel_history';

// ── Recent-local-cell guard ───────────────────────────────────────────
// Tracks cells the current user painted optimistically in the last 15 s.
// Used in broadcast.js (paintInitPixelsChunked) to skip stale SSE init-
// bundle entries on reconnect, so we never overwrite a freshly-placed
// local pixel with an older server snapshot.
// Key: "x,y" string.  Value: timestamp of the local paint.
const _recentLocalCells = new Map();
const RECENT_LOCAL_TTL_MS = 15000; // 15 s — covers multiple cooldown cycles on reconnect

function _markLocalCell(x, y) {
  const key = `${x},${y}`;
  _recentLocalCells.set(key, Date.now());
  // Lazy prune: remove entries older than the TTL whenever we add a new one
  const cutoff = Date.now() - RECENT_LOCAL_TTL_MS;
  for (const [k, t] of _recentLocalCells) {
    if (t < cutoff) _recentLocalCells.delete(k);
  }
}

// ── Pixel history helpers ─────────────────────────────────────────────

function appendHistory(event) {
  const history = safeParse(localStorage.getItem(PIXEL_HISTORY_KEY), []);
  history.push(event);
  if (history.length > 500) history.shift();
  localStorage.setItem(PIXEL_HISTORY_KEY, JSON.stringify(history));
}

// ── Canvas clear helpers ──────────────────────────────────────────────

/** Clear the buffer locally; optionally broadcast to other tabs. */
function clearCanvasLocal(announce = true) {
  bufferCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  redraw();
  if (announce) {
    broadcastEvent({ type: 'clear', user: currentUser });
  }
}

/** Public clear — requires login. */
function clearCanvas() {
  if (!currentUser) return;
  clearCanvasLocal(true);
}

// ── UI sync ──────────────────────────────────────────────────────────

/** Re-sync palette, color swatch, tool buttons, coord label, and cooldown bar. */
function syncUI() {
  renderPalette();
  setColor(color);
  setTool(tool);
  updateStatus(cursorPosition ? cursorPosition.x : 0, cursorPosition ? cursorPosition.y : 0);
  updateCooldownLabel();
}

function updateLiveCount(count) {
  dispatchStateChange({ liveCount: count });
}

// ── Init sequence ─────────────────────────────────────────────────────

window.addEventListener('load', () => {
  // 1. Size the canvas and draw the white board instantly (fixes the blue flash)
  resizeViewport();
  // Set cursor to board center now that BOARD_WIDTH/HEIGHT are available
  if (!cursorPosition) {
    cursorPosition = { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
  }
  syncUI();

  // 2. Fetch palette asynchronously in the background
  initPalette();

  // On local dev / mobileDebug origins skip the login overlay entirely.
  if (isLocalDev()) {
    const isLoopback = (() => {
      const h = window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1';
    })();

    if (isLoopback) {
      // Pure localhost — no token, no network call needed
      setCurrentUser('dev', true);
    } else {
      // LAN IP — ask the server for the assigned anon username
      fetch('/api/me')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.username) {
            setCurrentUser(data.username, true);
          } else {
            const parts = window.location.hostname.split('.');
            setCurrentUser('anon-' + parts[parts.length - 1], true);
          }
        })
        .catch(() => { setCurrentUser('anon-local', true); });
    }
  } else {
    updateAuthState();
  }

  // 3. Start game loops
  replayHistory();
  connectSSE();
  updateCooldownLabel();

  // 4. Engagement features — non-blocking background fetches
  _ensureParticleCanvas();
  fetchEventStatus();
  // Streak/stats are fetched after auth resolves (handled inside setCurrentUser)
});

// ── Auth form submit guard ────────────────────────────────────────────
// Prevents default form submission (required because Content-Security-Policy
// blocks inline onsubmit="return false;" handlers).
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('authForm')?.addEventListener('submit', e => e.preventDefault());
});
