// Injected by initializeActions
let _db = null;

// Ban module — provides checkBan() for profile responses.
// Loaded lazily so Leaderboard.js works even if ban.js hasn't been wired up yet.
let _checkBan = null;
try {
  const ban = require('../helpers/ban.js');
  _checkBan = ban.checkBan;
} catch {
  // ban.js not present — ban info simply won't appear in profiles
}

/**
 * Returns the current day string in UTC-4 (e.g. "2025-05-23")
 * @returns {string}
 */
function getDayUTC4() {
  const now = new Date();
  const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return utc4.toISOString().slice(0, 10);
}

/**
 * Build a WHERE clause fragment for filtering by time period.
 * For pixel_counts table (day TEXT "YYYY-MM-DD").
 * @param {'today'|'yesterday'|'week'|'month'|'year'|'decade'|'century'|'alltime'} period
 * @returns {{ clause: string, params: string[] }}
 */
function buildDateFilter(period) {
  const now = new Date(Date.now() - 4 * 60 * 60 * 1000); // UTC-4
  const today = now.toISOString().slice(0, 10);

  if (period === 'today') {
    return { clause: 'WHERE day = ?', params: [today] };
  }
  if (period === 'yesterday') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    const yest = d.toISOString().slice(0, 10);
    return { clause: 'WHERE day = ?', params: [yest] };
  }
  if (period === 'week') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 6);
    const from = d.toISOString().slice(0, 10);
    return { clause: 'WHERE day >= ?', params: [from] };
  }
  if (period === 'month') {
    const from = today.slice(0, 7) + '-01';
    return { clause: 'WHERE day >= ?', params: [from] };
  }
  if (period === 'year') {
    const from = today.slice(0, 4) + '-01-01';
    return { clause: 'WHERE day >= ?', params: [from] };
  }
  if (period === 'decade') {
    const decadeStart = String(Math.floor(parseInt(today.slice(0, 4)) / 10) * 10) + '-01-01';
    return { clause: 'WHERE day >= ?', params: [decadeStart] };
  }
  if (period === 'century') {
    const centuryStart = String(Math.floor(parseInt(today.slice(0, 4)) / 100) * 100) + '-01-01';
    return { clause: 'WHERE day >= ?', params: [centuryStart] };
  }
  // alltime — no filter
  return { clause: '', params: [] };
}

class Leaderboard {
  /**
   * GET /api/leaderboard?period=today|week|month|year|decade|alltime
   * Returns the top 100 players for the selected period.
   */
  static execute(req, res) {
    if (!_db) return res.status(503).json({ error: 'Database not available' });

    try {
      const period = ['today', 'yesterday', 'week', 'month', 'year', 'decade', 'century', 'alltime'].includes(req.query.period)
        ? req.query.period
        : 'today';

      const { clause, params } = buildDateFilter(period);

      const rows = _db.prepare(`
        SELECT username, SUM(count) AS count
        FROM pixel_counts
        ${clause}
        GROUP BY username
        ORDER BY count DESC
        LIMIT 100
      `).all(...params);

      const day = getDayUTC4();
      return res.json({ day, period, leaderboard: rows });
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * GET /api/profile/:username
   * Returns stats for a user: total pixels, today's pixels, rank, recent pixels.
   */
  static profile(req, res) {
    if (!_db) return res.status(503).json({ error: 'Database not available' });

    try {
      const { username } = req.params;

      const totalRow = _db.prepare(
        'SELECT SUM(count) AS total FROM pixel_counts WHERE username = ?'
      ).get(username);

      const day = getDayUTC4();
      const todayRow = _db.prepare(
        'SELECT count FROM pixel_counts WHERE username = ? AND day = ?'
      ).get(username, day);

      // Global rank (all time) — use a counting subquery instead of fetching
      // all rows into JS, which would be a full-table scan proportional to
      // every user ever registered.
      const rankRow = _db.prepare(`
        SELECT COUNT(*) + 1 AS rank
        FROM (
          SELECT username, SUM(count) AS total
          FROM pixel_counts
          GROUP BY username
          HAVING total > (
            SELECT COALESCE(SUM(count), 0)
            FROM pixel_counts
            WHERE username = ?
          )
        )
      `).get(username);
      const rank = rankRow ? rankRow.rank : null;

      // Last 20 pixels placed
      const recentPixels = _db.prepare(`
        SELECT x, y, color, placed_at FROM pixels
        WHERE username = ?
        ORDER BY placed_at DESC
        LIMIT 20
      `).all(username);

      // Check active ban status
      let banned = false;
      let banReason = null;
      if (_checkBan) {
        const banEntry = _checkBan(username);
        if (banEntry) {
          banned = true;
          banReason = banEntry.reason || null;
        }
      }

      return res.json({
        username,
        totalPixels: totalRow?.total || 0,
        todayPixels: todayRow?.count || 0,
        allTimeRank: rank,
        recentPixels,
        banned,
        banReason,
      });
    } catch (err) {
      console.error('Failed to fetch profile:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * @param {Database} db
   */
  static setDb(db) {
    _db = db;
  }
}

module.exports = { Leaderboard };
