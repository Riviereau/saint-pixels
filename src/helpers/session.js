const crypto   = require('crypto');
const { checkBan, buildBanPayload } = require('./ban');

/** Sessions TTL: 30 days in milliseconds */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let _db = null;

function setDb(db) { _db = db; }

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();
  _db.prepare(
    'INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, username, now, now + SESSION_TTL_MS);

  if (Math.random() < 0.02) {
    _db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  return token;
}

function closeSession(token) {
  if (!token) return false;
  const info = _db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return info.changes > 0;
}

/**
 * Returns true when the request IP is loopback or an RFC-1918 private address.
 * Mirrors the client-side isLocalDev() check in auth.js and the isPrivateIp()
 * helper in captcha.js so all three agree without needing any extra config flag.
 */
function isPrivateIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6

  if (raw === '127.0.0.1' || raw === '::1' || raw === 'localhost') return true;

  const parts = raw.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) return false;
  const [, a, b] = parts.map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Returns:
 *   { username, created_at }                          — valid session, not banned
 *   { banned: true, reason, message, expiresAt }      — valid session but banned
 *   null                                               — no valid session
 */
function getSession(req) {
  // mobileDebug bypass — also accept any request from a private-network IP
  // so LAN phones work without needing app.locals.mobileDebug to be set manually.
  if (req && (req.localBypassUser || isPrivateIp(req))) {
    const bypassUser = req.localBypassUser || 'anon-local';
    const ban = checkBan(bypassUser);
    if (ban) return buildBanPayload(ban);
    return { username: bypassUser, created_at: Date.now() };
  }

  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type !== 'Bearer' || !token) return null;

  const row = _db.prepare(
    'SELECT username, created_at FROM sessions WHERE token = ? AND expires_at > ?'
  ).get(token, Date.now());

  if (!row) return null;

  const ban = checkBan(row.username);
  if (ban) return buildBanPayload(ban);

  return row;
}

/**
 * Express middleware — intercepts banned users and returns 403.
 * Plug in as: app.use('/api', banCheckMiddleware)
 */
function banCheckMiddleware(req, res, next) {
  const session = getSession(req);
  if (session && session.banned === true) {
    return res.status(403).json({
      error:     'banned',
      message:   session.message,
      reason:    session.reason,
      expiresAt: session.expiresAt,
    });
  }
  next();
}

module.exports = { setDb, createSession, closeSession, getSession, banCheckMiddleware, isPrivateIp };
