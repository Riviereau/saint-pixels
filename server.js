require('dotenv').config();

const express  = require('express');
const helmet   = require('helmet');
const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');
const os       = require('os');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const app = express();

// Trust the first reverse-proxy hop so req.ip is the real client IP
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// CSP is applied per-request so we can embed a fresh cryptographic nonce on
// every response. The nonce is injected into the HTML (replacing the
// __CSP_NONCE__ placeholder in index.html) and into the CSP header, meaning
// only script tags that carry that exact nonce value are allowed to execute.
// This eliminates the need for 'unsafe-inline' and 'unsafe-eval'.
app.use((req, res, next) => {
  // Generate a fresh 128-bit nonce for every request.
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use((req, res, next) => {
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc: [
        "'self'",
        // Per-request nonce covers all script tags we control (app.js, chat.js,
        // the inline rules script). Any tag without this nonce is blocked.
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
        // Fallback hashes for inline scripts that lack a nonce attribute.
        // Fallback hashes for inline scripts. Inline scripts should carry a
        // nonce="__CSP_NONCE__" — if one is missing the nonce, the browser will
        // report its hash here and it should be added. Once all inline scripts are
        // extracted to external files these entries can be removed.
        "'sha256-fhzTSFP/g8pZXkvs0zLgEc7vR12cQqDrjqwhNP7LoMA='",
        "'sha256-kgL4BeXu5i8IL19/h+xX29yxerkiRJAIMlaB16C9Z3c='",
        "'sha256-DKvyw+VPCZ+yYosvM7fBfmlQLJUOPR/XmndDIzBHCuk='",
        "'sha256-x3UaW7aTn2jCzxUxDrLUMzK5PLT7EZW2R8ZZV/nT5Hs='",
        // Rules window script — two hashes cover the file-as-uploaded and the
        // version the browser reported. The inline script has been moved to
        // /rules.js so these hashes are belt-and-suspenders for cached deployments.
        "'sha256-cTc7j0QRPd2lahucuGoesYnoiY20ld2VoJH/dI1jo1Q='",
        "'sha256-VRHni0ghwcE6k2ag6cOlYFcp2gCLPlFMjucv3rvRtEo='",
        "'sha256-5hcVLnyeg7ovvPCWy9TY4zmi3k8SnAhE/oa2/McvSwk='",
        // Hashes reported by browser for blocked inline/dynamic scripts (see CSP console errors).
        // These scripts are injected at runtime by third-party libraries (hCaptcha, Alpine, etc.)
        // and cannot carry a nonce, so their SHA-256 hashes must be listed here instead.
        "'sha256-6Y1r0ipW2nGvNHy99N0UdQ26IeVwb6LxPwoRtSyIJBc='",
        "'sha256-CslW5vTI7mG39IVtHaNDZyZVHaYIKdKoKJgse8X3zQk='",
        // Trusted CDN origins for external scripts.
        "https://cdn.tailwindcss.com",
        "https://cdn.jsdelivr.net",
        "https://js.hcaptcha.com",
        "https://newassets.hcaptcha.com",
        // 'unsafe-eval' is required by Alpine.js — it uses Function() internally
        // to evaluate x-data / x-on / x-bind expressions. There is no build-time
        // workaround when loading Alpine from a CDN. Acceptable risk because our
        // chat input is sanitised server-side and rendered as textContent (not
        // innerHTML), so injected payloads cannot reach eval().
        "'unsafe-eval'",
        // NOTE: 'unsafe-inline' is intentionally OMITTED here. Per the W3C CSP
        // spec, when a nonce-source is present in script-src, browsers
        // automatically ignore 'unsafe-inline' — keeping it only produces the
        // "Ignoring 'unsafe-inline'" console warning without any security benefit.
        // hCaptcha's inline scripts run inside its own sandboxed iframe, so they
        // are governed by the iframe's CSP, not this page's script-src.
      ],
      // Explicitly block inline event handlers (onsubmit, onclick attrs).
      // index.html no longer uses any, so this is safe.
      scriptSrcAttr: ["'none'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      frameSrc:   ["https://newassets.hcaptcha.com"],
      connectSrc: ["'self'", "https://hcaptcha.com", "https://*.hcaptcha.com"],
      imgSrc:     ["'self'", "data:"],
      // 'data:' allows the silent inline WAV used to unlock iOS audio on first
      // touch (the _unlockAudio() helper in app.js).  Without it, iOS falls back
      // to default-src 'self' which blocks data: URIs and silently drops every
      // subsequent SFX play() call — the user hears nothing.
      // 'blob:' covers browsers that resolve Audio.src to a blob: URL internally.
      mediaSrc:   ["'self'", "data:", "blob:"],
      fontSrc:    ["'self'"],
      upgradeInsecureRequests: null,
    },
  })(req, res, next);
});

// ── Additional security headers ───────────────────────────────────────────────
// Referrer-Policy: don't leak the full URL to third parties (hCaptcha CDN etc.)
// Permissions-Policy: explicitly revoke powerful APIs this app doesn't use.
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  next();
});

// ── Body parsing — hard cap to blunt large-payload floods ────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ── Database & Helpers ────────────────────────────────────────────────────────
const dbFile = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbFile);

