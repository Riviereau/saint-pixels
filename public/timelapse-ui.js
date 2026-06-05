/**
 * public/timelapse-ui.js — In-browser canvas timelapse player (v2)
 *
 * Enhancements over v1:
 *  - Fullscreen button (native Fullscreen API + CSS :fullscreen)
 *  - Download current frame as PNG
 *  - Zoom + pan inside the canvas wrap (pinch/wheel + drag)
 *  - Crisp pixel rendering (image-rendering: pixelated enforced via JS)
 *  - Bigger, more readable UI (wider modal, larger canvas area)
 *  - History cap raised to 500k events (server cap must also be raised)
 *  - All-history load: the server may page; client fetches until done
 *  - Progress bar is clickable to seek; also shows a drag thumb
 *
 * Fetches pixel_history from /api/timelapse/history and replays every
 * placement event on a <canvas> inside the modal.
 *
 * Tab layout:
 *   Player  — live canvas playback with fullscreen / zoom / download
 *   CLI     — MP4 export reference (flags, examples)
 *   About   — what/why, data source notes, FAQ
 */

(function () {
  'use strict';

  const BOARD_W = 1920;
  const BOARD_H = 1080;

  // ── Inject topbar button ──────────────────────────────────────────────────────
  const topbarBtn = document.createElement('button');
  topbarBtn.id        = 'timelapse-topbar-btn';
  topbarBtn.type      = 'button';
  topbarBtn.title     = 'Timelapse — replay every pixel placement in the browser';
  topbarBtn.setAttribute('aria-label', 'In-browser timelapse player');
  topbarBtn.className = 'tl-topbar-btn';
  topbarBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="5 3 19 12 5 21 5 3"/>' +
    '</svg>Timelapse';

  const rulesBtn = document.getElementById('topbarRulesBtn');
  if (rulesBtn && rulesBtn.parentNode) {
    rulesBtn.parentNode.insertBefore(topbarBtn, rulesBtn);
  } else {
    const header     = document.querySelector('header');
    const rightGroup = header?.querySelector('[role="group"]');
    if (rightGroup) rightGroup.insertBefore(topbarBtn, rightGroup.firstChild);
    else if (header) header.appendChild(topbarBtn);
  }

  // ── Mobile strip button ───────────────────────────────────────────────────────
  const mobBtn = document.createElement('button');
  mobBtn.id        = 'mob-timelapse-btn';
  mobBtn.type      = 'button';
  mobBtn.title     = 'Timelapse';
  mobBtn.className = 'tl-mob-btn';
  mobBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="5 3 19 12 5 21 5 3"/>' +
    '</svg>Timelapse';
  const mobStrip    = document.querySelector('header .flex.flex-row.flex-nowrap');
  const mobSettings = document.getElementById('mob-settings-btn');
  if (mobStrip && mobSettings) mobStrip.insertBefore(mobBtn, mobSettings);
  else if (mobStrip) mobStrip.appendChild(mobBtn);

  // ── Build modal HTML ──────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'timelapse-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Timelapse player');

  overlay.innerHTML = `
    <div id="timelapse-modal">

      <!-- Header -->
      <div class="tl-header">
        <div class="tl-header-left">
          <div class="tl-header-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
          <div>
            <div class="tl-title">Timelapse</div>
            <div class="tl-subtitle" id="tl-subtitle">Replay every pixel ever placed</div>
          </div>
        </div>
        <button id="tl-close-btn" class="tl-close-btn" type="button" title="Close" aria-label="Close">✕</button>
      </div>

      <!-- Tab strip -->
      <div class="tl-tabs" role="tablist">
        <button class="tl-tab active" data-tab="player" role="tab" aria-selected="true"  type="button">▶ Player</button>
        <button class="tl-tab"        data-tab="cli"    role="tab" aria-selected="false" type="button">CLI / MP4</button>
        <button class="tl-tab"        data-tab="about"  role="tab" aria-selected="false" type="button">About</button>
      </div>

      <!-- ══ Tab: Player ══════════════════════════════════════════════════════ -->
      <div class="tl-panel" id="tl-panel-player" role="tabpanel">

        <!-- Canvas viewport with zoom/pan -->
        <div id="tl-canvas-wrap" class="tl-canvas-wrap">
          <canvas id="tl-canvas" class="tl-canvas"></canvas>
          <div id="tl-placeholder" class="tl-placeholder">
            <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor"
                 stroke-width="1.5" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>Press Load to fetch pixel history</span>
          </div>
          <!-- Zoom reset hint (visible when zoomed) -->
          <button id="tl-zoom-reset" class="tl-zoom-reset hidden" type="button" title="Reset zoom">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/><path d="M8 11h6M11 8v6"/></svg>
            Reset zoom
          </button>
          <!-- Fullscreen button -->
          <button id="tl-fullscreen-btn" class="tl-fullscreen-btn" type="button" title="Fullscreen (F)">
            <svg id="tl-fs-expand" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
            <svg id="tl-fs-collapse" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="display:none">
              <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
              <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
            </svg>
          </button>
        </div>

        <!-- Progress bar -->
        <div id="tl-progress-wrap" class="tl-progress-wrap" title="Click or drag to seek">
          <div id="tl-progress-bg" class="tl-progress-bg">
            <div id="tl-progress-fill" class="tl-progress-fill"></div>
            <div id="tl-progress-thumb" class="tl-progress-thumb"></div>
          </div>
        </div>

        <!-- Controls -->
        <div class="tl-controls">
          <button id="tl-load-btn"     class="tl-btn tl-btn--load"     type="button">Load</button>
          <button id="tl-play-btn"     class="tl-btn tl-btn--play"     type="button" disabled>▶ Play</button>
          <button id="tl-reset-btn"    class="tl-btn tl-btn--reset"    type="button" disabled>⏹ Reset</button>
          <button id="tl-download-btn" class="tl-btn tl-btn--download" type="button" disabled title="Download current frame as PNG">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            PNG
          </button>

          <div class="tl-speed-wrap">
            <span class="tl-speed-label-text">Speed</span>
            <input id="tl-speed" class="tl-speed-slider" type="range" min="1" max="5" step="1" value="2" />
            <span id="tl-speed-label" class="tl-speed-value">Normal</span>
          </div>

          <span id="tl-counter" class="tl-counter">0 / 0</span>
        </div>
      </div>

      <!-- ══ Tab: CLI / MP4 ══════════════════════════════════════════════════ -->
      <div class="tl-panel hidden" id="tl-panel-cli" role="tabpanel">

        <p class="tl-section-label">Requirements</p>
        <div class="tl-req-list">
          <div class="tl-req-item">
            <span class="tl-req-icon">📦</span>
            <span>Node packages: <code>npm install canvas better-sqlite3</code></span>
          </div>
          <div class="tl-req-item">
            <span class="tl-req-icon">🎬</span>
            <span><strong>ffmpeg</strong> on your PATH — or set <code>FFMPEG_PATH</code> in your environment.
              Install: <code>sudo apt-get install ffmpeg</code> / <code>brew install ffmpeg</code></span>
          </div>
        </div>

        <p class="tl-section-label">Quick start</p>
        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Render everything → timelapse.mp4</div>
          <div class="tl-cmd" data-copy="node timelapse.js">
            <span class="tl-cmd-text">node timelapse.js</span>
            <button class="tl-cmd-copy-btn" type="button">Copy</button>
          </div>
        </div>
        <div class="tl-cmd-block">
          <div class="tl-cmd-label">Half resolution — faster, less RAM (recommended on Railway)</div>
          <div class="tl-cmd" data-copy="node timelapse.js --scale 2">
            <span class="tl-cmd-text">node timelapse.js --scale 2</span>
            <button class="tl-cmd-copy-btn" type="button">Copy</button>
          </div>
        </div>
        <div class="tl-cmd-block">
          <div class="tl-cmd-label">From JSON history file instead of SQLite</div>
          <div class="tl-cmd" data-copy="node timelapse.js --json /var/data/pixel-history.json">
            <span class="tl-cmd-text">node timelapse.js --json /var/data/pixel-history.json</span>
            <button class="tl-cmd-copy-btn" type="button">Copy</button>
          </div>
        </div>

        <p class="tl-section-label">All flags</p>
        <div class="tl-options-table">
          <div class="tl-option-row">
            <div class="tl-option-flag">--db &lt;path&gt;</div>
            <div class="tl-option-desc">SQLite database path <em>(default: ./database.sqlite)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--json &lt;path&gt;</div>
            <div class="tl-option-desc">Use a JSON history file instead of SQLite</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--out &lt;path&gt;</div>
            <div class="tl-option-desc">Output MP4 path <em>(default: ./timelapse.mp4)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--fps &lt;n&gt;</div>
            <div class="tl-option-desc">Video framerate <em>(default: 30)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--pps &lt;n&gt;</div>
            <div class="tl-option-desc">Pixel events per second of video <em>(default: 200)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--from &lt;date&gt;</div>
            <div class="tl-option-desc">Only events on or after this date <em>(e.g. 2025-01-01)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--to &lt;date&gt;</div>
            <div class="tl-option-desc">Only events up to this date</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--user &lt;name&gt;</div>
            <div class="tl-option-desc">Only placements by one user</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--scale &lt;n&gt;</div>
            <div class="tl-option-desc">Downscale — <code>2</code> renders 960×540 <em>(faster)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--bg &lt;hex&gt;</div>
            <div class="tl-option-desc">Background colour, no # <em>(default: 2e2e2f)</em></div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--no-watermark</div>
            <div class="tl-option-desc">Remove the "Saint-Pixels" text overlay</div>
          </div>
          <div class="tl-option-row">
            <div class="tl-option-flag">--crop x0,y0,x1,y1</div>
            <div class="tl-option-desc">Crop to board-pixel rectangle <em>(e.g. 0,0,960,540)</em></div>
          </div>
        </div>

        <p class="tl-section-label">Speed guide</p>
        <div class="tl-speed-grid">
          <div class="tl-speed-card">
            <div class="tl-speed-label">Slow</div>
            <div class="tl-speed-val">--pps 50</div>
            <div class="tl-speed-desc">~2 events/frame — every pixel visible</div>
          </div>
          <div class="tl-speed-card">
            <div class="tl-speed-label">Default</div>
            <div class="tl-speed-val">--pps 200</div>
            <div class="tl-speed-desc">~7 events/frame — balanced</div>
          </div>
          <div class="tl-speed-card">
            <div class="tl-speed-label">Fast</div>
            <div class="tl-speed-val">--pps 3000</div>
            <div class="tl-speed-desc">100 events/frame — quick export</div>
          </div>
        </div>

      </div>

      <!-- ══ Tab: About ═══════════════════════════════════════════════════════ -->
      <div class="tl-panel hidden" id="tl-panel-about" role="tabpanel">

        <p class="tl-section-label">What this is</p>
        <p class="tl-intro">
          The timelapse replays every pixel placement ever recorded on Saint-Pixels,
          in chronological order. The <strong>in-browser player</strong> needs no install —
          just Load and Play. For a full-resolution <strong>MP4 export</strong>, use the CLI tab.
        </p>

        <p class="tl-section-label">Player controls</p>
        <div class="tl-chips">
          <div class="tl-chip purple">
            <span class="tl-chip-dot"></span>
            <span><strong>Zoom:</strong> scroll wheel or pinch to zoom the canvas. Drag to pan when zoomed in.</span>
          </div>
          <div class="tl-chip sky">
            <span class="tl-chip-dot"></span>
            <span><strong>Fullscreen:</strong> click the ⛶ button or press <kbd>F</kbd> while the player is open.</span>
          </div>
          <div class="tl-chip amber">
            <span class="tl-chip-dot"></span>
            <span><strong>Download:</strong> the PNG button saves the current canvas frame to your device.</span>
          </div>
          <div class="tl-chip purple">
            <span class="tl-chip-dot"></span>
            <span><strong>Seek:</strong> click anywhere on the progress bar to jump to that point in history.</span>
          </div>
        </div>

        <p class="tl-section-label">What gets recorded</p>
        <div class="tl-chips">
          <div class="tl-chip purple">
            <span class="tl-chip-dot"></span>
            <span>Every pixel placement — colour and position — with the placer's username and timestamp</span>
          </div>
          <div class="tl-chip sky">
            <span class="tl-chip-dot"></span>
            <span>Erase events are stored too and shown as white fills in the replay</span>
          </div>
          <div class="tl-chip amber">
            <span class="tl-chip-dot"></span>
            <span>The in-browser player loads up to <strong>500 000</strong> events. Larger histories show a note with the count loaded.</span>
          </div>
        </div>

        <p class="tl-section-label">Data sources</p>
        <div class="tl-chips">
          <div class="tl-chip purple">
            <span class="tl-chip-dot"></span>
            <span><strong>SQLite</strong> — the <code>pixel_history</code> table is an append-only log separate from
            <code>pixels</code> (which only stores the current board state)</span>
          </div>
          <div class="tl-chip sky">
            <span class="tl-chip-dot"></span>
            <span><strong>JSON file</strong> — if <code>JSON_HISTORY_PATH</code> is set in your environment, every
            placement is also written to a flat JSON array on disk in real time</span>
          </div>
        </div>

        <p class="tl-section-label">FAQ</p>
        <div class="tl-faq">
          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button">
              pixel_history table doesn't exist?
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="tl-faq-a">
              Your database predates the migration that added <code>pixel_history</code>.
              Start the server once — the migration runs automatically. Events from before
              that point won't appear in the timelapse.
            </div>
          </div>
          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button">
              Odd crop dimensions causing ffmpeg errors?
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="tl-faq-a">
              H.264 requires even width and height. If your <code>--crop</code> region results in an
              odd dimension after <code>--scale</code>, the script pads to the next even size and
              trims back inside ffmpeg automatically — no action needed on your end.
            </div>
          </div>
          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button">
              Running the CLI on Railway?
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="tl-faq-a">
              Railway has no persistent shell. Download your <code>pixel-history.json</code>
              from the Railway volume via your app's API, then run the CLI locally:
              <code>node timelapse.js --json ./pixel-history.json --out timelapse.mp4</code>
            </div>
          </div>
          <div class="tl-faq-item">
            <button class="tl-faq-q" type="button">
              Performance tips for large histories?
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="tl-faq-a">
              Use <code>--scale 2</code> — it renders at 960×540, roughly 4× less memory and
              much faster ffmpeg encoding. Raise <code>--pps</code> (e.g. <code>--pps 3000</code>)
              to reduce total frame count. SQLite mode streams rows rather than loading
              everything into memory at once.
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // ── DOM refs — player tab ─────────────────────────────────────────────────────
  const tlCanvas      = document.getElementById('tl-canvas');
  const tlCtx         = tlCanvas.getContext('2d');
  const canvasWrap    = document.getElementById('tl-canvas-wrap');
  const placeholder   = document.getElementById('tl-placeholder');
  const subtitle      = document.getElementById('tl-subtitle');
  const loadBtn       = document.getElementById('tl-load-btn');
  const playBtn       = document.getElementById('tl-play-btn');
  const resetBtn      = document.getElementById('tl-reset-btn');
  const downloadBtn   = document.getElementById('tl-download-btn');
  const speedSlider   = document.getElementById('tl-speed');
  const speedLabel    = document.getElementById('tl-speed-label');
  const counter       = document.getElementById('tl-counter');
  const progressWrap  = document.getElementById('tl-progress-wrap');
  const progressBg    = document.getElementById('tl-progress-bg');
  const progressFill  = document.getElementById('tl-progress-fill');
  const progressThumb = document.getElementById('tl-progress-thumb');
  const fullscreenBtn = document.getElementById('tl-fullscreen-btn');
  const fsExpand      = document.getElementById('tl-fs-expand');
  const fsCollapse    = document.getElementById('tl-fs-collapse');
  const zoomResetBtn  = document.getElementById('tl-zoom-reset');

  // Crisp pixel rendering
  tlCtx.imageSmoothingEnabled = false;

  // ── Player state ──────────────────────────────────────────────────────────────
  let events  = [];
  let cursor  = 0;
  let playing = false;
  let rafId   = null;

  const SPEED_TIERS = [10, 50, 200, 600, 2000];
  const SPEED_NAMES = ['Slow', 'Normal', 'Fast', 'Faster', 'Max'];

  function getPPF() { return SPEED_TIERS[parseInt(speedSlider.value, 10) - 1] ?? 50; }

  speedSlider.addEventListener('input', () => {
    speedLabel.textContent = SPEED_NAMES[parseInt(speedSlider.value, 10) - 1] ?? 'Normal';
  });

  // ── Canvas helpers ────────────────────────────────────────────────────────────
  function initCanvas() {
    tlCanvas.width  = BOARD_W;
    tlCanvas.height = BOARD_H;
    tlCtx.imageSmoothingEnabled = false;
    tlCtx.fillStyle = '#ffffff';
    tlCtx.fillRect(0, 0, BOARD_W, BOARD_H);
    placeholder.style.display = 'none';
    tlCanvas.style.display    = 'block';
    downloadBtn.disabled = false;
  }

  function resetCanvas() {
    tlCtx.imageSmoothingEnabled = false;
    tlCtx.fillStyle = '#ffffff';
    tlCtx.fillRect(0, 0, BOARD_W, BOARD_H);
  }

  // ── Zoom + pan state ──────────────────────────────────────────────────────────
  let tlScale  = 1;   // current CSS scale of canvas inside the wrap
  let tlPanX   = 0;   // CSS translate X of canvas
  let tlPanY   = 0;   // CSS translate Y of canvas
  let tlIsDragging = false;
  let tlDragStartX = 0;
  let tlDragStartY = 0;
  let tlDragOriginX = 0;
  let tlDragOriginY = 0;

  const TL_MIN_SCALE = 1;
  const TL_MAX_SCALE = 16;

  function applyTransform() {
    // Clamp pan so canvas can't be dragged completely off-screen
    const wrapR = canvasWrap.getBoundingClientRect();
    const cW    = tlCanvas.offsetWidth  * tlScale;
    const cH    = tlCanvas.offsetHeight * tlScale;

    const maxX =  (cW - wrapR.width)  / 2 + Math.max(0, (cW - wrapR.width)  / 2);
    const maxY =  (cH - wrapR.height) / 2 + Math.max(0, (cH - wrapR.height) / 2);
    const limitX = Math.max(0, (cW - wrapR.width)  / 2);
    const limitY = Math.max(0, (cH - wrapR.height) / 2);

    tlPanX = Math.max(-limitX, Math.min(limitX, tlPanX));
    tlPanY = Math.max(-limitY, Math.min(limitY, tlPanY));

    tlCanvas.style.transform = `translate(${tlPanX}px, ${tlPanY}px) scale(${tlScale})`;
    zoomResetBtn.classList.toggle('hidden', tlScale <= 1.01 && Math.abs(tlPanX) < 1 && Math.abs(tlPanY) < 1);
  }

  function resetZoom() {
    tlScale = 1;
    tlPanX  = 0;
    tlPanY  = 0;
    applyTransform();
  }

  // Mouse wheel zoom
  canvasWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(TL_MIN_SCALE, Math.min(TL_MAX_SCALE, tlScale * factor));

    // Zoom toward the mouse cursor position inside the wrap
    const rect = canvasWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width  / 2;
    const my = e.clientY - rect.top  - rect.height / 2;
    tlPanX = mx - (mx - tlPanX) * (newScale / tlScale);
    tlPanY = my - (my - tlPanY) * (newScale / tlScale);
    tlScale = newScale;
    applyTransform();
  }, { passive: false });

  // Touch pinch-zoom
  let _pinchDist = null;
  canvasWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      _pinchDist = Math.sqrt(dx*dx + dy*dy);
    } else if (e.touches.length === 1 && tlScale > 1.01) {
      tlIsDragging  = true;
      tlDragStartX  = e.touches[0].clientX;
      tlDragStartY  = e.touches[0].clientY;
      tlDragOriginX = tlPanX;
      tlDragOriginY = tlPanY;
    }
  }, { passive: true });
  canvasWrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && _pinchDist !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const factor = dist / _pinchDist;
      _pinchDist = dist;
      tlScale = Math.max(TL_MIN_SCALE, Math.min(TL_MAX_SCALE, tlScale * factor));
      applyTransform();
    } else if (e.touches.length === 1 && tlIsDragging) {
      e.preventDefault();
      tlPanX = tlDragOriginX + (e.touches[0].clientX - tlDragStartX);
      tlPanY = tlDragOriginY + (e.touches[0].clientY - tlDragStartY);
      applyTransform();
    }
  }, { passive: false });
  canvasWrap.addEventListener('touchend', () => {
    _pinchDist   = null;
    tlIsDragging = false;
  }, { passive: true });

  // Mouse drag pan (only when zoomed)
  canvasWrap.addEventListener('mousedown', (e) => {
    if (tlScale <= 1.01) return;
    tlIsDragging  = true;
    tlDragStartX  = e.clientX;
    tlDragStartY  = e.clientY;
    tlDragOriginX = tlPanX;
    tlDragOriginY = tlPanY;
    canvasWrap.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!tlIsDragging) return;
    tlPanX = tlDragOriginX + (e.clientX - tlDragStartX);
    tlPanY = tlDragOriginY + (e.clientY - tlDragStartY);
    applyTransform();
  });
  document.addEventListener('mouseup', () => {
    if (!tlIsDragging) return;
    tlIsDragging = false;
    canvasWrap.style.cursor = tlScale > 1.01 ? 'grab' : '';
  });

  zoomResetBtn.addEventListener('click', resetZoom);

  // ── Fullscreen ────────────────────────────────────────────────────────────────
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const el = document.getElementById('timelapse-modal');
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch(() => {});
    }
  }

  fullscreenBtn.addEventListener('click', toggleFullscreen);

  function onFullscreenChange() {
    const fs = isFullscreen();
    fsExpand.style.display   = fs ? 'none' : '';
    fsCollapse.style.display = fs ? ''     : 'none';
    // Reset zoom when leaving fullscreen to avoid stale transform
    if (!fs) resetZoom();
  }
  document.addEventListener('fullscreenchange',       onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // F key shortcut for fullscreen (only when modal is open)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      if (overlay.classList.contains('visible')) {
        e.preventDefault();
        toggleFullscreen();
      }
    }
  });

  // ── Download current frame ────────────────────────────────────────────────────
  downloadBtn.addEventListener('click', () => {
    if (!events.length) return;
    const link = document.createElement('a');
    link.download = `saint-pixels-timelapse-${cursor}-of-${events.length}.png`;
    link.href = tlCanvas.toDataURL('image/png');
    link.click();
  });

  // ── Progress bar (click + drag to seek) ───────────────────────────────────────
  function updateProgress() {
    const pct = events.length ? (cursor / events.length) * 100 : 0;
    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    counter.textContent = `${cursor.toLocaleString()} / ${events.length.toLocaleString()}`;
  }

  function seekFromEvent(e) {
    if (!events.length) return;
    const rect  = progressBg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(Math.floor(ratio * events.length));
  }

  let _seekDragging = false;
  progressBg.addEventListener('mousedown', (e) => {
    _seekDragging = true;
    seekFromEvent(e);
  });
  document.addEventListener('mousemove', (e) => {
    if (_seekDragging) seekFromEvent(e);
  });
  document.addEventListener('mouseup', () => { _seekDragging = false; });

  progressBg.addEventListener('touchstart', (e) => {
    seekFromEvent(e.touches[0]);
  }, { passive: true });
  progressBg.addEventListener('touchmove', (e) => {
    e.preventDefault();
    seekFromEvent(e.touches[0]);
  }, { passive: false });

  function seekTo(index) {
    const wasPlaying = playing;
    pause();
    resetCanvas();
    cursor = 0;
    const end = Math.min(index, events.length);
    for (let i = 0; i < end; i++) drawEvent(events[i]);
    cursor = end;
    updateProgress();
    if (wasPlaying && cursor < events.length) play();
  }

  // ── Draw one event ────────────────────────────────────────────────────────────
  function drawEvent(ev) {
    if (ev.color === 'erase' || !ev.color) {
      // If the server recorded what was there before the erase, show it briefly
      // then clear it — otherwise just fill white.
      tlCtx.fillStyle = '#ffffff';
    } else {
      tlCtx.fillStyle = '#' + ev.color.replace(/^#/, '');
    }
    tlCtx.fillRect(ev.x, ev.y, 1, 1);
  }

  // ── Animation loop ────────────────────────────────────────────────────────────
  function tick() {
    if (!playing) return;
    const ppf = getPPF();
    const end = Math.min(cursor + ppf, events.length);
    for (let i = cursor; i < end; i++) drawEvent(events[i]);
    cursor = end;
    updateProgress();
    if (cursor >= events.length) {
      pause();
      playBtn.textContent  = '✓ Done';
      subtitle.textContent = `Complete — ${events.length.toLocaleString()} events`;
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    if (!events.length || cursor >= events.length) return;
    playing = true;
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('tl-btn--playing');
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (cursor < events.length) {
      playBtn.textContent = '▶ Play';
      playBtn.classList.remove('tl-btn--playing');
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────────────
  playBtn.addEventListener('click',  () => { if (playing) pause(); else play(); });

  resetBtn.addEventListener('click', () => {
    pause();
    cursor = 0;
    resetCanvas();
    updateProgress();
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('tl-btn--playing');
    subtitle.textContent = 'Replay every pixel ever placed';
  });

  // ── Load data — fetches ALL history (paginates if server caps per request) ────
  // The server may return a `capped` flag if the result was truncated.
  // We set the cap high (500k) so one request usually gets everything.
  const HISTORY_FETCH_LIMIT = 500000;

  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled     = true;
    loadBtn.textContent  = 'Loading…';
    subtitle.textContent = 'Fetching pixel history…';

    try {
      // Include the auth token so the server can verify the request.
      // The token is stored in localStorage under 'sp_token' by app.js.
      const token = (() => { try { return localStorage.getItem('sp_token') || ''; } catch { return ''; } })();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      const res  = await fetch(`/api/timelapse/history?limit=${HISTORY_FETCH_LIMIT}`, { headers });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          subtitle.textContent = 'Please log in to view the timelapse.';
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
        loadBtn.disabled    = false;
        loadBtn.textContent = 'Load';
        return;
      }
      const data = await res.json();

      events = Array.isArray(data.events) ? data.events : [];
      if (!events.length) {
        subtitle.textContent = 'No pixel history yet — start painting!';
        loadBtn.disabled    = false;
        loadBtn.textContent = 'Load';
        return;
      }

      initCanvas();
      cursor = 0;
      updateProgress();

      const cappedNote     = data.capped
        ? ` (first ${events.length.toLocaleString()} of ${(data.total || '?').toLocaleString()} shown)`
        : '';
      subtitle.textContent = `${events.length.toLocaleString()} events loaded${cappedNote}`;
      playBtn.disabled     = false;
      resetBtn.disabled    = false;
      loadBtn.textContent  = 'Reload';
      loadBtn.disabled     = false;

    } catch (err) {
      console.error('[timelapse-ui] load error:', err);
      subtitle.textContent = 'Failed to load — try again later.';
      loadBtn.disabled     = false;
      loadBtn.textContent  = 'Retry';
    }
  });

  // ── Tab switching ─────────────────────────────────────────────────────────────
  const tabBtns   = overlay.querySelectorAll('.tl-tab');
  const tabPanels = overlay.querySelectorAll('.tl-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.tab === target);
        b.setAttribute('aria-selected', b.dataset.tab === target ? 'true' : 'false');
      });
      tabPanels.forEach(p => {
        p.classList.toggle('hidden', p.id !== `tl-panel-${target}`);
      });
    });
  });

  // ── Copy buttons ──────────────────────────────────────────────────────────────
  overlay.querySelectorAll('.tl-cmd-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.closest('.tl-cmd')?.dataset.copy;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1800);
      }).catch(() => {});
    });
  });

  // ── FAQ accordion ─────────────────────────────────────────────────────────────
  overlay.querySelectorAll('.tl-faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.tl-faq-item');
      item.classList.toggle('open');
    });
  });

  // ── Open / close ──────────────────────────────────────────────────────────────
  function openModal()  {
    overlay.classList.add('visible');
    resetZoom();
  }
  function closeModal() {
    pause();
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
    }
    overlay.classList.remove('visible');
  }

  topbarBtn.addEventListener('click', openModal);
  mobBtn.addEventListener('click',    openModal);
  document.getElementById('tl-close-btn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('visible') && !isFullscreen()) closeModal();
  });

})();
