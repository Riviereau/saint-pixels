// ═══════════════════════════════════════════════════════════════════
// Alpine.js component data is inlined directly in the <body x-data="...">
// attribute in index.html — no alpine:init registration needed.
// The canvas engine dispatches `sp-state-change` custom events;
// Alpine picks them up via @sp-state-change.window on <body>.
// ═══════════════════════════════════════════════════════════════════

// Helper: send reactive state updates to Alpine without touching the DOM
function dispatchStateChange(detail) {
  window.dispatchEvent(new CustomEvent('sp-state-change', { detail }));
}
document.addEventListener('DOMContentLoaded', () => {

// ═══════════════════════════════════════════════════════════════════
// ── BAN SCREEN ──────────────────────────────────────────────────────
// Displayed whenever the server returns { error: 'banned', ... }.
// Replaces the auth overlay with a full-page message so banned users
// cannot simply dismiss the dialog and keep using the app.
// ═══════════════════════════════════════════════════════════════════

/** Escape a string for safe insertion into HTML (prevents XSS via server-
 *  supplied ban reason strings). */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace the page content with a full-screen ban notice.
 * @param {{ reason?: string, message?: string, expiresAt?: number }} info
 */
function showBanScreen(info = {}) {
  // Build expiry line only when the server provides a timestamp
  let expiryLine = '';
  if (info.expiresAt) {
    const d = new Date(info.expiresAt);
    // Format as local date + time so the player knows exactly when it lifts
    expiryLine = `<p style="margin:.4em 0 0;font-size:.9em;opacity:.75;">
      Ban expires: ${escapeHtml(d.toLocaleString())}
    </p>`;
  }

  const reason  = escapeHtml(info.reason  || 'No reason provided.');
  const message = escapeHtml(info.message || 'You are banned from Saint Pixels.');

  // Overlay the entire viewport — pointer-events:all prevents interaction with
  // the canvas or any other element behind it.
  const screen = document.createElement('div');
  screen.id = 'ban-screen';
  screen.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'background:rgba(10,10,15,0.97)',
    'color:#fff', 'font-family:sans-serif',
    'text-align:center', 'padding:2rem',
    'pointer-events:all',
  ].join(';');

  screen.innerHTML = `
    <div style="font-size:3rem;margin-bottom:.5rem;">🔨</div>
    <h1 style="margin:0 0 .5rem;font-size:1.6rem;">${message}</h1>
    <p  style="margin:0;opacity:.8;max-width:480px;">${reason}</p>
    ${expiryLine}
    <p style="margin:1.5rem 0 0;font-size:.8em;opacity:.5;">
      If you believe this is a mistake, contact a moderator.
    </p>`;

  // Close the auth overlay (if open) and attach the ban screen
  document.body.classList.remove('auth-open');
  document.body.appendChild(screen);
}

/**
 * Inspect an API response object.  If it signals a ban, show the ban screen
 * and return true so the caller can bail out early.  Otherwise return false.
 *
 * @param {{ error?: string, reason?: string, message?: string, expiresAt?: number }} data
 * @param {Response} response  — the original fetch Response (used to check status)
 * @returns {boolean}  true when a ban screen was shown
 */
function handleApiBanResponse(data, response) {
  if (response.status === 403 && data?.error === 'banned') {
    showBanScreen(data);
    return true;
  }
  return false;
}

// ── end BAN SCREEN ────────────────────────────────────────────────────────────
// Prevents aside, chat panel, and other overflow containers from being
// accidentally scrolled with the mouse wheel.
document.addEventListener('wheel', (e) => {
  // Always allow wheel events on the canvas viewport (zoom / pan)
  if (e.target.closest('#viewport')) return;
  // Block wheel on any other scrollable container
  const scrollable = e.target.closest(
    'aside, #chat-messages, #pm-modal, [class*="overflow-y-auto"], [class*="overflow-y-scroll"]'
  );
  if (scrollable) {
    e.preventDefault();
    e.stopPropagation();
  }
}, { passive: false });

// ── Block arrow keys from scrolling any element except inputs/textareas ──
// Arrow keys are used for canvas cursor movement; they must not scroll
// sidebars, modals, or any other overflow container.
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End']);
document.addEventListener('keydown', (e) => {
  if (!ARROW_KEYS.has(e.key)) return;
  // Always allow in text inputs / textareas (cursor movement / selection)
  if (e.target.closest('input, textarea, select')) return;
  // Block the browser's default scroll behaviour everywhere else
  e.preventDefault();
}, { capture: true, passive: false });

// Prevent default form submission (replaces the removed onsubmit="return false;" attr,
// which was blocked by Content-Security-Policy script-src-attr 'none').
document.getElementById('authForm')?.addEventListener('submit', e => e.preventDefault());

const canvas = document.getElementById('canvas');
const overlay = document.getElementById('overlay');
const gridCanvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');
const overlayCtx = overlay.getContext('2d');
const gridCtx = gridCanvas.getContext('2d');
const viewport = document.getElementById('viewport');
const zoomInput = document.getElementById('zoom');
const toggleGridBtn = document.getElementById('toggle-grid');
const clearCanvasButton = document.getElementById('clear-canvas');
const exportButton = document.getElementById('export-png');
const paletteEl = document.getElementById('palette');
const colorInput = document.getElementById('color');
const toolButtons = document.querySelectorAll('[data-tool]');
const coordLabel = document.getElementById('coord');
const authOverlay = document.getElementById('authOverlay');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const authEmail = document.getElementById('authEmail');
const authEmailLabel = document.getElementById('authEmailLabel');
const authLoginButton = document.getElementById('authLogin');
const authRegisterButton = document.getElementById('authRegister');
const authMessage = document.getElementById('authMessage');
const addColorButton = document.getElementById('add-color');
const cooldownBar = document.getElementById('cooldownBar');
const cooldownFill = document.getElementById('cooldownFill');
const cooldownBarLabel = document.getElementById('cooldownBarLabel');

const CANVAS_WIDTH = 2000;
const CANVAS_HEIGHT = 2000;
// Visible board dimensions (grid and placement area)
const BOARD_WIDTH = 1920;
const BOARD_HEIGHT = 1080;

// ═══════════════════════════════════════════════════════════════════
// ── SFX ENGINE ──────────────────────────────────────────────────────
// Loads audio from /sfx/<name>.wav. Plays are rate-limited per sound
// (minInterval) so spamming pixels never floods the audio channel.
// All sounds are disabled while the tab is hidden (visibilitychange).
// ═══════════════════════════════════════════════════════════════════
const SFX = (() => {
  const cache   = {};
  const lastAt  = {};
  let   enabled = true;
  const SFX_VERSION = Date.now(); // cache-bust: forces browser to re-fetch on every page load

  // ── Master volume (persisted to localStorage) ──────────────────────
  const VOL_KEY = 'sp_sfx_volume';
  const _parsed = parseFloat(localStorage.getItem(VOL_KEY) ?? '1');
  let masterVolume = isNaN(_parsed) ? 1 : Math.max(0, Math.min(1, _parsed));

  function setVolume(v) {
    masterVolume = Math.max(0, Math.min(1, isNaN(v) ? 1 : v));
    localStorage.setItem(VOL_KEY, String(masterVolume));
  }

  function getVolume() {
    return masterVolume;
  }

  document.addEventListener('visibilitychange', () => {
    enabled = !document.hidden;
  });

  // ── iOS / Safari audio unlock ──────────────────────────────────────
  // iOS requires a user gesture before any Audio element can play.
  // On the first touchstart or click we silently play a blank audio
  // element to promote the browser's internal audio session from
  // "suspended" to "running".  Without this the very first SFX after
  // opening the page is silently dropped on iOS.
  let _iosUnlocked = false;
  function _unlockAudio() {
    if (_iosUnlocked) return;
    _iosUnlocked = true;
    try {
      // Minimal valid WAV: 44-byte header + 4 bytes of silence
      const silent = new Audio(
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAACABAAZGF0YQQAAAAAAA=='
      );
      silent.volume = 0;
      silent.play().catch(() => {});
    } catch { /* ignore */ }
  }
  document.addEventListener('touchstart', _unlockAudio, { once: true, passive: true });
  document.addEventListener('mousedown',  _unlockAudio, { once: true, passive: true });

  function load(name) {
    if (cache[name]) return cache[name];
    const a = new Audio(`/sfx/${name}.wav?v=${SFX_VERSION}`);
    a.preload = 'auto';
    cache[name] = a;
    return a;
  }

  // Pre-warm the sounds that will be needed immediately
  ['pixel-placed','pixel-placed2','pixel-placed3','pixel-erased','tool-changed','eyedropper',
   'hand','ruler','none','click','notification','achievement','ultra-achivement', 'error', 'equiping',
   'leaderboard-open','leaderboard-close','chat-open','chat-close',
   'star-picked','failling-star'].forEach(load);

  /**
   * Play a sound.
   * @param {string} name  — filename without extension (e.g. 'pixel-placed')
   * @param {number} minInterval — minimum ms between plays of this sound (default 80)
   * @param {number} volume — 0-1 relative volume, scaled by masterVolume (default 0.5)
   *
   * iOS note: we create a fresh Audio element each time instead of using
   * cloneNode(). Safari/iOS requires every HTMLAudioElement to be individually
   * "unlocked" via a user gesture. cloneNode() copies an element created at
   * load time (before any gesture) and inherits its locked state, so plays are
   * silently dropped on iOS. A fresh new Audio() whose .play() is called
   * inside a user-gesture call stack is treated as unlocked by iOS.
   */
  function play(name, minInterval = 80, volume = 0.5) {
    if (!enabled) return;
    if (masterVolume === 0) return; // hard mute — don't create Audio elements at all
    const now = Date.now();
    if (lastAt[name] && now - lastAt[name] < minInterval) return;
    lastAt[name] = now;
    try {
      const src = load(name).src; // reuse the resolved URL from cache
      const a = new Audio(src);
      a.volume = Math.max(0, Math.min(1, volume * masterVolume));
      a.play().catch(() => {}); // ignore NotAllowedError before first interaction
    } catch { /* ignore */ }
  }

  return { play, enabled: () => enabled, setVolume, getVolume };
})();
window.SFX = SFX; // expose globally so settings.js (and any other module) can call SFX.setVolume / getVolume at runtime

// ═══════════════════════════════════════════════════════════════════
// ── PARTICLE SYSTEM ─────────────────────────────────────────────────
// Spawns small colored squares that fly outward from the pixel that
// was just placed. Runs on a dedicated canvas layered above the overlay.
// ═══════════════════════════════════════════════════════════════════
const _particleCanvas = document.createElement('canvas');
_particleCanvas.id = 'particle-canvas';
_particleCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
const _pCtx = _particleCanvas.getContext('2d');
let   _particles = [];

function _ensureParticleCanvas() {
  const vp = document.getElementById('viewport');
  if (vp && !vp.contains(_particleCanvas)) {
    vp.style.position = 'relative';
    vp.appendChild(_particleCanvas);
    _resizeParticleCanvas();
  }
}

function _resizeParticleCanvas() {
  const vp = document.getElementById('viewport');
  if (!vp) return;
  const r = vp.getBoundingClientRect();
  _particleCanvas.width  = r.width  * (window.devicePixelRatio || 1);
  _particleCanvas.height = r.height * (window.devicePixelRatio || 1);
  _particleCanvas.style.width  = r.width  + 'px';
  _particleCanvas.style.height = r.height + 'px';
}
window.addEventListener('resize', _resizeParticleCanvas);

/**
 * Spawn a burst of particles at a board-pixel coordinate.
 * @param {number} bx  board x
 * @param {number} by  board y
 * @param {string} hexColor  e.g. '#ef4444'
 */
function spawnParticles(bx, by, hexColor) {
  _ensureParticleCanvas();
  const dpr = window.devicePixelRatio || 1;
  // Screen position of the board pixel's centre
  const cx = (bx + 0.5) * scale + offsetX;
  const cy = (by + 0.5) * scale + offsetY;
  const count = 16;
  for (let i = 0; i < count; i++) {
    const angle  = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
    const speed  = 1.5 + Math.random() * 2.5;
    _particles.push({
      x:  cx * dpr, y:  cy * dpr,
      vx: Math.cos(angle) * speed * dpr,
      vy: Math.sin(angle) * speed * dpr,
      size: (2 + Math.random() * 3) * dpr,
      alpha: 1,
      color: hexColor,
      decay: 0.035 + Math.random() * 0.025,
    });
  }
  _runParticleLoop();
}

let _particleRaf = null;
function _runParticleLoop() {
  if (_particleRaf) return;
  function tick() {
    _pCtx.clearRect(0, 0, _particleCanvas.width, _particleCanvas.height);
    _particles = _particles.filter(p => p.alpha > 0.02);
    _particles.forEach(p => {
      p.x     += p.vx;
      p.y     += p.vy;
      p.vy    += 0.12 * (window.devicePixelRatio || 1); // tiny gravity
      p.alpha -= p.decay;
      _pCtx.globalAlpha = Math.max(0, p.alpha);
      _pCtx.fillStyle   = p.color;
      _pCtx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    _pCtx.globalAlpha = 1;
    if (_particles.length > 0) {
      _particleRaf = requestAnimationFrame(tick);
    } else {
      _particleRaf = null;
    }
  }
  _particleRaf = requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════════
// ── ACHIEVEMENT ENGINE ──────────────────────────────────────────────
// Definitions + client-side unlock checks. The server also tracks
// achievements in the DB; the client is responsible for showing the
// popup immediately (no latency). Server is the authoritative record.
// ═══════════════════════════════════════════════════════════════════
const ACHIEVEMENT_DEFS = [
  { id: 'first_pixel',   label: 'First Pixel!',       desc: 'Place your very first pixel.',         icon: '🎨', ultra: false },
  { id: 'pixels_10',     label: 'Getting Started',    desc: 'Place 10 pixels.',                     icon: '✏️',  ultra: false },
  { id: 'pixels_100',    label: 'Dedicated Artist',   desc: 'Place 100 pixels.',                    icon: '🖌️',  ultra: false },
  { id: 'pixels_1000',   label: 'Pixel Veteran',      desc: 'Place 1,000 pixels.',                  icon: '⭐',  ultra: false },
  { id: 'pixels_10000',  label: 'Grand Master',       desc: 'Place 10,000 pixels.',                 icon: '👑',  ultra: true  },
  { id: 'streak_3',      label: '3-Day Streak',       desc: 'Paint 3 days in a row.',               icon: '🔥',  ultra: false },
  { id: 'streak_7',      label: 'Week Warrior',       desc: 'Paint 7 days in a row.',               icon: '🔥',  ultra: false },
  { id: 'streak_30',     label: 'Month of Madness',   desc: 'Paint 30 days in a row.',              icon: '🔥',  ultra: true  },
];
// Expose to settings.js (must come after the const declaration)
window.ACHIEVEMENT_DEFS = ACHIEVEMENT_DEFS;

const ACHIEVEMENT_LS_KEY = 'sp_achievements_unlocked';

function getUnlockedAchievements() {
  try { return new Set(JSON.parse(localStorage.getItem(ACHIEVEMENT_LS_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveUnlockedAchievement(id) {
  const set = getUnlockedAchievements();
  set.add(id);
  localStorage.setItem(ACHIEVEMENT_LS_KEY, JSON.stringify([...set]));
}

function checkAchievements({ totalPixels, currentStreak }) {
  const unlocked = getUnlockedAchievements();
  const toUnlock = [];

  const milestones = [
    { id: 'first_pixel',  threshold: 1    },
    { id: 'pixels_10',    threshold: 10   },
    { id: 'pixels_100',   threshold: 100  },
    { id: 'pixels_1000',  threshold: 1000 },
    { id: 'pixels_10000', threshold: 10000},
  ];
  milestones.forEach(m => {
    if (!unlocked.has(m.id) && totalPixels >= m.threshold) toUnlock.push(m.id);
  });

  const streakMilestones = [
    { id: 'streak_3',  threshold: 3  },
    { id: 'streak_7',  threshold: 7  },
    { id: 'streak_30', threshold: 30 },
  ];
  streakMilestones.forEach(m => {
    if (!unlocked.has(m.id) && currentStreak >= m.threshold) toUnlock.push(m.id);
  });

  toUnlock.forEach(id => {
    saveUnlockedAchievement(id);
    const def = ACHIEVEMENT_DEFS.find(d => d.id === id);
    if (def) showAchievementPopup(def);
  });
}

function showAchievementPopup(def) {
  const container = document.getElementById('achievement-container');
  if (!container) return;
  SFX.play(def.ultra ? 'ultra-achivement' : 'achievement', 1000, 0.7);

  const el = document.createElement('div');
  el.className = 'achievement-popup' + (def.ultra ? ' achievement-popup--ultra' : '');
  el.innerHTML = `
    <span class="achievement-icon">${def.icon}</span>
    <div class="achievement-text">
      <div class="achievement-label">${def.ultra ? '✨ ULTRA ACHIEVEMENT' : 'Achievement Unlocked'}</div>
      <div class="achievement-name">${def.label}</div>
      <div class="achievement-desc">${def.desc}</div>
    </div>`;
  container.appendChild(el);

  // Animate in, hold, then remove
  requestAnimationFrame(() => { el.classList.add('achievement-popup--visible'); });
  setTimeout(() => {
    el.classList.remove('achievement-popup--visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }, 4000);
}

// ═══════════════════════════════════════════════════════════════════
// ── ATTACK DETECTION ────────────────────────────────────────────────
// Counts how many of the current user's pixels have been overwritten
// in a sliding 10-second window. If > ATTACK_THRESHOLD, show a warning.
// ═══════════════════════════════════════════════════════════════════
const ATTACK_THRESHOLD = 15;
const ATTACK_WINDOW_MS = 10_000;
let _attackTimestamps = [];
let _attackCooldownUntil = 0;

function recordAttackPixel() {
  if (!currentUser) return;
  const now = Date.now();
  _attackTimestamps.push(now);
  // Prune old events outside window
  _attackTimestamps = _attackTimestamps.filter(t => now - t < ATTACK_WINDOW_MS);
  if (_attackTimestamps.length >= ATTACK_THRESHOLD && now > _attackCooldownUntil) {
    _attackCooldownUntil = now + 30_000; // suppress re-notification for 30s
    _attackTimestamps = [];
    showAttackWarning();
  }
}

function showAttackWarning() {
  const el = document.getElementById('attack-warning');
  if (!el) return;
  SFX.play('notification', 5000, 0.8);
  el.classList.add('attack-warning--visible');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('attack-warning--visible'), 6000);
}

// ═══════════════════════════════════════════════════════════════════
// ── COOLDOWN EVENT SYSTEM ───────────────────────────────────────────
// Polls /api/event on load and listens to SSE for live updates.
// Shows a countdown banner in the topbar. Adjusts client COOLDOWN_MS.
// ═══════════════════════════════════════════════════════════════════
/** Normal per-pixel cooldown in ms — must match cooldown.js on the server. */
const COOLDOWN_MS = 3000;
let _activeCooldownMs = COOLDOWN_MS; // starts at default; overridden by event

function updateEventBanner(active, endsAt, cooldownMs) {
  const banner = document.getElementById('event-banner');
  const countdown = document.getElementById('event-countdown');
  if (!banner) return;
  if (active && endsAt) {
    _activeCooldownMs = cooldownMs || 1500;
    banner.style.display = '';
    // Tick countdown every second
    clearInterval(banner._tickInterval);
    banner._tickInterval = setInterval(() => {
      const rem = endsAt - Date.now();
      if (rem <= 0) {
        banner.style.display = 'none';
        _activeCooldownMs = COOLDOWN_MS;
        clearInterval(banner._tickInterval);
        return;
      }
      const m = Math.floor(rem / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      if (countdown) countdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);
  } else if (endsAt && !active) {
    // Event is upcoming — show "in X hours" teaser
    const rem = endsAt - Date.now();
    if (rem > 0 && countdown) {
      const h = Math.floor(rem / 3600000);
      const m = Math.floor((rem % 3600000) / 60000);
      banner.style.display = '';
      banner.classList.add('event-banner--upcoming');
      if (countdown) countdown.textContent = `in ${h}h ${m}m`;
    }
  } else {
    banner.style.display = 'none';
    _activeCooldownMs = COOLDOWN_MS;
  }
}

async function fetchEventStatus() {
  try {
    const res = await fetch('/api/event');
    if (!res.ok) return;
    const data = await res.json();
    updateEventBanner(data.active, data.endsAt, data.cooldownMs);
    // Schedule next upcoming check using next event if server provides it
    if (!data.active && data.nextEventAt) {
      const delay = Math.max(0, data.nextEventAt - Date.now());
      setTimeout(fetchEventStatus, Math.min(delay, 60_000));
    }
  } catch { /* non-fatal */ }
}

// ── Streak state (loaded once after login) ────────────────────────────────────
let _currentStreak  = 0;
let _longestStreak  = 0;
let _totalPixelCount = 0; // approximate running count for achievement checks

async function fetchStreakAndStats() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/streak', {
      headers: { 'Authorization': `Bearer ${getStoredToken()}` }
    });
    if (!res.ok) return;
    const d = await res.json();
    _currentStreak  = d.currentStreak  || 0;
    _longestStreak  = d.longestStreak  || 0;
    updateStreakBadge();
  } catch { /* non-fatal */ }
}

function updateStreakBadge() {
  const badge = document.getElementById('streak-badge');
  if (!badge) return;
  if (_currentStreak >= 2) {
    badge.textContent = `🔥 ${_currentStreak}`;
    badge.title = `${_currentStreak}-day streak! Longest: ${_longestStreak}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}
const DEFAULT_PALETTE = [
  { id: 0, label: 'Black', color: '#000000' },
  { id: 1, label: 'White', color: '#ffffff' },
  { id: 2, label: 'Red', color: '#ef4444' },
  { id: 3, label: 'Orange', color: '#fb923c' },
  { id: 4, label: 'Yellow', color: '#facc15' },
  { id: 5, label: 'Green', color: '#22c55e' },
  { id: 6, label: 'Cyan', color: '#06b6d4' },
  { id: 7, label: 'Blue', color: '#3b82f6' },
  { id: 8, label: 'Indigo', color: '#6366f1' },
  { id: 9, label: 'Violet', color: '#8b5cf6' },
  { id: 10, label: 'Pink', color: '#ec4899' },
  { id: 11, label: 'Light Brown', color: '#a0785a' },
  { id: 12, label: 'Beige', color: '#f5deb3' },
  { id: 13, label: 'Gray', color: '#888888' },
  { id: 14, label: 'Dark Amber', color: '#925c01' },
  { id: 15, label: 'Dark Sienna', color: '#6d2300' },
  { id: 16, label: 'Sandy Orange', color: '#df8f5c' },
  { id: 17, label: 'Burnt Sienna', color: '#d38252' }
];
const paletteColors = [];
const CUSTOM_PALETTE_KEY = 'sp_customPalette';
const TOKEN_KEY = 'sp_token';
const EVENT_KEY = 'sp_last_event';
const PIXEL_HISTORY_KEY = 'sp_pixel_history';
// Declared here (top of DOMContentLoaded) so clearToken(), updateAuthState(),
// and checkVerifiedParam() can all reference it without a TDZ ReferenceError.
const EMAIL_VERIFIED_KEY = 'sp_email_verified';
// NOTE: COOLDOWN_MS is declared earlier, near the Cooldown Event System block.
/** Max zoom as UI scale (1 = 100%, 50 = 5000%) */
const MAX_ZOOM_SCALE = 50;
/** Min zoom as UI scale (1 = 100%, 50 = 5000%) */
const MIN_ZOOM_SCALE = 0.5;
/** Slow OS key-repeat for arrow nudging (ms between steps while key is held) */
const ARROW_KEY_REPEAT_MS = 110;
/** Ignore small mouse jitter after arrow moves until pointer moves this far (px). */
const MOUSE_CURSOR_ARMOR_PX = 36;
/** Grid corner dots — screen pixels per dot (was 1×1). */
const GRID_DOT_SCREEN_PX = 3;

// ── SSE real-time sync ──────────────────────────────────────────────────────
// Connects to /api/stream and applies pixels placed by other users instantly.
let _sseSource = null;

// Tracks cells the current user painted optimistically in the last 5 seconds.
// Used to skip stale init-bundle entries on SSE reconnect so we never
// overwrite a freshly-placed local pixel with an older server snapshot.
// Key: "x,y" string.  Value: timestamp of the local paint.
const _recentLocalCells = new Map();
const RECENT_LOCAL_TTL_MS = 5000;
function _markLocalCell(x, y) {
  const key = `${x},${y}`;
  _recentLocalCells.set(key, Date.now());
  // Lazy prune: remove entries older than the TTL whenever we add a new one
  const cutoff = Date.now() - RECENT_LOCAL_TTL_MS;
  for (const [k, t] of _recentLocalCells) {
    if (t < cutoff) _recentLocalCells.delete(k);
  }
}

// Batch rapid incoming remote pixels into a single rAF redraw.
// When many players are painting simultaneously the SSE stream can deliver
// dozens of pixel events per frame; calling redraw() for each one wastes CPU.
let _remoteRedrawPending = false;
function scheduleRemoteRedraw() {
  if (_remoteRedrawPending) return;
  _remoteRedrawPending = true;
  requestAnimationFrame(() => {
    _remoteRedrawPending = false;
    redraw();
  });
}

// ── Chunked init-pixel painting ─────────────────────────────────────────────
// The SSE init bundle can contain up to 500 000 pixels. Painting them all
// synchronously in one forEach freezes the main thread for several seconds.
// Instead we split the array into chunks and paint one chunk per animation
// frame, keeping the UI responsive throughout.
const SSE_INIT_CHUNK_SIZE = 5000; // pixels per frame — ~1–2 ms per chunk

function paintInitPixelsChunked(pixels) {
  let i = 0;
  function paintChunk() {
    const end = Math.min(i + SSE_INIT_CHUNK_SIZE, pixels.length);
    for (; i < end; i++) {
      const p = pixels[i];
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      if (_recentLocalCells.has(`${p.x},${p.y}`)) continue;
      if (p.color === 'erase') {
        paintPixel(p.x, p.y, 1, 'eraser', null);
      } else if (typeof p.color === 'string') {
        paintPixel(p.x, p.y, 1, 'brush', p.color.startsWith('#') ? p.color : '#' + p.color);
      }
    }
    // We are already inside a rAF callback — call the render body directly
    // instead of scheduling another rAF via redraw(), which would double-wrap
    // and cause stutter during the init phase.
    _doRender();
    if (i < pixels.length) {
      requestAnimationFrame(paintChunk);
    }
  }
  requestAnimationFrame(paintChunk);
}

// Exponential backoff for SSE reconnects: starts at 2 s, doubles each attempt,
// caps at 30 s. Reset to base on a successful connection.
let _sseRetryDelay = 2000;
const SSE_RETRY_BASE  = 2000;
const SSE_RETRY_MAX   = 30000;

function connectSSE() {
  if (_sseSource) { _sseSource.close(); }
  // Do NOT include the auth token in the URL — query-string tokens are recorded
  // in server access logs and browser history. The SSE endpoint is public-read;
  // authentication is handled separately via /api/me.
  _sseSource = new EventSource('/api/stream');

  _sseSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'init') {
        // Server sent the full canvas history — paint all pixels on connect.
        // Skip cells where the current user has a recent optimistic paint
        // (within 5 s) so a reconnect doesn't overwrite locally-placed pixels
        // with stale server state from just before our last placement.
        if (Array.isArray(event.pixels)) {
          // Reset backoff — we have a working connection
          _sseRetryDelay = SSE_RETRY_BASE;
          // Paint in chunks across animation frames to avoid freezing the UI
          paintInitPixelsChunked(event.pixels);
        }
      } else if (event.type === 'pixel') {
        if (event.user !== currentUser) {
          applyRemotePixel(event);
          scheduleRemoteRedraw();
          // Attack detection: check if this pixel overwrites one of ours
          if (currentUser && event.user !== currentUser) {
            const existing = bufferCtx.getImageData(event.x, event.y, 1, 1).data;
            // A non-transparent pixel was there — assume it was ours if we're tracking
            if (existing[3] > 0) recordAttackPixel();
          }
        }
        // Notify leaderboard of any pixel placed (own or other players)
        window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
      } else if (event.type === 'erase') {
        if (event.user !== currentUser) {
          paintPixel(event.x, event.y, 1, 'eraser', null);
          scheduleRemoteRedraw();
        }
      } else if (event.type === 'clients') {
        // Update live player count from server SSE (authoritative count)
        dispatchStateChange({ liveCount: event.count });
        // A 'clients' message means the connection is alive — reset backoff
        _sseRetryDelay = SSE_RETRY_BASE;
      } else if (event.type === 'event') {
        // Cooldown event started/updated from server broadcast
        updateEventBanner(event.active, event.endsAt, event.cooldownMs);
      } else if (event.type === 'chat') {
        // Forward chat messages to the chat panel (chat.js)
        if (typeof window.__chatIncoming === 'function') window.__chatIncoming(event);
      }
    } catch { /* ignore malformed events */ }
  };

  _sseSource.onerror = () => {
    // Guard: only schedule a reconnect if this source is still the active one.
    // Without this check, a stale onerror handler from a previous source fires
    // after connectSSE() has already replaced _sseSource, scheduling a second
    // redundant reconnect that opens a duplicate connection.
    const thisSource = _sseSource;
    if (thisSource) thisSource.close();
    _sseSource = null;
    // Exponential backoff: 2 s → 4 s → 8 s … capped at 30 s.
    // Prevents a reconnect storm when the server is temporarily unavailable.
    const delay = _sseRetryDelay;
    _sseRetryDelay = Math.min(_sseRetryDelay * 2, SSE_RETRY_MAX);
    setTimeout(() => {
      if (!_sseSource) connectSSE();
    }, delay);
  };
}

const bufferCanvas = document.createElement('canvas');
bufferCanvas.width = CANVAS_WIDTH;
bufferCanvas.height = CANVAS_HEIGHT;
const bufferCtx = bufferCanvas.getContext('2d');

let scale = 1;
let offsetX = 0;
let offsetY = 0;
// Track the last values used to draw the grid so we only redraw it when
// the viewport actually changes (prevents the flash on every cursor move).
let lastGridScale = null;
let lastGridOffsetX = null;
let lastGridOffsetY = null;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let dragStart = null;
/** Long-press-to-pan: timer ID and anchor coords for the pending long press */
let _longPressPanTimer = null;
let _longPressAnchorX = 0;
let _longPressAnchorY = 0;
/** px of movement allowed before the long-press is cancelled */
const LONG_PRESS_MOVE_THRESHOLD = 6;
/** ms to hold before panning starts */
const LONG_PRESS_PAN_DELAY_MS = 400;
let gridEnabled = true;
let tool = 'brush';
/** Set to true when the eyedropper fires on mobile so the same touchend that
 * triggered the pick doesn't also place a pixel after switching to brush. */
let _eyedropperJustFired = false;
let color = '#000000';
let pixelSize = 1;
let isMouseDown = false;
let cursorPosition = { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
let currentUser = null;
let lastPlaceAt = 0;
let customPalette = [];
let lastArrowKeyMoveAt = 0;
let lastPointerClientX = 0;
let lastPointerClientY = 0;
/** After arrow keys, tiny mouse moves won't snap the board cursor until you move farther. */
let keyboardCursorArmored = false;
let mouseArmorAnchorX = 0;
let mouseArmorAnchorY = 0;
/** Index of the palette slot most recently activated by the user — eyedropper prefers this slot on ties. */
let lastUsedPaletteIdx = -1;

function safeParse(value, fallback) {
  try {
    return JSON.parse(value) || fallback;
  } catch (error) {
    return fallback;
  }
}

function getCustomPalette() {
  const raw = safeParse(localStorage.getItem(CUSTOM_PALETTE_KEY), []);
  if (!Array.isArray(raw)) return [];
  return raw.map(entry =>
    normalizeHexColor(typeof entry === 'string' ? entry : String(entry?.color ?? ''))
  );
}

function saveCustomPalette(list) {
  localStorage.setItem(CUSTOM_PALETTE_KEY, JSON.stringify(list));
}

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_VERIFIED_KEY);
}

function normalizeHexColor(value) {
  if (!value && value !== '') return '#000000';
  let hex = String(value).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    hex = hex.split('').map(ch => ch + ch).join('');
  }
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : '#000000';
}

function asPaletteEntry(entry) {
  if (typeof entry === 'string') {
    return { id: null, label: normalizeHexColor(entry), color: normalizeHexColor(entry) };
  }
  return {
    id: entry.id != null ? entry.id : null,
    label: entry.label || normalizeHexColor(entry.color),
    color: normalizeHexColor(entry.color)
  };
}

async function loadServerPalette() {
  try {
    const response = await fetch('/api/palette');
    if (!response.ok) {
      throw new Error('Palette API failed');
    }
    const data = await response.json();
    if (Array.isArray(data.colors)) {
      paletteColors.length = 0;
      data.colors.forEach(item => paletteColors.push(asPaletteEntry(item)));
      // Ensure the standard rainbow colors are present in the loaded palette
      ensureRainbowInPalette(paletteColors);
      return;
    }
  } catch (error) {
    console.warn('Unable to load palette from API, using defaults.', error);
  }
  paletteColors.length = 0;
  DEFAULT_PALETTE.forEach(item => paletteColors.push(asPaletteEntry(item)));
  // Ensure the defaults include rainbow colors (safety)
  ensureRainbowInPalette(paletteColors);
}

/**
 * Ensure the palette contains the seven rainbow colors (red, orange, yellow,
 * green, blue, indigo, violet). If any are missing, append them from
 * DEFAULT_PALETTE so the user always has the full rainbow available.
 * Also ensures any other DEFAULT_PALETTE entries (e.g. Light Brown, Beige)
 * that the server palette omits are appended.
 */
function ensureRainbowInPalette(list) {
  if (!Array.isArray(list)) return;
  const present = new Set(list.map(e => normalizeHexColor(e.color)));
  // Add every DEFAULT_PALETTE entry that's missing from the loaded palette
  DEFAULT_PALETTE.forEach(entry => {
    const norm = normalizeHexColor(entry.color);
    if (!present.has(norm)) {
      list.push(asPaletteEntry(entry));
      present.add(norm);
    }
  });
}

async function updateAuthState(retryCount = 0) {
  const token = getStoredToken();
  if (!token) {
    currentUser = null;
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 s hard timeout
    let response;
    try {
      response = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // 401/403 = token genuinely invalid — clear it and show login
      if (response.status === 401 || response.status === 403) {
        clearToken();
        currentUser = null;
        dispatchStateChange({ currentUser: null, emailVerified: false });
        document.body.classList.add('auth-open');
        authUsername.focus();
        return;
      }
      // 5xx or other transient server error — retry once after 2 s
      if (retryCount < 1) {
        setTimeout(() => updateAuthState(retryCount + 1), 2000);
        return;
      }
      // Retry exhausted — show login overlay
      clearToken();
      currentUser = null;
      dispatchStateChange({ currentUser: null, emailVerified: false });
      document.body.classList.add('auth-open');
      authUsername.focus();
      return;
    }

    const data = await response.json();
    currentUser = data.username;
    
    // Sync local cooldown timer with server remaining time.
    // Use _activeCooldownMs (live value, synced from the server via
    // fetchEventStatus / SSE) so canPlacePixel() and the bar both agree,
    // even when a speed-up event is active.
    if (data.cooldown && data.cooldown > 0) {
      lastPlaceAt = Date.now() - (_activeCooldownMs - data.cooldown);
    } else {
      lastPlaceAt = 0; // Ready to place
    }

    // If the server says unverified but the user just clicked the link this session,
    // trust localStorage — the DB may lag slightly behind the redirect.
    const locallyVerified = localStorage.getItem(EMAIL_VERIFIED_KEY) === '1';
    const emailVerified = !!data.emailVerified || locallyVerified;
    if (data.emailVerified) {
      // DB confirms verified — keep the flag in sync
      localStorage.setItem(EMAIL_VERIFIED_KEY, '1');
    }
    // Expose auth state for chat.js
    window.__username  = data.username;
    window.__authToken = token;
    dispatchStateChange({ currentUser: data.username, emailVerified });
    document.body.classList.remove('auth-open');
    authMessage.textContent = '';
    updateCooldownLabel();
  } catch (error) {
    // Network failure (offline, DNS, AbortError from timeout) — retry once
    if (retryCount < 1) {
      setTimeout(() => updateAuthState(retryCount + 1), 2000);
      return;
    }
    // Retry exhausted — clear state and show login
    currentUser = null;
    window.__username  = null;
    window.__authToken = null;
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
  }
}

function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function setCurrentUser(username, emailVerified = false, cooldown = 0) {
  currentUser = username;
  
  // Sync local cooldown timer with server remaining time.
  // Use _activeCooldownMs (live value, synced from the server via
  // fetchEventStatus / SSE) so canPlacePixel() and the bar both agree,
  // even when a speed-up event is active.
  if (cooldown && cooldown > 0) {
    lastPlaceAt = Date.now() - (_activeCooldownMs - cooldown);
  } else {
    lastPlaceAt = 0; // Ready to place
  }

  // Expose auth state for chat.js
  window.__username  = username;
  window.__authToken = getStoredToken();
  dispatchStateChange({ currentUser: username, emailVerified: !!emailVerified });
  document.body.classList.remove('auth-open');
  showAuthMessage('');
  updateCooldownLabel();
  // Load streak + pixel count for achievements
  fetchStreakAndStats().then(() => {
    // Load total pixel count from profile for achievement seeding
    fetch(`/api/profile/${encodeURIComponent(username)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          _totalPixelCount = d.totalPixels || 0;
          _currentStreak   = d.currentStreak || 0;
          _longestStreak   = d.longestStreak || 0;
          updateStreakBadge();
        }
      }).catch(() => {});
  });
}

async function handleLogout() {
  const token = getStoredToken();
  if (token) {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    } catch (e) {
      // ignore network errors
    }
  }
  clearToken();
  currentUser = null;
  // Clear auth globals used by chat.js
  window.__username  = null;
  window.__authToken = null;
  
  // Reset placement cooldown on logout
  lastPlaceAt = 0; 
  
  dispatchStateChange({ currentUser: null });
  showAuthMessage('Logged out', false);
  updateCooldownLabel();
}

/**
 * Handles user login by validating form input, verifying the captcha,
 * sending credentials to the login API, and updating the current user 
 * state when auth is successful.
 */
async function handleLogin(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) {
    showAuthMessage('Enter username and password.');
    return;
  }

  const captchaToken = getCaptchaToken();
  if (!captchaToken && !isLocalDev()) {
    showAuthMessage('Please complete the captcha.');
    return;
  }

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, captchaToken })
    });

    const data = await response.json();
    if (!response.ok) {
      resetCaptcha();
      showAuthMessage(data.error || 'Login failed.');
      return;
    }

    resetCaptcha();
    saveToken(data.token);
    // Pass the cooldown data to setCurrentUser
    setCurrentUser(data.username, data.emailVerified, data.cooldown);
  } catch (error) {
    resetCaptcha();
    showAuthMessage('Unable to reach server.');
  }
}