// ── SQLite performance & concurrency pragmas ──────────────────────────────────
// WAL (Write-Ahead Logging): allows concurrent reads during writes — critical
// when SSE connections (reads) overlap with pixel placements (writes).
// Without WAL, SQLite uses exclusive write locks that block every reader.
db.pragma('journal_mode = WAL');
// Persist WAL across connections (default is DELETE which recreates on open).
db.pragma('wal_autocheckpoint = 1000');
// Synchronous = NORMAL: safe with WAL (no data loss on crash, only on OS crash),
// much faster than FULL (the default) which fsync()s on every transaction.
db.pragma('synchronous = NORMAL');
// 64 MB page cache — reduces disk I/O for the pixel table which is hot-read
// on every SSE connect (up to 500k rows scanned per new connection).
db.pragma('cache_size = -65536');
// Keep temp tables in memory rather than on disk.
db.pragma('temp_store = MEMORY');
// Busy timeout: if another writer holds the lock, wait up to 5 s before
// returning SQLITE_BUSY. Prevents spurious 500 errors under write bursts.
db.pragma('busy_timeout = 5000');

const { setDb: setSessionDb, createSession, closeSession, getSession } = require('./src/helpers/session.js');
const { setDb: setCooldownDb, getCooldown, COOLDOWN_MS } = require('./src/helpers/cooldown.js');

// ── Guest mode constants ──────────────────────────────────────────────────────
const GUEST_PIXEL_BUDGET = 300;
const GUEST_SESSION_MS   = 180 * 60 * 1000; // 180 minutes
const { setDb: setAntiCheatDb } = require('./src/helpers/AntiCheat.js');
const { checkIpBan, banCheckMiddleware, setDb: setBanDb } = require('./src/helpers/ban.js');
const { hashPassword, verifyPassword } = require('./src/helpers/password.js');
const { requireCaptcha }         = require('./src/helpers/captcha.js');
const { sendVerificationEmail }  = require('./src/helpers/mailer.js');
const { initializeActions }      = require('./src/setup/actions.js');
const { initializeDatabase, runMaintenance } = require('./src/setup/database.js');
const { initializeSSE, broadcastSSE, setDb: setSseDb } = require('./src/setup/sse.js');
const { initializeChat }         = require('./src/setup/chat.js');
const { initializeClan }         = require('./src/setup/clan.js');
const { initializeTimelapse }    = require('./src/setup/timelapse.js');
const { localBypassMiddleware }  = require('./src/helpers/localBypass.js');

// ── Local Bypass Middleware ───────────────────────────────────────────────────
app.use(localBypassMiddleware); // <-- Activates req.localBypassUser if valid

// ── Static files ──────────────────────────────────────────────────────────────
const fs        = require('fs');
const indexPath = path.join(__dirname, 'public', 'index.html');

// Cache index.html once at startup — avoids a synchronous fs read on every request.
let cachedIndexHtml = null;
try {
  cachedIndexHtml = fs.readFileSync(indexPath, 'utf8');
} catch (err) {
  console.error('Failed to pre-load index.html:', err);
}

// ── Index route: 120 req / min / IP ─────────────────────────────────────────
// Each hit does string replacement on cached HTML; cheap but still needs a
// tighter bound than the 600/min global limiter. Uses safeIp (IPv6-normalised)
// rather than the raw req.ip to stay consistent with all other limiters.
const indexLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

app.get('/', indexLimiter, (req, res) => {
  if (!cachedIndexHtml) return res.status(500).send('Server error.');
  try {
    let html = cachedIndexHtml.replace('__VITE_HCAPTCHA_SITEKEY__', process.env.HCAPTCHA_SITEKEY || '');

    // Inject the per-request CSP nonce into every <script> tag.
    // In index.html, add nonce="__CSP_NONCE__" to each <script> tag, e.g.:
    //   <script nonce="__CSP_NONCE__" src="..."></script>
    //   <script nonce="__CSP_NONCE__">/* inline alpine init */</script>
    // This placeholder is replaced here with the real nonce value, which must
    // match what the helmet CSP middleware emitted in res.locals.cspNonce.
    html = html.replaceAll('__CSP_NONCE__', res.locals.cspNonce);

    // Inject bypass flag if middleware detected a private IP + MOBILE_DEBUG=true
    if (req.localBypassUser) {
      html = html.replace('<html lang="en">', '<html lang="en" data-local-bypass="1">');
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Failed to serve index.html:', err);
    res.status(500).send('Server error.');
  }
});
// ── Favicon routes — explicit handlers so the browser tab icon always resolves ─
// Browsers auto-request /favicon.ico regardless of <link> tags in HTML.
// express.static only serves files that physically exist at the exact path
// requested; without these routes, a missing root-level favicon.ico returns 404
// and no icon appears in the tab.
// Ensure .avif files are served with the correct MIME type.
// Some Node/Express versions don't include image/avif in their default
// MIME map, which causes browsers to reject the image silently.
express.static.mime.define({ 'image/avif': ['avif'] });
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/favicon.ico', indexLimiter, (req, res) => {
  res.redirect(301, '/images/favicon.ico');
});

app.get('/favicon.svg', indexLimiter, (req, res) => {
  res.redirect(301, '/images/favicon.svg');
});



