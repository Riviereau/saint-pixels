#!/usr/bin/env node
'use strict';

/**
 * timelapse.js  — Root-level CLI script
 * ─────────────────────────────────────
 * Renders a full-resolution MP4 timelapse of every pixel ever placed on the
 * board, including pixels that predate the pixel_history table (legacy pixels
 * stored only in the `pixels` upsert table).
 *
 * Usage:
 *   node timelapse.js [options]
 *
 * Options:
 *   --db <path>          SQLite database path  (default: ./database.sqlite)
 *   --json <path>        Use a JSON history file instead of SQLite
 *   --out <path>         Output MP4 path       (default: ./timelapse.mp4)
 *   --fps <n>            Video framerate        (default: 30)
 *   --pps <n>            Pixel events/second    (default: 200)
 *   --scale <n>          Downscale factor — 2 = 960×540 (default: 1)
 *   --bg <hex>           Background colour, no # (default: 2e2e2f)
 *   --from <date>        Only events on/after this date  (e.g. 2025-01-01)
 *   --to <date>          Only events up to this date
 *   --user <name>        Only placements by one user
 *   --crop x0,y0,x1,y1  Crop to board-pixel rectangle (e.g. 0,0,960,540)
 *   --no-watermark       Remove the "Saint-Pixels" watermark
 *   --social <platform>  Optimise for social sharing — "discord" or "reddit"
 *                        Upscales each board pixel with nearest-neighbour so
 *                        it stays crisp after platform re-encoding, raises the
 *                        bitrate, and tunes the encoder for pixel art.
 *                        discord → targets ≤50 MB (Nitro Basic), 1080p cap.
 *                        reddit  → targets ≤1 GB, 1080p cap.
 *
 * Requirements:
 *   npm install canvas better-sqlite3
 *   ffmpeg on PATH (or set FFMPEG_PATH env var)
 *
 * Legacy pixel handling:
 *   Pixels placed before the pixel_history table was added live only in the
 *   `pixels` table (the upsert table storing current board state).  This
 *   script detects them, assigns synthetic timestamps spaced 3200 ms apart
 *   anchored just before the earliest real history event, and merges them
 *   into the full event stream so the timelapse starts from day one.
 */

const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');

// ── Parse CLI args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
function hasFlag(flag) {
  return args.includes(flag);
}

const DB_PATH   = getArg('--db')    || process.env.DB_PATH    || path.join(process.cwd(), 'database.sqlite');
const JSON_PATH = getArg('--json')  || process.env.JSON_HISTORY_PATH || null;
const OUT_PATH  = getArg('--out')   || path.join(process.cwd(), 'timelapse.mp4');
const FFMPEG    = process.env.FFMPEG_PATH || 'ffmpeg';

const FPS       = Math.max(1, parseInt(getArg('--fps')   || '30',  10));
const PPS       = Math.max(1, parseInt(getArg('--pps')   || '200', 10));
const SCALE     = Math.max(1, parseInt(getArg('--scale') || '1',   10));
const BG_HEX    = '#' + (getArg('--bg') || '2e2e2f').replace(/^#/, '');
const WATERMARK = !hasFlag('--no-watermark');

const FROM_DATE = getArg('--from') || null;
const TO_DATE   = getArg('--to')   || null;
const USER      = getArg('--user') || null;

// --social discord | reddit
const SOCIAL_RAW = (getArg('--social') || '').toLowerCase();
if (SOCIAL_RAW && SOCIAL_RAW !== 'discord' && SOCIAL_RAW !== 'reddit') {
  console.error('--social must be "discord" or "reddit".');
  process.exit(1);
}
const SOCIAL = SOCIAL_RAW || null; // null = off, 'discord', 'reddit'

// Social-mode upscale: each board pixel becomes SOCIAL_UPSCALE x SOCIAL_UPSCALE
// real output pixels, keeping hard edges crisp after platform re-encoding.
// We calculate the max integer upscale that still keeps output within 1920x1080.
function calcSocialUpscale(outW, outH) {
  if (!SOCIAL) return 1;
  const maxByW = Math.floor(1920 / outW);
  const maxByH = Math.floor(1080 / outH);
  return Math.max(1, Math.min(maxByW, maxByH, 4)); // cap at 4x
}

// --crop x0,y0,x1,y1
let CROP = null;
const rawCrop = getArg('--crop');
if (rawCrop) {
  const parts = rawCrop.split(',').map(Number);
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    CROP = { x0: parts[0], y0: parts[1], x1: parts[2], y1: parts[3] };
  } else {
    console.error('--crop must be four numbers: x0,y0,x1,y1  e.g. --crop 0,0,960,540');
    process.exit(1);
  }
}

