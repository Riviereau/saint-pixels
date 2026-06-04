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
      const historyExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pixel_history'"
      ).get();

      // ── Build the final row list ──────────────────────────────────────────
      // Goal: every pixel that has ever been placed should appear in the output,
      // including pixels placed before pixel_history existed.
      //
      // Strategy:
      //   1. Load all pixel_history rows (the real append-log).
      //   2. Find pixels in the `pixels` table (current board state) that have
      //      NO entry in pixel_history — these are "legacy" pixels placed before
      //      the history table was added.
      //   3. Assign the legacy pixels synthetic timestamps spaced LEGACY_GAP_MS
      //      apart, anchored just before the earliest real history event (or
      //      before Date.now() if there is no history at all).
      //   4. Merge and sort everything by placed_at ASC.
      //
      // The 3200 ms gap between legacy pixels gives the timelapse a slow,
      // deliberate reveal of the "founding" pixels before the real history begins.

      const LEGACY_GAP_MS = 3200;

      // Step 1: real history rows
      const historyRows = historyExists
        ? db.prepare('SELECT username, x, y, color, placed_at FROM pixel_history ORDER BY placed_at ASC').all()
        : [];

      // Step 2: legacy pixels — in pixels table but absent from pixel_history
      // We detect absence by looking for (x,y) pairs that never appear in
      // pixel_history.  If pixel_history doesn't exist yet, ALL pixels are legacy.
      let legacyRows;
      if (!historyExists || historyRows.length === 0) {
        // No history at all — every pixel in the board is legacy
        legacyRows = db.prepare(
          'SELECT username, x, y, color, placed_at FROM pixels ORDER BY placed_at ASC'
        ).all();
      } else {
        // Find pixels whose (x,y) never appears in pixel_history
        legacyRows = db.prepare(`
          SELECT p.username, p.x, p.y, p.color, p.placed_at
          FROM pixels p
          WHERE NOT EXISTS (
            SELECT 1 FROM pixel_history ph WHERE ph.x = p.x AND ph.y = p.y
          )
          ORDER BY p.placed_at ASC
        `).all();
      }

      // Step 3: assign synthetic timestamps to legacy pixels
      let syntheticRows = [];
      if (legacyRows.length > 0) {
        // Anchor just before the earliest real event (or now if no real events)
        const anchor = historyRows.length > 0
          ? historyRows[0].placed_at
          : Date.now();
        // Work backwards from the anchor so the last legacy pixel lands just
        // before the first real event.
        const startTs = anchor - legacyRows.length * LEGACY_GAP_MS;
        syntheticRows = legacyRows.map((r, i) => ({
          username:  r.username,
          x:         r.x,
          y:         r.y,
          color:     r.color,
          placed_at: startTs + i * LEGACY_GAP_MS,
        }));
      }

      // Step 4: merge and sort
      const allRows = [...syntheticRows, ...historyRows];
      allRows.sort((a, b) => a.placed_at - b.placed_at);

      // ── Stream the JSON array ─────────────────────────────────────────────
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="pixel-history.json"');

      res.write('[\n');
      for (let i = 0; i < allRows.length; i++) {
        const { username, x, y, color, placed_at } = allRows[i];
        const entry = JSON.stringify({ username, x, y, color, placed_at });
        res.write(i < allRows.length - 1 ? entry + ',\n' : entry + '\n');
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