app.get('/apple-touch-icon.png', indexLimiter, (req, res) => {
  // Return 204 No Content when the file doesn't exist so the browser stops
  // logging a 404 for a missing touch icon instead of doing a redirect loop.
  const iconPath = path.join(__dirname, 'images', 'apple-touch-icon.png');
  if (fs.existsSync(iconPath)) {
    res.sendFile(iconPath);
  } else {
    res.status(204).end();
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/sfx', express.static(path.join(__dirname, 'sfx')));

// ── DB init & helpers ─────────────────────────────────────────────────────────
initializeDatabase(db);

// ── Scheduled maintenance — runs once on startup then every 6 hours ──────────
// Deletes expired sessions, used/expired tokens, and pixel_counts older than
// 366 days. Keeps the DB lean without touching any live data.
function scheduleMaintenance() {
  try {
    const deleted = runMaintenance(db);
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log('[maintenance] Cleaned up rows:', deleted);
    }
  } catch (err) {
    console.error('[maintenance] Error during maintenance:', err);
  }
  setTimeout(scheduleMaintenance, 6 * 60 * 60 * 1000);
}
scheduleMaintenance();

if (!process.env.APP_BASE_URL) {
  console.warn('[config] WARNING: APP_BASE_URL is not set. Email links will point to http://localhost:3000 which will NOT work in production.');
}
if (!process.env.RESEND_API_KEY) {
  console.warn('[config] WARNING: RESEND_API_KEY is not set. Emails will only be printed to the console.');
}

setSessionDb(db);
setCooldownDb(db);
setSseDb(db);
setAntiCheatDb(db);
setBanDb(db);

// ── Safe email validator — O(n), no backtracking, RFC 5321 length cap ────────
function isValidEmail(str) {
  if (!str || typeof str !== 'string' || str.length > 254) return false;
  const at = str.indexOf('@');
  if (at < 1) return false;
  const local  = str.slice(0, at);
  const domain = str.slice(at + 1);
  return (
    local.length > 0 &&
    local.length <= 64 &&
    domain.length > 0 &&
    domain.includes('.') &&
    !domain.startsWith('.') &&
    !domain.endsWith('.') &&
    !/\s/.test(str)
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  RATE LIMITERS & DDOS PROTECTION
// ══════════════════════════════════════════════════════════════════════════════

/** IPv6-safe IP string for use inside custom keyGenerators. */
function safeIp(req) {
  return ipKeyGenerator(req);
}

// ── Global limiter: 600 req / min / IP ───────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => (req.method === 'GET' && req.path === '/api/stream') ||
                 (req.method === 'GET' && req.path === '/api/health'),
});

// ── Health check — bypasses the global limiter so uptime monitors don't ──────
// burn rate-limit quota. Returns 200 + a tiny JSON payload.
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(globalLimiter);
app.use('/api', banCheckMiddleware);

// ── Maintenance mode ──────────────────────────────────────────────────────────
// Set MAINTENANCE_MODE=true in Railway env vars to activate.
// All routes below this point are blocked — visitors see maintenance.html.
// The /api/health check above is intentionally left outside so Railway's
// uptime monitor still gets a 200 while the site is in maintenance.
if (process.env.MAINTENANCE_MODE === 'true') {
  app.use((req, res) => {
    res.status(503).sendFile(path.join(__dirname, 'maintenance.html'));
  });
}

// ── Pixel limiter: 60 placements / min / IP ───────────────────────────────────
const pixelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many pixels placed. Slow down.' },
});

// ── Auth limiter: 20 login attempts / 15 min / IP ────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many attempts. Please try again later.' },
});

// ── Register limiter: 5 accounts / 10 min / IP ───────────────────────────────
const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many accounts created from this IP. Try again in 10 minutes.' },
});

// ── Resend-verification limiter: 3 / 10 min, keyed by username when available
const resendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (token) {
      try {
        const row = db.prepare('SELECT username FROM sessions WHERE token = ? AND expires_at > ?')
          .get(token, Date.now());
        if (row?.username) return `resend:user:${row.username}`;
      } catch { /* fall through */ }
    }
    return `resend:ip:${safeIp(req)}`;
  },
  message: { error: 'Too many resend requests. Please wait before trying again.' },
});

// ── Forgot-password limiter: 5 / 15 min / IP ─────────────────────────────────
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many reset requests. Please wait 15 minutes.' },
});

// ── Palette limiter: 30 req / min / IP ───────────────────────────────────────
// The palette is a full table scan that almost never changes.
// 120/min invited DB thrash under load; 30/min is more than enough for
// any legitimate client (typically fetched once at startup, then cached).
const paletteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many palette requests. Please slow down.' },
});

// ── Chat POST limiter: 20 messages / min, keyed by username when available ────
// Keyed by username (resolved from the session DB) rather than the raw Bearer
// token: a rotated or freshly-issued token would otherwise start a new bucket,
// letting a script bypass the limit by re-logging in between bursts.
// Falls back to IP so unauthenticated probes are still throttled.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    const [type, token] = auth.split(' ');
    if (type === 'Bearer' && token) {
      try {
        const row = db.prepare(
          'SELECT username FROM sessions WHERE token = ? AND expires_at > ?'
        ).get(token, Date.now());
        if (row?.username) return `chat:user:${row.username}`;
      } catch { /* fall through */ }
    }
    return `chat:ip:${safeIp(req)}`;
  },
  message: { error: 'Sending too fast. Please slow down.' },
});

// ── Chat history (GET) limiter: 60 req / min / IP ────────────────────────────
// Previously unlimited — an attacker could hammer GET /api/chat to force
// repeated full-table scans of chat_messages.
const chatHistoryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many history requests. Please slow down.' },
});

// ── Clan limiter: 30 req / min / IP ──────────────────────────────────────────
const clanLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: ipKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many clan requests. Slow down.' },
});

// ── /api/me limiter: 120 req / min / IP ──────────────────────────────────────
// /api/me does two DB lookups per call (session + account row).
// Without a limiter a script can poll it freely to exhaust DB read capacity.
const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

// ── Guest session limiter: 1 new session / hour / IP ─────────────────────────
// One guest account per IP per hour. Prevents farming fresh 300-pixel budgets
// by refreshing — sessionStorage restore means a legitimate visitor never needs
// a second session within the same hour window.
const guestSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many guest sessions from this IP. Try again in an hour.' },
});

const guestMeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

// ── /api/logout limiter: 30 req / min / IP ────────────────────────────────────
// Each logout does a DB DELETE; flooding it is cheap for the attacker but
// non-trivial for SQLite under write contention.
const logoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

// ── /api/verify-email limiter: 10 req / 15 min / IP ──────────────────────────
// Unguarded token lookups can be used to enumerate valid tokens via timing.
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many verification attempts. Please try again later.' },
});

// ── /api/reset-password limiter: 5 req / 15 min / IP ─────────────────────────
// CRITICAL: this endpoint calls bcrypt.hash() (expensive CPU) on every request.
// Without a limiter an attacker can trigger sustained bcrypt work to exhaust CPU.
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many reset attempts. Please try again later.' },
});

// ── SSE reconnect-rate limiter: max 20 new connections / 60 s / IP ───────────
const sseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many stream reconnects. Please wait a moment.' },
});

// ── SSE connection guard: max 10 concurrent SSE connections per IP ────────────
const sseConnectionsPerIp = new Map();
const SSE_MAX_PER_IP = 10;

function sseConnectionGuard(req, res, next) {
  const ip = safeIp(req);
  const current = sseConnectionsPerIp.get(ip) || 0;
  if (current >= SSE_MAX_PER_IP) {
    return res.status(429).json({ error: 'Too many SSE connections from this IP.' });
  }
  sseConnectionsPerIp.set(ip, current + 1);
  // Use once() — both 'finish' and 'close' can fire on the same response in
  // Node's keep-alive path, which would decrement the counter twice and corrupt
  // the per-IP count (allowing more connections than the cap allows).
  const _decrement = () => {
    const c = sseConnectionsPerIp.get(ip) || 1;
    if (c <= 1) sseConnectionsPerIp.delete(ip);
    else sseConnectionsPerIp.set(ip, c - 1);
  };
  res.once('close', _decrement);
  next();
}

// ── Actions & SSE ─────────────────────────────────────────────────────────────
initializeActions(app, db, pixelLimiter, (event) => {
  broadcastSSE(event);
  // Update streak whenever a pixel or erase is placed
  if ((event.type === 'pixel' || event.type === 'erase') && event.user) {
    try { updateStreak(event.user); } catch(e) { /* non-fatal */ }
  }
}, () => isEventActive() ? EVENT_COOLDOWN_MS : 0);
// SSE connections must not be subject to requestTimeout (30 s) — they are
// intentionally long-lived and would otherwise be killed by the server-wide
// timeout set below, causing Firefox to report "can't establish a connection".
// Disabling it per-socket here, before the rate limiter, ensures the timeout
// is cleared regardless of which middleware runs next.
app.use('/api/stream', (req, res, next) => {
  req.socket.setTimeout(0);          // disable socket inactivity timeout
  if (res.socket) res.socket.setTimeout(0);
  // Node 18+ exposes requestTimeout directly on the request; clear it too.
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
  next();
});
app.use('/api/stream', sseLimiter);

// NOTE: SSE keep-alive heartbeats are handled inside sse.js (every 20 s),
// which sends { type: 'ping' } as an unnamed data: message.  No second
// heartbeat middleware is needed here.

initializeSSE(app, db, sseConnectionGuard);

// ── Chat ──────────────────────────────────────────────────────────────────────
initializeChat(app, db, broadcastSSE, chatLimiter, chatHistoryLimiter);
initializeClan(app, db, broadcastSSE, clanLimiter);

// ── Timelapse API: 4 requests / 10 min / IP ───────────────────────────────────
// Timelapse renders are CPU-heavy (ffmpeg + canvas). Tight limit prevents a
// single caller from queuing up dozens of jobs that would saturate the server.
const timelapseLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many timelapse requests. Please wait before trying again.' },
});
initializeTimelapse(app, db, timelapseLimiter);

