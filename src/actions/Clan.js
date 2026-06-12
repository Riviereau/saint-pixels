/**
 * src/actions/Clan.js
 *
 * Clan system backend.
 *
 * Endpoints (wired in src/setup/clan.js):
 *   GET    /api/clan/search?q=          — search open/all clans by name
 *   GET    /api/clan/mine               — current user's clan (or null)
 *   POST   /api/clan/create             — create a new clan (becomes leader)
 *   POST   /api/clan/join/:clanId       — join (open) or request to join (closed)
 *   POST   /api/clan/leave              — leave current clan
 *   POST   /api/clan/disband            — leader-only: delete clan
 *   GET    /api/clan/:clanId/members    — member list with roles
 *   POST   /api/clan/:clanId/kick       — leader/officer: remove a member
 *   POST   /api/clan/:clanId/promote    — leader: officer <-> member toggle
 *   POST   /api/clan/:clanId/requests/:username/accept
 *   POST   /api/clan/:clanId/requests/:username/reject
 *   PATCH  /api/clan/:clanId/settings   — leader: update name/desc/emoji/open
 *   POST   /api/clan/:clanId/allies     — leader/officer: add ally clan
 *   DELETE /api/clan/:clanId/allies/:targetId
 *   POST   /api/clan/:clanId/enemies    — leader/officer: declare rival clan
 *   DELETE /api/clan/:clanId/enemies/:targetId
 *   GET    /api/clan/:clanId/relations  — allies + enemies list
 *
 *   POST   /api/clan/chat               — send clan chat message
 *   GET    /api/clan/chat                — load clan chat history (last 200)
 *
 * Reuses the same sanitisation / abuse protections as global chat
 * (src/actions/Chat.js) for clan chat messages.
 */

'use strict';
// ── Clan-creation abuse limits ────────────────────────────────────────────────
// Max clans a single account may create per UTC day. Persisted in the
// clan_creations table so the cap survives restarts and can't be bypassed
// by spamming create+disband in a loop.
const MAX_CLAN_CREATIONS_PER_DAY = 3;
// Minimum time between create attempts for the same user, regardless of the
// daily cap — stops a tight create/fail/retry loop from hammering the
// clans table with INSERT + UNIQUE-constraint churn.
const CLAN_CREATE_COOLDOWN_MS = 10_000;

const { getSession } = require('../helpers/session.js');

const MAX_MESSAGE_LENGTH   = 300;
const CHAT_HISTORY_LIMIT   = 200;
const USER_COOLDOWN_MS     = 2_000;
const BURST_LIMIT          = 10;
const BURST_WINDOW_MS      = 30_000;

const MAX_CLAN_NAME_LEN    = 40;
const MAX_CLAN_DESC_LEN    = 200;
const MAX_CLAN_EMOJI_LEN   = 4;
const MAX_RELATIONS        = 10; // max allies / enemies per clan

/** @type {import('better-sqlite3').Database|null} */
let _db        = null;
/** @type {((data: object) => void)|null} */
let _broadcast = null;

// ── In-memory rate tracking (mirrors Chat.js) ─────────────────────────────────
const _userState = new Map(); // username -> { lastAt, timestamps, lastMsg }

// Tracks the last clan-creation attempt timestamp per user, in addition to
// the persisted daily cap. Cheap in-memory guard against rapid retries.
const _lastCreateAttempt = new Map(); // username -> timestamp (ms)

/**
 * Returns the current day string in UTC-4 (matches Leaderboard.js convention,
 * so "today" lines up with the rest of the app's daily resets).
 * @returns {string}
 */
function getDayUTC4() {
  const now = new Date();
  const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return utc4.toISOString().slice(0, 10);
}

