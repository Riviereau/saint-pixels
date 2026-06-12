'use strict';

/**
 * suspicion.js — Suspicious account detector for Saint Pixels
 * Place at: src/helpers/suspicion.js
 *
 * Run this as a standalone script from your project root:
 *   node src/helpers/suspicion.js
 *
 * It reads your live database and prints a report of accounts that show
 * one or more of the following signals:
 *
 *   VPN / datacenter IP   — ASN/org name matches known hosting providers
 *   Shared IP             — multiple accounts registered from the same IP
 *   Rapid registration    — account created very recently (< 24 h ago)
 *   Pixel burst           — abnormally high pixels placed in a single day
 *   No pixels ever        — account has never placed a pixel (lurker / bot shell)
 *   Banned-IP evasion     — IP matches one listed in ban-list.json bannedIps
 *
 * The script does NOT modify the database.  Copy suspicious usernames
 * into ban-list.json to act on them.
 *
 * Requirements (already in your package.json):
 *   better-sqlite3
 *
 * Optional (install for real VPN/datacenter IP lookups):
 *   npm install node-fetch   (or use Node 18+ native fetch)
 */

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH       = process.env.DATABASE_PATH || path.resolve(__dirname, '../../database.sqlite');
const BAN_FILE      = path.resolve(__dirname, '../../ban-list.json');
const PIXEL_BURST   = 500;   // flag if placed > N pixels in any single day
const RECENT_HOURS  = 24;    // flag if account is younger than N hours
const SHARED_IP_MIN = 3;     // flag if N or more accounts share the same IP

// Known datacenter / VPN ASN organisation name fragments (lowercase).
// These are matched against the "org" field returned by ip-api.com.
// This list is a starting point — extend it as you discover more.
const DATACENTER_KEYWORDS = [
  'amazon', 'aws', 'google', 'googlecloud', 'microsoft', 'azure',
  'digitalocean', 'linode', 'vultr', 'ovh', 'hetzner', 'scaleway',
  'cloudflare', 'akamai', 'fastly', 'incapsula', 'imperva',
  'mullvad', 'nordvpn', 'expressvpn', 'privatevpn', 'cyberghost',
  'surfshark', 'protonvpn', 'ipvanish', 'hidemyass', 'purevpn',
  'torguard', 'windscribe', 'airvpn', 'vpnunlimited',
  'hosting', 'datacenter', 'data center', 'colocation', 'colo',
  'server', 'vps', 'cloud', 'dedicated',
];

// ── Load ban-list IPs ─────────────────────────────────────────────────────────

function loadBannedIps() {
  try {
    const data = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    const ips  = new Set();
    for (const entry of (data.bans || [])) {
      if (entry._example) continue;
      for (const ip of (entry.bannedIps || [])) ips.add(ip);
    }
    return ips;
  } catch {
    return new Set();
  }
}

// ── IP lookup via ip-api.com (free, no key needed, 45 req/min) ───────────────

const _ipCache = new Map();