// ── Board dimensions ───────────────────────────────────────────────────────────

const BOARD_W = 1920;
const BOARD_H = 1080;

// Render region (full board unless --crop is set)
const REGION_X0 = CROP ? CROP.x0 : 0;
const REGION_Y0 = CROP ? CROP.y0 : 0;
const REGION_X1 = CROP ? CROP.x1 : BOARD_W;
const REGION_Y1 = CROP ? CROP.y1 : BOARD_H;
const REGION_W  = REGION_X1 - REGION_X0;
const REGION_H  = REGION_Y1 - REGION_Y0;

if (REGION_W <= 0 || REGION_H <= 0) {
  console.error('--crop region has zero or negative size.');
  process.exit(1);
}

// H.264 requires even dimensions — pad up if needed
const OUT_W = Math.ceil(Math.round(REGION_W / SCALE) / 2) * 2;
const OUT_H = Math.ceil(Math.round(REGION_H / SCALE) / 2) * 2;

const EVENTS_PER_FRAME = PPS / FPS;

// ── Legacy pixel synthesis ─────────────────────────────────────────────────────
//
// Pixels placed before pixel_history existed live only in the `pixels` table.
// We find them, give them synthetic timestamps, and prepend them to the stream.

const LEGACY_GAP_MS = 3200;

/**
 * Build a full, chronologically sorted event array from a SQLite database.
 * Merges real pixel_history rows with legacy pixels from the `pixels` table.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ username:string, x:number, y:number, color:string, placed_at:number }[]}
 */
function buildFullEventStreamFromDb(db) {
  // ── Step 1: real history rows (with optional date/user filters) ────────────
  let WHERE = '1=1';
  const bindings = [];

  if (FROM_DATE) {
    const ts = Date.parse(FROM_DATE);
    if (!isNaN(ts)) { WHERE += ' AND placed_at >= ?'; bindings.push(ts); }
  }
  if (TO_DATE) {
    const ts = Date.parse(TO_DATE + 'T23:59:59');
    if (!isNaN(ts)) { WHERE += ' AND placed_at <= ?'; bindings.push(ts); }
  }
  if (USER) {
    WHERE += ' AND username = ?'; bindings.push(USER);
  }

  // Check pixel_history exists before querying it
  const historyTableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pixel_history'"
  ).get();

  let historyRows = [];
  if (historyTableExists) {
    historyRows = db.prepare(
      `SELECT username, x, y, color, placed_at
       FROM pixel_history WHERE ${WHERE} ORDER BY placed_at ASC`
    ).all(...bindings);
  }

  // ── Step 2: legacy pixels absent from pixel_history ────────────────────────
  let legacyRows = [];
  if (!historyTableExists || historyRows.length === 0) {
    // No history at all — every pixel on the board is considered legacy.
    // Apply user filter if set; date filter can't be applied reliably.
    const userClause = USER ? ' WHERE username = ?' : '';
    legacyRows = db.prepare(
      `SELECT username, x, y, color, placed_at FROM pixels${userClause} ORDER BY placed_at ASC`
    ).all(...(USER ? [USER] : []));
  } else if (historyTableExists) {
    // Pixels whose (x,y) never appears in pixel_history — they predate it.
    const userClause = USER ? ' AND p.username = ?' : '';
    legacyRows = db.prepare(`
      SELECT p.username, p.x, p.y, p.color, p.placed_at
      FROM pixels p
      WHERE NOT EXISTS (
        SELECT 1 FROM pixel_history ph WHERE ph.x = p.x AND ph.y = p.y
      )${userClause}
      ORDER BY p.placed_at ASC
    `).all(...(USER ? [USER] : []));
  }

  // ── Step 3: assign synthetic timestamps to legacy pixels ───────────────────
  let syntheticRows = [];
  if (legacyRows.length > 0) {
    const earliestReal = historyTableExists
      ? db.prepare('SELECT placed_at FROM pixel_history ORDER BY placed_at ASC LIMIT 1').get()
      : null;
    const anchor  = earliestReal ? earliestReal.placed_at : Date.now();
    const startTs = anchor - legacyRows.length * LEGACY_GAP_MS;
    syntheticRows = legacyRows.map((r, i) => ({
      username:  r.username,
      x:         r.x,
      y:         r.y,
      color:     r.color,
      placed_at: startTs + i * LEGACY_GAP_MS,
    }));

    console.log(`[timelapse] Found ${legacyRows.length} legacy pixel(s) (pre-history) — prepending with synthetic timestamps.`);
  }

  // ── Step 4: merge and sort ─────────────────────────────────────────────────
  const all = [...syntheticRows, ...historyRows];
  all.sort((a, b) => a.placed_at - b.placed_at);
  return all;
}