// ══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Register ──────────────────────────────────────────────────────────────────
app.post('/api/register', registerLimiter, requireCaptcha, async (req, res) => {
  const { username, password, email } = req.body || {};
  // Clamp to 45 chars (max IPv6 length) before storing — prevents an oversized
  // X-Forwarded-For value (possible with trust proxy enabled) bloating the DB.
  const ip = (req.ip || safeIp(req) || 'unknown').slice(0, 45);

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, hyphen, underscore.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 256)
    return res.status(400).json({ error: 'Password too long.' });
  if (!isValidEmail(email))
    return res.status(400).json({ error: 'A valid email address is required.' });

  try {
    const usernameTaken = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username);
    if (usernameTaken)
      return res.status(409).json({ error: 'Username already taken.' });
    const emailTaken    = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.toLowerCase());
    if (emailTaken)
      return res.status(409).json({ error: 'An account with that email already exists.' });

    // ── IP ban check — prevents banned players creating new accounts ──────────
    // Checked after username/email uniqueness so the error messages above still
    // fire for genuinely taken handles (avoids leaking ban status via 409 vs 403).
    const ipBan = checkIpBan(ip);
    if (ipBan.found) {
      return res.status(403).json({ error: ipBan.reason });
    }
    // ── end IP ban check ──────────────────────────────────────────────────────

    const hashed = await hashPassword(password);
    db.prepare('INSERT INTO accounts (username, password, ip, created_at, email, email_verified) VALUES (?, ?, ?, ?, ?, 0)')
      .run(username, hashed, ip, Date.now(), email.toLowerCase());

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO email_verifications (username, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(username, verifyToken, now, now + 24 * 60 * 60 * 1000);

    sendVerificationEmail(email, username, verifyToken).catch(err => {
      console.error('[register] Failed to send verification email:', err.message);
    });

    const token = createSession(username);
    return res.json({ 
      username, 
      token, 
      emailVerified: false, 
      message: 'Account created! Check your email to verify your address.',
      cooldown: 0, // New users have no initial cooldown
      cooldownMs: isEventActive() ? EVENT_COOLDOWN_MS : COOLDOWN_MS,
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', authLimiter, requireCaptcha, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const row = db.prepare('SELECT username, password, email_verified FROM accounts WHERE username = ?').get(username);
    const dummyHash = '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV01234';
    const valid = row
      ? await verifyPassword(password, row.password)
      : (await verifyPassword(password, dummyHash).catch(() => {}), false);

    if (!row || !valid)
      return res.status(401).json({ error: 'Invalid credentials.' });

    const token = createSession(row.username);
    const cooldownLeft = getCooldown(row.username); // Fetch current cooldown

    return res.json({ 
      username: row.username, 
      token, 
      emailVerified: !!row.email_verified,
      cooldown: cooldownLeft,
      cooldownMs: isEventActive() ? EVENT_COOLDOWN_MS : COOLDOWN_MS,
    });
  } catch (err) {
    console.error('[login] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Email verification ────────────────────────────────────────────────────────
app.get('/api/verify-email', verifyEmailLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  try {
    const row = db.prepare('SELECT username, expires_at, used FROM email_verifications WHERE token = ?').get(token);
    if (!row)     return res.status(400).send('Invalid or expired verification link.');
    if (row.used) return res.redirect('/?verified=already');
    if (Date.now() > row.expires_at) return res.status(400).send('This verification link has expired. Please request a new one.');

    db.prepare('UPDATE accounts SET email_verified = 1 WHERE username = ?').run(row.username);
    db.prepare('UPDATE email_verifications SET used = 1 WHERE token = ?').run(token);
    // Broadcast to all connected clients so any open tab for this user
    // updates its banner without needing a manual refresh.
    broadcastSSE({ type: 'email_verified', username: row.username });
    return res.redirect('/?verified=1');
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).send('Server error. Please try again.');
  }
});

// ── Resend verification ───────────────────────────────────────────────────────
app.post('/api/resend-verification', resendLimiter, async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const row = db.prepare('SELECT email, email_verified FROM accounts WHERE username = ?').get(session.username);
    if (!row)              return res.status(404).json({ error: 'Account not found.' });
    if (row.email_verified) return res.json({ message: 'Email already verified.' });
    if (!row.email)        return res.status(400).json({ error: 'No email address on file.' });

    db.prepare('UPDATE email_verifications SET used = 1 WHERE username = ? AND used = 0').run(session.username);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO email_verifications (username, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(session.username, token, now, now + 24 * 60 * 60 * 1000);

    // force=true bypasses the in-process 60 s cooldown so an explicit resend
    // always goes out, even if a registration email was sent moments earlier.
    await sendVerificationEmail(row.email, session.username, token, true);
    return res.json({ message: 'Verification email sent. Check your inbox (and Spam folder).' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ error: 'Could not send verification email.' });
  }
});

// ── Forgot / Reset password ───────────────────────────────────────────────────
app.post('/api/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  const OK = { message: 'If that email is registered, a reset link has been sent.' };
  if (!isValidEmail(email)) return res.json(OK);

  try {
    const account = db.prepare('SELECT username FROM accounts WHERE email = ?').get(email.toLowerCase());
    if (!account) return res.json(OK);

    db.prepare('UPDATE password_resets SET used = 1 WHERE username = ? AND used = 0').run(account.username);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO password_resets (username, token, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)')
      .run(account.username, token, now, now + 60 * 60 * 1000);

    const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const link = `${base}/?resetToken=${encodeURIComponent(token)}`;

    const { sendMail } = require('./src/helpers/mailer.js');
    await sendMail({
      to: email.toLowerCase(),
      subject: 'Reset your Saint-Pixels password',
      text: `Hi ${account.username},\n\nReset your password:\n\n${link}\n\nExpires in 1 hour.`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family:sans-serif;background:#1e1e1f;color:#e2e8f0;padding:32px;"><div style="max-width:480px;margin:0 auto;background:#2e2e2f;border-radius:16px;padding:32px;border:1px solid rgba(255,255,255,0.1);"><h1 style="margin:0 0 8px;font-size:1.5rem;">Saint-Pixels</h1><p style="color:#94a3b8;margin:0 0 24px;">Password reset</p><p>Hi <strong>${account.username}</strong>,</p><p>Click the button below to set a new password. The link expires in <strong>1 hour</strong>.</p><a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#38bdf8;color:#0f172a;font-weight:700;border-radius:10px;text-decoration:none;">Reset Password</a><p style="font-size:0.82rem;color:#64748b;margin-top:24px;">If the button doesn't work, copy this link:<br/><a href="${link}" style="color:#38bdf8;word-break:break-all;">${link}</a></p><p style="font-size:0.82rem;color:#64748b;">If you didn't request this, ignore this email.</p></div></body></html>`,
    });

    return res.json(OK);
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }
});