async function lookupIp(ip) {
  if (_ipCache.has(ip)) return _ipCache.get(ip);

  // Skip private/loopback addresses — no point querying them
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc|fd)/.test(ip)) {
    const result = { org: 'private', country: 'local', proxy: false };
    _ipCache.set(ip, result);
    return result;
  }

  try {
    // ip-api.com free tier: fields=org,country,proxy,hosting
    // 'proxy' and 'hosting' fields require no API key on the free plan.
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=org,country,proxy,hosting`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _ipCache.set(ip, data);
    return data;
  } catch (err) {
    console.warn(`[suspicion] IP lookup failed for ${ip}: ${err.message}`);
    const result = { org: 'unknown', country: 'unknown', proxy: false, hosting: false };
    _ipCache.set(ip, result);
    return result;
  }
}

function isDatacenterOrVpn(ipInfo) {
  if (!ipInfo) return false;
  if (ipInfo.proxy || ipInfo.hosting) return true;
  const org = (ipInfo.org || '').toLowerCase();
  return DATACENTER_KEYWORDS.some((kw) => org.includes(kw));
}

// ── Rate limiter for ip-api (45 req/min free tier) ───────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function lookupIpThrottled(ip, index) {
  // ~1.4 s per request → stays under 43 req/min with some headroom
  if (index > 0 && index % 40 === 0) {
    console.log('[suspicion] Pausing 60 s to respect ip-api rate limit…');
    await sleep(60_000);
  } else if (index > 0) {
    await sleep(1400);
  }
  return lookupIp(ip);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[suspicion] Database not found at: ${DB_PATH}`);
    console.error('Set DATABASE_PATH env var or run from your project root.');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  console.log('\n━━━ Saint Pixels — Suspicious Account Report ━━━\n');
  console.log(`Database : ${DB_PATH}`);
  console.log(`Generated: ${new Date().toUTCString()}\n`);

  const bannedIps   = loadBannedIps();
  const nowMs       = Date.now();
  const recentCutoff = nowMs - RECENT_HOURS * 60 * 60 * 1000;

  // ── Fetch all accounts ────────────────────────────────────────────────────
  const accounts = db.prepare('SELECT username, ip, created_at FROM accounts').all();
  console.log(`Total accounts: ${accounts.length}\n`);

  // ── Shared-IP map ─────────────────────────────────────────────────────────
  const ipMap = new Map(); // ip → [username, ...]
  for (const acc of accounts) {
    const list = ipMap.get(acc.ip) || [];
    list.push(acc.username);
    ipMap.set(acc.ip, list);
  }

  // ── Pixel burst map ───────────────────────────────────────────────────────
  const burstRows = db.prepare(`
    SELECT username, MAX(count) AS maxDay
    FROM pixel_counts GROUP BY username
  `).all();
  const burstMap = new Map(burstRows.map((r) => [r.username, r.maxDay]));

  // ── Total pixels map ──────────────────────────────────────────────────────
  const totalRows = db.prepare(`
    SELECT username, SUM(count) AS total FROM pixel_counts GROUP BY username
  `).all();
  const totalMap = new Map(totalRows.map((r) => [r.username, r.total]));

  // ── Collect unique IPs for lookup ─────────────────────────────────────────
  const uniqueIps = [...new Set(accounts.map((a) => a.ip))];
  console.log(`Unique IPs: ${uniqueIps.length}`);

  const skipLookup = process.argv.includes('--no-lookup');
  if (skipLookup) {
    console.log('IP geo-lookup skipped (--no-lookup flag).\n');
  } else {
    console.log('Looking up IPs via ip-api.com (may take a while for large sets)…\n');
  }

  const ipInfoMap = new Map();
  if (!skipLookup) {
    for (let i = 0; i < uniqueIps.length; i++) {
      const ip   = uniqueIps[i];
      const info = await lookupIpThrottled(ip, i);
      ipInfoMap.set(ip, info);
      if ((i + 1) % 10 === 0 || i === uniqueIps.length - 1) {
        process.stdout.write(`\r  Looked up ${i + 1}/${uniqueIps.length} IPs…`);
      }
    }
    console.log('\n');
  }

  // ── Score each account ────────────────────────────────────────────────────
  const results = [];

  for (const acc of accounts) {
    const flags   = [];
    const ipInfo  = ipInfoMap.get(acc.ip);
    const sharedUsers = ipMap.get(acc.ip) || [];
    const maxDay  = burstMap.get(acc.username) || 0;
    const total   = totalMap.get(acc.username) || 0;

    if (bannedIps.has(acc.ip)) {
      flags.push('⛔ IP MATCHES BAN LIST (evasion attempt)');
    }

    if (sharedUsers.length >= SHARED_IP_MIN) {
      flags.push(`👥 Shared IP with ${sharedUsers.length - 1} other account(s): ${
        sharedUsers.filter((u) => u !== acc.username).slice(0, 5).join(', ')
      }${sharedUsers.length > 6 ? '…' : ''}`);
    }

    if (acc.created_at > recentCutoff) {
      const ageH = ((nowMs - acc.created_at) / 3_600_000).toFixed(1);
      flags.push(`🕐 Very new account (${ageH}h old)`);
    }

    if (total === 0) {
      flags.push('🫥 Never placed a pixel');
    } else if (maxDay > PIXEL_BURST) {
      flags.push(`⚡ Pixel burst: ${maxDay} in a single day`);
    }

    if (ipInfo && isDatacenterOrVpn(ipInfo)) {
      const extra = [
        ipInfo.proxy    ? 'proxy=yes'   : '',
        ipInfo.hosting  ? 'hosting=yes' : '',
        ipInfo.org      ? `org="${ipInfo.org}"` : '',
        ipInfo.country  ? `country=${ipInfo.country}` : '',
      ].filter(Boolean).join(' ');
      flags.push(`🌐 VPN/datacenter IP — ${extra}`);
    }

    if (flags.length > 0) {
      results.push({ username: acc.username, ip: acc.ip, created_at: acc.created_at, flags, total, maxDay });
    }
  }

  db.close();

  // ── Print report ──────────────────────────────────────────────────────────
  if (results.length === 0) {
    console.log('✅ No suspicious accounts found.\n');
    return;
  }

  // Sort: most flags first, then alphabetical
  results.sort((a, b) => b.flags.length - a.flags.length || a.username.localeCompare(b.username));

  console.log(`⚠️  Found ${results.length} suspicious account(s):\n`);
  console.log('─'.repeat(70));

  for (const r of results) {
    const created = new Date(r.created_at).toUTCString();
    console.log(`\nUsername : ${r.username}`);
    console.log(`IP       : ${r.ip}`);
    console.log(`Created  : ${created}`);
    console.log(`Pixels   : ${r.total} total, ${r.maxDay} max in one day`);
    console.log('Flags:');
    for (const flag of r.flags) console.log(`  ${flag}`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log('\nTo ban a user, add an entry to ban-list.json.');
  console.log('Tip: re-run with --no-lookup to skip IP geo-lookup (faster).\n');
}

main().catch((err) => {
  console.error('[suspicion] Fatal error:', err);
  process.exit(1);
});
