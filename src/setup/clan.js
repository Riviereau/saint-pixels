/**
 * src/setup/clan.js
 *
 * Wires the Clan action into the Express app.
 * Call initializeClan() after initializeChat() in server.js.
 *
 * Usage in server.js:
 *   const { initializeClan } = require('./src/setup/clan.js');
 *   initializeClan(app, db, broadcastSSE, clanLimiter);
 */

const Clan = require('../actions/Clan.js');

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {(data: object) => void} broadcastSSE
 * @param {import('express').RequestHandler} clanLimiter - rate limiter applied to all clan routes
 */
function initializeClan(app, db, broadcastSSE, clanLimiter) {
  Clan.setDb(db);
  Clan.setBroadcast(broadcastSSE);

  const limiter = clanLimiter || ((req, res, next) => next());

  // ── Discovery ────────────────────────────────────────────────────────────
  app.get('/api/clan/search', limiter, Clan.search);
  app.get('/api/clan/mine',   limiter, Clan.mine);

  // ── Lifecycle ────────────────────────────────────────────────────────────
  app.post('/api/clan/create',        limiter, Clan.create);
  app.post('/api/clan/join/:clanId',  limiter, Clan.join);
  app.post('/api/clan/leave',         limiter, Clan.leave);
  app.post('/api/clan/disband',       limiter, Clan.disband);

  // ── Members ──────────────────────────────────────────────────────────────
  app.get('/api/clan/:clanId/members',  limiter, Clan.members);
  app.post('/api/clan/:clanId/kick',    limiter, Clan.kick);
  app.post('/api/clan/:clanId/promote', limiter, Clan.promote);

  // ── Join requests ────────────────────────────────────────────────────────
  app.post('/api/clan/:clanId/requests/:username/accept', limiter, Clan.acceptRequest);
  app.post('/api/clan/:clanId/requests/:username/reject', limiter, Clan.rejectRequest);

  // ── Settings ─────────────────────────────────────────────────────────────
  app.patch('/api/clan/:clanId/settings', limiter, Clan.updateSettings);

  // ── Alliances / Enemies ──────────────────────────────────────────────────
  app.get('/api/clan/:clanId/relations',        limiter, Clan.relations);
  app.post('/api/clan/:clanId/allies',          limiter, Clan.addAlly);
  app.delete('/api/clan/:clanId/allies/:targetId',  limiter, Clan.removeAlly);
  app.post('/api/clan/:clanId/enemies',         limiter, Clan.addEnemy);
  app.delete('/api/clan/:clanId/enemies/:targetId', limiter, Clan.removeEnemy);

  // ── Clan chat ────────────────────────────────────────────────────────────
  app.post('/api/clan/chat', limiter, Clan.sendChat);
  app.get('/api/clan/chat',  limiter, Clan.chatHistory);
}

module.exports = { initializeClan };