async function handleRegister(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  const email = authEmail ? authEmail.value.trim() : '';

  if (!username || !password) {
    showAuthMessage('Enter username and password.');
    return;
  }
  if (!email) {
    showAuthMessage('Enter your email address.');
    return;
  }

  const authRulesCheck = document.getElementById('authRulesCheck');
  if (!authRulesCheck || !authRulesCheck.checked) {
    showAuthMessage('Please read and agree to the community rules.');
    return;
  }

  const captchaToken = getCaptchaToken();
  if (!captchaToken && !isLocalDev()) {
    showAuthMessage('Please complete the captcha.');
    return;
  }

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email, captchaToken })
    });

    const data = await response.json();
    if (!response.ok) {
      resetCaptcha();
      showAuthMessage(data.error || 'Registration failed.');
      return;
    }

    resetCaptcha();
    // Save token and immediately update UI — no need for a separate updateAuthState() round-trip
    // because the register response already contains username, emailVerified, and cooldown.
    saveToken(data.token);
    // Expose auth token for chat.js before setCurrentUser dispatches state
    window.__authToken = data.token;
    setCurrentUser(data.username, data.emailVerified, data.cooldown);
    // Show the verification message (e.g. "Check your email") after the overlay closes
    if (data.message) setTimeout(() => showAuthMessage(data.message, false), 100);
  } catch (error) {
    resetCaptcha();
    showAuthMessage('Unable to reach server.');
  }
}

