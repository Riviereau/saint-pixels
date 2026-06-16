#!/usr/bin/env node
/**
 * migrate.js — One-shot pixel migration: old 1920×1080 canvas → moon canvas
 *
 * Run ONCE before deploying the moon canvas update:
 *   node migrate.js
 *   node migrate.js --dry-run     # preview only, no writes
 *   node migrate.js --offset 0,0  # pin old canvas to a specific moon coordinate
 *
 * What it does:
 *   1. Reads all player pixels from the `pixels` table (excludes moonmap baseline).
 *   2. Offsets their coordinates so the old canvas maps to the centre of the moon.
 *   3. Writes them back in-place (same table, same schema) using INSERT OR REPLACE.
 *   4. Does the same to `pixel_history` so the timelapse stays consistent.
 *
 * Safe to re-run — uses a migration_log table to skip if already applied.
 *
 * Usage:
 *   DATABASE_PATH=/path/to/database.sqlite node migrate.js
 */

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env.DATABASE_PATH
  || path.resolve(__dirname, 'database.sqlite');

// Old canvas dimensions
const OLD_W = 1920;
const OLD_H = 1080;

// New moon canvas dimensions
const NEW_W = 27360;
const NEW_H = 13680;

// Where to place the top-left corner of the old canvas on the moon canvas.
// Default: centre the old canvas on the moon.
const DEFAULT_OFFSET_X = Math.floor((NEW_W - OLD_W) / 2); // 12720
const DEFAULT_OFFSET_Y = Math.floor((NEW_H - OLD_H) / 2); // 6300

// Username used for moon baseline tiles — never moved.
const MOON_BASELINE_USERNAME = process.env.MOON_BASELINE_USERNAME || 'moonmap';

// ── Parse args ────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const dryRun     = args.includes('--dry-run');
const offsetArg  = args.find(a => a.startsWith('--offset'));
let offsetX = DEFAULT_OFFSET_X;
let offsetY = DEFAULT_OFFSET_Y;

if (offsetArg) {
  const val = offsetArg.split('=')[1] || args[args.indexOf(offsetArg) + 1] || '';
  const parts = val.split(',').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    [offsetX, offsetY] = parts;
  } else {
    console.error(`Invalid --offset value: "${val}". Expected --offset X,Y (e.g. --offset 12720,6300)`);
    process.exit(1);
  }
}

console.log(`\n━━━ Saint-Pixels Canvas Migration ━━━`);
console.log(`Database   : ${DB_PATH}`);
console.log(`Old canvas : ${OLD_W}×${OLD_H}`);
console.log(`New canvas : ${NEW_W}×${NEW_H}`);
console.log(`Offset     : +${offsetX}x, +${offsetY}y  (old 0,0 → new ${offsetX},${offsetY})`);
if (dryRun) console.log(`Mode       : DRY RUN — no changes will be written\n`);
else        console.log(`Mode       : LIVE — changes will be written\n`);

// ── Open DB ───────────────────────────────────────────────────────────────────

if (!require('fs').existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// ── Idempotency guard ─────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS migration_log (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    details    TEXT
  )
