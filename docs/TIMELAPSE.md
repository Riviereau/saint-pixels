# Saint-Pixels — Timelapse

Two ways to replay every pixel ever placed on the board:

| Method | Best for |
|--------|----------|
| **In-Browser Player** | Quick replays, no install needed |
| **CLI Generator (MP4)** | Full-resolution video export |

---

## In-Browser Player

Click **Timelapse** in the topbar → **Load** → **▶ Play**.  
No installation required.

### Controls

| Control | Description |
|---------|-------------|
| **Load / Reload** | Fetches up to 100 000 pixel events from the server |
| **▶ Play / ⏸ Pause** | Start or pause playback |
| **⏹ Reset** | Rewind to the beginning |
| **Speed slider** | Slow (10 px/frame) → Normal → Fast → Faster → Max (2 000 px/frame) |
| **Progress bar** | Shows % complete; click anywhere to seek |

### Notes

- The server returns the first **100 000** events. If the board has more history, a "first 100k shown" note appears.
- Seeking backwards replays all events from scratch (fast for short histories; may take a moment for long ones).
- Closing the modal pauses playback. Re-opening preserves progress until you press Reset or Reload.

### Customising the UI

All timelapse styles live in **`styles.css`** under the `.tl-*` / `#timelapse-*` namespace.  
`timelapse-ui.js` contains **no** inline `style=` attributes — to change colours, sizing, or layout, edit `styles.css` only.

```
styles.css        ← all visual changes go here (.tl-* classes)
timelapse-ui.js   ← player logic only, no inline styles
```

---

## CLI Generator (MP4 export)

Renders a full-resolution MP4 from the `pixel_history` table (or a JSON history file) using Node.js + ffmpeg.

### Requirements

```bash
npm install canvas better-sqlite3
```

On Linux you may also need system libraries for `canvas`:
```bash
sudo apt-get install libcairo2-dev libpango1.0-dev libpng-dev libjpeg-dev
```

**ffmpeg** must be on your PATH (or set `FFMPEG_PATH`):
```bash
# Ubuntu / Debian
sudo apt-get install ffmpeg
# macOS
brew install ffmpeg
```

### Quick Start

```bash
node timelapse.js
# Reads ./database.sqlite → writes ./timelapse.mp4 at 30 fps, 200 events/sec
```

### All Options

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | `./database.sqlite` | Path to your SQLite database |
| `--json <path>` | — | Use a JSON history file instead of SQLite (see below) |
| `--out <path>` | `./timelapse.mp4` | Output MP4 file path |
| `--fps <n>` | `30` | Output video framerate |
| `--pps <n>` | `200` | Pixel events per second of video |
| `--from <date>` | — | Only include events on or after this date (e.g. `2025-01-01`) |
| `--to <date>` | — | Only include events up to this date (e.g. `2025-12-31`) |
| `--user <name>` | — | Only placements by one specific user |
| `--scale <n>` | `1` | Downscale factor — `2` renders at 960×540 (faster, less RAM) |
| `--bg <hex>` | `2e2e2f` | Background fill colour (no `#` needed) |
| `--no-watermark` | — | Remove the "Saint-Pixels" text overlay |
| `--crop <x0,y0,x1,y1>` | — | Crop to a board-pixel rectangle, e.g. `0,0,1000,1000` |
| `--help` | — | Print usage and exit |

### Examples

```bash
# Default: full canvas, 30 fps, 200 events/sec
node timelapse.js

# Half-resolution (faster, less RAM — recommended on Railway)
node timelapse.js --scale 2

# Slow the video down (more frames per event)
node timelapse.js --pps 50

# Speed it up
node timelapse.js --pps 1000

# Filter to a date range
node timelapse.js --from 2025-04-01 --to 2025-04-30 --out april.mp4

# Single user only
node timelapse.js --user flynotron --out flynotron.mp4

# No watermark, custom background
node timelapse.js --no-watermark --bg 1a1a2e

# Crop to the top-left quadrant and downscale
node timelapse.js --crop 0,0,960,540 --scale 2 --out cropped.mp4

# Read from a JSON history file instead of SQLite
node timelapse.js --json /var/data/pixel-history.json --out timelapse.mp4
```

> **Odd crop dimensions:** H.264 requires even width/height. If your `--crop` region results in an odd dimension after `--scale`, the script pads to the next even size and trims back inside ffmpeg automatically.

### Understanding `--fps` and `--pps`

- `--fps` — output video frame rate (smoothness). 30 is standard.
- `--pps` — how many pixel events play back per second of video (speed).

A new frame is emitted every `pps / fps` events:

| `--pps` | `--fps` | Events per frame | Feel |
|---------|---------|------------------|------|
| 30 | 30 | 1 | Very slow — every pixel is a frame |
| 200 | 30 | ~7 | Moderate (default) |
| 3 000 | 30 | 100 | Very fast |

### Data Sources

**SQLite (default)** — reads directly from the `pixel_history` table. Streams rows rather than loading everything into memory, so it handles very large histories efficiently.

**JSON file** — if `JSON_HISTORY_PATH` is set in your environment, the server writes every placement to that file in real time. Pass it with `--json`:
```bash
node timelapse.js --json /var/data/pixel-history.json
```

The JSON file is a flat array:
```json
[
  { "username": "alice", "x": 100, "y": 200, "color": "ef4444", "placed_at": 1714000000000 },
  { "username": "bob",   "x": 101, "y": 200, "color": "erase",  "placed_at": 1714000001000 }
]
```

### Performance Tips

- Use `--scale 2` on Railway or any memory-constrained server. Full 1920×1080 is 8 MB of RGBA per frame (240 MB/s at 30 fps into ffmpeg).
- Raise `--pps` (e.g. `--pps 3000`) to reduce total frame count and speed up the ffmpeg pass.
- Set `FFMPEG_PATH` in your environment if ffmpeg is not on the system `PATH`.

### Running on Railway

Railway has no persistent shell. Generate the timelapse locally using a database copy or the JSON history file:

```bash
# Download pixel-history.json from your Railway volume via your app's API, then:
node timelapse.js --json ./pixel-history.json --out timelapse.mp4
```

---

## Database Tables

| Table | Contents |
|-------|----------|
| `pixels` | Current board state only (one row per cell, upserted). Bounded to ≤ 1 920 × 1 080 rows. |
| `pixel_history` | Append-only log of every placement/erase ever made. Grows indefinitely. Both the CLI and in-browser player read from this table. |

> If you get an error saying `pixel_history` doesn't exist, your database predates the migration that added it. Start the server once — the migration runs automatically on startup. Events from before that point won't appear in the timelapse.