let _cooldownRafId = null;
function updateCooldownLabel() {
  if (!cooldownBar || !cooldownFill || !cooldownBarLabel) return;
  if (!currentUser) {
    cooldownBar.classList.add('cooldown-bar--guest');
    cooldownBar.classList.remove('cooldown-bar--cooling');
    cooldownFill.style.width = '100%';
    cooldownBarLabel.textContent = 'Sign in to place pixels';
    if (_cooldownRafId) { cancelAnimationFrame(_cooldownRafId); _cooldownRafId = null; }
    return;
  }
  cooldownBar.classList.remove('cooldown-bar--guest');
  const remaining = Math.max(0, _activeCooldownMs - (Date.now() - lastPlaceAt));
  const recharged = 1 - remaining / _activeCooldownMs;
  cooldownFill.style.width = `${Math.max(0, Math.min(100, recharged * 100))}%`;
  if (remaining > 0) {
    cooldownBar.classList.add('cooldown-bar--cooling');
    cooldownBarLabel.textContent = `Cooldown · ${Math.ceil(remaining / 1000)}s`;
    // Drive smooth updates via rAF while cooling
    if (!_cooldownRafId) {
      const tick = () => {
        const rem = Math.max(0, _activeCooldownMs - (Date.now() - lastPlaceAt));
        const pct = (1 - rem / _activeCooldownMs) * 100;
        cooldownFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        if (rem > 0) {
          cooldownBarLabel.textContent = `Cooldown · ${Math.ceil(rem / 1000)}s`;
          _cooldownRafId = requestAnimationFrame(tick);
        } else {
          cooldownFill.style.width = '100%';
          cooldownBar.classList.remove('cooldown-bar--cooling');
          cooldownBarLabel.textContent = 'Ready to place';
          _cooldownRafId = null;
        }
      };
      _cooldownRafId = requestAnimationFrame(tick);
    }
  } else {
    cooldownBar.classList.remove('cooldown-bar--cooling');
    cooldownBarLabel.textContent = 'Ready to place';
    if (_cooldownRafId) { cancelAnimationFrame(_cooldownRafId); _cooldownRafId = null; }
  }
}

function canPlacePixel() {
  // Require the full cooldown PLUS a tiny safety margin (20 ms) before
  // allowing the next placement.  This ensures the HTTP request always
  // reaches the server well after the cooldown window, not at the exact
  // millisecond boundary where clock skew could still cause a 429.
  return !!currentUser && Date.now() - lastPlaceAt >= _activeCooldownMs + 20;
}

// ─── Grid: corner dots drawn in viewport space ───────────────────────────────
// One dot at every board-pixel corner visible on screen. Canvas is always
// viewport-sized; offsetX/Y baked in directly — no CSS translate tricks.
// ─────────────────────────────────────────────────────────────────────────────
function drawGrid() {
  const dpr = window.devicePixelRatio || 1;

  // Do NOT resize gridCanvas here — resizeViewport() already keeps it in sync
  // with canvas.  Resizing on every drawGrid call is extremely expensive
  // (allocates + clears a new backing store each time) and was the primary
  // source of lag during zoom and pan.

  gridCtx.setTransform(1, 0, 0, 1, 0, 0);
  gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);

  if (!gridEnabled || scale < 4) return;

  const vpW = canvas.width  / dpr;
  const vpH = canvas.height / dpr;

  gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const boardScreenR = offsetX + Math.round(BOARD_WIDTH  * scale);
  const boardScreenB = offsetY + Math.round(BOARD_HEIGHT * scale);

  const clipL = Math.max(0, offsetX);
  const clipT = Math.max(0, offsetY);
  const clipR = Math.min(vpW, boardScreenR);
  const clipB = Math.min(vpH, boardScreenB);
  if (clipR <= clipL || clipB <= clipT) return;

  const startCol = Math.max(0, Math.floor((clipL - offsetX) / scale));
  const startRow = Math.max(0, Math.floor((clipT - offsetY) / scale));
  const endCol   = Math.min(BOARD_WIDTH,  Math.ceil((clipR - offsetX) / scale));
  const endRow   = Math.min(BOARD_HEIGHT, Math.ceil((clipB - offsetY) / scale));

  // Collect unique x positions (duplicate-pixel guard for awkward zoom levels)
  const xs = [];
  let lastX = -Infinity;
  for (let col = startCol; col <= endCol; col++) {
    const x = Math.floor(col * scale + offsetX);
    if (x === lastX || x < clipL || x > clipR) continue;
    lastX = x;
    xs.push(x);
  }

  const ys = [];
  let lastY = -Infinity;
  for (let row = startRow; row <= endRow; row++) {
    const y = Math.floor(row * scale + offsetY);
    if (y === lastY || y < clipT || y > clipB) continue;
    lastY = y;
    ys.push(y);
  }

  // Cross markers at every corner: each arm extends 25% into the adjacent cell.
  const armBase = Math.min(scale * 0.25, 6);
  const thick = Math.min(Math.max(scale * 0.15, 1), 2);

  // White glow first
  gridCtx.fillStyle = 'rgba(255,255,255,0.12)';
  for (const y of ys) {
    for (const x of xs) {
      // Clamp arms so they never go outside the board
      const left  = Math.min(armBase, x - offsetX);
      const right = Math.min(armBase, boardScreenR - x);
      const up    = Math.min(armBase, y - offsetY);
      const down  = Math.min(armBase, boardScreenB - y);

      // Horizontal bar
      gridCtx.fillRect(x - left, y - thick/2, left + right, thick);
      // Vertical bar
      gridCtx.fillRect(x - thick/2, y - up, thick, up + down);
    }
  }

  // Dark core on top
  gridCtx.fillStyle = 'rgba(0,0,0,0.18)';
  for (const y of ys) {
    for (const x of xs) {
      const left  = Math.min(armBase, x - offsetX);
      const right = Math.min(armBase, boardScreenR - x);
      const up    = Math.min(armBase, y - offsetY);
      const down  = Math.min(armBase, boardScreenB - y);

      gridCtx.fillRect(x - left, y - thick/2, left + right, thick);
      gridCtx.fillRect(x - thick/2, y - up, thick, up + down);
    }
  }

  // Board border
  gridCtx.strokeStyle = 'rgba(0,0,0,0.6)';
  gridCtx.lineWidth = 1;
  gridCtx.strokeRect(
    offsetX + 0.5, offsetY + 0.5,
    Math.round(BOARD_WIDTH * scale),
    Math.round(BOARD_HEIGHT * scale)
  );
}

function drawGridIfDirty() {
  const scaleChanged  = scale   !== lastGridScale;
  const offsetChanged = offsetX !== lastGridOffsetX || offsetY !== lastGridOffsetY;
  if (!scaleChanged && !offsetChanged) return;
  lastGridScale   = scale;
  lastGridOffsetX = offsetX;
  lastGridOffsetY = offsetY;
  drawGrid();
}

function toggleGrid() {
  gridEnabled = !gridEnabled;
  toggleGridBtn.classList.toggle('active', gridEnabled);
  // Force a full grid redraw since gridEnabled changed
  lastGridScale = null;
  redraw();
}

let isRedrawPending = false;

/** The actual render work — called from inside a rAF callback. */
function _doRender() {
  clampOffsets();
  
  const dpr = window.devicePixelRatio || 1;
  
  // offsetX/Y are always whole numbers (rounded at every write site),
  // so no rounding is needed here — just use them directly.
  const ox = offsetX;
  const oy = offsetY;
  
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Keep pixels crisp at any zoom level
  ctx.imageSmoothingEnabled = false;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  
  const boardW = Math.round(BOARD_WIDTH * scale);
  const boardH = Math.round(BOARD_HEIGHT * scale);
  
  // Draw the white board background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, boardW, boardH);

  // ── Occlusion culling ──────────────────────────────────────────────
  // Compute the visible board region in board-pixel coordinates so we
  // only blit the portion of the buffer that's actually on screen.
  const vpW_css = canvas.width / dpr;
  const vpH_css = canvas.height / dpr;

  // Board rect in viewport-CSS pixels
  const bLeft   = ox;
  const bTop    = oy;
  const bRight  = ox + boardW;
  const bBottom = oy + boardH;

  // Visible intersection (viewport is 0,0 → vpW,vpH)
  const visL = Math.max(0, bLeft);
  const visT = Math.max(0, bTop);
  const visR = Math.min(vpW_css, bRight);
  const visB = Math.min(vpH_css, bBottom);

  if (visR > visL && visB > visT) {
    // Map the visible screen rect back to source board-pixel coords
    const srcX = (visL - ox) / scale;
    const srcY = (visT - oy) / scale;
    const srcW = (visR - visL) / scale;
    const srcH = (visB - visT) / scale;

    // Draw only the visible slice — skip off-screen pixels entirely
    ctx.drawImage(
      bufferCanvas,
      srcX, srcY, srcW, srcH,
      visL, visT, visR - visL, visB - visT
    );
  }

  // Redraw grid only when scale/offset changed — grid lives on its own canvas
  drawGridIfDirty();

  // Overlay is cursor-only; clear and redraw just the cursor highlight
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  drawCursor();
  rulerDrawOverlay();
}

function redraw() {
  if (isRedrawPending) return;
  isRedrawPending = true;

  requestAnimationFrame(() => {
    isRedrawPending = false;
    _doRender();
  });
}

function getCanvasCoords(clientX, clientY) {
  // Use viewport rect — canvas pixel dimensions are sized from viewport, not from canvas CSS size.
  // offsetX/Y are always whole numbers (rounded at every write site), so
  // tap-to-place always lands on the same cell the cursor highlight is drawn on.
  const rect = viewport.getBoundingClientRect();

  // When the user pinch-zooms the *browser* (not the in-app zoom), the Visual
  // Viewport API reports a scale != 1.  touch.clientX/clientY are given in
  // *layout* CSS pixels (unscaled), but getBoundingClientRect() also returns
  // layout pixels, so they cancel correctly.  However offsetX/offsetY are
  // maintained in *visual* CSS pixels (the coordinate space the canvas is
  // drawn in), so we must divide by the visual viewport scale to convert
  // them back to layout pixels before subtracting.
  //
  // On browsers that don't support visualViewport the scale is 1 and this
  // reduces to the original formula.
  const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;

  const ox = offsetX / vvScale;
  const oy = offsetY / vvScale;
  const s  = scale   / vvScale;

  const x = (clientX - rect.left - ox) / s;
  const y = (clientY - rect.top  - oy) / s;
  return {
    x: clamp(Math.floor(x), 0, BOARD_WIDTH - 1),
    y: clamp(Math.floor(y), 0, BOARD_HEIGHT - 1)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampOffsets() {
  const dpr = window.devicePixelRatio || 1;
  // Use CSS pixel dimensions so all comparisons are in the same unit as scale, offsetX, offsetY.
  const vpW = canvas.width / dpr;
  const vpH = canvas.height / dpr;
  const scaledWidth = BOARD_WIDTH * scale;
  const scaledHeight = BOARD_HEIGHT * scale;

  // Allow panning up to 30% of the viewport outside the canvas edges
  // so users can see the dark-blue area around the canvas.
  const padX = Math.round(vpW * 0.30);
  const padY = Math.round(vpH * 0.30);

  if (vpW >= scaledWidth) {
    // Canvas fits: center it, but still allow a little wiggle
    const centered = Math.round((vpW - scaledWidth) / 2);
    offsetX = clamp(offsetX, centered - padX, centered + padX);
  } else {
    offsetX = clamp(offsetX, vpW - scaledWidth - padX, padX);
  }

  if (vpH >= scaledHeight) {
    const centered = Math.round((vpH - scaledHeight) / 2);
    offsetY = clamp(offsetY, centered - padY, centered + padY);
  } else {
    offsetY = clamp(offsetY, vpH - scaledHeight - padY, padY);
  }
}

function paintPixel(x, y, customSize = pixelSize, customTool = tool, customColor = color) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  bufferCtx.save();
  if (customTool === 'eraser') {
    bufferCtx.globalCompositeOperation = 'destination-out';
    // destination-out uses the source alpha; fully transparent fill erases nothing.
    bufferCtx.fillStyle = 'rgba(0, 0, 0, 1)';
  } else {
    bufferCtx.globalCompositeOperation = 'source-over';
    bufferCtx.fillStyle = customColor;
  }
  bufferCtx.fillRect(x, y, customSize, customSize);
  bufferCtx.restore();
}

function fillArea(x, y) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  const imageData = bufferCtx.getImageData(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  const targetIndex = (y * BOARD_WIDTH + x) * 4;
  const targetColor = imageData.data.slice(targetIndex, targetIndex + 4);
  const replacement = hexToRgba(color);
  if (colorsMatch(targetColor, replacement)) return;

  const queue = [{ x, y }];
  const visited = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT);

  while (queue.length) {
    const { x: cx, y: cy } = queue.pop();
    const index = cy * BOARD_WIDTH + cx;
    if (cx < 0 || cy < 0 || cx >= BOARD_WIDTH || cy >= BOARD_HEIGHT) continue;
    if (visited[index]) continue;
    visited[index] = 1;

    const pixelIndex = index * 4;
    if (!colorsMatch(imageData.data.slice(pixelIndex, pixelIndex + 4), targetColor)) continue;

    imageData.data[pixelIndex] = replacement[0];
    imageData.data[pixelIndex + 1] = replacement[1];
    imageData.data[pixelIndex + 2] = replacement[2];
    imageData.data[pixelIndex + 3] = replacement[3];

    queue.push({ x: cx + 1, y: cy });
    queue.push({ x: cx - 1, y: cy });
    queue.push({ x: cx, y: cy + 1 });
    queue.push({ x: cx, y: cy - 1 });
  }

  bufferCtx.putImageData(imageData, 0, 0);
}

function colorsMatch(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function hexToRgba(hex) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  if (clean.length === 3) {
    return [
      ((bigint >> 8) & 0xf) * 17,
      ((bigint >> 4) & 0xf) * 17,
      (bigint & 0xf) * 17,
      255
    ];
  }
  return [
    (bigint >> 16) & 255,
    (bigint >> 8) & 255,
    bigint & 255,
    255
  ];
}

