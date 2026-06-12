const { getCooldown, resetCooldown } = require('../helpers/cooldown.js');
const { getSession } = require('../helpers/session.js');
const { recordIp } = require('../helpers/AntiCheat.js');
const fs   = require('fs');
const path = require('path');

// Board dimensions — must match the client constants in app.js.
const BOARD_WIDTH  = 1920;
const BOARD_HEIGHT = 1080;

// Guest pixel budget — must match GUEST_PIXEL_BUDGET in server.js.
const GUEST_PIXEL_BUDGET = 300;

// Path to the rolling JSON pixel-history file.
// Set JSON_HISTORY_PATH in your environment (or .env) to override the default.
// The file stores a JSON array; each new event is appended by rewriting the
// array tail so the file stays valid JSON at all times.
const JSON_HISTORY_PATH = process.env.JSON_HISTORY_PATH
  || path.join(process.cwd(), 'pixel-history.json');

// Injected by initializeActions
let _db = null;
let _broadcast = () => {};
/** Returns the currently active cooldown duration in ms (event-aware). */
let _getEffectiveCooldownMs = () => 0;

/**
 * Resolve the session for a request.
 * Returns one of:
 *   { username, isGuest: false }   — valid registered session
 *   { username, isGuest: true  }   — valid guest session
 *   { banned: true, … }            — banned
 *   null                           — not authenticated
 *
 * Guest tokens live in guest_sessions, not sessions, so they are never
 * accidentally accepted by getSession(). We check guest_sessions here
 * explicitly so PlacePixel is the single place that understands both kinds.
 */
function resolveSession(req) {
  // Try regular session first (covers local-bypass path too)
  const regular = getSession(req);
  if (regular) {
    if (regular.banned) return regular; // pass ban payload through unchanged
    return { ...regular, isGuest: false };
  }

  // Try guest token
  if (!_db) return null;
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !token) return null;

  const row = _db.prepare(
    'SELECT username, pixels_used, expires_at FROM guest_sessions WHERE token = ? AND expires_at > ?'
  ).get(token, Date.now());

  if (!row) return null;
  return { username: row.username, isGuest: true, pixelsUsed: row.pixels_used, guestToken: token };
}

/**
 * Append one pixel-history event to the JSON file on disk.
 *
 * The file contains a JSON array.  Rather than re-parsing and re-serialising
 * the entire file on every pixel (expensive once the file is large), we use a
 * cheap tail-append trick:
 *
 *   • If the file does not yet exist, write `[\n<entry>\n]`.
 *   • Otherwise open the file, seek to just before the closing `]`, overwrite
 *     it with `,\n<entry>\n]`.
 *
 * This keeps the file valid JSON at all times while being O(1) regardless of
 * how many entries already exist.
 *
 * @param {{ username: string, x: number, y: number, color: string, placed_at: number }} entry
 */
