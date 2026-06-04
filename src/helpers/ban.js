'use strict';

/**
 * ban.js — Player ban system for Saint Pixels
 * Place at: src/helpers/ban.js
 *
 * Features:
 *  - Timed bans (N days) or permanent bans
 *  - IP bans: prevents banned players from registering new accounts on the same IP
 *  - Hot-reloads ban-list.json on save — no server restart needed
 *  - checkBan(username)         — call anywhere to test if a user is banned
 *  - checkIpBan(ip)             — call in /api/register to block new accounts
 *  - banCheckMiddleware          — Express middleware, attach to app.use('/api', ...)
 */

const fs   = require('fs');
const path = require('path');

// ban-list.json lives at the project root (next to server.js)
const BAN_FILE = path.resolve(__dirname, '../../ban-list.json');

/** @type {Array} */
let _bans = [];

// ── Loader ────────────────────────────────────────────────────────────────────

function loadBans() {
  try {
    const raw  = fs.readFileSync(BAN_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data.bans)) {
      console.warn('[ban] ban-list.json "bans" field is not an array — no bans loaded.');
      _bans = [];
      return;
    }

    // Strip placeholder/example entries
    _bans = data.bans.filter(
      (b) => !b._example && typeof b.username === 'string' && b.username.trim() !== ''
    );

    console.log(`[ban] Loaded ${_bans.length} ban(s) from ban-list.json`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('[ban] ban-list.json not found — no bans in effect.');
    } else {
      console.error('[ban] Failed to load ban-list.json:', err.message);
    }
    _bans = [];
  }
}

loadBans();

// ── Hot-reload ────────────────────────────────────────────────────────────────
let _reloadTimer = null;
try {
  fs.watch(BAN_FILE, () => {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
      console.log('[ban] ban-list.json changed — reloading…');
      loadBans();
    }, 250);
  });
} catch {
  console.warn('[ban] Cannot watch ban-list.json — hot-reload disabled.');
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the active ban for a username, or null if not banned / expired.
 * @param {string} username
 * @returns {{ username, reason, expiresAt: Date|null, isPermanent: boolean } | null}
 */
function checkBan(username) {
  if (!username || typeof username !== 'string') return null;
  const lower = username.toLowerCase();
  const now   = Date.now();

  for (const entry of _bans) {
    if (entry.username.toLowerCase() !== lower) continue;

    if (entry.duration === 'permanent') {
      return {
        username:    entry.username,
        reason:      entry.reason || 'You have been banned from Saint Pixels.',
        expiresAt:   null,
        isPermanent: true,
      };
    }

    const days = Number(entry.duration);
    if (!isFinite(days) || days <= 0) {
      console.warn(`[ban] Invalid duration for "${entry.username}": ${entry.duration} — skipping.`);
      continue;
    }

    const bannedAt  = new Date(entry.bannedAt).getTime();
    const expiresAt = bannedAt + days * 24 * 60 * 60 * 1000;

    if (now < expiresAt) {
      return {
        username:    entry.username,
        reason:      entry.reason || 'You have been banned from Saint Pixels.',
        expiresAt:   new Date(expiresAt),
        isPermanent: false,
      };
    }

    return null; // Expired
  }

  return null;
}

/**
 * Returns true if the given IP belongs to a banned player (any active ban),
 * preventing them from registering a new account to bypass their ban.
 *
 * @param {string} ip
 * @returns {{ found: boolean, reason?: string }}
 */
function checkIpBan(ip) {
  if (!ip || typeof ip !== 'string') return { found: false };
  const now = Date.now();

  for (const entry of _bans) {
    // Only check entries that also have an ipBan: true flag
    if (!entry.ipBan) continue;

    const bannedIps = Array.isArray(entry.bannedIps) ? entry.bannedIps : [];
    if (!bannedIps.includes(ip)) continue;

    // Check if this ban is still active
    if (entry.duration === 'permanent') {
      return {
        found:  true,
        reason: 'Registration is not allowed from this network.',
      };
    }

    const days = Number(entry.duration);
    if (!isFinite(days) || days <= 0) continue;

    const bannedAt  = new Date(entry.bannedAt).getTime();
    const expiresAt = bannedAt + days * 24 * 60 * 60 * 1000;
    if (now < expiresAt) {
      return {
        found:  true,
        reason: 'Registration is not allowed from this network.',
      };
    }
  }

  return { found: false };
}

// ── Ban payload builder ───────────────────────────────────────────────────────

function buildBanPayload(ban) {
  return {
    banned:    true,
    reason:    ban.reason,
    message:   ban.isPermanent
      ? 'Your account has been permanently banned.'
      : `Your account is banned until ${ban.expiresAt.toUTCString()}.`,
    expiresAt: ban.expiresAt ? ban.expiresAt.toISOString() : null,
  };
}

// ── Express middleware ────────────────────────────────────────────────────────

/** @type {import('better-sqlite3').Database|null} */
let _db = null;

function setDb(db) { _db = db; }

/**
 * Express middleware — attach to app.use('/api', banCheckMiddleware).
 * Checks the session token → username → ban list.
 * Unauthenticated requests pass through (no session = no ban check needed here).
 */
function banCheckMiddleware(req, res, next) {
  // Honour localBypassUser (mobileDebug)
  const bypassUser = req.localBypassUser;
  if (bypassUser) {
    const ban = checkBan(bypassUser);
    if (ban) return res.status(403).json({ error: 'banned', ...buildBanPayload(ban) });
    return next();
  }

  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type !== 'Bearer' || !token || !_db) return next();

  try {
    const row = _db
      .prepare('SELECT username FROM sessions WHERE token = ? AND expires_at > ?')
      .get(token, Date.now());
    if (!row) return next();

    const ban = checkBan(row.username);
    if (ban) return res.status(403).json({ error: 'banned', ...buildBanPayload(ban) });
  } catch { /* DB error — fail open */ }

  next();
}

module.exports = { checkBan, checkIpBan, buildBanPayload, banCheckMiddleware, setDb, loadBans };
