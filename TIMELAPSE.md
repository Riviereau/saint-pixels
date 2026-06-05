# Saint-Pixels — Timelapse

The **Timelapse** button in the topbar opens an in-browser canvas player that replays every pixel ever placed on the board, in chronological order.

## In-Browser Player

No installation required. Click **Timelapse** → **Load** → **▶ Play**.

| Control | Description |
|---------|-------------|
| **Load / Reload** | Fetches up to 100 000 pixel events from the server |
| **▶ Play / ⏸ Pause** | Start or pause the playback |
| **⏹ Reset** | Rewind to the beginning |
| **Speed slider** | Slow (10 px/frame) → Normal → Fast → Faster → Max (2000 px/frame) |
| **Progress bar** | Shows % complete; click anywhere to seek |

### Notes

- The server returns the first **100 000** events from `pixel_history`. If the board has more history than that, only the earliest 100k are shown (a "first 100k shown" note appears in the subtitle).
- Seeking backwards replays all events from scratch (the canvas is cleared and redrawn up to the target index). This is fast for short histories but may take a moment for very long ones.
- Closing the modal pauses playback. Reopening it preserves where you left off until you press Reset or Reload.

---

## CLI Generator (MP4 export)

For a full-resolution MP4 video you can use the bundled `timelapse.js` CLI script. It requires Node.js, `canvas`, `better-sqlite3`, and `ffmpeg`.

### Requirements

```bash
npm install canvas better-sqlite3
# Ubuntu/Debian:
sudo apt-get install ffmpeg libcairo2-dev libpango1.0-dev libpng-dev libjpeg-dev
# macOS:
brew install ffmpeg
```

### Quick Start

```bash
node timelapse.js
# Reads ./database.sqlite → writes ./timelapse.mp4 at 30 fps
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | `./database.sqlite` | Path to your SQLite database |
| `--out <path>` | `./timelapse.mp4` | Output MP4 filename |
| `--fps <n>` | `30` | Output framerate |
| `--pps <n>` | `200` | Pixel events per output second |
| `--from <ISO>` | — | Only events on/after this date |
| `--to <ISO>` | — | Only events up to this date |
| `--user <name>` | — | Only events from this username |
| `--scale <n>` | `1` | Downscale factor (2 = 960×540, much faster) |
| `--bg <hex>` | `2e2e2f` | Background fill colour |
| `--no-watermark` | — | Suppress the "Saint-Pixels" text overlay |
| `--crop <x0,y0,x1,y1>` | — | Crop to board-pixel rectangle |
| `--help` | — | Print help and exit |

### Examples

```bash
# Default: full canvas, 30 fps, 200 events/sec
node timelapse.js

# Half-resolution (faster, less RAM)
node timelapse.js --scale 2

# Just one user's placements
node timelapse.js --user alice --out alice.mp4

# This week only, faster speed
node timelapse.js --from 2024-01-01 --to 2024-01-07 --pps 1000

# Crop to the top-left quarter of the canvas
node timelapse.js --crop 0,0,960,540 --scale 2
```

### Performance Tips

- Use `--scale 2` on Railway or any memory-constrained server. Full 1920×1080 is 8 MB of RGBA per frame.
- Raise `--pps` (e.g. `--pps 3000`) to reduce total frame count and speed up the ffmpeg pass.
- Set `FFMPEG_PATH` in your environment if ffmpeg is not on your system `PATH`.

---

## Database Tables

| Table | Contents |
|-------|----------|
| `pixels` | Current board state only (one row per cell, upserted). Bounded to ≤ 1 920 × 1 080 rows. |
| `pixel_history` | Append-only log of every placement/erase ever made. Grows indefinitely. Both the CLI and the in-browser player read from this table. |

The `pixel_history` table was added by the migration in `server.js`. If you're on an older database that doesn't have it yet, start the server once — the migration runs automatically on startup.