function appendToJsonHistory(entry) {
  const line = JSON.stringify(entry);
  try {
    if (!fs.existsSync(JSON_HISTORY_PATH)) {
      // Ensure the parent directory exists before creating the file.
      const dir = path.dirname(JSON_HISTORY_PATH);
      fs.mkdirSync(dir, { recursive: true });
      // First entry — create the file as a single-element array.
      fs.writeFileSync(JSON_HISTORY_PATH, `[\n${line}\n]`, 'utf8');
      return;
    }

    // File exists — find the closing `]` and replace it.
    const stat = fs.statSync(JSON_HISTORY_PATH);
    const size = stat.size;

    // Read the last few bytes to locate the `]`.
    // We search backwards for the first `]` within the last 16 bytes.
    const TAIL = Math.min(16, size);
    const fd   = fs.openSync(JSON_HISTORY_PATH, 'r+');
    try {
      const tailBuf = Buffer.alloc(TAIL);
      fs.readSync(fd, tailBuf, 0, TAIL, size - TAIL);
      const tailStr  = tailBuf.toString('utf8');
      const closingIdx = tailStr.lastIndexOf(']');
      if (closingIdx === -1) {
        // Shouldn't happen with a valid file — fall back to full rewrite.
        fs.closeSync(fd);
        const existing = JSON.parse(fs.readFileSync(JSON_HISTORY_PATH, 'utf8'));
        existing.push(entry);
        fs.writeFileSync(JSON_HISTORY_PATH, JSON.stringify(existing, null, 2), 'utf8');
        return;
      }

      const writePos = size - TAIL + closingIdx;
      const patch    = Buffer.from(`,\n${line}\n]`, 'utf8');
      fs.writeSync(fd, patch, 0, patch.length, writePos);
      // Truncate in case the new content is shorter than what was there
      // (it won't be in normal use, but be safe).
      fs.ftruncateSync(fd, writePos + patch.length);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // JSON history write failure is non-fatal — log and continue.
    console.error('[PlacePixel] Failed to append to JSON history:', err.message);
  }
}

/**
 * Returns the current day string in UTC-4 (e.g. "2025-05-23")
 * The leaderboard resets at midnight UTC-4.
 * @returns {string}
 */
function getDayUTC4() {
  const now = new Date();
  const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return utc4.toISOString().slice(0, 10);
}

class PlacePixel {
  /**
   * POST /api/pixel — place a coloured pixel
   */
  static execute(req, res) {
    const session = resolveSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    if (session.banned) {
      return res.status(403).json({ error: 'banned', message: session.message, reason: session.reason, expiresAt: session.expiresAt });
    }

    // ── Guest pixel-budget enforcement ──────────────────────────────────────
    // Checked before the cooldown so a guest who has exhausted their budget
    // gets a clear 403 (not a 429 cooldown error) and the cooldown is NOT
    // consumed, which would otherwise block the conversion-prompt signup flow.
    if (session.isGuest) {
      if (session.pixelsUsed >= GUEST_PIXEL_BUDGET) {
        return res.status(403).json({ error: 'guest_limit', message: 'Guest pixel budget exhausted. Create a free account to keep placing pixels.' });
      }
    }

    const cooldownLeft = getCooldown(session.username, _getEffectiveCooldownMs());
    // Allow a 100 ms grace window on the server side.  The client enforces a
    // 150 ms margin before sending, so requests should always arrive well after
    // the cooldown expires.  The grace window absorbs any remaining clock-skew
    // or jitter between the two Date.now() calls so legitimate clicks at the
    // exact boundary are never rejected with a 429.
    if (cooldownLeft > 100) {
      return res.status(429).json({ error: 'Cooldown active. Please wait.', cooldown: cooldownLeft });
    }

    const x = parseInt(req.body.x, 10);
    const y = parseInt(req.body.y, 10);
    const color = typeof req.body.color === 'string' ? req.body.color : '';
    if (isNaN(x) || isNaN(y) || !color) {
      return res.status(400).json({ error: 'Invalid pixel coordinates or color.' });
    }
    if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) {
      return res.status(400).json({ error: 'Pixel coordinates out of bounds.' });
    }
    // Strip everything except hex digits and #, then drop any leading #
    const safeColor = color.replace(/[^0-9a-fA-F#]/g, '').replace(/^#+/, '').slice(0, 6);
    if (safeColor.length !== 6) {
      return res.status(400).json({ error: 'Invalid color value.' });
    }

    // prevColor: optional field sent by the client recording what was on the
    // canvas at (x,y) before this placement.  Accept only a valid 6-char hex;
    // anything else is silently dropped so bad/missing values never block saves.
    const rawPrev = typeof req.body.prevColor === 'string' ? req.body.prevColor : '';
    const safePrevColor = /^#?[0-9a-fA-F]{6}$/.test(rawPrev)
      ? rawPrev.replace(/^#/, '').toLowerCase()
      : null;

    // Validation passed — now consume the cooldown
    resetCooldown(session.username);
    // Record this placement against the IP for anti-cheat enforcement
    recordIp(req.ip || req.socket?.remoteAddress || 'unknown', session.username);

    // ── Guest: increment pixels_used atomically ──────────────────────────────
    // We use a conditional UPDATE (WHERE pixels_used < budget) as a database-
    // level guard so two concurrent requests from the same guest token can
    // never both sneak through a budget=2 check and each write their pixel —
    // only the first UPDATE will match, the second returns changes=0 → 403.
    if (session.isGuest && _db) {
      try {
        const info = _db.prepare(`
          UPDATE guest_sessions
          SET pixels_used = pixels_used + 1
          WHERE token = ? AND pixels_used < ?
        `).run(session.guestToken, GUEST_PIXEL_BUDGET);

        if (info.changes === 0) {
          // Race condition: another concurrent request already hit the cap.
          return res.status(403).json({ error: 'guest_limit', message: 'Guest pixel budget exhausted.' });
        }
      } catch (err) {
        console.error('[PlacePixel] Guest pixel_count update failed:', err.message);
        return res.status(500).json({ error: 'Failed to update guest pixel count.' });
      }
    }

    // Increment this player's pixel count for today (UTC-4 day boundary).
    // Guests are included — their usernames are stable within a session and
    // they appear on the leaderboard like any other player.
    if (_db) {
      try {
        const day = getDayUTC4();
        _db.prepare(`
          INSERT INTO pixel_counts (username, day, count)
          VALUES (?, ?, 1)
          ON CONFLICT(username, day) DO UPDATE SET count = count + 1
        `).run(session.username, day);
      } catch (err) {
        console.error('Failed to update pixel count:', err);
      }
    }

    // Upsert the pixel — replaces the existing row for this (x,y) if one exists.
    if (_db) {
      try {
        const now = Date.now();
        _db.prepare(`
          INSERT OR REPLACE INTO pixels (username, x, y, color, placed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(session.username, x, y, safeColor, now);
        // Append-log for timelapse generation — one row per event, never pruned.
        // prev_color records what was at this cell before this placement so the
        // timelapse player can show the "old pixel" underneath.
        _db.prepare(`
          INSERT INTO pixel_history (username, x, y, color, prev_color, placed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(session.username, x, y, safeColor, safePrevColor, now);
        // Mirror the same event to the JSON history file for timelapse --json.
        appendToJsonHistory({ username: session.username, x, y, color: safeColor, prev_color: safePrevColor, placed_at: now });
        // Broadcast uses the same sanitised, #-prefixed color so SSE clients
        // and the DB are always consistent.
        _broadcast({ type: 'pixel', x, y, color: '#' + safeColor, user: session.username });

        // Include remaining guest budget in the response so the client HUD
        // can update without needing a separate /api/guest/me call.
        if (session.isGuest) {
          const remaining = GUEST_PIXEL_BUDGET - (session.pixelsUsed + 1);
          return res.json({ success: true, guestPixelsRemaining: Math.max(0, remaining) });
        }

        return res.json({ success: true });
      } catch (err) {
        console.error('PIXEL WRITE FAILED:', err.message, err.code);
        return res.status(500).json({ error: 'Failed to save pixel.' });
      }
    }

    // _db not available — broadcast anyway so other clients still see the pixel,
    // but the pixel won't survive a reload.
    _broadcast({ type: 'pixel', x, y, color: '#' + safeColor, user: session.username });

    return res.json({ success: true });
  }

  /**
   * POST /api/erase — erase a pixel (stored as color='erase' sentinel)
   * Uses the same cooldown as a regular pixel placement.
   * Guests are blocked — erasing requires a registered account.
   */
  static erase(req, res) {
    const session = resolveSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    if (session.banned) {
      return res.status(403).json({ error: 'banned', message: session.message, reason: session.reason, expiresAt: session.expiresAt });
    }

    // ── Guests cannot erase ──────────────────────────────────────────────────
    if (session.isGuest) {
      return res.status(403).json({ error: 'guest_no_erase', message: 'Erasing requires a registered account.' });
    }

    const cooldownLeft = getCooldown(session.username, _getEffectiveCooldownMs());
    if (cooldownLeft > 100) {
      return res.status(429).json({ error: 'Cooldown active. Please wait.', cooldown: cooldownLeft });
    }

    // Validate BEFORE consuming the cooldown
    const x = parseInt(req.body.x, 10);
    const y = parseInt(req.body.y, 10);
    if (isNaN(x) || isNaN(y)) {
      return res.status(400).json({ error: 'Invalid pixel coordinates.' });
    }
    if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) {
      return res.status(400).json({ error: 'Pixel coordinates out of bounds.' });
    }

    resetCooldown(session.username);
    // Record this erase against the IP for anti-cheat enforcement
    recordIp(req.ip || req.socket?.remoteAddress || 'unknown', session.username);

    if (_db) {
      try {
        const now = Date.now();
        // Upsert the erase sentinel — same bounded-table guarantee as pixel placement.
        _db.prepare(`
          INSERT OR REPLACE INTO pixels (username, x, y, color, placed_at)
          VALUES (?, ?, ?, 'erase', ?)
        `).run(session.username, x, y, now);

        // Append-log for timelapse generation.
        _db.prepare(`
          INSERT INTO pixel_history (username, x, y, color, placed_at)
          VALUES (?, ?, ?, 'erase', ?)
        `).run(session.username, x, y, now);
        // Mirror the erase event to the JSON history file for timelapse --json.
        appendToJsonHistory({ username: session.username, x, y, color: 'erase', placed_at: now });

        // Increment this player's pixel count for today to update the leaderboard
        _db.prepare(`
          INSERT INTO pixel_counts (username, day, count)
          VALUES (?, ?, 1)
          ON CONFLICT(username, day)
          DO UPDATE SET count = count + 1
        `).run(session.username, getDayUTC4());
      } catch (err) {
        console.error('Failed to store erase:', err);
      }
    }

    // Broadcast erase event to all SSE clients
    _broadcast({ type: 'erase', x, y, user: session.username });

    return res.json({ success: true });
  }

  /**
   * Inject the database instance (called from initializeActions)
   * @param {Database} db
   */
  static setDb(db) {
    _db = db;
  }

  /**
   * Inject a function that returns the currently active cooldown in ms.
   * Called from initializeActions after isEventActive is available.
   * @param {() => number} fn
   */
  static setEffectiveCooldownMs(fn) {
    _getEffectiveCooldownMs = fn;
  }

  /**
   * Inject the SSE broadcast function (called from initializeActions)
   * @param {Function} fn
   */
  static setBroadcast(fn) {
    _broadcast = fn;
  }
}

module.exports = { PlacePixel };
