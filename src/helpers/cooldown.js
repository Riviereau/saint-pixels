/** Injected by initializeDatabase / server startup */
let _db = null;

const COOLDOWN_MS = 3000;

/**
 * Grace window subtracted from the server-side cooldown check.
 *
 * The client fires its request the moment its local timer expires, but
 * clock skew and network latency mean the server may see the request
 * arrive 10–80 ms before the cooldown has technically elapsed.  Without
 * this buffer the server rejects the pixel with a 429, the client erases
 * the optimistically-painted pixel, and the user has to place it again —
 * the "ghost click" bug.
 *
 * 100 ms absorbs typical client/server clock drift and round-trip jitter
 * (previously 50 ms — raised to also cover high-latency connections).
 * At < 3.5 % of the 3 s cooldown, this cannot be meaningfully exploited.
 */
const COOLDOWN_GRACE_MS = 100;

/**
 * @param {import('better-sqlite3').Database} db
 */
function setDb(db) {
  _db = db;
}

/**
 * Returns the remaining cooldown in ms for a user (0 if none).
 * @param {string} username
 * @returns {number}
 */
function getCooldown(username) {
  const row = _db.prepare(
    'SELECT last_pixel_at FROM cooldowns WHERE username = ?'
  ).get(username);
  if (!row) return 0;
  // Subtract the grace window so requests arriving right at the boundary
  // (due to clock skew or network jitter) are not incorrectly rejected.
  const remaining = row.last_pixel_at + COOLDOWN_MS - COOLDOWN_GRACE_MS - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Reset the cooldown timer for a user (called after a successful pixel place).
 * @param {string} username
 */
function resetCooldown(username) {
  _db.prepare(`
    INSERT INTO cooldowns (username, last_pixel_at)
    VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET last_pixel_at = excluded.last_pixel_at
  `).run(username, Date.now());
}

module.exports = { setDb, getCooldown, resetCooldown, COOLDOWN_MS };