`);

const alreadyRan = db.prepare(
  "SELECT applied_at FROM migration_log WHERE name = 'canvas_1920x1080_to_moon'"
).get();

if (alreadyRan) {
  const date = new Date(alreadyRan.applied_at).toUTCString();
  console.log(`✅ Migration already applied on ${date}. Skipping.`);
  console.log(`   Delete the migration_log row to re-run (not recommended).\n`);
  db.close();
  process.exit(0);
}

// ── Count rows to migrate ─────────────────────────────────────────────────────

const pixelCount = db.prepare(
  `SELECT COUNT(*) AS n FROM pixels WHERE username != ? AND x < ? AND y < ?`
).get(MOON_BASELINE_USERNAME, OLD_W, OLD_H).n;

const histCount = db.prepare(
  `SELECT COUNT(*) AS n FROM pixel_history WHERE username != ? AND x < ? AND y < ?`
).get(MOON_BASELINE_USERNAME, OLD_W, OLD_H).n;

console.log(`Pixels to migrate        : ${pixelCount.toLocaleString()} rows`);
console.log(`Pixel history to migrate : ${histCount.toLocaleString()} rows\n`);

if (pixelCount === 0 && histCount === 0) {
  console.log('Nothing to migrate — all player pixels are already outside the old canvas bounds.');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log(`DRY RUN complete. Re-run without --dry-run to apply.\n`);
  db.close();
  process.exit(0);
}

// ── Confirmation prompt ───────────────────────────────────────────────────────

const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
readline.question(`Type YES to proceed: `, (answer) => {
  readline.close();
  if (answer.trim() !== 'YES') {
    console.log('Aborted.\n');
    db.close();
    process.exit(0);
  }
  runMigration();
});

// ── Migration ─────────────────────────────────────────────────────────────────

function runMigration() {
  console.log('\nRunning migration…');
  const start = Date.now();

  db.transaction(() => {
    // ── pixels table ────────────────────────────────────────────────────────
    // We do this in pure SQL via a temp table to avoid pulling 2M rows into JS.
    //
    // Strategy:
    //   1. Create a temp table with the shifted coordinates.
    //   2. Delete the old rows.
    //   3. Insert the shifted rows (INSERT OR REPLACE handles any collisions).

    console.log('  Migrating pixels table…');
    db.exec(`
      CREATE TEMP TABLE pixels_shifted AS
        SELECT username,
               x + ${offsetX} AS x,
               y + ${offsetY} AS y,
               color,
               placed_at
        FROM pixels
        WHERE username != '${MOON_BASELINE_USERNAME}'
          AND x < ${OLD_W}
          AND y < ${OLD_H};
    `);

    const shiftedCount = db.prepare('SELECT COUNT(*) AS n FROM pixels_shifted').get().n;
    console.log(`    Shifted ${shiftedCount.toLocaleString()} pixel rows`);

    db.exec(`
      DELETE FROM pixels
        WHERE username != '${MOON_BASELINE_USERNAME}'
          AND x < ${OLD_W}
          AND y < ${OLD_H};
    `);

    db.exec(`
      INSERT OR REPLACE INTO pixels (username, x, y, color, placed_at)
        SELECT username, x, y, color, placed_at FROM pixels_shifted;

      DROP TABLE pixels_shifted;
    `);

    // ── pixel_history table ─────────────────────────────────────────────────
    console.log('  Migrating pixel_history table…');
    db.exec(`
      CREATE TEMP TABLE ph_shifted AS
        SELECT id, username,
               x + ${offsetX} AS x,
               y + ${offsetY} AS y,
               color,
               prev_color,
               placed_at
        FROM pixel_history
        WHERE username != '${MOON_BASELINE_USERNAME}'
          AND x < ${OLD_W}
          AND y < ${OLD_H};
    `);

    const phShifted = db.prepare('SELECT COUNT(*) AS n FROM ph_shifted').get().n;
    console.log(`    Shifted ${phShifted.toLocaleString()} history rows`);

    // Update in-place by id (pixel_history has an autoincrement id PK)
    db.exec(`
      UPDATE pixel_history
        SET x = x + ${offsetX},
            y = y + ${offsetY}
        WHERE username != '${MOON_BASELINE_USERNAME}'
          AND x < ${OLD_W}
          AND y < ${OLD_H};

      DROP TABLE IF EXISTS ph_shifted;
    `);

    // ── Record migration ────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO migration_log (name, applied_at, details) VALUES (?, ?, ?)
    `).run(
      'canvas_1920x1080_to_moon',
      Date.now(),
      JSON.stringify({ offsetX, offsetY, pixelsMoved: shiftedCount, historyMoved: phShifted })
    );

  })();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ Migration complete in ${elapsed}s`);
  console.log(`   Old pixels now centred at moon coordinates (${offsetX}, ${offsetY})\n`);

  db.close();
}
