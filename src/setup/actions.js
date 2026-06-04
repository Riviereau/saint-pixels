const { PlacePixel } = require('../actions/PlacePixel.js');
const { Leaderboard } = require('../actions/Leaderboard.js');
const { ipCooldownMiddleware } = require('../helpers/AntiCheat.js');

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {Function} [pixelLimiter]
 * @param {Function} [broadcastSSE]
 */
function initializeActions(app, db, pixelLimiter, broadcastSSE) {
  // Inject db into actions that need it
  PlacePixel.setDb(db);
  PlacePixel.setBroadcast(broadcastSSE || (() => {}));
  Leaderboard.setDb(db);

  // ipCooldownMiddleware is applied first — before the per-request rate limiter
  // and before the per-user cooldown check — so multi-account IP bypasses are
  // caught at the earliest possible point.
  const pixelMiddleware = pixelLimiter
    ? [ipCooldownMiddleware, pixelLimiter, PlacePixel.execute]
    : [ipCooldownMiddleware, PlacePixel.execute];

  const eraseMiddleware = pixelLimiter
    ? [ipCooldownMiddleware, pixelLimiter, PlacePixel.erase]
    : [ipCooldownMiddleware, PlacePixel.erase];

  app.post('/api/pixel',              ...pixelMiddleware);
  app.post('/api/erase',              ...eraseMiddleware);
  app.get('/api/leaderboard',         Leaderboard.execute);
  app.get('/api/profile/:username',   Leaderboard.profile);

  // ── Admin: pixel history dump ─────────────────────────────────────────────
  // GET /api/admin/pixel-history?secret=<ADMIN_SECRET>
  //
  // Streams the full pixel_history table as a JSON array.
  // Protect with the ADMIN_SECRET environment variable — set this in Railway.
  // Download locally with:
  //   curl "https://www.saint-pixels.org/api/admin/pixel-history?secret=YOUR_SECRET" \
  //        -o pixel-history.json
  //
  // Falls back to the current pixels table if pixel_history doesn't exist yet.
  app.get('/api/admin/pixel-history', (req, res) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.query.secret !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      // Check which table to read from
      const historyExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pixel_history'"
      ).get();

      const rows = historyExists
        ? db.prepare('SELECT username, x, y, color, placed_at FROM pixel_history ORDER BY placed_at ASC').all()
        : db.prepare('SELECT username, x, y, color, placed_at FROM pixels ORDER BY placed_at ASC').all();

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="pixel-history.json"');

      // Stream as a JSON array without loading it all into a single string
      res.write('[\n');
      for (let i = 0; i < rows.length; i++) {
        const { username, x, y, color, placed_at } = rows[i];
        const entry = JSON.stringify({ username, x, y, color, placed_at });
        res.write(i < rows.length - 1 ? entry + ',\n' : entry + '\n');
      }
      res.write(']\n');
      res.end();
    } catch (err) {
      console.error('[admin] pixel-history dump failed:', err);
      res.status(500).json({ error: 'Dump failed', detail: err.message });
    }
  });
}

module.exports = { initializeActions };
