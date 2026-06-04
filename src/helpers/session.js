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
 * Returns:
 *   { username, created_at }                          — valid session, not banned
 *   { banned: true, reason, message, expiresAt }      — valid session but banned
 *   null                                               — no valid session
 */
function getSession(req) {
  // mobileDebug bypass
  if (req && req.localBypassUser) {
    const ban = checkBan(req.localBypassUser);
    if (ban) return buildBanPayload(ban);
    return { username: req.localBypassUser, created_at: Date.now() };
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

module.exports = { setDb, createSession, closeSession, getSession, banCheckMiddleware };
