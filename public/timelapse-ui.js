/**
 * public/timelapse-ui.js — In-browser canvas timelapse player
 *
 * Fetches pixel_history from /api/timelapse/history and replays every
 * placement event on a <canvas> inside the modal — no ffmpeg needed.
 *
 * Controls:
 *   ▶/⏸  Play / Pause
 *   ⏹   Reset to beginning
 *   Speed slider — Slow / Normal / Fast / Faster / Max
 *   Progress bar — shows % complete, click to seek
 *
 * All styling lives in timelapse.css under the .tl-* / #timelapse-* namespace.
 * This file contains no inline style= attributes — change the look in CSS only.
 *
 * Tab layout:
 *   Player  — live canvas playback
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

        <!-- Canvas preview -->
        <div id="tl-canvas-wrap" class="tl-canvas-wrap">
          <canvas id="tl-canvas" class="tl-canvas"></canvas>
          <div id="tl-placeholder" class="tl-placeholder">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor"
                 stroke-width="1.5" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>Press Load to fetch pixel history</span>
          </div>
        </div>

        <!-- Progress bar -->
        <div id="tl-progress-wrap" class="tl-progress-wrap" title="Click to seek">
          <div id="tl-progress-bg" class="tl-progress-bg">
            <div id="tl-progress-fill" class="tl-progress-fill"></div>
          </div>
        </div>

        <!-- Controls -->
        <div class="tl-controls">
          <button id="tl-load-btn"  class="tl-btn tl-btn--load"  type="button">Load</button>
          <button id="tl-play-btn"  class="tl-btn tl-btn--play"  type="button" disabled>▶ Play</button>
          <button id="tl-reset-btn" class="tl-btn tl-btn--reset" type="button" disabled>⏹ Reset</button>

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
          just Load and Play. For a full-resolution <strong>MP4 export</strong>, use the
          CLI tab.
        </p>

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
            <span>The in-browser player loads up to <strong>100 000</strong> events. Larger histories show a "first 100k shown" note</span>
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
  const tlCanvas    = document.getElementById('tl-canvas');
  const tlCtx       = tlCanvas.getContext('2d');
  const placeholder = document.getElementById('tl-placeholder');
  const subtitle    = document.getElementById('tl-subtitle');
  const loadBtn     = document.getElementById('tl-load-btn');
  const playBtn     = document.getElementById('tl-play-btn');
  const resetBtn    = document.getElementById('tl-reset-btn');
  const speedSlider = document.getElementById('tl-speed');
  const speedLabel  = document.getElementById('tl-speed-label');
  const counter     = document.getElementById('tl-counter');
  const progressBg  = document.getElementById('tl-progress-bg');
  const progressFill= document.getElementById('tl-progress-fill');

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
    tlCtx.fillStyle = '#ffffff';
    tlCtx.fillRect(0, 0, BOARD_W, BOARD_H);
    placeholder.style.display = 'none';
    tlCanvas.style.display    = 'block';
  }

  function resetCanvas() {
    tlCtx.fillStyle = '#ffffff';
    tlCtx.fillRect(0, 0, BOARD_W, BOARD_H);
  }

  // ── Progress bar ──────────────────────────────────────────────────────────────
  function updateProgress() {
    const pct = events.length ? (cursor / events.length) * 100 : 0;
    progressFill.style.width = pct + '%';
    counter.textContent = `${cursor.toLocaleString()} / ${events.length.toLocaleString()}`;
  }

  progressBg.addEventListener('click', (e) => {
    if (!events.length) return;
    const rect  = progressBg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(Math.floor(ratio * events.length));
  });

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

  // ── Load data ─────────────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled     = true;
    loadBtn.textContent  = 'Loading…';
    subtitle.textContent = 'Fetching pixel history…';

    try {
      const res  = await fetch('/api/timelapse/history');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

      const cappedNote     = data.capped ? ' (first 100k shown)' : '';
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
      }).catch(() => {
        // Clipboard API unavailable (non-HTTPS) — silently ignore
      });
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
  function openModal()  { overlay.classList.add('visible'); }
  function closeModal() { pause(); overlay.classList.remove('visible'); }

  topbarBtn.addEventListener('click', openModal);
  mobBtn.addEventListener('click',    openModal);
  document.getElementById('tl-close-btn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) closeModal();
  });

})();