function getUserState(username) {
  if (!_userState.has(username)) {
    _userState.set(username, { lastAt: 0, timestamps: [], lastMsg: '' });
  }
  return _userState.get(username);
}
function pruneWindow(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

const _statePruneInterval = setInterval(() => {
  const cutoff = Date.now() - BURST_WINDOW_MS * 4;
  for (const [k, v] of _userState) {
    if (v.lastAt < cutoff) _userState.delete(k);
  }
  const createCutoff = Date.now() - CLAN_CREATE_COOLDOWN_MS * 4;
  for (const [k, t] of _lastCreateAttempt) {
    if (t < createCutoff) _lastCreateAttempt.delete(k);
  }
}, 5 * 60 * 1_000);
if (_statePruneInterval.unref) _statePruneInterval.unref();

// ── Sanitisation (mirrors Chat.js) ────────────────────────────────────────────
const STRIP_CTRL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF\uFFF9-\uFFFF]/g;
const STRIP_TAGS_RE = /<[^>]{0,2048}?>/g;
const URL_RE = /(?:https?:\/\/|www\.[a-z0-9-]+\.|javascript:|data:|href=|discord\.gg\/)/i;
const SUSPICIOUS_RE = /(?:<(?:script|iframe|img|svg|object|embed|link|meta)[\s/>]|on\w+\s*=|eval\s*\(|set(?:timeout|interval)\s*\(|function\s*\(|document\.(?:cookie|write)|window\.location|base64,)/i;

function isSpammy(msg) {
  if (msg.length <= 4) return false;
  const freq = {};
  for (const ch of msg) freq[ch] = (freq[ch] || 0) + 1;
  const maxFreq = Math.max(...Object.values(freq));
  return maxFreq / msg.length > 0.70;
}

function sanitise(raw) {
  if ((raw.match(/</g) || []).length > 10) {
    raw = raw.replace(/</g, '');
  }
  return raw.replace(STRIP_CTRL_RE, '').replace(STRIP_TAGS_RE, '').trim();
}

// Emoji / short text — used for crest. Strip control chars, cap length.
function sanitiseEmoji(raw) {
  if (typeof raw !== 'string') return '🛡️';
  const cleaned = raw.replace(STRIP_CTRL_RE, '').replace(STRIP_TAGS_RE, '').trim();
  return cleaned ? cleaned.slice(0, MAX_CLAN_EMOJI_LEN) : '🛡️';
}

function sanitiseName(raw) {
  if (typeof raw !== 'string') return '';
  return sanitise(raw).slice(0, MAX_CLAN_NAME_LEN);
}
function sanitiseDesc(raw) {
  if (typeof raw !== 'string') return '';
  return sanitise(raw).slice(0, MAX_CLAN_DESC_LEN);
}

// ── DB setup ───────────────────────────────────────────────────────────────────

function setDb(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS clans (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    NOT NULL DEFAULT '',
      emoji       TEXT    NOT NULL DEFAULT '🛡️',
      open        INTEGER NOT NULL DEFAULT 1,
      leader      TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clan_members (
      clan_id   INTEGER NOT NULL,
      username  TEXT    NOT NULL,
      role      TEXT    NOT NULL DEFAULT 'member', -- 'leader' | 'officer' | 'member'
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (username)
    );
    CREATE INDEX IF NOT EXISTS idx_clan_members_clan ON clan_members(clan_id);

    CREATE TABLE IF NOT EXISTS clan_requests (
      clan_id     INTEGER NOT NULL,
      username    TEXT    NOT NULL,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (clan_id, username)
    );

    CREATE TABLE IF NOT EXISTS clan_relations (
      clan_id   INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation  TEXT    NOT NULL, -- 'ally' | 'enemy'
      created_at INTEGER NOT NULL,
      PRIMARY KEY (clan_id, target_id, relation)
    );

    CREATE TABLE IF NOT EXISTS clan_chat_messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      clan_id  INTEGER NOT NULL,
      username TEXT    NOT NULL,
      role     TEXT    NOT NULL DEFAULT 'member',
      message  TEXT    NOT NULL,
      sent_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clan_chat_clan_sent ON clan_chat_messages(clan_id, sent_at);
  `);
}

function setBroadcast(fn) {
  _broadcast = fn;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMembership(username) {
  return _db.prepare('SELECT * FROM clan_members WHERE username = ?').get(username);
}

function getClan(clanId) {
  return _db.prepare('SELECT * FROM clans WHERE id = ?').get(clanId);
}

function clanSummary(clan) {
  if (!clan) return null;
  const memberCount = _db.prepare('SELECT COUNT(*) AS c FROM clan_members WHERE clan_id = ?').get(clan.id).c;
  return {
    id: clan.id,
    name: clan.name,
    description: clan.description,
    emoji: clan.emoji,
    open: !!clan.open,
    leader: clan.leader,
    memberCount,
    createdAt: clan.created_at,
  };
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated.' });
    return null;
  }
  // Defence-in-depth: getSession() is documented to only validate the
  // 'sessions' table (registered accounts), never 'guest_sessions'. If that
  // ever changes, this explicit check still blocks guest tokens from every
  // clan endpoint, not just create.
  if (session.isGuest) {
    res.status(403).json({ error: 'Guests cannot use clan features. Please register an account.' });
    return null;
  }
  return session;
}

// ── GET /api/clan/search?q= ──────────────────────────────────────────────────

function search(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  try {
    const q = sanitiseName(req.query.q || '');
    let rows;
    if (q) {
      // Escape SQLite LIKE wildcards (% and _) so a literal search for e.g.
      // "%" or "_" doesn't act as a wildcard and match every clan.
      const likeSafe = q.replace(/[%_\\]/g, '\\$&');
      rows = _db.prepare(`
        SELECT * FROM clans
        WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY name ASC LIMIT 25
      `).all(`%${likeSafe}%`);
    } else {
      rows = _db.prepare(`
        SELECT * FROM clans
        WHERE open = 1
        ORDER BY created_at DESC LIMIT 25
      `).all();
    }
    return res.json({ clans: rows.map(clanSummary) });
  } catch (err) {
    console.error('[clan] search error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── GET /api/clan/mine ────────────────────────────────────────────────────────

function mine(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const membership = getMembership(session.username);
    if (!membership) return res.json({ clan: null });

    const clan = getClan(membership.clan_id);
    if (!clan) return res.json({ clan: null });

    const summary = clanSummary(clan);
    summary.myRole = membership.role;

    // Pending join requests — only for leader/officer
    let pending = [];
    if (membership.role === 'leader' || membership.role === 'officer') {
      pending = _db.prepare(
        'SELECT username, requested_at FROM clan_requests WHERE clan_id = ? ORDER BY requested_at ASC'
      ).all(clan.id);
    }

    return res.json({ clan: summary, pending });
  } catch (err) {
    console.error('[clan] mine error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/create ────────────────────────────────────────────────────

function create(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    if (getMembership(session.username)) {
      return res.status(400).json({ error: 'You are already in a clan. Leave it first.' });
    }

    // ── Per-user cooldown — blocks tight create/fail/retry loops ────────────
    const lastAttempt = _lastCreateAttempt.get(session.username) || 0;
    const sinceLast = Date.now() - lastAttempt;
    if (sinceLast < CLAN_CREATE_COOLDOWN_MS) {
      return res.status(429).json({
        error: 'Please wait before creating another clan.',
        cooldownMs: CLAN_CREATE_COOLDOWN_MS - sinceLast,
      });
    }

    // ── Daily creation cap (persisted — survives restarts) ───────────────────
    const day = getDayUTC4();
    const creationRow = _db.prepare(
      'SELECT count FROM clan_creations WHERE username = ? AND day = ?'
    ).get(session.username, day);
    const creationsToday = creationRow?.count || 0;
    if (creationsToday >= MAX_CLAN_CREATIONS_PER_DAY) {
      return res.status(429).json({
        error: `You can only create ${MAX_CLAN_CREATIONS_PER_DAY} clans per day. Try again tomorrow.`,
      });
    }

    const name = sanitiseName(req.body?.name);
    const description = sanitiseDesc(req.body?.description);
    const emoji = sanitiseEmoji(req.body?.emoji);
    const open = req.body?.open === false ? 0 : 1;

    if (!name) return res.status(400).json({ error: 'Clan name is required.' });
    if (name.length < 2) return res.status(400).json({ error: 'Clan name too short.' });

    const existing = _db.prepare('SELECT id FROM clans WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) return res.status(409).json({ error: 'A clan with that name already exists.' });

    // Record the attempt timestamp now — even if creation fails after this
    // point for an unrelated reason, we don't want to let the user bypass
    // the cooldown by repeatedly hitting a different failure path.
    _lastCreateAttempt.set(session.username, Date.now());

    const now = Date.now();
    let clanId;
    _db.transaction(() => {
      const info = _db.prepare(`
        INSERT INTO clans (name, description, emoji, open, leader, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, description, emoji, open, session.username, now);

      clanId = info.lastInsertRowid;
      _db.prepare(`
        INSERT INTO clan_members (clan_id, username, role, joined_at)
        VALUES (?, ?, 'leader', ?)
      `).run(clanId, session.username, now);

      // Bump the persisted daily counter
      _db.prepare(`
        INSERT INTO clan_creations (username, day, count) VALUES (?, ?, 1)
        ON CONFLICT(username, day) DO UPDATE SET count = count + 1
      `).run(session.username, day);
    })();

    const clan = getClan(clanId);
    const summary = clanSummary(clan);
    summary.myRole = 'leader';
    return res.json({ ok: true, clan: summary });
  } catch (err) {
    console.error('[clan] create error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/join/:clanId ──────────────────────────────────────────────

function join(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    if (getMembership(session.username)) {
      return res.status(400).json({ error: 'You are already in a clan. Leave it first.' });
    }

    const clanId = parseInt(req.params.clanId, 10);
    const clan = getClan(clanId);
    if (!clan) return res.status(404).json({ error: 'Clan not found.' });

    const now = Date.now();

    if (clan.open) {
      _db.prepare(`
        INSERT INTO clan_members (clan_id, username, role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(clanId, session.username, now);

      if (_broadcast) {
        _broadcast({ type: 'clan_event', clan_id: clanId, event: 'join', username: session.username });
      }

      const summary = clanSummary(getClan(clanId));
      summary.myRole = 'member';
      return res.json({ ok: true, joined: true, clan: summary });
    }

    // Closed clan — create/refresh a join request
    _db.prepare(`
      INSERT OR REPLACE INTO clan_requests (clan_id, username, requested_at)
      VALUES (?, ?, ?)
    `).run(clanId, session.username, now);

    return res.json({ ok: true, joined: false, requested: true });
  } catch (err) {
    console.error('[clan] join error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/leave ─────────────────────────────────────────────────────

function leave(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const membership = getMembership(session.username);
    if (!membership) return res.status(400).json({ error: 'You are not in a clan.' });

    if (membership.role === 'leader') {
      const memberCount = _db.prepare('SELECT COUNT(*) AS c FROM clan_members WHERE clan_id = ?').get(membership.clan_id).c;
      if (memberCount > 1) {
        return res.status(400).json({ error: 'Leaders must promote a new leader or disband the clan before leaving.' });
      }
      // Sole member — leaving disbands the clan
      return disbandClanInternal(membership.clan_id, res, session.username);
    }

    _db.prepare('DELETE FROM clan_members WHERE username = ?').run(session.username);

    if (_broadcast) {
      _broadcast({ type: 'clan_event', clan_id: membership.clan_id, event: 'leave', username: session.username });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[clan] leave error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/disband ───────────────────────────────────────────────────

function disband(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const membership = getMembership(session.username);
    if (!membership) return res.status(400).json({ error: 'You are not in a clan.' });
    if (membership.role !== 'leader') return res.status(403).json({ error: 'Only the leader can disband the clan.' });

    return disbandClanInternal(membership.clan_id, res, session.username);
  } catch (err) {
    console.error('[clan] disband error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function disbandClanInternal(clanId, res, actingUsername) {
  const members = _db.prepare('SELECT username FROM clan_members WHERE clan_id = ?').all(clanId);

  _db.transaction(() => {
    _db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(clanId);
    _db.prepare('DELETE FROM clan_requests WHERE clan_id = ?').run(clanId);
    _db.prepare('DELETE FROM clan_relations WHERE clan_id = ? OR target_id = ?').run(clanId, clanId);
    _db.prepare('DELETE FROM clan_chat_messages WHERE clan_id = ?').run(clanId);
    _db.prepare('DELETE FROM clans WHERE id = ?').run(clanId);
  })();

  if (_broadcast) {
    for (const m of members) {
      _broadcast({ type: 'clan_event', clan_id: clanId, event: 'disbanded', username: actingUsername, target: m.username });
    }
  }

  return res.json({ ok: true, disbanded: true });
}

// ── GET /api/clan/:clanId/members ────────────────────────────────────────────

function members(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    const clan = getClan(clanId);
    if (!clan) return res.status(404).json({ error: 'Clan not found.' });

    const rows = _db.prepare(`
      SELECT username, role, joined_at FROM clan_members
      WHERE clan_id = ?
      ORDER BY
        CASE role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END,
        joined_at ASC
    `).all(clanId);

    return res.json({ members: rows });
  } catch (err) {
    console.error('[clan] members error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/:clanId/kick ──────────────────────────────────────────────

function kick(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    const membership = getMembership(session.username);
    if (!membership || membership.clan_id !== clanId) {
      return res.status(403).json({ error: 'You are not a member of this clan.' });
    }
    if (membership.role !== 'leader' && membership.role !== 'officer') {
      return res.status(403).json({ error: 'Only leaders and officers can remove members.' });
    }

    const target = String(req.body?.username || '');
    if (!target) return res.status(400).json({ error: 'Username required.' });
    if (target === session.username) return res.status(400).json({ error: 'Use Leave Clan to remove yourself.' });

    const targetMembership = getMembership(target);
    if (!targetMembership || targetMembership.clan_id !== clanId) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    if (targetMembership.role === 'leader') {
      return res.status(403).json({ error: 'Cannot remove the leader.' });
    }
    // Officers can't kick other officers — leader-only
    if (targetMembership.role === 'officer' && membership.role !== 'leader') {
      return res.status(403).json({ error: 'Only the leader can remove officers.' });
    }

    _db.prepare('DELETE FROM clan_members WHERE username = ?').run(target);

    if (_broadcast) {
      _broadcast({ type: 'clan_event', clan_id: clanId, event: 'kicked', username: session.username, target });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[clan] kick error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/:clanId/promote ───────────────────────────────────────────

function promote(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    const membership = getMembership(session.username);
    if (!membership || membership.clan_id !== clanId || membership.role !== 'leader') {
      return res.status(403).json({ error: 'Only the leader can change roles.' });
    }

    const target = String(req.body?.username || '');
    const targetMembership = getMembership(target);
    if (!targetMembership || targetMembership.clan_id !== clanId) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    if (targetMembership.role === 'leader') {
      return res.status(400).json({ error: 'Target is the leader.' });
    }

    const newRole = targetMembership.role === 'officer' ? 'member' : 'officer';
    _db.prepare('UPDATE clan_members SET role = ? WHERE username = ?').run(newRole, target);

    if (_broadcast) {
      _broadcast({ type: 'clan_event', clan_id: clanId, event: 'role_change', username: session.username, target, role: newRole });
    }

    return res.json({ ok: true, role: newRole });
  } catch (err) {
    console.error('[clan] promote error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── POST /api/clan/:clanId/requests/:username/accept | reject ───────────────

function respondRequest(req, res, accept) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    const membership = getMembership(session.username);
    if (!membership || membership.clan_id !== clanId || (membership.role !== 'leader' && membership.role !== 'officer')) {
      return res.status(403).json({ error: 'Only leaders and officers can manage join requests.' });
    }

    const target = req.params.username;
    const reqRow = _db.prepare('SELECT * FROM clan_requests WHERE clan_id = ? AND username = ?').get(clanId, target);
    if (!reqRow) return res.status(404).json({ error: 'Request not found.' });

    _db.prepare('DELETE FROM clan_requests WHERE clan_id = ? AND username = ?').run(clanId, target);

    if (accept) {
      if (getMembership(target)) {
        return res.status(409).json({ error: 'User already joined another clan.' });
      }
      _db.prepare(`
        INSERT INTO clan_members (clan_id, username, role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(clanId, target, Date.now());

      if (_broadcast) {
        _broadcast({ type: 'clan_event', clan_id: clanId, event: 'join', username: target });
      }
    }

    return res.json({ ok: true, accepted: !!accept });
  } catch (err) {
    console.error('[clan] respondRequest error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function acceptRequest(req, res) { return respondRequest(req, res, true); }
function rejectRequest(req, res) { return respondRequest(req, res, false); }

// ── PATCH /api/clan/:clanId/settings ─────────────────────────────────────────

function updateSettings(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    const membership = getMembership(session.username);
    if (!membership || membership.clan_id !== clanId || membership.role !== 'leader') {
      return res.status(403).json({ error: 'Only the leader can change clan settings.' });
    }

    const clan = getClan(clanId);
    if (!clan) return res.status(404).json({ error: 'Clan not found.' });

    const updates = {};
    if (req.body?.name !== undefined) {
      const name = sanitiseName(req.body.name);
      if (!name || name.length < 2) return res.status(400).json({ error: 'Invalid clan name.' });
      if (name.toLowerCase() !== clan.name.toLowerCase()) {
        const existing = _db.prepare('SELECT id FROM clans WHERE name = ? COLLATE NOCASE AND id != ?').get(name, clanId);
        if (existing) return res.status(409).json({ error: 'A clan with that name already exists.' });
      }
      updates.name = name;
    }
    if (req.body?.description !== undefined) updates.description = sanitiseDesc(req.body.description);
    if (req.body?.emoji !== undefined) updates.emoji = sanitiseEmoji(req.body.emoji);
    if (req.body?.open !== undefined) updates.open = req.body.open ? 1 : 0;

    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, clan: clanSummary(clan) });
    }

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    _db.prepare(`UPDATE clans SET ${setClause} WHERE id = ?`).run(...values, clanId);

    const summary = clanSummary(getClan(clanId));
    summary.myRole = 'leader';

    if (_broadcast) {
      _broadcast({ type: 'clan_event', clan_id: clanId, event: 'settings_updated', username: session.username });
    }

    return res.json({ ok: true, clan: summary });
  } catch (err) {
    console.error('[clan] updateSettings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Alliances / Enemies ───────────────────────────────────────────────────────

function relations(req, res) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    if (!getClan(clanId)) return res.status(404).json({ error: 'Clan not found.' });

    const allies = _db.prepare(`
      SELECT c.id, c.name, c.emoji FROM clan_relations r
      JOIN clans c ON c.id = r.target_id
      WHERE r.clan_id = ? AND r.relation = 'ally'
      ORDER BY c.name ASC
    `).all(clanId);

    const enemies = _db.prepare(`
      SELECT c.id, c.name, c.emoji FROM clan_relations r
      JOIN clans c ON c.id = r.target_id
      WHERE r.clan_id = ? AND r.relation = 'enemy'
      ORDER BY c.name ASC
    `).all(clanId);

    return res.json({ allies, enemies });
  } catch (err) {
    console.error('[clan] relations error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function requireOfficer(session, clanId, res) {
  const membership = getMembership(session.username);
  if (!membership || membership.clan_id !== clanId || (membership.role !== 'leader' && membership.role !== 'officer')) {
    res.status(403).json({ error: 'Only leaders and officers can manage alliances.' });
    return null;
  }
  return membership;
}

function addRelation(req, res, relation) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    if (!requireOfficer(session, clanId, res)) return;

    const targetName = sanitiseName(req.body?.name || req.body?.clanName);
    if (!targetName) return res.status(400).json({ error: 'Target clan name is required.' });

    const target = _db.prepare('SELECT * FROM clans WHERE name = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: 'Clan not found.' });
    if (target.id === clanId) return res.status(400).json({ error: 'A clan cannot ally or rival itself.' });

    const count = _db.prepare("SELECT COUNT(*) AS c FROM clan_relations WHERE clan_id = ? AND relation = ?").get(clanId, relation).c;
    if (count >= MAX_RELATIONS) {
      return res.status(400).json({ error: `Maximum of ${MAX_RELATIONS} ${relation === 'ally' ? 'allies' : 'rivals'} reached.` });
    }

    // Adding an ally removes any existing enemy relation with that clan, and vice versa
    const opposite = relation === 'ally' ? 'enemy' : 'ally';
    _db.prepare('DELETE FROM clan_relations WHERE clan_id = ? AND target_id = ? AND relation = ?').run(clanId, target.id, opposite);

    _db.prepare(`
      INSERT OR IGNORE INTO clan_relations (clan_id, target_id, relation, created_at)
      VALUES (?, ?, ?, ?)
    `).run(clanId, target.id, relation, Date.now());

    return res.json({ ok: true, target: { id: target.id, name: target.name, emoji: target.emoji } });
  } catch (err) {
    console.error('[clan] addRelation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function removeRelation(req, res, relation) {
  if (!_db) return res.status(503).json({ error: 'Database not available' });
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const clanId = parseInt(req.params.clanId, 10);
    if (!requireOfficer(session, clanId, res)) return;

    const targetId = parseInt(req.params.targetId, 10);
    _db.prepare('DELETE FROM clan_relations WHERE clan_id = ? AND target_id = ? AND relation = ?').run(clanId, targetId, relation);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[clan] removeRelation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function addAlly(req, res)     { return addRelation(req, res, 'ally'); }
function removeAlly(req, res)  { return removeRelation(req, res, 'ally'); }
function addEnemy(req, res)    { return addRelation(req, res, 'enemy'); }
function removeEnemy(req, res) { return removeRelation(req, res, 'enemy'); }

// ── Clan chat ──────────────────────────────────────────────────────────────────

async function sendChat(req, res) {
  if (!_db) return res.status(500).json({ error: 'Database not ready.' });

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  const membership = getMembership(session.username);
  if (!membership) return res.status(403).json({ error: 'You must be in a clan to use clan chat.' });

  const rawBody = req.body?.message;
  if (rawBody === undefined || rawBody === null || typeof rawBody !== 'string') {
    return res.status(400).json({ error: 'Message must be a string.' });
  }

  const message = sanitise(rawBody);
  if (!message) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars).` });
  }
  if (SUSPICIOUS_RE.test(rawBody)) {
    return res.status(400).json({ error: 'Message contains disallowed content.' });
  }
  if (URL_RE.test(message)) {
    return res.status(400).json({ error: 'Links are not allowed in chat.' });
  }
  if (isSpammy(message)) {
    return res.status(400).json({ error: 'Message looks like spam.' });
  }

  const uState = getUserState(session.username);
  if (message === uState.lastMsg) {
    return res.status(429).json({ error: 'No duplicate messages.' });
  }
  const remaining = uState.lastAt + USER_COOLDOWN_MS - Date.now();
  if (remaining > 0) {
    return res.status(429).json({ error: 'Slow down!', cooldownMs: remaining });
  }
  pruneWindow(uState.timestamps, BURST_WINDOW_MS);
  if (uState.timestamps.length >= BURST_LIMIT) {
    return res.status(429).json({ error: `Max ${BURST_LIMIT} messages per 30 seconds.` });
  }

  const now = Date.now();
  uState.lastAt = now;
  uState.lastMsg = message;
  uState.timestamps.push(now);

  let rowId;
  try {
    const info = _db.prepare(`
      INSERT INTO clan_chat_messages (clan_id, username, role, message, sent_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(membership.clan_id, session.username, membership.role, message, now);
    rowId = info.lastInsertRowid;
  } catch (err) {
    console.error('[clan] chat insert error:', err);
    return res.status(500).json({ error: 'Could not save message.' });
  }

  const payload = {
    type: 'clan_chat',
    id: rowId,
    clan_id: membership.clan_id,
    username: session.username,
    role: membership.role,
    message,
    sent_at: now,
  };
  if (_broadcast) _broadcast(payload);

  return res.json({ ok: true, ...payload });
}

function chatHistory(req, res) {
  if (!_db) return res.status(500).json({ error: 'Database not ready.' });
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  const membership = getMembership(session.username);
  if (!membership) return res.json({ messages: [], clan_id: null });

  try {
    const rows = _db.prepare(`
      SELECT id, username, role, message, sent_at
      FROM   clan_chat_messages
      WHERE  clan_id = ?
      ORDER  BY sent_at DESC
      LIMIT  ?
    `).all(membership.clan_id, CHAT_HISTORY_LIMIT);
    rows.reverse();
    return res.json({ messages: rows, clan_id: membership.clan_id });
  } catch (err) {
    console.error('[clan] chatHistory error:', err);
    return res.status(500).json({ error: 'Could not load clan chat history.' });
  }
}

module.exports = {
  setDb,
  setBroadcast,
  search,
  mine,
  create,
  join,
  leave,
  disband,
  members,
  kick,
  promote,
  acceptRequest,
  rejectRequest,
  updateSettings,
  relations,
  addAlly,
  removeAlly,
  addEnemy,
  removeEnemy,
  sendChat,
  chatHistory,
};
