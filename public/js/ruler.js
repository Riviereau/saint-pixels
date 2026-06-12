// ═══════════════════════════════════════════════════════════════════
// ruler.js — Pixel Ruler Engine
// Cursor-flash rAF loop, state machine (idle → drawing → locked),
// overlay drawing, DOM label management, coordinate helpers.
// Depends on: scale, offsetX, offsetY, tool, rulers, rulerState,
//             rulerStart, rulerLiveEnd (shared state)
//             overlayCtx, viewport (canvas.js)
//             redraw, redrawOverlay (canvas.js)
// ═══════════════════════════════════════════════════════════════════

// ── Ruler state ───────────────────────────────────────────────────────
const rulers     = []; // Array of { x1, y1, x2, y2 } locked rulers
let rulerState   = 'idle'; // 'idle' | 'drawing'
let rulerStart   = null;   // { x, y } board pixels
let rulerLiveEnd = null;   // { x, y } board pixels — live cursor while drawing

// ── Cursor-flash rAF loop ─────────────────────────────────────────────
// Keeps the sine-pulse animating even when the mouse is stationary.
// Runs only while the ruler tool is active.
let _rulerFlashRaf = null;

function rulerFlashStart() {
  if (_rulerFlashRaf !== null) return; // already running
  function tick() {
    if (tool !== 'ruler') { _rulerFlashRaf = null; return; }
    redraw();
    _rulerFlashRaf = requestAnimationFrame(tick);
  }
  _rulerFlashRaf = requestAnimationFrame(tick);
}

function rulerFlashStop() {
  if (_rulerFlashRaf !== null) {
    cancelAnimationFrame(_rulerFlashRaf);
    _rulerFlashRaf = null;
  }
}

// ── Click handler (called from applyToolAtCell when tool === 'ruler') ──
function rulerHandleClick(bx, by) {
  if (rulerState === 'idle') {
    rulerStart   = { x: bx, y: by };
    rulerLiveEnd = { x: bx, y: by };
    rulerState   = 'drawing';
  } else {
    // Lock the ruler
    rulers.push({ x1: rulerStart.x, y1: rulerStart.y, x2: bx, y2: by });
    rulerState   = 'idle';
    rulerStart   = null;
    rulerLiveEnd = null;
    rulerRenderDOM();
  }
  if (typeof window._updateRulerStopBtn === 'function') window._updateRulerStopBtn();
  redraw();
}

// ── Live-end update (called from mousemove / touchmove) ───────────────
function rulerUpdateLiveEnd(bx, by) {
  if (rulerState !== 'drawing') return;
  rulerLiveEnd = { x: bx, y: by };
  redraw();
}

// ── Distance helper ───────────────────────────────────────────────────
function rulerPixelDistance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

// ── Board pixel → overlay CSS coords ─────────────────────────────────
function boardToOverlayCSS(bx, by) {
  return {
    cx: bx * scale + offsetX,
    cy: by * scale + offsetY,
  };
}

// ── Overlay drawing ───────────────────────────────────────────────────

/** Draw the live (in-progress) and locked rulers on the overlay canvas */
function rulerDrawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Draw all locked rulers
  for (const r of rulers) {
    rulerDrawLine(r.x1, r.y1, r.x2, r.y2, false);
  }

  // Draw in-progress ruler
  if (rulerState === 'drawing' && rulerStart && rulerLiveEnd) {
    rulerDrawLine(rulerStart.x, rulerStart.y, rulerLiveEnd.x, rulerLiveEnd.y, true);
    // Draw crosshair cursor at start
    rulerDrawCrosshair(rulerStart.x, rulerStart.y, '#00e5ff');
  }

  // Reposition DOM labels to follow zoom/pan
  rulerRepositionLabels();
}

function rulerDrawLine(x1, y1, x2, y2, isLive) {
  const ox  = offsetX;
  const oy  = offsetY;
  const sx1 = x1 * scale + ox;
  const sy1 = y1 * scale + oy;
  const sx2 = x2 * scale + ox;
  const sy2 = y2 * scale + oy;

  const dist = rulerPixelDistance(x1, y1, x2, y2);

  // Main line
  overlayCtx.save();
  overlayCtx.setLineDash(isLive ? [6, 4] : []);
  overlayCtx.strokeStyle = isLive ? 'rgba(0,229,255,0.85)' : 'rgba(0,229,255,1)';
  overlayCtx.lineWidth   = isLive ? 1.5 : 2;
  overlayCtx.shadowColor = 'rgba(0,180,220,0.6)';
  overlayCtx.shadowBlur  = 4;
  overlayCtx.beginPath();
  overlayCtx.moveTo(sx1, sy1);
  overlayCtx.lineTo(sx2, sy2);
  overlayCtx.stroke();
  overlayCtx.setLineDash([]);
  overlayCtx.shadowBlur = 0;

  // Endpoint caps
  const capSize = Math.max(3, Math.min(8, scale * 0.6));
  overlayCtx.strokeStyle = isLive ? 'rgba(0,229,255,0.85)' : 'rgba(0,229,255,1)';
  overlayCtx.lineWidth   = isLive ? 1.5 : 2;
  const angle = Math.atan2(sy2 - sy1, sx2 - sx1);
  const perp  = angle + Math.PI / 2;
  [{ sx: sx1, sy: sy1 }, { sx: sx2, sy: sy2 }].forEach(({ sx, sy }) => {
    overlayCtx.beginPath();
    overlayCtx.moveTo(sx + Math.cos(perp) * capSize, sy + Math.sin(perp) * capSize);
    overlayCtx.lineTo(sx - Math.cos(perp) * capSize, sy - Math.sin(perp) * capSize);
    overlayCtx.stroke();
  });

  // Pixel label — only on live line; DOM handles locked ruler labels
  if (isLive) {
    const mx = (sx1 + sx2) / 2;
    const my = (sy1 + sy2) / 2;
    const label = `${dist} px`;
    overlayCtx.font          = 'bold 12px ui-monospace, monospace';
    overlayCtx.textAlign     = 'center';
    overlayCtx.textBaseline  = 'middle';
    const tw  = overlayCtx.measureText(label).width;
    const pad = 5;
    overlayCtx.fillStyle = 'rgba(0,0,0,0.75)';
    overlayCtx.beginPath();
    overlayCtx.roundRect(mx - tw / 2 - pad, my - 10, tw + pad * 2, 20, 5);
    overlayCtx.fill();
    overlayCtx.fillStyle = '#00e5ff';
    overlayCtx.fillText(label, mx, my);
  }

  overlayCtx.restore();
}