app.post('/api/reset-password', resetPasswordLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  if (typeof token !== 'string' || token.length > 128) return res.status(400).json({ error: 'Invalid token.' });
  if (password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 256) return res.status(400).json({ error: 'Password too long.' });

  try {
    const row = db.prepare('SELECT username, expires_at, used FROM password_resets WHERE token = ?').get(token);
    if (!row || row.used)         return res.status(400).json({ error: 'Invalid or already-used reset link.' });
    if (Date.now() > row.expires_at) return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });

    const hashed = await hashPassword(password);
    db.prepare('UPDATE accounts SET password = ? WHERE username = ?').run(hashed, row.username);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);
    db.prepare('DELETE FROM sessions WHERE username = ?').run(row.username);
    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Could not reset password.' });
  }
});

// ── Session ───────────────────────────────────────────────────────────────────
app.get('/api/me', meLimiter, (req, res) => {
  const activeCooldownMs = isEventActive() ? EVENT_COOLDOWN_MS : COOLDOWN_MS;
  if (req.localBypassUser) {
    return res.json({ username: req.localBypassUser, emailVerified: true, cooldown: 0, cooldownMs: activeCooldownMs });
  }

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  
  const row = db.prepare('SELECT email_verified FROM accounts WHERE username = ?').get(session.username);
  const cooldownLeft = getCooldown(session.username); // Get remaining time from DB
  
  return res.json({ 
    username: session.username, 
    emailVerified: row ? !!row.email_verified : false,
    cooldown: cooldownLeft,
    cooldownMs: activeCooldownMs,
  });
});

app.post('/api/logout', logoutLimiter, (req, res) => {
  const [, token] = (req.headers.authorization || '').split(' ');
  res.json({ success: closeSession(token) });
});

// ── Guest session ─────────────────────────────────────────────────────────────