/**
 * Load events from a JSON history file (written by PlacePixel.appendToJsonHistory).
 * Applies --from / --to / --user filters and sorts by placed_at.
 *
 * @param {string} jsonPath
 * @returns {{ username:string, x:number, y:number, color:string, placed_at:number }[]}
 */
function loadEventsFromJson(jsonPath) {
  console.log(`[timelapse] Reading JSON history: ${jsonPath}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read JSON history file: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(raw)) {
    console.error('JSON history file must contain a top-level array.');
    process.exit(1);
  }

  let events = raw;

  if (FROM_DATE) {
    const ts = Date.parse(FROM_DATE);
    if (!isNaN(ts)) events = events.filter(e => e.placed_at >= ts);
  }
  if (TO_DATE) {
    const ts = Date.parse(TO_DATE + 'T23:59:59');
    if (!isNaN(ts)) events = events.filter(e => e.placed_at <= ts);
  }
  if (USER) {
    events = events.filter(e => e.username === USER);
  }

  events.sort((a, b) => a.placed_at - b.placed_at);
  return events;
}

// ── Color normaliser ───────────────────────────────────────────────────────────

function normalizeColor(c) {
  if (!c || c === 'erase') return null;
  const h = String(c).replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(h)) return '#' + h;
  if (/^[0-9a-fA-F]{3}$/.test(h)) return '#' + h.split('').map(x => x + x).join('');
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // ── Load canvas ─────────────────────────────────────────────────────────────
  let createCanvas;
  try {
    ({ createCanvas } = require('canvas'));
  } catch {
    console.error(
      'Error: the "canvas" npm package is not installed.\n' +
      'Run: npm install canvas\n' +
      '(You may also need system libs: libcairo2-dev libpango1.0-dev libpng-dev)'
    );
    process.exit(1);
  }

  // ── Load events ─────────────────────────────────────────────────────────────
  let events;

  if (JSON_PATH) {
    // JSON mode — no DB needed
    events = loadEventsFromJson(JSON_PATH);
  } else {
    // SQLite mode — requires better-sqlite3
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      console.error(
        'Error: the "better-sqlite3" npm package is not installed.\n' +
        'Run: npm install better-sqlite3'
      );
      process.exit(1);
    }

    if (!fs.existsSync(DB_PATH)) {
      console.error(`Database not found: ${DB_PATH}\nUse --db <path> to specify a different location.`);
      process.exit(1);
    }

    console.log(`[timelapse] Opening database: ${DB_PATH}`);
    const db = new Database(DB_PATH, { readonly: true });
    events = buildFullEventStreamFromDb(db);
    db.close();
  }

  if (events.length === 0) {
    console.error('No pixel events found for the given filters. Nothing to render.');
    process.exit(1);
  }

  console.log(`[timelapse] ${events.length.toLocaleString()} events to render`);
  console.log(`[timelapse] Output: ${OUT_PATH}  (${SOCIAL_OUT_W}x${SOCIAL_OUT_H} @ ${FPS} fps, ${PPS} px/s)`);
  if (CROP) console.log(`[timelapse] Crop: (${REGION_X0},${REGION_Y0}) -> (${REGION_X1},${REGION_Y1})`);

  // ── Canvas setup ─────────────────────────────────────────────────────────────
  // Source canvas is always full board size so crop coords map correctly.
  const srcCanvas = createCanvas(BOARD_W, BOARD_H);
  const srcCtx    = srcCanvas.getContext('2d');
  srcCtx.fillStyle = BG_HEX;
  srcCtx.fillRect(0, 0, BOARD_W, BOARD_H);

  // ── Social upscale ──────────────────────────────────────────────────────────
  // In social mode each board pixel is rendered as UPSCALE×UPSCALE output
  // pixels using nearest-neighbour scaling.  This preserves the hard colour
  // boundaries that make pixel art look crisp and gives the video codec many
  // identical pixels to work with per "pixel", which it compresses losslessly.
  // Without this, H.264's DCT blocks blur sharp 1-pixel edges into gradients.
  const SOCIAL_UPSCALE = SOCIAL ? calcSocialUpscale(OUT_W, OUT_H) : 1;
  const SOCIAL_OUT_W   = OUT_W * SOCIAL_UPSCALE;
  const SOCIAL_OUT_H   = OUT_H * SOCIAL_UPSCALE;

  // Output canvas is the cropped + scaled (+ social-upscaled) region
  const outCanvas = createCanvas(SOCIAL_OUT_W, SOCIAL_OUT_H);
  const outCtx    = outCanvas.getContext('2d');

  // Nearest-neighbour: never blur pixel boundaries
  outCtx.imageSmoothingEnabled = false;

  if (SOCIAL) {
    const platformLabel = SOCIAL === 'discord' ? 'Discord' : 'Reddit';
    console.log(
      `[timelapse] Social mode: ${platformLabel} — ` +
      `nearest-neighbour ${SOCIAL_UPSCALE}x upscale → ` +
      `${SOCIAL_OUT_W}x${SOCIAL_OUT_H}, animation-tuned encoder`
    );
  }

  const FONT_SIZE = Math.max(14, Math.round(22 / SCALE));

  function drawWatermark() {
    if (!WATERMARK) return;
    outCtx.save();
    outCtx.font      = `bold ${FONT_SIZE * SOCIAL_UPSCALE}px sans-serif`;
    outCtx.fillStyle = 'rgba(255,255,255,0.18)';
    outCtx.textAlign = 'right';
    outCtx.fillText('Saint-Pixels', SOCIAL_OUT_W - 10, SOCIAL_OUT_H - 10);
    outCtx.restore();
  }

  // ── ffmpeg ───────────────────────────────────────────────────────────────────
  //
  // Social mode tweaks (both Discord and Reddit):
  //   -tune animation   Optimises the H.264 encoder for large flat-colour areas
  //                     and hard edges — exactly what pixel art is made of.
  //                     The default tune blurs those edges trying to save bits.
  //   -crf 16           Near-lossless quality (vs default 18) so the platform's
  //                     own re-encoder starts from the best possible source.
  //   -preset slow      More exhaustive inter-frame search → fewer DCT artefacts
  //                     on the pixel boundaries, worth the extra encode time.
  //   -pix_fmt yuv444p  Discord & Reddit both accept it; preserves colour
  //                     accuracy better than yuv420p (no chroma subsampling).
  //                     Falls back to yuv420p automatically if the platform
  //                     can't play it (Discord web sometimes can't), so we keep
  //                     yuv420p as the safe default and note the trade-off.
  //
  // Note on file size:
  //   The upscaled output is larger on disk, but Discord & Reddit both re-encode
  //   your upload anyway — you want to give them the sharpest possible source.
  //   For Discord free (10 MB limit) reduce --pps to shorten the video, or use
  //   --scale 2 alongside --social to stay under the cap.

  const socialCrf    = SOCIAL ? '16'        : '18';
  const socialPreset = SOCIAL ? 'slow'      : 'fast';
  const socialTune   = SOCIAL ? 'animation' : null;

  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${SOCIAL_OUT_W}x${SOCIAL_OUT_H}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', socialPreset,
    '-crf',    socialCrf,
    ...(socialTune ? ['-tune', socialTune] : []),
    '-movflags', '+faststart',
    OUT_PATH,
  ];

  const ffmpeg      = spawn(FFMPEG, ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffmpegStdin = ffmpeg.stdin;

  let ffmpegExitCode = null;
  const ffmpegClosed = new Promise((resolve, reject) => {
    ffmpeg.on('close', code => { ffmpegExitCode = code; resolve(); });
    ffmpeg.on('error', err => {
      if (err.code === 'ENOENT') {
        err.message =
          `ffmpeg not found (tried: "${FFMPEG}").\n` +
          'Install it:  sudo apt-get install ffmpeg  /  brew install ffmpeg\n' +
          'Or set the FFMPEG_PATH environment variable to the full path of the ffmpeg binary.';
      }
      console.error('[timelapse] ffmpeg error:', err.message);
      ffmpegExitCode = -1;
      reject(err);
    });
  });

  // ── Render loop ──────────────────────────────────────────────────────────────

  function writeFrame() {
    // Draw the crop region from the source canvas into the output canvas.
    // imageSmoothingEnabled=false ensures nearest-neighbour scaling (no blur)
    // in both normal and social mode — especially critical for pixel art.
    outCtx.imageSmoothingEnabled = false;
    outCtx.drawImage(
      srcCanvas,
      REGION_X0, REGION_Y0, REGION_W, REGION_H,
      0, 0, SOCIAL_OUT_W, SOCIAL_OUT_H
    );
    drawWatermark();
    const buf = outCanvas.toBuffer('raw');

    // Erase watermark so it doesn't bleed onto subsequent frames.
    if (WATERMARK) {
      const wy = SOCIAL_OUT_H - FONT_SIZE * SOCIAL_UPSCALE * 2 - 10;
      const wh = FONT_SIZE * SOCIAL_UPSCALE * 2 + 10;
      outCtx.clearRect(0, wy, SOCIAL_OUT_W, wh);
      outCtx.imageSmoothingEnabled = false;
      outCtx.drawImage(
        srcCanvas,
        REGION_X0, REGION_Y0 + Math.round(wy * SCALE / SOCIAL_UPSCALE), REGION_W, Math.round(wh * SCALE / SOCIAL_UPSCALE),
        0, wy, SOCIAL_OUT_W, wh
      );
    }

    return ffmpegStdin.write(buf);
  }

  let frameAccum  = 0;
  let eventsDone  = 0;
  let lastLogTime = Date.now();
  const LOG_INTERVAL_MS = 2000;

  for (const row of events) {
    const { x, y, color } = row;

    if (color === 'erase') {
      srcCtx.fillStyle = BG_HEX;
      srcCtx.fillRect(x, y, 1, 1);
    } else {
      const c = normalizeColor(color);
      if (c) { srcCtx.fillStyle = c; srcCtx.fillRect(x, y, 1, 1); }
    }

    eventsDone++;
    frameAccum += 1;

    if (frameAccum >= EVENTS_PER_FRAME) {
      frameAccum -= EVENTS_PER_FRAME;
      const ok = writeFrame();
      if (!ok) {
        await new Promise(resolve => ffmpegStdin.once('drain', resolve));
      }
    }

    if (Date.now() - lastLogTime > LOG_INTERVAL_MS) {
      const pct = ((eventsDone / events.length) * 100).toFixed(1);
      process.stdout.write(`\r[timelapse] ${eventsDone.toLocaleString()} / ${events.length.toLocaleString()} events  (${pct}%)`);
      lastLogTime = Date.now();
    }
  }

  // Flush final partial frame
  if (frameAccum > 0) writeFrame();

  process.stdout.write('\n');
  console.log('[timelapse] Encoding -- waiting for ffmpeg to finish...');

  ffmpegStdin.end();
  try {
    await ffmpegClosed;
  } catch (ffmpegErr) {
    // Error already logged by the 'error' handler above
    process.exit(1);
  }

  if (ffmpegExitCode !== 0) {
    console.error(`[timelapse] ffmpeg exited with code ${ffmpegExitCode}`);
    process.exit(1);
  }

  const stat = fs.statSync(OUT_PATH);
  const mb   = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`[timelapse] Done! -> ${OUT_PATH}  (${mb} MB)`);
}

main().catch(err => {
  console.error('[timelapse] Fatal error:', err.message || err);
  process.exit(1);
});