function rulerDrawCrosshair(bx, by, crossColor) {
  const sx  = bx * scale + offsetX;
  const sy  = by * scale + offsetY;
  const arm = 8;
  overlayCtx.save();
  overlayCtx.strokeStyle = crossColor;
  overlayCtx.lineWidth   = 1.5;
  overlayCtx.beginPath();
  overlayCtx.moveTo(sx - arm, sy); overlayCtx.lineTo(sx + arm, sy);
  overlayCtx.moveTo(sx, sy - arm); overlayCtx.lineTo(sx, sy + arm);
  overlayCtx.stroke();
  overlayCtx.restore();
}

// ── DOM ruler labels ──────────────────────────────────────────────────

/** Render DOM labels for locked rulers (positioned over the canvas viewport) */
function rulerRenderDOM() {
  // Remove old ruler DOM labels
  document.querySelectorAll('.sp-ruler-label').forEach(el => el.remove());

  rulers.forEach((r, idx) => {
    const label = document.createElement('div');
    label.className        = 'sp-ruler-label';
    label.dataset.rulerIdx = idx;

    const dist = rulerPixelDistance(r.x1, r.y1, r.x2, r.y2);
    const dx   = r.x2 - r.x1;
    const dy   = r.y2 - r.y1;

    label.innerHTML = `
      <svg class="sp-ruler-icon" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <line x1="1" y1="11" x2="11" y2="1"/>
        <line x1="1" y1="8"  x2="1"  y2="11"/>
        <line x1="4" y1="11" x2="1"  y2="11"/>
        <line x1="8" y1="1"  x2="11" y2="1"/>
        <line x1="11" y1="4" x2="11" y2="1"/>
      </svg>
      <span class="sp-ruler-dist">${dist} px</span>
      ${dx !== 0 ? `<span class="sp-ruler-axis">W:${Math.abs(dx)}</span>` : ''}
      ${dy !== 0 ? `<span class="sp-ruler-axis">H:${Math.abs(dy)}</span>` : ''}
      <button class="sp-ruler-trash" data-ruler-idx="${idx}" title="Remove ruler" aria-label="Remove ruler">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
          <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
        </svg>
      </button>
    `;

    // Position: midpoint of the ruler line in viewport CSS coords
    const { cx: mx, cy: my } = boardToOverlayCSS((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
    label.style.left = `${mx}px`;
    label.style.top  = `${my}px`;

    const vp = document.getElementById('viewport');
    if (vp) vp.appendChild(label);

    // Forward wheel events on the ruler label to the canvas so the user can
    // still zoom when the cursor is over a ruler widget.
    label.addEventListener('wheel', (e) => {
      e.stopPropagation();
      // handleWheel is defined in input.js
      if (typeof handleWheel === 'function') handleWheel(e);
    }, { passive: false });
  });

  // Trash click handler (event delegation)
  const vp = document.getElementById('viewport');
  if (vp) {
    vp.querySelectorAll('.sp-ruler-trash').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.rulerIdx, 10);
        rulers.splice(idx, 1);
        rulerRenderDOM();
        redraw();
      });
    });
  }
}

/** Reposition DOM ruler labels whenever viewport changes (zoom / pan / resize) */
function rulerRepositionLabels() {
  const vp = document.getElementById('viewport');
  if (!vp) return;
  vp.querySelectorAll('.sp-ruler-label').forEach(label => {
    const idx = parseInt(label.dataset.rulerIdx, 10);
    const r   = rulers[idx];
    if (!r) return;
    const { cx, cy } = boardToOverlayCSS((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
    label.style.left = `${cx}px`;
    label.style.top  = `${cy}px`;
  });
}
// rulerRepositionLabels is called from rulerDrawOverlay() which is called
// at the end of every redraw() rAF pass — no extra wiring needed.