// POST /api/guest/session — create a short-lived guest token
// Returns { token, username, expiresAt }
// guest.js stores this in sessionStorage (never localStorage) so it dies with the tab.
app.post('/api/guest/session', guestSessionLimiter, (req, res) => {
  const ip = (req.ip || safeIp(req) || 'unknown').slice(0, 45);

  // Probabilistic cleanup of expired rows (~2% of requests) — same pattern as sessions.
  if (Math.random() < 0.02) {
    try { db.prepare('DELETE FROM guest_sessions WHERE expires_at < ?').run(Date.now()); }
    catch { /* non-fatal */ }
  }

  try {
    const token     = crypto.randomBytes(32).toString('hex');
    const now       = Date.now();
    const expiresAt = now + GUEST_SESSION_MS;

    // Atomically increment the guest counter for a human-readable username.
    // The transaction guarantees no two concurrent requests get the same number.
    const username = db.transaction(() => {
      db.prepare('UPDATE guest_counter SET seq = seq + 1 WHERE id = 1').run();
      const row = db.prepare('SELECT seq FROM guest_counter WHERE id = 1').get();
      return 'Guest ' + String(row.seq).padStart(7, '0');
    })();

    db.prepare(`
      INSERT INTO guest_sessions (token, username, ip, created_at, expires_at, pixels_used)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(token, username, ip, now, expiresAt);

    return res.json({ token, username, expiresAt });
  } catch (err) {
    console.error('[guest] Failed to create session:', err);
    return res.status(500).json({ error: 'Could not create guest session.' });
  }
});

// GET /api/guest/me — returns current guest session state (used on tab restore)
// Authorization: Bearer <guest-token>
// Response 200: { username, pixelsUsed, expiresAt, budget }
app.get('/api/guest/me', guestMeLimiter, (req, res) => {
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const row = db.prepare(
      'SELECT username, pixels_used, expires_at FROM guest_sessions WHERE token = ? AND expires_at > ?'
    ).get(token, Date.now());

    if (!row) return res.status(401).json({ error: 'Guest session expired or not found.' });

    return res.json({
      username:   row.username,
      pixelsUsed: row.pixels_used,
      expiresAt:  row.expires_at,
      budget:     GUEST_PIXEL_BUDGET,
    });
  } catch (err) {
    console.error('[guest] /api/guest/me error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── Palette ───────────────────────────────────────────────────────────────────
app.get('/api/palette', paletteLimiter, (req, res) => {
  try {
    const colors = db.prepare('SELECT id, label, color FROM palette ORDER BY id ASC').all();
    res.json({ colors });
  } catch (err) {
    console.error('Palette fetch error:', err);
    return res.status(500).json({ error: 'Could not load palette.' });
  }
});

// ── Streak helpers (UTC-4 day boundary) ──────────────────────────────────────
function getDayUTC4() {
  const now = new Date();
  const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return utc4.toISOString().slice(0, 10);
}

function initStreakTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS streaks (
    username TEXT PRIMARY KEY,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_day TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS achievements (
    username TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY (username, achievement_id)
  )`).run();
}
initStreakTables();

// guest_sessions and guest_counter tables are created by initializeDatabase()
// in database.js — no separate initGuestTable() needed here.

// Update a user's streak when they place a pixel. Called from placePixel paths.
function updateStreak(username) {
  try {
    const today = getDayUTC4();
    const row = db.prepare('SELECT current_streak, longest_streak, last_day FROM streaks WHERE username = ?').get(username);
    if (!row) {
      db.prepare('INSERT INTO streaks (username, current_streak, longest_streak, last_day) VALUES (?, 1, 1, ?)').run(username, today);
      return { current: 1, longest: 1 };
    }
    if (row.last_day === today) return { current: row.current_streak, longest: row.longest_streak };

    const yesterday = (() => {
      const d = new Date(today + 'T04:00:00Z'); // UTC-4 midnight
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    const newStreak = row.last_day === yesterday ? row.current_streak + 1 : 1;
    const newLongest = Math.max(newStreak, row.longest_streak);
    db.prepare('UPDATE streaks SET current_streak = ?, longest_streak = ?, last_day = ? WHERE username = ?')
      .run(newStreak, newLongest, today, username);
    return { current: newStreak, longest: newLongest };
  } catch (err) {
    console.error('[streak] update error:', err.message);
    return null;
  }
}

// ── Cooldown Event state ──────────────────────────────────────────────────────
// A cooldown event halves the per-player cooldown for a set duration.
// Server admins trigger it via POST /api/event/start (no auth for simplicity —
// add a secret header check if you want to restrict it).
let _eventActive = false;
let _eventEndsAt  = 0;
const EVENT_COOLDOWN_MS = 1500; // 1.5 s during event (vs normal 3 s)
const EVENT_DURATION_MS = 60 * 60 * 1000; // 1 hour

function isEventActive() {
  if (_eventActive && Date.now() < _eventEndsAt) return true;
  _eventActive = false;
  return false;
}

// Read / write event state from DB so it survives restarts
(function initEventTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS cooldown_events (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ends_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  const row = db.prepare('SELECT ends_at FROM cooldown_events WHERE id = 1').get();
  if (row && row.ends_at > Date.now()) {
    _eventActive  = true;
    _eventEndsAt  = row.ends_at;
  }
})();

const eventLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, keyGenerator: (req) => safeIp(req) });

// GET /api/event — returns current event status + countdown
app.get('/api/event', eventLimiter, (req, res) => {
  const active = isEventActive();
  res.json({
    active,
    endsAt:   active ? _eventEndsAt : null,
    cooldownMs: active ? EVENT_COOLDOWN_MS : COOLDOWN_MS,
  });
});

// POST /api/event/start — admin trigger (protect with a secret if needed)
app.post('/api/event/start', eventLimiter, (req, res) => {
  const secret = process.env.EVENT_SECRET || '';
  if (secret && req.headers['x-event-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  _eventActive = true;
  _eventEndsAt = Date.now() + EVENT_DURATION_MS;
  db.prepare('INSERT OR REPLACE INTO cooldown_events (id, ends_at) VALUES (1, ?)').run(_eventEndsAt);
  broadcastSSE({ type: 'event', active: true, endsAt: _eventEndsAt, cooldownMs: EVENT_COOLDOWN_MS });
  return res.json({ success: true, endsAt: _eventEndsAt });
});

// ── Profile API ───────────────────────────────────────────────────────────────
const profileLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, keyGenerator: (req) => safeIp(req) });

app.get('/api/profile/:username', profileLimiter, (req, res) => {
  const { username } = req.params;
  if (!username || username.length > 30) return res.status(400).json({ error: 'Invalid username.' });
  try {
    const today = getDayUTC4();

    // Total pixels all-time
    const totalRow = db.prepare(`SELECT COALESCE(SUM(count), 0) AS total FROM pixel_counts WHERE username = ?`).get(username);
    // Today's pixels
    const todayRow = db.prepare(`SELECT COALESCE(count, 0) AS cnt FROM pixel_counts WHERE username = ? AND day = ?`).get(username, today);
    // All-time rank
    const rankRow  = db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM (
        SELECT username, SUM(count) AS total FROM pixel_counts GROUP BY username
      ) t WHERE total > COALESCE((SELECT SUM(count) FROM pixel_counts WHERE username = ?), 0)
    `).get(username);
    // Recent pixels
    const recent = db.prepare(`SELECT x, y, color, placed_at FROM pixel_history WHERE username = ? ORDER BY placed_at DESC LIMIT 20`).all(username);
    // Most-used color (exclude 'erase')
    const colorRow = db.prepare(`
      SELECT color, COUNT(*) AS cnt FROM pixel_history
      WHERE username = ? AND color != 'erase'
      GROUP BY color ORDER BY cnt DESC LIMIT 1
    `).get(username);
    // Streak
    const streakRow = db.prepare('SELECT current_streak, longest_streak FROM streaks WHERE username = ?').get(username);
    // Achievements
    const achievements = db.prepare(`SELECT achievement_id, unlocked_at FROM achievements WHERE username = ? ORDER BY unlocked_at ASC`).all(username);

    return res.json({
      username,
      totalPixels:   Number(totalRow?.total  || 0),
      todayPixels:   Number(todayRow?.cnt    || 0),
      allTimeRank:   Number(rankRow?.rank    || 0),
      currentStreak: streakRow?.current_streak  || 0,
      longestStreak: streakRow?.longest_streak  || 0,
      mostUsedColor: colorRow ? ('#' + colorRow.color) : null,
      achievements:  achievements || [],
      recentPixels:  recent || [],
    });
  } catch (err) {
    console.error('[profile] error:', err);
    return res.status(500).json({ error: 'Could not load profile.' });
  }
});

// ── Streak API ────────────────────────────────────────────────────────────────
const streakLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, keyGenerator: (req) => safeIp(req) });

app.get('/api/streak', streakLimiter, (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const row = db.prepare('SELECT current_streak, longest_streak, last_day FROM streaks WHERE username = ?').get(session.username);
    return res.json({
      currentStreak: row?.current_streak  || 0,
      longestStreak: row?.longest_streak  || 0,
      lastDay:       row?.last_day        || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not load streak.' });
  }
});

// ── Leaderboard API ───────────────────────────────────────────────────────────
const leaderboardLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, keyGenerator: (req) => safeIp(req) });

// Build a parameterized { clause, params } pair for the leaderboard period.
// getDayUTC4() is called at request time so date boundaries are always current.
// ALL user-controlled input (req.query.period) is validated against the whitelist
// before this function is called — the resulting date strings are computed
// server-side and never derived from user input.
function buildLeaderboardFilter(period) {
  const now  = new Date(Date.now() - 4 * 60 * 60 * 1000); // UTC-4
  const today = now.toISOString().slice(0, 10);

  if (period === 'today') {
    return { clause: 'AND day = ?', params: [today] };
  }
  if (period === 'yesterday') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return { clause: 'AND day = ?', params: [d.toISOString().slice(0, 10)] };
  }
  if (period === 'week') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 6);
    return { clause: 'AND day >= ?', params: [d.toISOString().slice(0, 10)] };
  }
  if (period === 'month') {
    return { clause: 'AND day >= ?', params: [today.slice(0, 7) + '-01'] };
  }
  if (period === 'year') {
    return { clause: 'AND day >= ?', params: [today.slice(0, 4) + '-01-01'] };
  }
  if (period === 'decade') {
    const decadeStart = String(Math.floor(parseInt(today.slice(0, 4), 10) / 10) * 10) + '-01-01';
    return { clause: 'AND day >= ?', params: [decadeStart] };
  }
  if (period === 'century') {
    const centuryStart = String(Math.floor(parseInt(today.slice(0, 4), 10) / 100) * 100) + '-01-01';
    return { clause: 'AND day >= ?', params: [centuryStart] };
  }
  // alltime — no filter
  return { clause: '', params: [] };
}

app.get('/api/leaderboard', leaderboardLimiter, (req, res) => {
  const period = ['today','yesterday','week','month','year','decade','century','alltime'].includes(req.query.period)
    ? req.query.period : 'today';
  const { clause, params } = buildLeaderboardFilter(period);
  try {
    const rows = db.prepare(`
      SELECT username, SUM(count) AS count
      FROM pixel_counts WHERE 1=1 ${clause}
      GROUP BY username ORDER BY count DESC LIMIT 50
    `).all(...params);
    return res.json({ leaderboard: rows });
  } catch (err) {
    console.error('[leaderboard] error:', err);
    return res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

// NOTE: /api/timelapse/history is registered inside initializeTimelapse() in
// timelapse.js — it must come before the /:id wildcard route to avoid the 401.


// ── Database backup — streams the SQLite file to the browser as a download ──
// Protect with ADMIN_SECRET. Use this to take manual snapshots of the canvas.
// In your browser: https://www.saint-pixels.org/api/admin/backup?secret=YOUR_SECRET
// Then save the downloaded file locally as a .sqlite backup.
//
// IMPORTANT: this uses the SQLite backup API (db.backup()) which creates a
// safe consistent snapshot even while the DB is being written to (WAL mode).
// Never copy the raw .sqlite file directly — WAL pages may not be flushed yet.
app.post('/api/admin/backup', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.body.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const tmpFile = path.join(os.tmpdir(), `sp-backup-${Date.now()}.sqlite`);
  try {
    // db.backup() is better-sqlite3's safe online backup — works correctly
    // under concurrent reads/writes without locking out other connections.
    await db.backup(tmpFile);
    const stat = fs.statSync(tmpFile);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=saint-pixels-${stamp}.sqlite`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('close', () => {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup error */ }
    });
    stream.on('error', (err) => {
      console.error('[backup] Stream error:', err);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed.' });
    });
  } catch (err) {
    console.error('[backup] Backup failed:', err);
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return res.status(500).json({ error: 'Backup failed.', detail: err.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send('Not found'));

// Get the local IP to print to the console when running the app
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const desiredPort = process.env.PORT ? Number(process.env.PORT) : 3005;
const ip = getLocalIP();
// Binding to '0.0.0.0' allows connections from both localhost and your local Wi-Fi IP
const server = app.listen(desiredPort, '0.0.0.0', () => {
  console.log(`\nSaint Pixels server running on:`);
  console.log(`\x1b[32mLocal:\x1b[0m http://localhost:${desiredPort}`);
  console.log(`\x1b[36mNetwork:\x1b[0m http://${ip}:${desiredPort}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${desiredPort} is already in use.`);
  } else {
    console.error('Server error:', err);
  }
});

// ── Slowloris / slow-header attack mitigation ─────────────────────────────────
// Without these a client can hold a TCP connection open indefinitely by sending
// headers extremely slowly, exhausting the server's connection pool.
//
//   headersTimeout  — max time (ms) to receive the full HTTP request headers
//   requestTimeout  — max time (ms) for the entire request (headers + body)
//   keepAliveTimeout — how long an idle keep-alive connection is held open
//
// Values are intentionally conservative: legitimate browsers finish headers in
// well under 10 s; the defaults (0 = unlimited) invite abuse.
server.headersTimeout  = 10_000;   // 10 s to finish sending headers
server.requestTimeout  = 30_000;   // 30 s for full request (covers slow bodies)
                                   // NOTE: /api/stream overrides this to 0 per-socket
                                   // so SSE connections aren't killed after 30 s.
server.keepAliveTimeout = 65_000;  // slightly above typical proxy idle timeout

// ── Global Express error handler ─────────────────────────────────────────────
// Catches any error thrown synchronously inside a route handler that wasn't
// caught by the handler's own try/catch.  Without this, Express would call
// next(err) → default handler which sends a stack trace to the client and,
// in some Node versions, can crash the process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled route error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Unhandled rejection / exception safety net ────────────────────────────────
// Prevents a single unhandled async throw from silently killing the process.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Give in-flight requests a moment to drain before exiting — avoids a hard kill
  // that would leave SSE clients with broken connections and no error.
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5_000).unref();
});