function drawCursor() {
  if (!cursorPosition || tool === 'hand' || tool === 'none') return;

  const dpr = window.devicePixelRatio || 1;
  const { x, y } = cursorPosition;

  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // offsetX/Y are always integers — no rounding needed
  const ox = offsetX;
  const oy = offsetY;
  
  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);
  
  // Calculating dynamic width based on next pixel coordinate avoids any 1px overlap gaps
  const sizeX = Math.floor((x + 1) * scale + ox) - px;
  const sizeY = Math.floor((y + 1) * scale + oy) - py;

  // FIX: Inject the currently selected color into the cursor fill (Eraser shows white)
  // For the ruler tool, flash the cell with a cyan tint.
  // While drawing: highlight the live endpoint (current cursor = where the
  // ruler end will be placed).  While idle: show where the first point goes.
  const isRulerMode = tool === 'ruler';
  const activeColor = isRulerMode
    ? '#00e5ff'
    : (tool === 'eraser' ? '#ffffff' : (color || '#000000'));
  const rgba = hexToRgba(activeColor);
  // Ruler uses a pulsing alpha so the highlight is clearly distinct from a
  // normal brush cursor.  A simple sine on performance.now() gives a smooth
  // flash without requiring a separate rAF loop.
  const rulerAlpha = isRulerMode
    ? 0.25 + 0.25 * Math.sin(performance.now() / 180)
    : 0.45;
  overlayCtx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rulerAlpha})`;
  overlayCtx.fillRect(px, py, sizeX, sizeY);

  // Ensure border stays exactly 1px thick at all zoom levels
  overlayCtx.lineWidth = 1;

  // Outer dark border (+0.5 centers the stroke perfectly)
  overlayCtx.strokeStyle = 'rgba(0,0,0,0.8)';
  overlayCtx.strokeRect(px - 0.5, py - 0.5, sizeX + 1, sizeY + 1);

  // Inner white border — only draw when the cell is large enough that it won't overdraw the fill
  if (sizeX >= 4 && sizeY >= 4) {
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    overlayCtx.strokeRect(px + 0.5, py + 0.5, sizeX - 1, sizeY - 1);
  }
}

function moveCursor(dx, dy) {
  if (!cursorPosition) return;
  const x = clamp(cursorPosition.x + dx, 0, BOARD_WIDTH - 1);
  const y = clamp(cursorPosition.y + dy, 0, BOARD_HEIGHT - 1);
  cursorPosition = { x, y };
  updateStatus(x, y);
  redraw();
}

function armKeyboardCursorAfterArrow() {
  keyboardCursorArmored = true;
  mouseArmorAnchorX = lastPointerClientX;
  mouseArmorAnchorY = lastPointerClientY;
}

function disarmKeyboardCursor() {
  keyboardCursorArmored = false;
}

function pointerMovedPastArmor(clientX, clientY) {
  const dx = clientX - mouseArmorAnchorX;
  const dy = clientY - mouseArmorAnchorY;
  return dx * dx + dy * dy >= MOUSE_CURSOR_ARMOR_PX * MOUSE_CURSOR_ARMOR_PX;
}

function ensureBoardCursor() {
  if (!cursorPosition) {
    cursorPosition = { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
  }
}

/** Arrow keys move one board pixel; repeated keys are throttled so holding the key does not jump too fast. */
function moveCursorFromArrow(dx, dy, event) {
  ensureBoardCursor();
  if (event.repeat) {
    const now = Date.now();
    if (now - lastArrowKeyMoveAt < ARROW_KEY_REPEAT_MS) return;
    lastArrowKeyMoveAt = now;
  } else {
    lastArrowKeyMoveAt = Date.now();
  }
  moveCursor(dx, dy);
  armKeyboardCursorAfterArrow();
}

function applyToolAtCell(x, y) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  if (tool === 'none' || tool === 'hand') return;
  if (tool === 'ruler') { rulerHandleClick(x, y); return; }
  updateStatus(x, y);
  cursorPosition = { x, y };

  if (tool === 'eyedropper') {
    const pixel = bufferCtx.getImageData(x, y, 1, 1).data;
    // FIX 1: Default to white if clicking an empty/transparent canvas area
    const picked = pixel[3] === 0 ? '#ffffff' : rgbToHex(pixel[0], pixel[1], pixel[2]);
    const norm = normalizeHexColor(picked);

    // Find the closest existing palette entry by hue similarity and update it
    // in-place, rather than adding a new entry.
    // FIX 2: Extract Lightness (pL) to distinguish between black and white
    const [pH, pS, pL] = hexToHsl(norm);

    // Search paletteColors (source of truth) directly — avoids the dual-DOM
    // problem where #palette and #fullscreen-palette are separate button sets.
    // Prefer the most-recently-used slot when multiple slots tie on hue distance,
    // so picking a dark blue replaces the blue you last used, not a random one.
    let bestIdx = -1;
    let bestDist = Infinity;

    paletteColors.forEach((entry, i) => {
      // Always compare against the canonical base color stored in paletteColors
      const base = normalizeHexColor(entry.color);     
      const [bH, bS, bL] = hexToHsl(base);
      
      const dH = Math.min(Math.abs(pH - bH), 360 - Math.abs(pH - bH));
      
      // 1. Calculate the 3D HSL distance first
      const dist = dH + Math.abs(pS - bS) * 0.3 + Math.abs(pL - bL) * 0.5;

      // 2. Set your comparison epsilon (1.0 handles 0-100 Lightness values smoothly)
      const EPSILON = 1.0;

      // 3. Run your comparison checks safely using the computed dist
      const isBetter = dist < bestDist - EPSILON;
      const isTieWithRecent = Math.abs(dist - bestDist) <= EPSILON && i === lastUsedPaletteIdx;
      
      if (isBetter || isTieWithRecent) { 
        bestDist = dist; 
        bestIdx = i; 
      }
    });

    // Only update in-place when the hue is genuinely close (within 30°); otherwise
    // fall back to adding a new entry so completely novel colors still get recorded.
    const HUE_THRESHOLD = 30;
    // Collect every button updated by the eyedropper (both #palette and
    // #fullscreen-palette mirror the same slot) so setColor can mark all of them
    // selected at once.  The old "last wins" approach only marked the
    // fullscreen-palette button, leaving the desktop palette button unselected.
    const eyedropperBtns = [];
    if (bestIdx !== -1 && bestDist <= HUE_THRESHOLD) {
      // The exact color currently stored at the best slot — used to match DOM buttons precisely.
      const slotColor = normalizeHexColor(paletteColors[bestIdx].color);
      // Update paletteColors (source of truth) first
      paletteColors[bestIdx] = asPaletteEntry({ ...paletteColors[bestIdx], color: norm });
      // Sync ALL buttons whose dataset.color exactly matches the slot being replaced
      // (both the desktop #palette button and the mobile #fullscreen-palette button).
      document.querySelectorAll('#palette button, #fullscreen-palette button').forEach(btn => {
        if (normalizeHexColor(btn.dataset.color) === slotColor) {
          btn.style.background = norm;
          btn.dataset.color = norm;
          btn.title = norm.toUpperCase();
          // dataset.baseColor intentionally NOT updated — keeps the hue family anchor
          eyedropperBtns.push(btn);
        }
      });
    } else {
      const alreadyIn = paletteColors.some(e => normalizeHexColor(e.color) === norm);
      if (!alreadyIn) {
        paletteColors.push(asPaletteEntry({ id: null, label: norm, color: norm }));
        renderPalette();
      }
    }

    // Mark all matched buttons selected; pass first as the "preferred" anchor so
    // setColor's loop doesn't also try to search by hex (which could match wrong slots).
    // Then manually select any remaining ones setColor didn't touch.
    setColor(norm, eyedropperBtns[0] || null);
    if (eyedropperBtns.length > 1) {
      // setColor already cleared all .selected; re-apply to the rest
      eyedropperBtns.forEach(btn => btn.classList.add('selected'));
    }
    _eyedropperJustFired = true;
    // Cancel any pending long-press-pan timer so the mouseup for this same
    // click doesn't try to place a pixel after the eyedropper pick.
    cancelLongPressPan();
    // Delay the tool switch on touch devices so the touchend that triggered the
    // eyedropper pick has fully resolved before brush becomes active.
    // Without this delay, the same touch gesture that picked the color could
    // immediately place a pixel once the tool switches to brush.
    if (window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => { setTool('brush'); _eyedropperJustFired = false; }, 320);
    } else {
      setTool('brush');
    }
    redraw();
    return;
  }

  if (!canPlacePixel()) {
    updateCooldownLabel();
    redraw();
    return;
  }

  // 1. Paint immediately to the buffer and flush to screen — zero latency
  paintPixel(x, y);
  lastPlaceAt = Date.now();
  // Track this cell so SSE reconnect init-bundles don't overwrite it
  _markLocalCell(x, y);

  // SFX + particles for brush/eraser
  if (tool === 'eraser') {
    SFX.play('pixel-erased', 80, 0.4);
  }
  if(tool === 'brush') {
    SFX.play(Math.random() < 0.5 ? 'pixel-placed2' : 'pixel-placed3', 80, 0.45);
    spawnParticles(x, y, color || '#ffffff');
  }

  // Draw only the new pixel directly to ctx for instant feedback
  const ox = offsetX;
  const oy = offsetY;
  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);
  const size = Math.max(1, Math.round(pixelSize * scale));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (tool === 'eraser') {
    ctx.clearRect(px, py, size, size);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(px, py, size, size);
  }
  ctx.restore();

  // 2. Full redraw (grid, cursor, overlay) deferred one frame — invisible delay
  requestAnimationFrame(() => redraw());

  // 3. Defer storage/broadcast off the hot path entirely
  setTimeout(() => {
    updateCooldownLabel();
    broadcastEvent({
      type: 'pixel',
      x,
      y,
      color: tool === 'eraser' ? null : color,
      size: pixelSize,
      tool,
      user: currentUser,
      time: lastPlaceAt
    });
  }, 0);
}

function placeFromKeyboard() {
  if (!currentUser) return;
  ensureBoardCursor();

  // If the cursor wandered outside the board (panning into the void), snap it
  // back to the nearest valid board pixel so Enter always lands somewhere.
  cursorPosition = {
    x: clamp(cursorPosition.x, 0, BOARD_WIDTH  - 1),
    y: clamp(cursorPosition.y, 0, BOARD_HEIGHT - 1),
  };

  // 'none' and 'hand' are view-only tools — pressing Enter should place a pixel,
  // so switch to brush first (same intent as any other keyboard-place action).
  if (tool === 'none' || tool === 'hand') {
    setTool('brush');
  }

  applyToolAtCell(cursorPosition.x, cursorPosition.y);
}

function updateStatus(x, y) {
  const txt = `${x}, ${y}`;
  coordLabel.textContent = txt;
  const topbarCoord = document.getElementById('coord-topbar');
  if (topbarCoord) topbarCoord.textContent = txt;
}

function appendHistory(event) {
  const history = safeParse(localStorage.getItem(PIXEL_HISTORY_KEY), []);
  history.push(event);
  if (history.length > 500) history.shift();
  localStorage.setItem(PIXEL_HISTORY_KEY, JSON.stringify(history));
}

function broadcastEvent(event) {
  // Write EVENT_KEY synchronously so other tabs get it immediately,
  // but defer the heavier history append to keep the click path instant.
  localStorage.setItem(EVENT_KEY, JSON.stringify(event));
  if (event.type === 'pixel') {
    setTimeout(() => appendHistory(event), 0);

    // Persist to server (leaderboard + pixel history)
    const token = getStoredToken();
    if (token) {
      const endpoint = event.tool === 'eraser' ? '/api/erase' : '/api/pixel';
      // Coerce x/y to integers — the server guard uses parseInt() but sending
      // floats can cause subtle mismatches on fractional zoom coords.
      const payload = event.tool === 'eraser'
        ? { x: Math.round(event.x), y: Math.round(event.y) }
        : { x: Math.round(event.x), y: Math.round(event.y), color: event.color };
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      }).then(res => {
        if (res.ok) {
          window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
          // Refresh the recent-cell guard now that the server confirmed the paint
          _markLocalCell(event.x, event.y);
          // Update running total and check achievements
          _totalPixelCount++;
          _currentStreak = Math.max(_currentStreak, 1); // at minimum 1 today
          checkAchievements({ totalPixels: _totalPixelCount, currentStreak: _currentStreak });
          updateStreakBadge();
        } else {
          // Non-2xx = pixel was NOT saved.
          res.json().then(data => {
            console.warn('[sp] pixel save failed:', res.status, data?.error);

            if (res.status === 429) {
              // Server rejected due to cooldown. Two cases:
              //
              // A) Tiny boundary race (remaining <= 100 ms): the request arrived
              //    at the server a few ms before the grace window kicked in.
              //    Treat it as a success — keep the optimistic pixel and stamp
              //    lastPlaceAt so the full cooldown runs from now.
              //
              // B) Genuine early click (remaining > 100 ms): the user spammed
              //    before the cooldown was actually up. Roll back the pixel and
              //    lock the gate for the real remaining duration so no further
              //    spam placements can slip through.
              const remaining = data?.cooldown ?? 0;
              if (remaining <= 150) {
                // Case A — boundary race (click fired at the exact moment the
                // cooldown expired; server received it slightly early due to
                // clock skew or network latency).  Keep the optimistic pixel.
                window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
                _totalPixelCount++;
                _currentStreak = Math.max(_currentStreak, 1);
                checkAchievements({ totalPixels: _totalPixelCount, currentStreak: _currentStreak });
                updateStreakBadge();
                lastPlaceAt = Date.now();
              } else {
                // Case B — genuinely too early, roll back and lock the gate.
                paintPixel(event.x, event.y, event.size || 1, 'eraser', null);
                redraw();
                // Position lastPlaceAt so canPlacePixel() stays false for
                // exactly `remaining` ms from now.
                lastPlaceAt = Date.now() - (_activeCooldownMs - remaining);
              }
              updateCooldownLabel();
            } else {
              // Non-429 error (400 bad request, 500 server error, etc.) —
              // roll back the optimistic paint right away.
              // lastPlaceAt was already stamped at paint time so the cooldown
              // bar counts down normally — no extra gate manipulation needed.
              paintPixel(event.x, event.y, event.size || 1, 'eraser', null);
              redraw();
              updateCooldownLabel();
            }
          }).catch(() => {
            // Could not parse error body — roll back conservatively.
            // Don't touch lastPlaceAt; it was stamped at paint time.
            console.warn('[sp] pixel save failed (unparseable response):', res.status);
            paintPixel(event.x, event.y, event.size || 1, 'eraser', null);
            redraw();
            updateCooldownLabel();
          });
        }
      }).catch(err => {
        // Network error — pixel visible locally but not persisted to server.
        console.warn('[sp] pixel save network error:', err.message);
      });
    }
  }
  if (event.type === 'clear') {
    setTimeout(() => localStorage.setItem(PIXEL_HISTORY_KEY, JSON.stringify([])), 0);
  }
}

function applyRemotePixel(event) {
  const remoteTool = event.tool || 'brush';
  const remoteColor =
    remoteTool === 'eraser'
      ? null
      : event.color != null && event.color !== ''
        ? normalizeHexColor(String(event.color))
        : '#000000';
  paintPixel(event.x, event.y, event.size || 1, remoteTool, remoteColor);
  // NOTE: callers are responsible for calling redraw() — do NOT call it here
  // to avoid double-redraws when batching multiple remote pixels.
}

function handleRemoteEvent(event) {
  if (!event || !event.type) return;
  if (event.type === 'pixel') {
    applyRemotePixel(event);
    redraw();
  } else if (event.type === 'clear') {
    clearCanvasLocal(false);
  } else if (event.type === 'palette') {
    customPalette = Array.isArray(event.palette)
      ? event.palette.map(entry =>
          normalizeHexColor(typeof entry === 'string' ? entry : String(entry?.color ?? ''))
        )
      : [];
    saveCustomPalette(customPalette);
    renderPalette();
  }
}

function replayHistory() {
  const history = safeParse(localStorage.getItem(PIXEL_HISTORY_KEY), []);
  history.forEach(event => {
    if (event.type === 'pixel') {
      applyRemotePixel(event);
    }
  });
}

function clearCanvasLocal(announce = true) {
  bufferCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  redraw();
  if (announce) {
    broadcastEvent({ type: 'clear', user: currentUser });
  }
}

function clearCanvas() {
  if (!currentUser) return;
  clearCanvasLocal(true);
}

function exportPng() {
  // bufferCanvas is 2000×2000 but the board is only BOARD_WIDTH×BOARD_HEIGHT.
  // Export only the board region so the PNG isn't padded with blank rows/columns.
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width  = BOARD_WIDTH;
  exportCanvas.height = BOARD_HEIGHT;
  const exportCtx = exportCanvas.getContext('2d');
  exportCtx.fillStyle = '#ffffff';
  exportCtx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  exportCtx.drawImage(
    bufferCanvas,
    0, 0, BOARD_WIDTH, BOARD_HEIGHT,   // source: board region of buffer
    0, 0, BOARD_WIDTH, BOARD_HEIGHT    // dest: full export canvas
  );
  const link = document.createElement('a');
  link.download = 'saint-pixels.png';
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
}

function hexToHsl(hex) {
  let [r, g, b] = hexToRgba(hex).slice(0, 3).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function removeVariationPicker() {
  const existing = document.querySelector('.variation-picker');
  if (existing) existing.remove();
}

function showVariationPicker(button, baseColor) {
  removeVariationPicker();
  const [h, s, l] = hexToHsl(baseColor);
  const variants = [
    hslToHex(h, s, Math.max(0,   l - 25)),
    hslToHex(h, s, Math.max(0,   l - 12)),
    baseColor,
    hslToHex(h, s, Math.min(100, l + 12)),
    hslToHex(h, s, Math.min(100, l + 25)),
  ];

  // Find which variant best matches the shade currently shown on the button.
  // This makes double-clicking after picking a shade keep that shade highlighted.
  const currentButtonColor = normalizeHexColor(button.dataset.color || baseColor);
  let activeIdx = 2; // default to the base/middle swatch
  let bestDist = Infinity;
  variants.forEach((hex, i) => {
    const norm = normalizeHexColor(hex);
    if (norm === currentButtonColor) { activeIdx = i; bestDist = 0; return; }
    // Fallback: pick closest by lightness distance if no exact match
    if (bestDist > 0) {
      const [,, li] = hexToHsl(hex);
      const [,, lc] = hexToHsl(currentButtonColor);
      const d = Math.abs(li - lc);
      if (d < bestDist) { bestDist = d; activeIdx = i; }
    }
  });

  const picker = document.createElement('div');
  picker.className = 'variation-picker';
  picker.style.cssText = [
    'position:fixed', 'z-index:99999',
    'display:flex', 'gap:6px', 'padding:8px',
    'background:rgba(47,47,48,0.98)',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:12px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
    'touch-action:none',
  ].join(';');

  // Shared cleanup — always removes the outside listeners
  function cleanupOutside() {
    document.removeEventListener('touchstart', onOutside, true);
    document.removeEventListener('mousedown',  onOutside, true);
  }

  variants.forEach(function(hex, i) {
    const swatch = document.createElement('button');
    swatch.className = 'variation-swatch';
    const isActive = i === activeIdx;
    const sz = isActive ? '36px' : '28px';
    const bd = isActive ? '2px solid rgba(255,255,255,0.5)' : '1px solid rgba(255,255,255,0.2)';
    swatch.style.cssText = 'width:' + sz + ';height:' + sz + ';border-radius:6px;background:' + hex + ';border:' + bd + ';cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;';
    swatch.title = hex.toUpperCase();

    function applyHex(e) {
      e.preventDefault();
      e.stopPropagation();
      const normHex = normalizeHexColor(hex);
      // Do NOT mutate paletteColors — the slot keeps its original color so that
      // if renderPalette() is ever called, the rebuilt button still anchors to
      // the original hue and dataset.baseColor stays correct.
      // Only update the button's visual so the swatch shows the chosen shade.
      if (button) {
        button.style.background = normHex;
        button.dataset.color = normHex;
        button.title = normHex.toUpperCase();
        // dataset.baseColor intentionally NOT updated — locks the hue family
      }
      setColor(normHex);
      removeVariationPicker();
      cleanupOutside();
    }
    swatch.addEventListener('click', applyHex);
    swatch.addEventListener('touchend', applyHex, { passive: false });
    picker.appendChild(swatch);
  });

  document.body.appendChild(picker);

  const rect = button.getBoundingClientRect();
  const pw = picker.offsetWidth || 220;
  const ph = picker.offsetHeight || 52;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  const spaceBelow = window.innerHeight - rect.bottom - 10;
  const top = spaceBelow >= ph ? rect.bottom + 6 : rect.top - ph - 6;
  picker.style.left = left + 'px';
  picker.style.top  = Math.max(8, top) + 'px';

  // Dismiss on outside touch/click — 200ms grace so the opening touch
  // does not immediately close the picker
  let dismissReady = false;
  setTimeout(function() { dismissReady = true; }, 200);

  function onOutside(e) {
    if (!dismissReady) return;
    if (picker.contains(e.target)) return;
    removeVariationPicker();
    cleanupOutside();
  }
  document.addEventListener('touchstart', onOutside, { capture: true, passive: true });
  document.addEventListener('mousedown',  onOutside, { capture: true });
}

function createPaletteButton(entry) {
  const button = document.createElement('button');
  button.style.background = entry.color;
  button.dataset.color = entry.color;
  // baseColor is the original hue of this slot — never updated by variation picks,
  // so double-click always generates shades around the same root color.
  button.dataset.baseColor = entry.color;
  button.title = `${entry.label} (${entry.color.toUpperCase()})`;
  if (entry.color.toLowerCase() === (color || '').toLowerCase()) {
    button.classList.add('selected');
  }

  // Touch double-tap state — declared here so both click and touchend share the same variable
  let _tapTimer = null;
  let _tapCount = 0;
  let _suppressNextClick = false;

  button.addEventListener('click', () => {
    if (_suppressNextClick) { _suppressNextClick = false; return; }
    // Select the current color of this swatch (may be a picked variation)
    const current = normalizeHexColor(button.dataset.color);
    setColor(current);
  });

  button.addEventListener('dblclick', (e) => {
    e.preventDefault();
    // Always open picker from the original base color, never from a previously picked shade
    showVariationPicker(button, button.dataset.baseColor);
  });

  // Touch double-tap for variation picker on mobile
  button.addEventListener('touchend', (e) => {
    _tapCount++;
    if (_tapCount === 1) {
      _tapTimer = setTimeout(() => { _tapCount = 0; }, 350);
    } else if (_tapCount >= 2) {
      clearTimeout(_tapTimer);
      _tapCount = 0;
      e.preventDefault();
      e.stopPropagation();
      _suppressNextClick = true;
      // Reset suppress after a short delay in case no click fires (touchend only)
      setTimeout(() => { _suppressNextClick = false; }, 600);
      showVariationPicker(button, button.dataset.baseColor);
    }
  }, { passive: false });

  // Prevent long-press from removing color on mobile (contextmenu fires on long-press)
  let _longPressTimer = null;
  button.addEventListener('touchstart', (e) => {
    _longPressTimer = setTimeout(() => {
      // On mobile long-press: do nothing (don't remove the color)
      _longPressTimer = null;
    }, 500);
  }, { passive: true });
  button.addEventListener('touchend', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  });
  button.addEventListener('touchmove', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  });

  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Only remove on desktop (non-touch) right-click
    if (e.pointerType === 'touch' || window.matchMedia('(pointer: coarse)').matches) return;
    const idx = paletteColors.findIndex(p => normalizeHexColor(p.color) === normalizeHexColor(entry.color));
    if (idx !== -1) {
      paletteColors.splice(idx, 1);
      renderPalette();
    }
  });

  return button;
}

function renderPalette() {
  paletteEl.innerHTML = '';
  const fsPaletteEl = document.getElementById('fullscreen-palette');
  if (fsPaletteEl) fsPaletteEl.innerHTML = '';

  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const colors = sourcePalette.map(asPaletteEntry);

  colors.forEach(entry => {
    paletteEl.appendChild(createPaletteButton(entry));
    if (fsPaletteEl) {
      fsPaletteEl.appendChild(createPaletteButton(entry));
    }
  });

  // Variation hint — visible only on mobile via .mob-variation-hint CSS class
  if (fsPaletteEl) {
    const hint = document.createElement('span');
    hint.className = 'mob-variation-hint';
    hint.textContent = 'Double-tap a color for lighter / darker variations';
    fsPaletteEl.appendChild(hint);
  }
}

async function initPalette() {
  customPalette = getCustomPalette();
  await loadServerPalette();
  renderPalette();
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}


function setTool(newTool) {
  const prevTool = tool;
  tool = newTool;
  toolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === newTool));
  dispatchStateChange({ currentTool: newTool.charAt(0).toUpperCase() + newTool.slice(1) });

  // Play tool-specific SFX on manual tool changes (not internal switches)
  if (prevTool !== newTool) {
    if (newTool === 'eyedropper') SFX.play('eyedropper', 200, 0.5);
    else if (newTool === 'hand')  SFX.play('hand', 200, 0.45);
    else if (newTool === 'ruler') SFX.play('ruler', 150, 0.4);
    else if (newTool === 'none')  SFX.play('none', 150, 0.4);
    else                          SFX.play('tool-changed', 150, 0.4);
  }
  
  // Manage active cursor styling layers directly on the viewport wrapper container
  if (tool === 'hand') {
    rulerFlashStop();
    viewport.classList.add('tool-hand-active');
    canvas.style.cursor = 'grab';
    overlay.style.cursor = 'grab';
  } else if (tool === 'none') {
    rulerFlashStop();
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'default';
    overlay.style.cursor = 'default';
  } else if (tool === 'ruler') {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'crosshair';
    overlay.style.cursor = 'crosshair';
    // Start the cursor-flash animation loop for the ruler tool.
    rulerFlashStart();
    // If ruler is in "drawing" mode (start set, not yet finished), keep that state
    // but reset to idle if there's no pending start (allow switching back freely)
  } else {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'crosshair';
    overlay.style.cursor = 'crosshair';
    // Stop the ruler flash loop when switching to any other tool.
    rulerFlashStop();
  }
  // Keep the mobile ruler stop button in sync with current tool
  _updateRulerStopBtn();
}

// ═══════════════════════════════════════════════════════════════════
// ── PIXEL RULER ENGINE ──────────────────────────────────────────────
// Cursor-flash rAF loop — keeps the sine-pulse animating even when the
// mouse is stationary.  Runs only while the ruler tool is active.
let _rulerFlashRaf = null;
function rulerFlashStart() {
  if (_rulerFlashRaf !== null) return; // already running
  function tick() {
    if (tool !== 'ruler') { _rulerFlashRaf = null; return; }
    redraw();
    _rulerFlashRaf = requestAnimationFrame(tick);
  }
  _rulerFlashRaf = requestAnimationFrame(tick);
}
function rulerFlashStop() {
  if (_rulerFlashRaf !== null) {
    cancelAnimationFrame(_rulerFlashRaf);
    _rulerFlashRaf = null;
  }
}
// State machine: idle → drawing (start set, line follows cursor) → locked (measurement shown)
// Rulers persist across tool changes. A red trash icon on each ruler removes it.
// ═══════════════════════════════════════════════════════════════════

const rulers = []; // Array of { x1, y1, x2, y2 } locked rulers
let rulerState = 'idle'; // 'idle' | 'drawing'
let rulerStart = null;   // { x, y } in board pixels
let rulerLiveEnd = null; // { x, y } board pixels — where cursor is while drawing

/** Called from applyToolAtCell when tool === 'ruler' */
function rulerHandleClick(bx, by) {
  if (rulerState === 'idle') {
    rulerStart = { x: bx, y: by };
    rulerLiveEnd = { x: bx, y: by };
    rulerState = 'drawing';
  } else {
    // Lock the ruler
    rulers.push({ x1: rulerStart.x, y1: rulerStart.y, x2: bx, y2: by });
    rulerState = 'idle';
    rulerStart = null;
    rulerLiveEnd = null;
    rulerRenderDOM();
  }
  _updateRulerStopBtn();
  redraw();
}

/** Called from canvas mousemove / touchmove when tool === 'ruler' */
function rulerUpdateLiveEnd(bx, by) {
  if (rulerState !== 'drawing') return;
  rulerLiveEnd = { x: bx, y: by };
  redraw();
}

/** Pixel distance between two board-pixel points */
function rulerPixelDistance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

/** Board pixel coords → overlay canvas CSS coords */
function boardToOverlayCSS(bx, by) {
  const dpr = window.devicePixelRatio || 1;
  const ox = offsetX;
  const oy = offsetY;
  // overlayCtx uses DPR transform; but DOM labels live in CSS space.
  // We need CSS px = board * scale + offset (both already in CSS px).
  return {
    cx: bx * scale + ox,
    cy: by * scale + oy,
  };
}

/** Draw the live (in-progress) ruler on the overlay canvas */
function rulerDrawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Draw all locked rulers
  for (const r of rulers) {
    rulerDrawLine(r.x1, r.y1, r.x2, r.y2, false);
  }

  // Draw in-progress ruler
  if (rulerState === 'drawing' && rulerStart && rulerLiveEnd) {
    rulerDrawLine(rulerStart.x, rulerStart.y, rulerLiveEnd.x, rulerLiveEnd.y, true);
    // Draw crosshair cursor at start
    rulerDrawCrosshair(rulerStart.x, rulerStart.y, '#00e5ff');
  }

  // Reposition DOM labels to follow zoom/pan
  rulerRepositionLabels();
}

function rulerDrawLine(x1, y1, x2, y2, isLive) {
  const ox = offsetX;
  const oy = offsetY;
  const sx1 = x1 * scale + ox;
  const sy1 = y1 * scale + oy;
  const sx2 = x2 * scale + ox;
  const sy2 = y2 * scale + oy;

  const dist = rulerPixelDistance(x1, y1, x2, y2);

  // Main line
  overlayCtx.save();
  overlayCtx.setLineDash(isLive ? [6, 4] : []);
  overlayCtx.strokeStyle = isLive ? 'rgba(0,229,255,0.85)' : 'rgba(0,229,255,1)';
  overlayCtx.lineWidth = isLive ? 1.5 : 2;
  overlayCtx.shadowColor = 'rgba(0,180,220,0.6)';
  overlayCtx.shadowBlur = 4;
  overlayCtx.beginPath();
  overlayCtx.moveTo(sx1, sy1);
  overlayCtx.lineTo(sx2, sy2);
  overlayCtx.stroke();
  overlayCtx.setLineDash([]);
  overlayCtx.shadowBlur = 0;

  // Endpoint caps
  const capSize = Math.max(3, Math.min(8, scale * 0.6));
  overlayCtx.strokeStyle = isLive ? 'rgba(0,229,255,0.85)' : 'rgba(0,229,255,1)';
  overlayCtx.lineWidth = isLive ? 1.5 : 2;
  // Start cap
  const angle = Math.atan2(sy2 - sy1, sx2 - sx1);
  const perp = angle + Math.PI / 2;
  [{ sx: sx1, sy: sy1 }, { sx: sx2, sy: sy2 }].forEach(({ sx, sy }) => {
    overlayCtx.beginPath();
    overlayCtx.moveTo(sx + Math.cos(perp) * capSize, sy + Math.sin(perp) * capSize);
    overlayCtx.lineTo(sx - Math.cos(perp) * capSize, sy - Math.sin(perp) * capSize);
    overlayCtx.stroke();
  });

  // Pixel label — only on live line or short lines; DOM handles locked ruler labels
  if (isLive) {
    const mx = (sx1 + sx2) / 2;
    const my = (sy1 + sy2) / 2;
    const label = `${dist} px`;
    overlayCtx.font = 'bold 12px ui-monospace, monospace';
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    const tw = overlayCtx.measureText(label).width;
    const pad = 5;
    overlayCtx.fillStyle = 'rgba(0,0,0,0.75)';
    overlayCtx.beginPath();
    overlayCtx.roundRect(mx - tw / 2 - pad, my - 10, tw + pad * 2, 20, 5);
    overlayCtx.fill();
    overlayCtx.fillStyle = '#00e5ff';
    overlayCtx.fillText(label, mx, my);
  }

  overlayCtx.restore();
}

function rulerDrawCrosshair(bx, by, color) {
  const ox = offsetX;
  const oy = offsetY;
  const sx = bx * scale + ox;
  const sy = by * scale + oy;
  const arm = 8;
  overlayCtx.save();
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = 1.5;
  overlayCtx.beginPath();
  overlayCtx.moveTo(sx - arm, sy); overlayCtx.lineTo(sx + arm, sy);
  overlayCtx.moveTo(sx, sy - arm); overlayCtx.lineTo(sx, sy + arm);
  overlayCtx.stroke();
  overlayCtx.restore();
}

/** Render DOM labels for locked rulers (positioned over the canvas viewport) */
function rulerRenderDOM() {
  // Remove old ruler DOM labels
  document.querySelectorAll('.sp-ruler-label').forEach(el => el.remove());

  rulers.forEach((r, idx) => {
    const label = document.createElement('div');
    label.className = 'sp-ruler-label';
    label.dataset.rulerIdx = idx;

    const dist = rulerPixelDistance(r.x1, r.y1, r.x2, r.y2);
    const dx = r.x2 - r.x1;
    const dy = r.y2 - r.y1;

    label.innerHTML = `
      <svg class="sp-ruler-icon" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <line x1="1" y1="11" x2="11" y2="1"/>
        <line x1="1" y1="8" x2="1" y2="11"/>
        <line x1="4" y1="11" x2="1" y2="11"/>
        <line x1="8" y1="1" x2="11" y2="1"/>
        <line x1="11" y1="4" x2="11" y2="1"/>
      </svg>
      <span class="sp-ruler-dist">${dist} px</span>
      ${dx !== 0 ? `<span class="sp-ruler-axis">W:${Math.abs(dx)}</span>` : ''}
      ${dy !== 0 ? `<span class="sp-ruler-axis">H:${Math.abs(dy)}</span>` : ''}
      <button class="sp-ruler-trash" data-ruler-idx="${idx}" title="Remove ruler" aria-label="Remove ruler">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
          <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
        </svg>
      </button>
    `;

    // Position: midpoint of the ruler line in viewport CSS coords
    const { cx: mx, cy: my } = boardToOverlayCSS((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
    label.style.left = `${mx}px`;
    label.style.top  = `${my}px`;

    viewport.appendChild(label);

    // Forward wheel events on the ruler label to the canvas so the user can
    // still zoom in/out when the cursor happens to be over a ruler widget.
    label.addEventListener('wheel', (e) => {
      e.stopPropagation();
      handleWheel(e);
    }, { passive: false });
  });

  // Trash click handler
  viewport.querySelectorAll('.sp-ruler-trash').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.rulerIdx, 10);
      rulers.splice(idx, 1);
      rulerRenderDOM();
      redraw();
    });
  });
}

/** Reposition DOM ruler labels whenever viewport changes (zoom / pan / resize) */
function rulerRepositionLabels() {
  viewport.querySelectorAll('.sp-ruler-label').forEach(label => {
    const idx = parseInt(label.dataset.rulerIdx, 10);
    const r = rulers[idx];
    if (!r) return;
    const { cx, cy } = boardToOverlayCSS((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
    label.style.left = `${cx}px`;
    label.style.top  = `${cy}px`;
  });
}

// ── Patch redraw to also reposition ruler labels ───────────────────────────
// rulerRepositionLabels is called from rulerDrawOverlay() which is called
// at the end of every redraw() rAF pass — no extra wiring needed.

// ═══════════════════════════════════════════════════════════════════
// End of PIXEL RULER ENGINE
// ═══════════════════════════════════════════════════════════════════

/** Perceived brightness 0–255; pick label ink for small hex swatches in the top bar. */
function brightnessRgb(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function applyColorSwatchStyles(hex) {
  const [r, g, b] = hexToRgba(hex);
  const y = brightnessRgb(r, g, b);
  // currentColor swatch styling is handled by Alpine :style binding
}

function setColor(newColor, preferredBtn) {
  const norm = normalizeHexColor(newColor);
  color = norm;
  if (colorInput) colorInput.value = norm;
  dispatchStateChange({ currentColor: norm });
  applyColorSwatchStyles(norm);

  // Track which paletteColors slot was last activated so the eyedropper
  // can prefer it over other same-hue slots when resolving ties.
  const activatedIdx = paletteColors.findIndex(e => normalizeHexColor(e.color) === norm);
  if (activatedIdx !== -1) lastUsedPaletteIdx = activatedIdx;

  // If a specific button is preferred (e.g. after an eyedropper pick that
  // updates exactly one slot), mark only that button as selected so two
  // buttons with the same hex never both light up at once.
  const allBtns = document.querySelectorAll('#palette button, #fullscreen-palette button');
  if (preferredBtn) {
    allBtns.forEach(b => b.classList.remove('selected'));
    preferredBtn.classList.add('selected');
  } else {
    // Normal path: first button whose color matches gets selected; if multiple
    // share the same hex (e.g. after a variation pick), only the first is marked.
    let marked = false;
    allBtns.forEach(b => {
      const matches = !marked && normalizeHexColor(b.dataset.color) === norm;
      b.classList.toggle('selected', matches);
      if (matches) marked = true;
    });
  }

  // Redraw immediately so cursor preview color updates without waiting for mousemove
  redraw();
}

// cleanup: keep the UI consistent after any color change or palette update
function addColorToPalette() {
  const newColor = normalizeHexColor(colorInput ? colorInput.value : '#000000');
  const already = paletteColors.some(e => normalizeHexColor(e.color) === newColor);
  if (!already) {
    paletteColors.push(asPaletteEntry({ id: null, label: newColor, color: newColor }));
  }
  renderPalette();
  setColor(newColor);
}

function syncUI() {
  renderPalette();
  setColor(color);
  setTool(tool);
  updateStatus(cursorPosition.x, cursorPosition.y);
  updateCooldownLabel();
}


function updateLiveCount(count) {
  dispatchStateChange({ liveCount: count });
}

function cancelLongPressPan() {
  if (_longPressPanTimer !== null) {
    clearTimeout(_longPressPanTimer);
    _longPressPanTimer = null;
  }
}

function startAction(event) {
  if (event.button === 2) return; // Disallow right-clicks

  // If holding shift, middle mouse button OR the active tool is 'hand', trigger panning
  if (event.shiftKey || event.button === 1 || tool === 'hand') {
    handlePanStart(event);
    return;
  }

  if (!currentUser) {
    return;
  }

  // Reset the per-gesture dedup guard so every new mousedown can place on
  // the same cell as the previous gesture (e.g. rapid clicks on one pixel,
  // or a server-rollback retry on the exact same cell).
  _lastPlacedCell = null;

  // Start a long-press timer — if the user holds left-click without moving,
  // switch into pan mode after LONG_PRESS_PAN_DELAY_MS milliseconds.
  // We do NOT place a pixel yet; we wait to see whether this becomes a pan
  // or a normal click (resolved in endAction / stopAction).
  _longPressAnchorX = event.clientX;
  _longPressAnchorY = event.clientY;
  _longPressPanTimer = setTimeout(() => {
    _longPressPanTimer = null;
    // Only activate if we haven't released the mouse yet
    if (isMouseDown) {
      isMouseDown = false;
      handlePanStart({ clientX: lastPointerClientX, clientY: lastPointerClientY });
    }
  }, LONG_PRESS_PAN_DELAY_MS);

  isMouseDown = true;
  // Pixel placement is deferred to endAction so a long-press pan never
  // consumes the cooldown. The pixel is drawn on mouseup (short click).
}

function moveAction(event) {
  // Update hover crosshair labels
  const _coordPos = getCanvasCoords(event.clientX, event.clientY);
  updateStatus(_coordPos.x, _coordPos.y);

  // Cancel the long-press-to-pan timer if the pointer drifted too far.
  // Once cancelled by movement this becomes a normal draw drag — fire
  // handleAction so the first dragged pixel isn't skipped.
  if (_longPressPanTimer !== null) {
    const dx = event.clientX - _longPressAnchorX;
    const dy = event.clientY - _longPressAnchorY;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD) {
      cancelLongPressPan();
      if (isMouseDown && !isPanning) {
        handleAction(event);
      }
    }
  }

  // If we are currently panning, calculate new offset positions
  if (isPanning) {
    offsetX = event.clientX - panStartX;
    offsetY = event.clientY - panStartY;
    redraw();
    return;
  }

  if (!isMouseDown) return;
  handleAction(event);
}



// Tracks the last cell placed during the current mouse-drag so moveAction and
// stopAction never both fire applyToolAtCell on the same (x,y) in one gesture.
let _lastPlacedCell = null;

function handleAction(event) {
  disarmKeyboardCursor();
  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  // Always paint at the actual pointer position.
  // cursorPosition is used for the keyboard/arrow-key workflow; relying on it
  // here caused off-by-one placement on Android because touchmove jitter
  // updated cursorPosition to a slightly wrong cell before touchend fired.
  if (_lastPlacedCell && _lastPlacedCell.x === x && _lastPlacedCell.y === y) return;
  _lastPlacedCell = { x, y };
  applyToolAtCell(x, y);
}

function stopAction(event) {
  // If the long-press timer is still pending, this was a short click (not a pan).
  // Cancel the timer and place the pixel now — unless the eyedropper just fired
  // on this same click, in which case we only picked a color, not placed a pixel.
  const wasShortClick = _longPressPanTimer !== null;
  cancelLongPressPan();

  if (wasShortClick && isMouseDown && !isPanning && !_eyedropperJustFired) {
    // IMPORTANT: clear _lastPlacedCell BEFORE calling handleAction.
    // moveAction may have set it during the mousedown→mousemove sequence
    // (Firefox fires fine-grained mousemove even for sub-pixel jitter).
    // If we don't clear it first, handleAction's dedup guard would see the
    // same cell and silently skip the placement — causing the double-click bug.
    _lastPlacedCell = null;
    handleAction(event);
  }
  // Clear the flag so the next independent click works normally.
  _eyedropperJustFired = false;
  _lastPlacedCell = null; // reset so the next click always registers

  isMouseDown = false;

  // End any residual pan state (e.g. pointer left the canvas mid-pan)
  if (isPanning) {
    isPanning = false;
    viewport.classList.remove('tool-hand-dragging');
    if (tool === 'hand') {
      viewport.classList.add('tool-hand-active');
    }
  }
}

// Accumulated wheel state — all ticks within a single animation frame are
// merged so that fast trackpad scrolling never queues more than one redraw.
let _wheelRafId = null;
let _wheelPivotX = 0;   // viewport-CSS px — anchor point for the current batch
let _wheelPivotY = 0;
let _wheelFactor = 1;   // multiplicative zoom accumulated this frame

function handleWheel(event) {
  event.preventDefault();

  const direction = -Math.sign(event.deltaY);

  // Bail early only when already at the hard limit AND this tick would push further.
  if (scale === MAX_ZOOM_SCALE && direction > 0) return;
  if (scale === MIN_ZOOM_SCALE && direction < 0) return;

  const rect = viewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  if (_wheelRafId === null) {
    // First tick of this frame — set the pivot (anchor point stays fixed).
    _wheelPivotX = mouseX;
    _wheelPivotY = mouseY;
    _wheelFactor = 1;

    _wheelRafId = requestAnimationFrame(() => {
      _wheelRafId = null;

      const boardX = (_wheelPivotX - offsetX) / scale;
      const boardY = (_wheelPivotY - offsetY) / scale;

      let nextZoom = clamp(scale * _wheelFactor, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
      scale = nextZoom;

      offsetX = Math.round(_wheelPivotX - boardX * scale);
      offsetY = Math.round(_wheelPivotY - boardY * scale);

      clampOffsets();

      // Re-anchor pan origin if zooming while holding middle-mouse-pan
      if (isPanning) {
        panStartX = _wheelPivotX + rect.left - offsetX;
        panStartY = _wheelPivotY + rect.top  - offsetY;
      }

      zoomInput.value = Math.round(scale * 100);
      dispatchStateChange({ zoomLevel: Math.round(scale * 100) });

      // Snap cursor to pointer position after zoom
      const newCoords = getCanvasCoords(_wheelPivotX + rect.left, _wheelPivotY + rect.top);
      cursorPosition = { x: newCoords.x, y: newCoords.y };

      redraw();
    });
  }

  // Accumulate factor — multiple ticks in the same frame compound correctly.
  _wheelFactor *= (direction > 0 ? 1.12 : 0.88);
}

function handlePanStart(event) {
  isPanning = true;
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
  // Always force the grabbing cursor regardless of tool
  canvas.classList.remove('shift-pan');
  viewport.classList.remove('tool-hand-active');
  viewport.classList.add('tool-hand-dragging');
}

function handlePanMove(event) {
  if (!isPanning) return;
  offsetX = Math.round(event.clientX - panStartX);
  offsetY = Math.round(event.clientY - panStartY);
  // clampOffsets() is called inside redraw() — no need to duplicate it here
  redraw();

  // Re-anchor panStart if clamping moved the offset away from the proposed position
  // so the pan doesn't drift when hitting a boundary
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
}

function handlePanEnd() {
  if (!isPanning) return;
  isPanning = false;
  viewport.classList.remove('tool-hand-dragging');
  if (tool === 'hand') {
    viewport.classList.add('tool-hand-active');
  }
}

function resizeViewport() {
  const dpr = window.devicePixelRatio || 1;
  const rect = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  
  canvas.width      = w * dpr;
  canvas.height     = h * dpr;
  gridCanvas.width  = w * dpr;
  gridCanvas.height = h * dpr;
  overlay.width     = w * dpr;
  overlay.height    = h * dpr;

  lastGridScale = null;
  clampOffsets();
  redraw();
}

window.addEventListener('resize', resizeViewport);

// When the user pinch-zooms the *browser* (not the in-app zoom), the Visual
// Viewport fires resize and scroll events.  We re-run resizeViewport so that
// canvas.width/height and offsetX/offsetY stay consistent with the new scale.
// Without this, getCanvasCoords works in a stale coordinate space and taps
// land on the wrong pixel.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resizeViewport);
  window.visualViewport.addEventListener('scroll', resizeViewport);
}
canvas.addEventListener('mousedown', event => {
  startAction(event);
});

canvas.addEventListener('mousemove', event => {
  lastPointerClientX = event.clientX;
  lastPointerClientY = event.clientY;
  
  if (isPanning) {
    handlePanMove(event); 
    return;
  }

  if (keyboardCursorArmored && cursorPosition) {
    if (!pointerMovedPastArmor(event.clientX, event.clientY)) {
      updateStatus(cursorPosition.x, cursorPosition.y);
      redraw();
      return;
    }
    disarmKeyboardCursor();
  }

  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  updateStatus(x, y);

  // Skip redraw when the cursor is still on the same board pixel — avoids
  // thrashing the canvas on sub-pixel mouse movements (e.g. high-DPI mice).
  const cellChanged = !cursorPosition || cursorPosition.x !== x || cursorPosition.y !== y;
  cursorPosition = { x, y };

  // Update live ruler end if ruler is in drawing state
  if (tool === 'ruler') {
    rulerUpdateLiveEnd(x, y);
    redraw(); // ruler always needs redraw for the pulsing cursor
    return;
  }

  if (cellChanged || isMouseDown) {
    redraw();
  }
});

canvas.addEventListener('mouseup', event => {
  if (isPanning) {
    handlePanEnd(); 
    return;
  }
  stopAction(event);
});
// Also listen on the whole document so panning is robust when the pointer leaves the canvas element
document.addEventListener('mousemove', event => {
  if (isPanning) handlePanMove(event); 
});
document.addEventListener('mouseup', event => {
  if (isPanning) handlePanEnd(); 
});
canvas.addEventListener('mouseleave', () => {
  //isMouseDown = false;
  //disarmKeyboardCursor();
  //cursorPosition = null;
  //redraw();
});
canvas.addEventListener('wheel', handleWheel, { passive: false });

zoomInput.addEventListener('input', event => {
  const nextZoom = Number(event.target.value) / 100;
  const rect = viewport.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const boardCenterX = (centerX - offsetX) / scale;
  const boardCenterY = (centerY - offsetY) / scale;

  scale = clamp(nextZoom, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
  offsetX = Math.round(centerX - boardCenterX * scale);
  offsetY = Math.round(centerY - boardCenterY * scale);
  clampOffsets();
  dispatchStateChange({ zoomLevel: Math.round(scale * 100) });

  // NEW: Instantly recalculate the cursor position based on the new zoom scale
  const newCoords = getCanvasCoords(event.clientX, event.clientY);
  cursorPosition = { x: newCoords.x, y: newCoords.y };

  redraw();
});

toggleGridBtn.addEventListener('click', () => {
  toggleGrid();
});

// ensure UI reflects current grid state on load
if (toggleGridBtn) toggleGridBtn.classList.toggle('active', gridEnabled);

// Clear canvas button removed — users cannot wipe the shared board
exportButton.addEventListener('click', exportPng);
if (colorInput) colorInput.addEventListener('input', event => setColor(event.target.value));
if (addColorButton) addColorButton.addEventListener('click', addColorToPalette);

toolButtons.forEach(button => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

// ─── Captcha helpers ────────────────────────────────────────────────────────
function getCaptchaToken() {
  if (isLocalDev()) return 'dev-bypass';
  if (typeof hcaptcha !== 'undefined') {
    const response = hcaptcha.getResponse();
    // getResponse() returns '' when not yet completed or already used
    return response || null;
  }
  // hCaptcha not loaded (no sitekey configured) — return a placeholder
  return 'dev-bypass';
}

function resetCaptcha() {
  if (isLocalDev()) return;
  if (typeof hcaptcha !== 'undefined') {
    hcaptcha.reset();
  }
}

// ─── Auth mode tabs ──────────────────────────────────────────────────────────
// Tracks whether the panel is in 'login' or 'register' mode.
// The email field and submit button label change accordingly.
let authMode = 'login'; // 'login' | 'register'

const authTabLogin    = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');
const authSubmit      = document.getElementById('authSubmit');

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === 'register';

  // Show / hide email field (no flicker — driven by explicit state)
  if (authEmailLabel) authEmailLabel.style.display = isRegister ? '' : 'none';

  // Show / hide rules checkbox (register only)
  const rulesRow   = document.getElementById('authRulesRow');
  const rulesCheck = document.getElementById('authRulesCheck');
  if (rulesRow) rulesRow.style.display = isRegister ? '' : 'none';
  // Uncheck when switching away from register so it resets cleanly
  if (!isRegister && rulesCheck) rulesCheck.checked = false;

  // Update submit button label
  if (authSubmit) authSubmit.textContent = isRegister ? 'Create account' : 'Login';

  // Tab active styles
  if (authTabLogin) {
    authTabLogin.classList.toggle('bg-white/10',        !isRegister);
    authTabLogin.classList.toggle('border-white/20',    !isRegister);
    authTabLogin.classList.toggle('border-transparent',  isRegister);
    authTabLogin.classList.toggle('text-white',         !isRegister);
    authTabLogin.classList.toggle('text-slate-400',      isRegister);
    authTabLogin.classList.toggle('hover:text-white',    isRegister);
  }
  if (authTabRegister) {
    authTabRegister.classList.toggle('bg-white/10',        isRegister);
    authTabRegister.classList.toggle('border-white/20',    isRegister);
    authTabRegister.classList.toggle('border-transparent', !isRegister);
    authTabRegister.classList.toggle('text-white',         isRegister);
    authTabRegister.classList.toggle('text-slate-400',    !isRegister);
    authTabRegister.classList.toggle('hover:text-white',  !isRegister);
  }
}

if (authTabLogin)    authTabLogin.addEventListener('click',    () => { setAuthMode('login');    syncPasswordAutocomplete(); });
if (authTabRegister) authTabRegister.addEventListener('click', () => { setAuthMode('register'); syncPasswordAutocomplete(); });

// Unified submit button triggers the right handler based on current mode
if (authSubmit) {
  authSubmit.addEventListener('click', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

// Also handle native form submit (enables iOS password manager save prompt)
const authForm = document.getElementById('authForm');
if (authForm) {
  authForm.addEventListener('submit', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

// Switch autocomplete on the password field based on auth mode so
// iOS/Safari knows whether to offer saved passwords or to save a new one.
function syncPasswordAutocomplete() {
  if (authPassword) {
    authPassword.setAttribute('autocomplete',
      authMode === 'register' ? 'new-password' : 'current-password');
  }
}

// Initialise to login mode
setAuthMode('login');
syncPasswordAutocomplete();

// ─── Rules modal ─────────────────────────────────────────────────────────────
// The rules window is #sp-rules-window (managed by rules.js).
// The authRulesLink inside the auth form needs to open it; rules.js also wires
// #topbarRulesBtn. We only need to handle the auth-form link here, and only if
// rules.js hasn't already claimed it (rules.js runs after app.js).
const authRulesLink  = document.getElementById('authRulesLink');

function openRulesWindow() {
  const win = document.getElementById('sp-rules-window');
  if (win) win.style.display = 'flex';
}

// Wire the auth-form "community rules" link — rules.js will also wire it,
// but since addEventListener stacks, having two listeners is harmless
// (both call open on the same element). Use a named function so it's clear.
if (authRulesLink) authRulesLink.addEventListener('click', openRulesWindow);

// ─── Email verification banner ───────────────────────────────────────────────
const resendVerifyBtn = document.getElementById('resendVerifyBtn');
const resendMsg = document.getElementById('resendMsg');

if (resendVerifyBtn) {
  let resendCooling = false;
  resendVerifyBtn.addEventListener('click', async () => {
    if (resendCooling) return;
    resendCooling = true;
    resendVerifyBtn.disabled = true;
    resendVerifyBtn.style.opacity = '0.5';
    if (resendMsg) resendMsg.textContent = 'Sending…';
    try {
      const token = getStoredToken();
      const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json();
      if (resendMsg) {
        resendMsg.textContent = res.ok
          ? (data.message || 'Sent! Check your inbox.')
          : (data.error  || 'Could not send — try again.');
      }
    } catch {
      if (resendMsg) resendMsg.textContent = 'Could not send — try again.';
    }
    // Allow retry after 10 s
    setTimeout(() => {
      resendCooling = false;
      resendVerifyBtn.disabled = false;
      resendVerifyBtn.style.opacity = '';
    }, 10000);
  });
}

// Handle ?verified=1 redirect from email link.
// checkVerifiedParam() writes to localStorage BEFORE updateAuthState() reads it,
// so the banner is already dismissed when /api/me resolves.
// (EMAIL_VERIFIED_KEY is declared at the top of DOMContentLoaded — see line 74.)
(function checkVerifiedParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('verified') === '1') {
    // Persist so refreshes don't re-show the banner while the DB is being read
    localStorage.setItem(EMAIL_VERIFIED_KEY, '1');
    dispatchStateChange({ emailVerified: true });
    history.replaceState(null, '', window.location.pathname);
  }
})();

// Enter on username or password submits the current mode's action

const logoutButton = document.getElementById('logoutButton');
if (logoutButton) {
  logoutButton.addEventListener('click', event => {
    event.preventDefault();
    handleLogout();
  });
}

if (authPassword) authPassword.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  }
});
if (authUsername) authUsername.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    // On Enter in the username field: if password is empty, move focus there instead of submitting
    if (authPassword && !authPassword.value) {
      authPassword.focus();
    } else {
      if (authMode === 'register') handleRegister(); else handleLogin();
    }
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', event => {
  const target = event.target;
  // Let the browser handle standard text typing naturally 
  if (target.closest?.('input, textarea, select')) return;
  // Don't steal Enter from focused toolbar/auth buttons (activation uses Enter).
  if (target.closest?.('button') && event.key === 'Enter') return;

  // Respect browser shortcuts when modifiers are used
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (hasModifier) {
    return;
  }
  
  switch (event.key) {
    case 'w':
    case 'W': moveColorFocus(0, -1); break;
    case 's':
    case 'S': moveColorFocus(0, 1); break;
    case 'a':
    case 'A': moveColorFocus(-1, 0); break;
    case 'd':
    case 'D': moveColorFocus(1, 0); break;

    // Q / E scroll the topbar left / right — avoids conflict with arrow keys
    case 'q':
    case 'Q': window._scrollTopbarLeft?.();  break;
    case 'e':
    case 'E': window._scrollTopbarRight?.(); break;
    
    case '1': setTool('brush'); break;
    case '2': setTool('eraser'); break;
    case '3': setTool('eyedropper'); break;
    case '4': setTool('hand'); break;
    case '5': setTool('ruler'); break;
    case '6': setTool('none'); break;
    case 'g': 
    case 'G': 
      toggleGrid(); 
      break;

    case 'Enter':
      if (!event.repeat) placeFromKeyboard();
      break;
    // Fullscreen
    case 'f':
    case 'F':
      fullscreenBtn?.click();
      break;
    // Arrow key movement
    case 'ArrowUp':
      moveCursorFromArrow(0, -1, event);
      break;
    case 'ArrowDown':
      moveCursorFromArrow(0, 1, event);
      break;
    case 'ArrowLeft':
      moveCursorFromArrow(-1, 0, event);
      break;
    case 'ArrowRight':
      moveCursorFromArrow(1, 0, event);
      break;
    // Canvas panning
    case 'Shift':
      canvas.classList.add('shift-pan');
      break;
  }
});

window.addEventListener('keyup', event => {
  if (event.key === 'Shift') {
    canvas.classList.remove('shift-pan');
  }
});

window.addEventListener('storage', event => {
  if (!event.key) return;

  if (event.key === EVENT_KEY) {
    const remoteEvent = safeParse(event.newValue, null);
    if (remoteEvent) {
      handleRemoteEvent(remoteEvent);
      if (remoteEvent.type === 'pixel') {
        window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
      }
    }
  }

  if (event.key === CUSTOM_PALETTE_KEY) {
    customPalette = getCustomPalette();
    renderPalette();
  }
});

window.addEventListener('beforeunload', () => {
  // Cleanly close the SSE connection before the page unloads.
  // Without this, the browser logs "connection was interrupted while the page
  // was loading" because the EventSource is torn down abruptly by navigation
  // rather than by an explicit close() call.
  if (_sseSource) {
    _sseSource.close();
    _sseSource = null;
  }
});

/**
 * Returns true when the mobileDebug bypass should be active on the client.
 *
 * Two conditions must BOTH be true:
 * 1. The server injected data-local-bypass="1" on <html> — this only
 * happens when MOBILE_DEBUG=true is set in .env AND the request came
 * from a private/loopback IP.  Without the server flag this is always
 * false, so the bypass is completely inert for public users.
 * 2. The browser hostname is a loopback or private-network address.
 * This double-check prevents a cached/CDN copy of the page from
 * accidentally activating the bypass on a public host.
 *
 * The original localhost-only check is preserved as the fast path.
 */
function isLocalDev() {
  const { hostname } = window.location;

  // Fast path: genuine loopback (original behaviour, always allowed)
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;

  // mobileDebug path: LAN IP + server confirmed bypass is active
  const serverBypass = document.documentElement.dataset.localBypass === '1';
  if (!serverBypass) return false;

  // Verify the hostname is actually a private-network address
  // (guards against a stale cached page reaching a public server)
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

// ═══════════════════════════════════════════════════════════════════
// ── MOBILE RULER STOP BUTTON ────────────────────────────────────────
// On mobile portrait, shows a "Stop Ruler" pill above the palette
// while the ruler is in drawing mode. Hides the cooldown bar so there
// is room, restores it when any other tool is active.
// ═══════════════════════════════════════════════════════════════════
(function () {
  const isMobilePortrait = () =>
    window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches;

  // Create the stop button once and append to body
  const stopBtn = document.createElement('button');
  stopBtn.id = 'ruler-stop-btn';
  stopBtn.type = 'button';
  stopBtn.textContent = '✕  Stop Ruler';
  document.body.appendChild(stopBtn);

  // Expose update function so setTool() and rulerHandleClick() can call it
  window._updateRulerStopBtn = function () {
    const active = tool === 'ruler' && rulerState === 'drawing' && isMobilePortrait();
    stopBtn.classList.toggle('ruler-stop-btn--visible', active);
    // Hide cooldown bar while the stop button is showing to avoid overlap
    const bar = document.getElementById('cooldownBar');
    if (bar) bar.style.setProperty('opacity', active ? '0' : '', 'important');
  };

  stopBtn.addEventListener('click', () => {
    // Cancel the in-progress ruler and switch back to brush
    rulerState = 'idle';
    rulerStart = null;
    rulerLiveEnd = null;
    setTool('brush');
    redraw();
  });

  // Also re-evaluate on orientation change
  window.matchMedia('(max-width: 720px) and (orientation: portrait)')
    .addEventListener('change', () => window._updateRulerStopBtn());
})();

// ═══════════════════════════════════════════════════════════════════
// ── MOBILE LB TOGGLE HEIGHT — track tool-list dynamically ───────────
// Sets --lb-tool-list-bottom on :root so the leaderboard toggle tab
// always sits just above the tool-list regardless of its current height.
// ═══════════════════════════════════════════════════════════════════
(function () {
  function updateLbToggleBottom() {
    const toolList = document.querySelector('.tool-list');
    if (!toolList) return;
    const rect = toolList.getBoundingClientRect();
    const fromBottom = window.innerHeight - rect.top;
    document.documentElement.style.setProperty(
      '--lb-tool-list-bottom', fromBottom + 'px'
    );
  }

  // Run immediately, on resize, and on orientation change
  updateLbToggleBottom();
  window.addEventListener('resize', updateLbToggleBottom);
  window.addEventListener('orientationchange', updateLbToggleBottom);

  // Also re-measure after the first paint since fixed elements may shift
  requestAnimationFrame(() => { updateLbToggleBottom(); });
})();

window.addEventListener('load', () => {
  // 1. Size the canvas and draw the white board instantly (fixes the blue flash)
  resizeViewport();
  syncUI();

  // 2. Fetch server data asynchronously in the background
  initPalette();

  // On local dev / mobileDebug origins skip the login overlay entirely.
  // For genuine localhost we use the hardcoded 'dev' username (no network
  // round-trip needed).  For LAN IPs we call /api/me so the server can
  // return the real anon-<octet> username it assigned via localBypassMiddleware.
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
            // Fallback: derive username from hostname last octet
            const parts = window.location.hostname.split('.');
            setCurrentUser('anon-' + parts[parts.length - 1], true);
          }
        })
        .catch(() => {
          setCurrentUser('anon-local', true);
        });
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
  // Streak/stats fetched after auth resolves (handled in setCurrentUser)
});

(function () {
  const SPAWN_COOLDOWN_MS = 7000;
  let lastSpawnAt = 0;
  let spawnCooldownTimer = null;

  const spawnBtn = document.getElementById('spawn-btn');

  function updateSpawnBtn(remaining) {
    if (remaining > 0) {
      spawnBtn.disabled = true;
      spawnBtn.textContent = `Go (${Math.ceil(remaining / 1000)}s)`;
    } else {
      spawnBtn.disabled = false;
      spawnBtn.textContent = 'Go';
    }
  }

  spawnBtn.addEventListener('click', () => {
    const now = Date.now();
    const remaining = SPAWN_COOLDOWN_MS - (now - lastSpawnAt);
    if (remaining > 0) return;

    const spawnXInput = document.getElementById('spawn-x');
    const spawnYInput = document.getElementById('spawn-y');
    const spawnZoomInput = document.getElementById('spawn-zoom');

    const targetX = parseInt(spawnXInput.value, 10);
    const targetY = parseInt(spawnYInput.value, 10);
    let targetZoomPercent = parseInt(spawnZoomInput.value, 10);

    if (isNaN(targetX) || isNaN(targetY)) {
      alert('Please enter valid X and Y coordinates.');
      return;
    }
    if (isNaN(targetZoomPercent) || targetZoomPercent <= 0) {
      targetZoomPercent = 4500;
    }

    scale = clamp(targetZoomPercent / 100, 0.05, MAX_ZOOM_SCALE);

    const rect = viewport.getBoundingClientRect();
    offsetX = rect.width / 2 - targetX * scale;
    offsetY = rect.height / 2 - targetY * scale;

    zoomInput.value = Math.round(scale * 100);
    dispatchStateChange({ zoomLevel: Math.round(scale * 100) });

    clampOffsets();
    redraw();

    // Start cooldown
    lastSpawnAt = Date.now();
    if (spawnCooldownTimer) clearInterval(spawnCooldownTimer);
    spawnCooldownTimer = setInterval(() => {
      const rem = SPAWN_COOLDOWN_MS - (Date.now() - lastSpawnAt);
      updateSpawnBtn(rem);
      if (rem <= 0) {
        clearInterval(spawnCooldownTimer);
        spawnCooldownTimer = null;
      }
    }, 200);
    updateSpawnBtn(SPAWN_COOLDOWN_MS);
  });
})();

function moveColorFocus(dx, dy) {
  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const cols = 6;
  const currentIndex = sourcePalette.findIndex(p => normalizeHexColor(p.color) === normalizeHexColor(color));
  
  if (currentIndex === -1) return;

  const row = Math.floor(currentIndex / cols);
  const col = currentIndex % cols;

  const newRow = row + dy;
  const newCol = col + dx;

  if (newCol < 0 || newCol >= cols || newRow < 0) return;
  const newIndex = newRow * cols + newCol;

  if (newIndex >= 0 && newIndex < sourcePalette.length) {
    setColor(sourcePalette[newIndex].color);
  }
}


// --- TOPBAR DRAG LOGIC ---
// Uses scrollLeft instead of transform so the header never shrinks away
// from the right edge (which exposed the background behind it).
// Q / E (and < / >) scroll the topbar left/right without conflicting
// with the arrow keys that move the canvas cursor.
(function () {
  const header = document.querySelector('header.flex');
  const handle = document.getElementById('topbar-drag-handle');
  if (!header || !handle) return;

  let dragging = false;
  let startClientX = 0;
  let startScrollLeft = 0;

  function onDown(e) {
    dragging = true;
    startClientX = e.touches ? e.touches[0].clientX : e.clientX;
    startScrollLeft = header.scrollLeft;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    // drag left = positive delta = scroll right into overflow
    const delta = startClientX - clientX;
    header.scrollLeft = Math.max(0, startScrollLeft + delta);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown',  onDown, { passive: false });
  handle.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup',  onUp);
  document.addEventListener('touchend', onUp);
  window.addEventListener('resize', () => { header.scrollLeft = 0; });

  // Q = scroll topbar left, E = scroll topbar right
  // These keys are exposed globally so the keydown handler below can call them.
  const TOPBAR_SCROLL_STEP = 120; // CSS pixels per key press
  window._scrollTopbarLeft  = () => { header.scrollLeft = Math.max(0, header.scrollLeft - TOPBAR_SCROLL_STEP); };
  window._scrollTopbarRight = () => { header.scrollLeft += TOPBAR_SCROLL_STEP; };
})();

// --- FULLSCREEN LOGIC ---
const fullscreenBtn = document.getElementById('fullscreen-btn');
const fsIconEnter = document.getElementById('fs-icon-enter');
const fsIconExit = document.getElementById('fs-icon-exit');

if (fullscreenBtn) {
  // Core fullscreen toggle function
  const toggleFullscreen = (event) => {
    // Crucial: Stop the canvas behind it from intercepting the tap/click
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    fullscreenBtn.blur();
    const fsTarget = document.documentElement;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (fsTarget.requestFullscreen) {
        fsTarget.requestFullscreen().catch(err => console.error("Fullscreen error:", err));
      } else if (fsTarget.webkitRequestFullscreen) {
        fsTarget.webkitRequestFullscreen(); // Safari/iOS fallback
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  };

  // Bind to both click (desktop) and touchend (mobile) directly
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  fullscreenBtn.addEventListener('touchend', toggleFullscreen, { passive: false });

  const handleFullscreenChange = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (fsIconEnter) fsIconEnter.style.display = 'none';
      if (fsIconExit) fsIconExit.style.display = 'block';
    } else {
      if (fsIconEnter) fsIconEnter.style.display = 'block';
      if (fsIconExit) fsIconExit.style.display = 'none';
    }
    
    if (typeof resizeViewport === 'function') {
      setTimeout(resizeViewport, 150);
    }
  };

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}

// --- MOBILE TOUCH LOGIC ---
let lastTouchDistance = 0;
let isTouchDragging = false;
let lastTouchX = 0;
let lastTouchY = 0;
/** True while a single-finger touch pan is actively moving — suppresses cursor overlay redraws. */
let isTouchPanning = false;
/** rAF id for batched pinch-zoom redraws — ensures at most one redraw per frame during pinch. */
let _touchPinchRafId = null;
/** CSS-px position where the current touch began — used to measure drag distance for the ruler tool. */
let touchStartX = 0;
let touchStartY = 0;
/** Cumulative CSS-px travel of the current touch (ruler uses a larger tap threshold than other tools). */
let touchTotalTravel = 0;

/** True when a touch started on a UI control (palette, toolbar, etc.) — suppresses tap-to-place. */
let touchStartedOnUI = false;

// Mark touches that start on any UI control outside the drawing surface so they don't place pixels.
// Note: #fullscreen-palette and #fullscreen-btn live inside #viewport in the DOM, so we must
// explicitly exclude them in addition to anything outside the viewport entirely.
const _uiLayersInsideViewport = [
  document.getElementById('fullscreen-palette'),
  document.getElementById('fullscreen-btn'),
];

document.addEventListener("touchstart", (e) => {
  const target = e.target;
  const insideViewport = viewport.contains(target);
  const onUILayer = _uiLayersInsideViewport.some(el => el && el.contains(target));
  touchStartedOnUI = !insideViewport || onUILayer;
}, { passive: true, capture: true });

viewport.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchTotalTravel = 0;
    isTouchDragging = false;
  } else if (e.touches.length === 2) {
    e.preventDefault(); // Stop native 2-finger zoom gestures
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDistance = Math.hypot(dx, dy);
  }
}, { passive: false });

viewport.addEventListener("touchmove", (e) => {
  e.preventDefault(); // Stops pulling-to-refresh & native web scroll

  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;
    
    // Accumulate total travel so the ruler tool can use its own larger tap threshold.
    touchTotalTravel += Math.hypot(dx, dy);

    // Threshold to prevent jittering taps.
    // The ruler tool uses its own travel-based check in touchend, so we only
    // set isTouchDragging here for non-ruler tools (or when travel is clearly a pan).
    const dragThreshold = tool === 'ruler' ? 20 : 3;
    if (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) {
      isTouchDragging = true;
      isTouchPanning = true;
    }

    // Round at write time so offsetX/Y are always whole numbers.
    // Storing fractional values and rounding only inside redraw() causes
    // a 1px oscillation on every frame — the visible pan jitter on mobile.
    offsetX = Math.round(offsetX + dx);
    offsetY = Math.round(offsetY + dy);
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;

    clampOffsets();

    // If ruler is drawing, update live end from touch position
    if (tool === 'ruler' && rulerState === 'drawing') {
      const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
      rulerUpdateLiveEnd(coords.x, coords.y);
    }

    redraw();
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const distance = Math.hypot(dx, dy);

    if (lastTouchDistance) {
      const delta = distance - lastTouchDistance;
      const centerClientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerClientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      // Zoom towards center of the pinch
      const rect = viewport.getBoundingClientRect();
      const mouseX = centerClientX - rect.left;
      const mouseY = centerClientY - rect.top;

      const boardX = (mouseX - offsetX) / scale;
      const boardY = (mouseY - offsetY) / scale;

      let nextZoom = scale * (1 + delta * 0.005);
      nextZoom = clamp(nextZoom, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
      scale = nextZoom;

      // Round at write time — same reason as the pan path above
      offsetX = Math.round(mouseX - boardX * scale);
      offsetY = Math.round(mouseY - boardY * scale);

      clampOffsets();
      zoomInput.value = Math.round(scale * 100);
      dispatchStateChange({ zoomLevel: Math.round(scale * 100) });

      // Batch into rAF — pinch fires many events per frame on high-DPI screens.
      if (!_touchPinchRafId) {
        _touchPinchRafId = requestAnimationFrame(() => {
          _touchPinchRafId = null;
          redraw();
        });
      }
    }
    lastTouchDistance = distance;
  }
}, { passive: false });

viewport.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) {
    lastTouchDistance = 0;
  }
  
  // If one finger is left on the screen after a pinch, 
  // re-anchor the coordinates to that specific finger so the camera doesn't jump.
  if (e.touches.length === 1) {
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    isTouchDragging = true; // Mark as dragging so it doesn't accidentally drop a pixel
  }

  // Finger lifted — stop suppressing cursor overlay
  if (e.touches.length === 0) {
    isTouchPanning = false;
    // Full redraw to restore cursor overlay now that panning stopped
    redraw();
  }
  
  // TAP TO PLACE: If it was 1 finger, it ended, didn't drag, and started on the canvas (not a palette/UI tap)
  // Skip when hand tool is active — hand tool only pans, never places pixels
  // For the ruler tool, determine tap vs pan using total touch travel rather than
  // the per-move delta flag — this tolerates the natural finger jitter on mobile
  // that would otherwise prevent setting ruler points. 20px is generous enough
  // to absorb hold-still jitter but small enough not to swallow intentional pans.
  const wasRulerTap = tool === 'ruler'
    && !touchStartedOnUI
    && e.changedTouches.length === 1
    && e.touches.length === 0
    && touchTotalTravel < 20;

  if ((!isTouchDragging || wasRulerTap) && !touchStartedOnUI && tool !== 'hand' && e.changedTouches.length === 1 && e.touches.length === 0) {
     if (_eyedropperJustFired) { _eyedropperJustFired = false; return; }
     const touch = e.changedTouches[0];
     // iOS reports clientY at the TOP of the contact ellipse, not its center.
     // Adding half the vertical touch diameter corrects the perceived tap
     // position so the pixel lands where the majority of the finger was.
     //
     // touch.radiusY is in *physical* pixels on some browsers (notably Chrome
     // on Android) and in CSS pixels on others (Safari/iOS).  Dividing by
     // devicePixelRatio normalises it to CSS pixels in both cases.  When DPR
     // is 1 (desktop) this is a no-op.
     //
     // When the browser is pinch-zoomed OUT (vvScale < 1), clientX/Y are in
     // layout pixels but radiusY (after /dpr) is still in visual CSS pixels.
     // We must divide by vvScale to bring it into the same layout-pixel space
     // as clientY so the offset doesn't overshoot at non-100% browser zoom.
     const dpr = window.devicePixelRatio || 1;
     const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;
     // Both iOS and Android report clientY at or near the TOP of the touch
     // contact ellipse rather than its centroid, so placed pixels appear lower
     // than where the finger landed.  We correct by shifting clientY upward by
     // half the contact height (radiusY), normalised to CSS pixels.
     //
     // radiusY on iOS is in CSS pixels (already scaled by DPR internally).
     // radiusY on Android/Chrome is in physical px — divide by DPR to get CSS px.
     // We then divide by vvScale to convert from visual-CSS px to layout px,
     // matching the coordinate space of clientY.
     //
     // We cap the correction at 14 CSS px to avoid overshooting on
     // unusually large or missing radiusY values.
     const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
                   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
     let adjustedClientY = touch.clientY;
     // Raw radiusY → normalise to layout-CSS px
     const rawRadiusY = touch.radiusY || 0;
     // iOS reports radiusY in CSS px; Android in physical px
     const radiusCssPx = isIOS ? rawRadiusY : rawRadiusY / dpr;
     // Convert visual-CSS px to layout px (matters when browser is pinch-zoomed)
     const radiusLayoutPx = radiusCssPx / vvScale;
     // Half the contact height = centroid offset; clamp to [4, 14] CSS px
     const yCorrection = Math.min(Math.max(radiusLayoutPx * 0.5, 4), 14);
     adjustedClientY = touch.clientY - yCorrection;
     const coords = getCanvasCoords(touch.clientX, adjustedClientY);
     // Snap cursorPosition to the exact tap location BEFORE placing.
     // On Android, touchmove fires for tiny jitter during a tap and leaves
     // cursorPosition at a slightly wrong cell. Without this snap, any code
     // path that reads cursorPosition (e.g. handleAction) would place the
     // pixel one cell off from where the finger actually landed.
     cursorPosition = { x: coords.x, y: coords.y };
     applyToolAtCell(coords.x, coords.y);
  }
});

// ─── LEADERBOARD + PROFILE ──────────────────────────────────────────────────
(function initLeaderboard() {
  const panel        = document.getElementById('lb-panel');
  const toggle       = document.getElementById('lb-toggle');
  const list         = document.getElementById('lb-list');
  const dateEl       = document.getElementById('lb-date');
  const filtersEl    = document.getElementById('lb-filters');
  const resetNote    = document.getElementById('lb-reset-note');
  const profileStrip = document.getElementById('lb-profile-strip');
  const profileAvatar= document.getElementById('lb-profile-avatar');
  const profileName  = document.getElementById('lb-profile-name');
  const profileSub   = document.getElementById('lb-profile-sub');

  // Profile modal elements
  const modalOverlay = document.getElementById('profile-modal-overlay');
  const pmAvatar     = document.getElementById('pm-avatar');
  const pmUsername   = document.getElementById('pm-username');
  const pmSub        = document.getElementById('pm-sub');
  const pmTotal      = document.getElementById('pm-total');
  const pmToday      = document.getElementById('pm-today');
  const pmRank       = document.getElementById('pm-rank');
  const pmRecent     = document.getElementById('pm-recent-pixels');
  const pmClose      = document.getElementById('pm-close');

  if (!panel || !toggle || !list) return;

  let isOpen = false;
  let activePeriod = 'today';

  // ── Period filter buttons ──────────────────────────────────
  if (filtersEl) {
    filtersEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.lb-filter-btn');
      if (!btn) return;
      filtersEl.querySelectorAll('.lb-filter-btn').forEach(b => b.classList.remove('lb-filter-active'));
      btn.classList.add('lb-filter-active');
      activePeriod = btn.dataset.period;
      hasFetchedOnce = false; // Show loading indicator for the newly selected period

      // Update reset note text
      if (resetNote) {
        resetNote.textContent = activePeriod === 'today'
          ? 'Today resets at midnight · UTC−4'
          : `Showing ${activePeriod === 'alltime' ? 'all-time' : activePeriod} totals`;
      }

      fetchLeaderboard();
    });
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('lb-open');
  }

  toggle.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('lb-open', isOpen);
    SFX.play(isOpen ? 'leaderboard-open' : 'leaderboard-close', 300, 0.45);
    if (isOpen) fetchLeaderboard();
  });

  window.addEventListener('sp-state-change', (e) => {
    if (e.detail && e.detail.currentUser !== undefined) {
      updateProfileStrip(e.detail.currentUser);
      if (e.detail.currentUser === null) closePanel();
    }
  });

  // ── Profile strip update ────────────────────────────────────
  function updateProfileStrip(username) {
    if (!profileName || !profileAvatar || !profileSub) return;
    if (!username) {
      profileAvatar.textContent = '?';
      profileName.textContent = 'Not logged in';
      profileSub.textContent = 'Sign in to track pixels';
      return;
    }
    profileAvatar.textContent = username.charAt(0);
    profileName.textContent = username;
    profileSub.textContent = 'Tap to view your profile';
  }

  // ── Profile modal ───────────────────────────────────────────
  async function openProfileModal(username) {
    if (!modalOverlay || !username) return;
    pmAvatar.textContent = username.charAt(0);
    pmUsername.textContent = username;
    pmSub.textContent = 'Loading stats…';
    pmTotal.textContent = '—';
    pmToday.textContent = '—';
    pmRank.textContent = '—';
    pmRecent.innerHTML = '<span class="pm-loading">Loading…</span>';
    modalOverlay.classList.add('pm-open');

    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
      if (!res.ok) throw new Error('Profile fetch failed');
      const d = await res.json();
      pmSub.textContent = `${(d.totalPixels || 0).toLocaleString()} pixels total`;
      pmTotal.textContent = (d.totalPixels || 0).toLocaleString();
      pmToday.textContent = (d.todayPixels || 0).toLocaleString();
      pmRank.textContent = d.allTimeRank ? `#${d.allTimeRank}` : '—';

      // Streak display
      const pmStreakEl = document.getElementById('pm-streak');
      if (pmStreakEl) {
        pmStreakEl.textContent = d.currentStreak
          ? `🔥 ${d.currentStreak} day${d.currentStreak !== 1 ? 's' : ''} (best: ${d.longestStreak})`
          : '—';
      }

      // Most-used color swatch
      const pmColorEl = document.getElementById('pm-fav-color');
      if (pmColorEl) {
        if (d.mostUsedColor) {
          pmColorEl.style.background = d.mostUsedColor;
          pmColorEl.title = d.mostUsedColor.toUpperCase();
          pmColorEl.style.display = '';
        } else {
          pmColorEl.style.display = 'none';
        }
      }

      // Achievements
      const pmAchEl = document.getElementById('pm-achievements');
      if (pmAchEl) {
        if (d.achievements && d.achievements.length > 0) {
          pmAchEl.innerHTML = d.achievements.map(a => {
            const def = ACHIEVEMENT_DEFS.find(x => x.id === a.achievement_id);
            return def ? `<span class="pm-ach-badge" title="${def.label}: ${def.desc}">${def.icon}</span>` : '';
          }).join('');
        } else {
          pmAchEl.innerHTML = '<span style="color:#475569;font-size:0.8rem">No achievements yet.</span>';
        }
      }

      if (d.recentPixels && d.recentPixels.length > 0) {
        pmRecent.innerHTML = d.recentPixels.map(p => {
          const safeX = parseInt(p.x, 10) || 0;
          const safeY = parseInt(p.y, 10) || 0;
          
          const isErase = p.color === 'erase';
          
          // Using clean Base64 with no quotes inside url() ensures it never breaks HTML rendering
          const styleRule = isErase
            ? `background-image: url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjMWUyOTNiIiByeD0iMiIvPjxwYXRoIGQ9Ik00IDRsOCA4TTEyIDRMNCAxMiIgc3Ryb2tlPSIjZWY0NDQ0IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==); background-size: cover;`
            : `background: ${normalizeHexColor(String(p.color || '#888'))};`;
            
          const tooltipText = isErase 
            ? `(${safeX},${safeY}) Erased` 
            : `(${safeX},${safeY}) ${normalizeHexColor(String(p.color || '#888'))}`;

          return `<div class="pm-pixel-dot" style="${styleRule}" title="${tooltipText}"></div>`;
        }).join('');
      } else {
        pmRecent.innerHTML = '<span style="color:#475569;font-size:0.82rem;font-style:italic;">No pixels placed yet.</span>';
      }
    } catch {
      pmSub.textContent = 'Could not load profile.';
    }
  }

  function closeProfileModal() {
    if (modalOverlay) modalOverlay.classList.remove('pm-open');
  }

  if (profileStrip) {
    profileStrip.addEventListener('click', () => {
      if (currentUser) openProfileModal(currentUser);
    });
  }

  if (pmClose) pmClose.addEventListener('click', closeProfileModal);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeProfileModal();
    });
  }

  // Allow clicking a username in the leaderboard list to open their profile
  if (list) {
    list.addEventListener('click', (e) => {
      const span = e.target.closest('.lb-username');
      if (!span) return;
      const username = span.dataset.username;
      if (username) openProfileModal(username);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────
  function todayUTC4() {
    const d = new Date(Date.now() - 4 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function msUntilMidnightUTC4() {
    const now = new Date();
    const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const nextMidnight = new Date(utc4);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    return nextMidnight.getTime() - utc4.getTime();
  }

  // ── Render ───────────────────────────────────────────────────
  function render(rows) {
    dateEl.textContent = todayUTC4();
    if (!rows || rows.length === 0) {
      list.innerHTML = '<li class="lb-empty">No pixels placed yet.</li>';
      return;
    }

    const rankSymbols = ['🥇', '🥈', '🥉'];
    const rankClasses = ['lb-rank--gold', 'lb-rank--silver', 'lb-rank--bronze'];

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    list.innerHTML = rows.map((row, i) => {
      const rankContent = i < 3 ? rankSymbols[i] : `${i + 1}`;
      const rankCls = i < 3 ? rankClasses[i] : '';
      const isMe = currentUser && row.username === currentUser;
      const safeUsername = escHtml(row.username);
      return `
        <li class="${isMe ? 'lb-me' : ''}">
          <span class="lb-rank ${rankCls}">${rankContent}</span>
          <span class="lb-username" data-username="${safeUsername}" title="View ${safeUsername}'s profile">${safeUsername}</span>
          <span class="lb-count">${Number(row.count).toLocaleString()} px</span>
        </li>`;
    }).join('');
  }

  let hasFetchedOnce = false;

  async function fetchLeaderboard() {
    // Only show the loading placeholder on the very first fetch.
    // Subsequent refreshes update the list silently so there's no flash.
    if (!hasFetchedOnce) {
      list.innerHTML = '<li class="lb-loading">Loading…</li>';
    }
    try {
      const res = await fetch(`/api/leaderboard?period=${activePeriod}`);
      if (!res.ok) throw new Error('Leaderboard fetch failed');
      const data = await res.json();
      render(data.leaderboard || []);
      hasFetchedOnce = true;
    } catch {
      // Only replace content with error if we haven't shown real data yet
      if (!hasFetchedOnce) {
        list.innerHTML = '<li class="lb-loading">Unable to load…</li>';
      }
    }
  }

  // Auto-refresh every 10 s when open
  setInterval(() => { if (isOpen) fetchLeaderboard(); }, 10_000);

  // Instant refresh whenever any pixel is placed — own tab, other tab, or other player via SSE
  window.addEventListener('sp-pixel-placed', () => {
    if (isOpen) fetchLeaderboard();
  });

  // Scheduled reset at UTC-4 midnight
  function scheduleReset() {
    const delay = msUntilMidnightUTC4();
    setTimeout(() => {
      if (isOpen) fetchLeaderboard();
      scheduleReset();
    }, delay);
  }
  scheduleReset();

  // ── Expose openProfileModal globally so chat.js can open profiles on username click
  window.__openProfile = function (username) {
    openProfileModal(username);
  };
})();

// ── Password visibility toggle (auth form) ─────────────────────────────────
const togglePasswordBtn = document.getElementById('togglePassword');
const eyeIconOpen       = document.getElementById('eyeIconOpen');
const eyeIconClosed     = document.getElementById('eyeIconClosed');

// Replace any <img src="...eye-*.svg"> with inline SVGs so the browser
// never makes an HTTP request for image files that may not exist on disk.
// This eliminates the 404 logged in the console for eye-closed.svg.
const EYE_OPEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

if (eyeIconOpen  && eyeIconOpen.tagName  === 'IMG') { eyeIconOpen.outerHTML  = `<span id="eyeIconOpen"  style="display:inline-flex;align-items:center;pointer-events:none;">${EYE_OPEN_SVG}</span>`; }
if (eyeIconClosed && eyeIconClosed.tagName === 'IMG') { eyeIconClosed.outerHTML = `<span id="eyeIconClosed" style="display:none;align-items:center;pointer-events:none;">${EYE_CLOSED_SVG}</span>`; }

if (togglePasswordBtn && authPassword) {
  // Re-query after potential outerHTML replacement above
  const getEyeOpen   = () => document.getElementById('eyeIconOpen');
  const getEyeClosed = () => document.getElementById('eyeIconClosed');
  togglePasswordBtn.addEventListener('click', () => {
    const isHidden = authPassword.type === 'password';
    authPassword.type = isHidden ? 'text' : 'password';
    const eo = getEyeOpen();
    const ec = getEyeClosed();
    if (eo) eo.style.display   = isHidden ? 'none'         : 'inline-flex';
    if (ec) ec.style.display   = isHidden ? 'inline-flex'  : 'none';
  });
}

// ── Forgot / Reset password flow ───────────────────────────────────────────
const resetOverlay     = document.getElementById('resetPasswordOverlay');
const resetModalClose  = document.getElementById('resetModalClose');
const resetStep1       = document.getElementById('resetStep1');
const resetStep2       = document.getElementById('resetStep2');
const resetEmailInput  = document.getElementById('resetEmail');
const resetNewPassword = document.getElementById('resetNewPassword');
const resetSendBtn     = document.getElementById('resetSendBtn');
const resetConfirmBtn  = document.getElementById('resetConfirmBtn');
const resetMessage     = document.getElementById('resetMessage');
const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
const forgotPasswordRow = document.getElementById('forgotPasswordRow');

// Toggle password eye on reset modal
const toggleResetPasswordBtn = document.getElementById('toggleResetPassword');
const resetEyeIconOpen       = document.getElementById('resetEyeIconOpen');
const resetEyeIconClosed     = document.getElementById('resetEyeIconClosed');
if (toggleResetPasswordBtn && resetNewPassword && resetEyeIconOpen && resetEyeIconClosed) {
  toggleResetPasswordBtn.addEventListener('click', () => {
    const isHidden = resetNewPassword.type === 'password';
    resetNewPassword.type = isHidden ? 'text' : 'password';
    resetEyeIconOpen.style.display   = isHidden ? 'none' : '';
    resetEyeIconClosed.style.display = isHidden ? ''     : 'none';
  });
}

function showResetMessage(msg, isError = true) {
  if (!resetMessage) return;
  resetMessage.textContent = msg;
  resetMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function openResetModal(showStep2 = false, token = '') {
  if (!resetOverlay) return;
  resetOverlay.style.display = 'grid';
  showResetMessage('');
  if (showStep2) {
    if (resetStep1) resetStep1.style.display = 'none';
    if (resetStep2) resetStep2.style.display = '';
    resetOverlay._resetToken = token;
  } else {
    if (resetStep1) resetStep1.style.display = '';
    if (resetStep2) resetStep2.style.display = 'none';
    resetOverlay._resetToken = '';
    if (resetEmailInput) resetEmailInput.value = '';
    if (resetNewPassword) resetNewPassword.value = '';
  }
}

function closeResetModal() {
  if (resetOverlay) resetOverlay.style.display = 'none';
}

if (forgotPasswordBtn) {
  forgotPasswordBtn.addEventListener('click', () => openResetModal(false));
}
if (resetModalClose) {
  resetModalClose.addEventListener('click', closeResetModal);
}
if (resetOverlay) {
  resetOverlay.addEventListener('click', (e) => {
    if (e.target === resetOverlay) closeResetModal();
  });
}

// Hide "Forgot password?" in register mode
const origSetAuthMode = typeof setAuthMode === 'function' ? setAuthMode : null;
// Patch via MutationObserver since setAuthMode is defined in the same closure
if (forgotPasswordRow) {
  const authTabLoginEl    = document.getElementById('authTabLogin');
  const authTabRegisterEl = document.getElementById('authTabRegister');
  function syncForgotRow() {
    const isRegister = authTabRegisterEl &&
      authTabRegisterEl.classList.contains('bg-white/10');
    forgotPasswordRow.style.display = isRegister ? 'none' : '';
  }
  if (authTabLoginEl)    authTabLoginEl.addEventListener('click',    syncForgotRow);
  if (authTabRegisterEl) authTabRegisterEl.addEventListener('click', syncForgotRow);
}

// Send reset email
if (resetSendBtn) {
  resetSendBtn.addEventListener('click', async () => {
    const email = resetEmailInput ? resetEmailInput.value.trim() : '';
    if (!email) { showResetMessage('Enter your email address.'); return; }
    resetSendBtn.disabled = true;
    resetSendBtn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Always show success to avoid leaking whether an email exists
      showResetMessage('If that email is registered, a reset link has been sent. Check your inbox (and spam folder).', false);
      resetSendBtn.textContent = 'Sent!';
    } catch {
      showResetMessage('Unable to reach server. Try again.');
      resetSendBtn.disabled = false;
      resetSendBtn.textContent = 'Send reset link';
    }
  });
}

// Confirm new password
if (resetConfirmBtn) {
  resetConfirmBtn.addEventListener('click', async () => {
    const password = resetNewPassword ? resetNewPassword.value : '';
    const token = resetOverlay ? resetOverlay._resetToken : '';
    if (!password || password.length < 8) {
      showResetMessage('Password must be at least 8 characters.');
      return;
    }
    if (!token) { showResetMessage('Missing reset token.'); return; }
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        showResetMessage(data.error || 'Reset failed.');
        resetConfirmBtn.disabled = false;
        resetConfirmBtn.textContent = 'Set new password';
        return;
      }
      showResetMessage('Password updated! You can now log in.', false);
      resetConfirmBtn.textContent = 'Done ✓';
      // Remove the token from the URL so a reload doesn't re-open the modal
      const url = new URL(window.location.href);
      url.searchParams.delete('resetToken');
      window.history.replaceState({}, '', url.toString());
    } catch {
      showResetMessage('Unable to reach server.');
      resetConfirmBtn.disabled = false;
      resetConfirmBtn.textContent = 'Set new password';
    }
  });
}

// On load: check if URL has ?resetToken= and open step 2 automatically
(function checkResetToken() {
  const params = new URLSearchParams(window.location.search);
  const rt = params.get('resetToken');
  if (rt) openResetModal(true, rt);
})();

// ── Help section toggle (desktop only) ───────────────────────────────────────
(function initHelpToggle() {
  const btn = document.getElementById('help-toggle-btn');
  const content = document.getElementById('help-section-content');
  if (!btn || !content) return;

  // On desktop (hover: hover) the CSS hides .help-list by default.
  // Set aria-hidden to match the hidden CSS state on desktop; on mobile
  // the button is hidden via CSS and the list is always visible.
  const isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (isDesktop) {
    content.setAttribute('aria-hidden', 'true');
  }

  btn.addEventListener('click', () => {
    const section = btn.closest('section');
    const isOpen = section.classList.toggle('help-section-open');
    btn.textContent = isOpen ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', String(isOpen));
    content.setAttribute('aria-hidden', String(!isOpen));
  });
})();

}); // end DOMContentLoaded