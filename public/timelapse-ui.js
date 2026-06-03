/**
 * public/timelapse-ui.js — Timelapse info / help modal
 *
 * Adds a "Timelapse" button to the topbar that opens a modal explaining
 * how to generate a timelapse video from your pixel history.
 *
 * The modal has four tabs:
 *   • Overview  — what a timelapse is, what it needs, quick start command
 *   • Options   — full flag reference (mirrors TIMELAPSE.md)
 *   • Examples  — copy-ready commands for common scenarios
 *   • FAQ       — answers to common questions (Railway, performance, etc.)
 *
 * All content is derived directly from TIMELAPSE.md so it stays in sync.
 * Copy buttons use the Clipboard API with a graceful textarea fallback for
 * older mobile browsers.
 *
 * Drop  <script src="/timelapse-ui.js"></script>  after ios.js in index.html.
 * Requires timelapse.css to be linked in <head>.
 */

(function () {
  'use strict';

  // ── Inject topbar button ──────────────────────────────────────────────────────
  //
  // The button is placed in the scrolling topbar strip alongside Rules / Settings.
  // On desktop it sits next to the other brand-* pill buttons.
  const topbarBtn = document.createElement('button');
  topbarBtn.id        = 'timelapse-topbar-btn';
  topbarBtn.type      = 'button';
  topbarBtn.title     = 'Timelapse — generate a video of all pixel placements';
  topbarBtn.setAttribute('aria-label', 'Timelapse generator guide');
  // Matches the exact Tailwind classes used by topbarRulesBtn
  topbarBtn.className =
    'px-2 py-1.5 rounded-xl border border-white/10 bg-white/5 text-slate-100 ' +
    'font-semibold text-sm inline-flex items-center gap-1.5 hover:-translate-y-px ' +
    'hover:bg-purple-400/15 hover:border-purple-400/80 transition-all';
  topbarBtn.style.cursor = 'pointer';
  topbarBtn.innerHTML =
    // Film strip icon
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>' +
      '<line x1="7" y1="2" x2="7" y2="22"/>' +
      '<line x1="17" y1="2" x2="17" y2="22"/>' +
      '<line x1="2" y1="12" x2="22" y2="12"/>' +
      '<line x1="2" y1="7" x2="7" y2="7"/>' +
      '<line x1="2" y1="17" x2="7" y2="17"/>' +
      '<line x1="17" y1="17" x2="22" y2="17"/>' +
      '<line x1="17" y1="7" x2="22" y2="7"/>' +
    '</svg>' +
    'Timelapse';

  // Insert right before the Rules button in the right-side group, or append to header
  const rulesBtn = document.getElementById('topbarRulesBtn');
  if (rulesBtn && rulesBtn.parentNode) {
    rulesBtn.parentNode.insertBefore(topbarBtn, rulesBtn);
  } else {
    const header = document.querySelector('header');
    const rightGroup = header?.querySelector('[role="group"]');
    if (rightGroup) {
      rightGroup.insertBefore(topbarBtn, rightGroup.firstChild);
    } else if (header) {
      header.appendChild(topbarBtn);
    }
  }

  // Also add a compact version to the mobile scrolling strip
  const mobBtn = document.createElement('button');
  mobBtn.id        = 'mob-timelapse-btn';
  mobBtn.type      = 'button';
  mobBtn.title     = 'Timelapse';
  mobBtn.setAttribute('aria-label', 'Timelapse generator guide');
  mobBtn.className =
    'px-2 py-1 rounded-lg border border-white/10 bg-white/5 text-slate-100 ' +
    'font-semibold text-xs inline-flex items-center gap-1 hover:bg-purple-400/15 ' +
    'hover:border-purple-400/80 transition-all';
  mobBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>' +
      '<line x1="7" y1="2" x2="7" y2="22"/>' +
      '<line x1="17" y1="2" x2="17" y2="22"/>' +
      '<line x1="2" y1="12" x2="22" y2="12"/>' +
      '<line x1="2" y1="7" x2="7" y2="7"/>' +
      '<line x1="2" y1="17" x2="7" y2="17"/>' +
      '<line x1="17" y1="17" x2="22" y2="17"/>' +
      '<line x1="17" y1="7" x2="22" y2="7"/>' +
    '</svg>' +
    'Timelapse';

  const mobStrip = document.querySelector('header .flex.flex-row.flex-nowrap');
  const mobSettings = document.getElementById('mob-settings-btn');
  if (mobStrip && mobSettings) {
    mobStrip.insertBefore(mobBtn, mobSettings);
  } else if (mobStrip) {
    mobStrip.appendChild(mobBtn);
  }

  // ── Build modal HTML ──────────────────────────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.id = 'timelapse-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Timelapse generator guide');

  overlay.innerHTML = `
    <div id="timelapse-modal">

      <!-- Header -->
      <div class="tl-header">
        <div class="tl-header-left">
          <div class="tl-header-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
              <line x1="7" y1="2" x2="7" y2="22"/>
              <line x1="17" y1="2" x2="17" y2="22"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
              <line x1="2" y1="7" x2="7" y2="7"/>
              <line x1="2" y1="17" x2="7" y2="17"/>
              <line x1="17" y1="17" x2="22" y2="17"/>
              <line x1="17" y1="7" x2="22" y2="7"/>
            </svg>
          </div>
          <div>
            <div class="tl-title">Timelapse Generator</div>
            <div class="tl-subtitle">Render every pixel placement as an MP4 video</div>
          </div>
        </div>
        <button id="tl-close-btn" class="tl-close-btn" type="button" title="Close" aria-label="Close">✕</button>
      </div>

      <!-- Tab strip -->
      <div class="tl-tabs" role="tablist">
        <button class="tl-tab active" data-tl-tab="overview"  role="tab" type="button">🎬 Overview</button>
        <button class="tl-tab"        data-tl-tab="options"   role="tab" type="button">⚙ Options</button>
        <button class="tl-tab"        data-tl-tab="examples"  role="tab" type="button">💡 Examples</button>
        <button class="tl-tab"        data-tl-tab="faq"       role="tab" type="button">❓ FAQ</button>
      </div>

      <!-- ══════════════ TAB: OVERVIEW ══════════════ -->
      <div id="tl-panel-overview" class="tl-panel">

        <p class="tl-intro">
          <strong>timelapse.js</strong> reads every pixel ever placed on the board and
          renders them in chronological order into an MP4 video — a full replay of the
          canvas being painted from scratch.
        </p>

        <div>
          <p class="tl-section-label">What you need</p>
          <div class="tl-req-list">
            <div class="tl-req-item">
              <span class="tl-req-icon">📦</span>
              <div>
                <strong>Node packages</strong> — install once in your project root:<br>
                <code>npm install canvas better-sqlite3</code><br>
                <span style="font-size:0.74rem;color:#64748b;">
                  On Linux you may also need:
                  <code>sudo apt-get install libcairo2-dev libpango1.0-dev libpng-dev libjpeg-dev</code>
                </span>
              </div>
            </div>
            <div class="tl-req-item">
              <span class="tl-req-icon">🎞️</span>
              <div>
                <strong>ffmpeg</strong> — must be on your system PATH<br>
                <span style="font-size:0.74rem;color:#64748b;">
                  Ubuntu/Debian: <code>sudo apt-get install ffmpeg</code> ·
                  macOS: <code>brew install ffmpeg</code><br>
                  Or set <code>FFMPEG_PATH</code> in your env if installed elsewhere.
                </span>
              </div>
            </div>
            <div class="tl-req-item">
              <span class="tl-req-icon">🗄️</span>
              <div>
                <strong>Data source</strong> — either your SQLite database
                (<code>database.sqlite</code>) or a JSON history file
                (<code>pixel-history.json</code>).
                The server writes to the JSON file automatically if you set
                <code>JSON_HISTORY_PATH</code> in your <code>.env</code>.
              </div>
            </div>
          </div>
        </div>

        <div>
          <p class="tl-section-label">Quick start</p>
          <div class="tl-chips">
            <div class="tl-chip purple">
              <span class="tl-chip-dot"></span>
              <span>Run this from your project root — it reads <code style="color:#c084fc;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0 4px;">database.sqlite</code> and outputs <code style="color:#c084fc;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0 4px;">timelapse.mp4</code></span>
            </div>
          </div>
          <div style="margin-top:0.5rem;" class="tl-cmd-block">
            <div class="tl-cmd" id="tl-quick-cmd">
              <span class="tl-cmd-text">node timelapse.js</span>
              <button class="tl-cmd-copy-btn" data-copy="node timelapse.js" type="button">Copy</button>
            </div>
          </div>
        </div>

        <div>
          <p class="tl-section-label">Data sources</p>
          <div class="tl-chips">
            <div class="tl-chip sky">
              <span class="tl-chip-dot"></span>
              <span><strong>SQLite (default)</strong> — reads the <code style="color:#7dd3fc;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0 4px;">pixel_history</code> table directly from your database. Rows are streamed so it handles large histories without loading everything into RAM.</span>
            </div>
            <div class="tl-chip purple">
              <span class="tl-chip-dot"></span>
              <span><strong>JSON file</strong> — set <code style="color:#c084fc;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0 4px;">JSON_HISTORY_PATH</code> in your <code style="color:#c084fc;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0 4px;">.env</code> and the server will write every pixel to a flat JSON array in real time. Pass it to the generator with <code style="color:#c084fc;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0 4px;">--json</code>. Useful on Railway where you can't easily access the SQLite file directly.</span>
            </div>
            <div class="tl-chip amber">
              <span class="tl-chip-dot"></span>
              <span><strong>Note:</strong> if you get a "pixel_history table does not exist" error, your database predates when that table was added. New placements are recorded automatically once you're on the current server version. Old placements before that point won't appear in the timelapse.</span>
            </div>
          </div>
        </div>

      </div>

      <!-- ══════════════ TAB: OPTIONS ══════════════ -->
      <div id="tl-panel-options" class="tl-panel hidden">

        <p class="tl-intro">All flags are optional. Combine them freely.</p>

        <div class="tl-options-table">
          <div class="tl-option-row">
            <div class="tl-option-flag">--db &lt;path&gt;</div>
            <div class="tl-option-desc">SQLite database file. <em>Default: ./database.sqlite</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--json &lt;path&gt;</div>
            <div class="tl-option-desc">Use a JSON history file instead of SQLite (flat array of pixel events).</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--out &lt;path&gt;</div>
            <div class="tl-option-desc">Output MP4 file path. <em>Default: ./timelapse.mp4</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--fps &lt;n&gt;</div>
            <div class="tl-option-desc">Output video framerate. <em>Default: 30</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--pps &lt;n&gt;</div>
            <div class="tl-option-desc">Pixel events rendered per second of video. Controls playback speed. <em>Default: 200</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--from &lt;date&gt;</div>
            <div class="tl-option-desc">Only include events on or after this date. <em>e.g. 2025-01-01</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--to &lt;date&gt;</div>
            <div class="tl-option-desc">Only include events up to and including this date. <em>e.g. 2025-12-31</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--user &lt;name&gt;</div>
            <div class="tl-option-desc">Only include placements by one specific username.</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--scale &lt;n&gt;</div>
            <div class="tl-option-desc">Downscale factor. <em>--scale 2 renders at 960×540 (4× less RAM, much faster). Default: 1</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--bg &lt;hex&gt;</div>
            <div class="tl-option-desc">Background fill colour (no # needed). <em>Default: 2e2e2f</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--no-watermark</div>
            <div class="tl-option-desc">Remove the "Saint-Pixels" text overlay from the video.</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--crop x0,y0,x1,y1</div>
            <div class="tl-option-desc">Crop to a board-pixel rectangle. <em>e.g. --crop 0,0,1000,1000 for the top-left quarter</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--help</div>
            <div class="tl-option-desc">Print usage and exit.</div>
          </div>
        </div>

        <div>
          <p class="tl-section-label">Understanding --fps and --pps</p>
          <p class="tl-intro" style="margin-bottom:0.55rem;">
            <strong>--fps</strong> controls how smooth the output video looks (30 is standard).
            <strong>--pps</strong> controls how fast events play back — how many pixel placements
            are shown per second of video.
          </p>
          <div class="tl-speed-grid">
            <div class="tl-speed-card">
              <div class="tl-speed-label">Slow</div>
              <div class="tl-speed-val">--pps 30</div>
              <div class="tl-speed-desc">One frame per pixel — every placement gets its own frame</div>
            </div>
            <div class="tl-speed-card">
              <div class="tl-speed-label">Default</div>
              <div class="tl-speed-val">--pps 200</div>
              <div class="tl-speed-desc">~6–7 pixels per frame — smooth, moderate speed</div>
            </div>
            <div class="tl-speed-card">
              <div class="tl-speed-label">Fast</div>
              <div class="tl-speed-val">--pps 3000</div>
              <div class="tl-speed-desc">100 pixels per frame — very fast render</div>
            </div>
          </div>
        </div>

      </div>

      <!-- ══════════════ TAB: EXAMPLES ══════════════ -->
      <div id="tl-panel-examples" class="tl-panel hidden">

        <p class="tl-intro">Click any command to copy it to your clipboard.</p>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Basic render (default settings)</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Half resolution — recommended on Railway or low-RAM machines</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --scale 2</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --scale 2" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Read from JSON file (e.g. downloaded from Railway volume)</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --json ./pixel-history.json --out timelapse.mp4</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --json ./pixel-history.json --out timelapse.mp4" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Filter to a date range (e.g. April 2025)</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --from 2025-04-01 --to 2025-04-30 --out april.mp4</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --from 2025-04-01 --to 2025-04-30 --out april.mp4" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Filter to one player</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --user flynotron --out flynotron.mp4</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --user flynotron --out flynotron.mp4" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Slow playback — every pixel gets its own frame</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --pps 30 --fps 30</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --pps 30 --fps 30" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Fast render — 100 pixels per frame</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --pps 3000 --fps 30</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --pps 3000 --fps 30" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Crop to a region of the board (board-pixel coordinates)</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --crop 0,0,1000,1000 --out corner.mp4</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --crop 0,0,1000,1000 --out corner.mp4" type="button">Copy</button>
          </div>
        </div>

        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Crop + half-res + custom background + no watermark</div>
          <div class="tl-cmd">
            <span class="tl-cmd-text">node timelapse.js --crop 200,100,1200,700 --scale 2 --bg 1a1a2e --no-watermark --out cropped.mp4</span>
            <button class="tl-cmd-copy-btn" data-copy="node timelapse.js --crop 200,100,1200,700 --scale 2 --bg 1a1a2e --no-watermark --out cropped.mp4" type="button">Copy</button>
          </div>
        </div>

      </div>

      <!-- ══════════════ TAB: FAQ ══════════════ -->
      <div id="tl-panel-faq" class="tl-panel hidden">

        <div class="tl-faq" id="tl-faq-list">

          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button" aria-expanded="false">
              <span>I'm on Railway — how do I generate a timelapse?</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="tl-faq-a">
              Railway doesn't have a persistent shell, so the easiest approach is to run the generator locally
              using a copy of your data:<br><br>
              1. Set <code>JSON_HISTORY_PATH=/var/data/pixel-history.json</code> in your Railway environment variables.
              The server will then write every placement to that file in real time on the Railway volume.<br><br>
              2. Download the JSON file from your Railway volume (via your app's API or <code>railway run</code>).<br><br>
              3. Run locally: <code>node timelapse.js --json ./pixel-history.json --out timelapse.mp4</code><br><br>
              Alternatively, if ffmpeg is available in your Railway environment, you can expose a private admin
              endpoint that triggers the generator and streams the output.
            </div>
          </div>

          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button" aria-expanded="false">
              <span>I get "pixel_history table does not exist" — what do I do?</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="tl-faq-a">
              Your database predates the migration that added the <code>pixel_history</code> table.
              It is created automatically when you restart the server on the current version — the
              <code>initializeDatabase()</code> function in <code>database.js</code> handles it.
              Once restarted, all new placements will be recorded. Pixels placed before that point
              won't appear in the timelapse, but all future ones will.
            </div>
          </div>

          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button" aria-expanded="false">
              <span>The render is very slow or runs out of memory.</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="tl-faq-a">
              The full 1920×1080 canvas is 8 MB of raw RGBA per frame. Use <code>--scale 2</code> to render
              at 960×540 — about 4× less memory and significantly faster encoding. On Railway or any
              memory-constrained server, <code>--scale 2</code> is strongly recommended.<br><br>
              You can also use <code>--pps 3000</code> or higher to burn through events faster and keep
              the total frame count lower. Fewer frames = faster ffmpeg pass.
            </div>
          </div>

          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button" aria-expanded="false">
              <span>What's the difference between the pixels table and pixel_history?</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="tl-faq-a">
              The <code>pixels</code> table is an upsert table — it stores only the <em>current</em> state
              of every cell on the board. Each (x, y) coordinate has exactly one row, and it gets overwritten
              whenever someone places a pixel there. It's bounded to at most 1920×1080 rows.<br><br>
              The <code>pixel_history</code> table is an append-only log — every placement or erase ever made
              gets a new row and nothing is deleted. It grows indefinitely. The timelapse generator reads
              from this table (or the equivalent JSON file) to replay every event in order.
            </div>
          </div>

          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button" aria-expanded="false">
              <span>Can I make a timelapse of just one region of the canvas?</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="tl-faq-a">
              Yes — use the <code>--crop x0,y0,x1,y1</code> flag. The coordinates are in board pixels
              (top-left to bottom-right). For example, <code>--crop 0,0,960,540</code> renders the
              top-left quarter of the canvas. You can combine crop with <code>--scale</code>:
              the crop is applied first (in board-pixel space), then the result is scaled down.
            </div>
          </div>

          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button" aria-expanded="false">
              <span>What format is the JSON history file?</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="tl-faq-a">
              A flat JSON array where each element is one pixel event:<br><br>
              <code>[</code><br>
              <code>&nbsp;&nbsp;{ "username": "alice", "x": 100, "y": 200, "color": "ef4444", "placed_at": 1714000000000 },</code><br>
              <code>&nbsp;&nbsp;{ "username": "bob",   "x": 101, "y": 200, "color": "erase",  "placed_at": 1714000001000 }</code><br>
              <code>]</code><br><br>
              <code>color</code> is a 6-digit hex string without <code>#</code>, or the sentinel value <code>erase</code>.
              <code>placed_at</code> is a Unix timestamp in milliseconds.
            </div>
          </div>

        </div>

      </div>

    </div>
  `;

  document.body.appendChild(overlay);

  // ── Tab switching ─────────────────────────────────────────────────────────────

  const tabBtns = overlay.querySelectorAll('.tl-tab');

  function switchTab(name) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tlTab === name));
    overlay.querySelectorAll('.tl-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== `tl-panel-${name}`);
    });
  }

  tabBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tlTab)));

  // ── Open / close ──────────────────────────────────────────────────────────────

  function openModal() {
    overlay.classList.add('visible');
    switchTab('overview');
    document.getElementById('tl-close-btn').focus();
  }

  function closeModal() {
    overlay.classList.remove('visible');
  }

  topbarBtn.addEventListener('click', openModal);
  mobBtn.addEventListener('click', openModal);
  document.getElementById('tl-close-btn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) closeModal();
  });

  // ── Copy buttons ──────────────────────────────────────────────────────────────
  //
  // Clipboard API with textarea fallback for older Android WebViews.

  function copyText(text, btn) {
    function onSuccess() {
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = prev === 'Copied!' ? 'Copy' : prev;
        btn.classList.remove('copied');
      }, 1800);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallback(text, onSuccess));
    } else {
      fallback(text, onSuccess);
    }
  }

  function fallback(text, cb) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
      cb();
    } catch (e) {
      console.warn('[timelapse-ui] Copy failed:', e);
    }
  }

  // Delegate to all copy buttons (present and future — re-used across tabs)
  overlay.addEventListener('click', e => {
    const btn = e.target.closest('.tl-cmd-copy-btn');
    if (!btn) return;
    e.stopPropagation();
    const text = btn.dataset.copy || btn.closest('.tl-cmd')?.querySelector('.tl-cmd-text')?.textContent || '';
    if (text) copyText(text, btn);
  });

  // Clicking the command row itself also copies (easier on mobile)
  overlay.addEventListener('click', e => {
    const row = e.target.closest('.tl-cmd');
    if (!row || e.target.closest('.tl-cmd-copy-btn')) return;
    const btn = row.querySelector('.tl-cmd-copy-btn');
    const text = btn?.dataset.copy || row.querySelector('.tl-cmd-text')?.textContent || '';
    if (text && btn) copyText(text, btn);
  });

  // ── FAQ accordion ─────────────────────────────────────────────────────────────

  overlay.addEventListener('click', e => {
    const q = e.target.closest('.tl-faq-q');
    if (!q) return;
    const item = q.closest('.tl-faq-item');
    if (!item) return;
    const isOpen = item.classList.contains('open');
    // Close all, then open the clicked one (unless it was already open)
    overlay.querySelectorAll('.tl-faq-item').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.tl-faq-q')?.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      item.classList.add('open');
      q.setAttribute('aria-expanded', 'true');
    }
  });

})();
