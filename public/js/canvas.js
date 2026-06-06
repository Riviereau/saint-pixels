// ═══════════════════════════════════════════════════════════════════
// canvas.js — Canvas engine
// Buffer management, paintPixel, fillArea, grid, cursor, redraw loop,
// coordinate utilities, and viewport resize.
// ═══════════════════════════════════════════════════════════════════

const canvas     = document.getElementById('canvas');
const overlay    = document.getElementById('overlay');
const gridCanvas = document.getElementById('grid');
const ctx        = canvas.getContext('2d');
const overlayCtx = overlay.getContext('2d');
const gridCtx    = gridCanvas.getContext('2d');
const viewport   = document.getElementById('viewport');

const CANVAS_WIDTH  = 2000;
const CANVAS_HEIGHT = 2000;
// Visible board dimensions (grid and placement area)
const BOARD_WIDTH  = 1920;
const BOARD_HEIGHT = 1080;

const bufferCanvas = document.createElement('canvas');
bufferCanvas.width  = CANVAS_WIDTH;
bufferCanvas.height = CANVAS_HEIGHT;
const bufferCtx = bufferCanvas.getContext('2d');

let scale   = 1;
let offsetX = 0;
let offsetY = 0;
// Track the last values used to draw the grid so we only redraw it when
// the viewport actually changes (prevents the flash on every cursor move)
let lastGridScale   = null;
let lastGridOffsetX = null;
let lastGridOffsetY = null;
// isPanning is declared and owned by input.js (shared global)
let gridEnabled = true;

/** Max / min zoom as UI scale (1 = 100%, 50 = 5000%) */
const MAX_ZOOM_SCALE = 50;
const MIN_ZOOM_SCALE = 0.5;
/** Grid corner dots — screen pixels per dot */
const GRID_DOT_SCREEN_PX = 3;

// ── Utility helpers ────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hexToRgba(hex) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  if (clean.length === 3) {
    return [
      ((bigint >> 8) & 0xf) * 17,
      ((bigint >> 4) & 0xf) * 17,
      (bigint & 0xf) * 17,
      255
    ];
  }
  return [
    (bigint >> 16) & 255,
    (bigint >> 8)  & 255,
    bigint & 255,
    255
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

function colorsMatch(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function normalizeHexColor(value) {
  if (!value && value !== '') return '#000000';
  let hex = String(value).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    hex = hex.split('').map(ch => ch + ch).join('');
  }
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : '#000000';
}

function hexToHsl(hex) {
  let [r, g, b] = hexToRgba(hex).slice(0, 3).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function brightnessRgb(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// ── Paint operations ───────────────────────────────────────────────

function paintPixel(x, y, customSize = pixelSize, customTool = tool, customColor = color) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  bufferCtx.save();
  if (customTool === 'eraser') {
    bufferCtx.globalCompositeOperation = 'destination-out';
    // destination-out uses the source alpha; fully transparent fill erases nothing.
    bufferCtx.fillStyle = 'rgba(0, 0, 0, 1)';
  } else {
    bufferCtx.globalCompositeOperation = 'source-over';
    bufferCtx.fillStyle = customColor;
  }
  bufferCtx.fillRect(x, y, customSize, customSize);
  bufferCtx.restore();
}

function fillArea(x, y) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  const imageData = bufferCtx.getImageData(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  const targetIndex = (y * BOARD_WIDTH + x) * 4;
  const targetColor = imageData.data.slice(targetIndex, targetIndex + 4);
  const replacement = hexToRgba(color);
  if (colorsMatch(targetColor, replacement)) return;

  const queue   = [{ x, y }];
  const visited = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT);

  while (queue.length) {
    const { x: cx, y: cy } = queue.pop();
    const index = cy * BOARD_WIDTH + cx;
    if (cx < 0 || cy < 0 || cx >= BOARD_WIDTH || cy >= BOARD_HEIGHT) continue;
    if (visited[index]) continue;
    visited[index] = 1;

    const pixelIndex = index * 4;
    if (!colorsMatch(imageData.data.slice(pixelIndex, pixelIndex + 4), targetColor)) continue;

    imageData.data[pixelIndex]     = replacement[0];
    imageData.data[pixelIndex + 1] = replacement[1];
    imageData.data[pixelIndex + 2] = replacement[2];
    imageData.data[pixelIndex + 3] = replacement[3];

    queue.push({ x: cx + 1, y: cy });
    queue.push({ x: cx - 1, y: cy });
    queue.push({ x: cx, y: cy + 1 });
    queue.push({ x: cx, y: cy - 1 });
  }

  bufferCtx.putImageData(imageData, 0, 0);
}

// ── Grid ───────────────────────────────────────────────────────────

function drawGrid() {
  const dpr = window.devicePixelRatio || 1;

  // Do NOT resize gridCanvas here — resizeViewport() already keeps it in sync
  // with canvas. Resizing on every drawGrid call is extremely expensive.
  gridCtx.setTransform(1, 0, 0, 1, 0, 0);
  gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);

  if (!gridEnabled || scale < 4) return;

  const vpW = canvas.width  / dpr;
  const vpH = canvas.height / dpr;

  gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const boardScreenR = offsetX + Math.round(BOARD_WIDTH  * scale);
  const boardScreenB = offsetY + Math.round(BOARD_HEIGHT * scale);

  const clipL = Math.max(0, offsetX);
  const clipT = Math.max(0, offsetY);
  const clipR = Math.min(vpW, boardScreenR);
  const clipB = Math.min(vpH, boardScreenB);
  if (clipR <= clipL || clipB <= clipT) return;

  const startCol = Math.max(0, Math.floor((clipL - offsetX) / scale));
  const startRow = Math.max(0, Math.floor((clipT - offsetY) / scale));
  const endCol   = Math.min(BOARD_WIDTH,  Math.ceil((clipR - offsetX) / scale));
  const endRow   = Math.min(BOARD_HEIGHT, Math.ceil((clipB - offsetY) / scale));

  const xs = [];
  let lastXr = -Infinity;
  for (let col = startCol; col <= endCol; col++) {
    const x  = col * scale + offsetX;
    const xr = Math.round(x);
    if (xr === lastXr || xr < Math.round(clipL) || xr > Math.round(clipR)) continue;
    lastXr = xr;
    xs.push(x);
  }

  const ys = [];
  let lastYr = -Infinity;
  for (let row = startRow; row <= endRow; row++) {
    const y  = row * scale + offsetY;
    const yr = Math.round(y);
    if (yr === lastYr || yr < Math.round(clipT) || yr > Math.round(clipB)) continue;
    lastYr = yr;
    ys.push(y);
  }

  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

  if (!isTouchDevice) {
    // PC: line grid (fast and clean)
    
    gridCtx.strokeStyle = 'rgba(0,0,0,0.18)';
    gridCtx.lineWidth = 1 / dpr;

    gridCtx.beginPath();

    for (const x of xs) {
      const px = Math.round(x * dpr + 0.5) / dpr;
      gridCtx.moveTo(px, clipT);
      gridCtx.lineTo(px, clipB);
    }

    for (const y of ys) {
      const py = Math.round(y * dpr) / dpr;
      gridCtx.moveTo(clipL, py);
      gridCtx.lineTo(clipR, py);
    }

    gridCtx.stroke();
  } else {
    // Mobile: cross markers at every corner
    const armBase = Math.min(scale * 0.25, 6);
    const thick   = Math.min(Math.max(scale * 0.15, 1), 2);

    gridCtx.fillStyle = 'rgba(255,255,255,0.12)';
    for (const y of ys) {
      const ry = Math.round(y);
      for (const x of xs) {
        const rx    = Math.round(x);
        const left  = Math.min(armBase, rx - offsetX);
        const right = Math.min(armBase, boardScreenR - rx);
        const up    = Math.min(armBase, ry - offsetY);
        const down  = Math.min(armBase, boardScreenB - ry);
        gridCtx.fillRect(rx - left, ry - thick/2, left + right, thick);
        gridCtx.fillRect(rx - thick/2, ry - up, thick, up + down);
      }
    }

    gridCtx.fillStyle = 'rgba(0,0,0,0.18)';
    for (const y of ys) {
      const ry = Math.round(y);
      for (const x of xs) {
        const rx    = Math.round(x);
        const left  = Math.min(armBase, rx - offsetX);
        const right = Math.min(armBase, boardScreenR - rx);
        const up    = Math.min(armBase, ry - offsetY);
        const down  = Math.min(armBase, boardScreenB - ry);
        gridCtx.fillRect(rx - left, ry - thick/2, left + right, thick);
        gridCtx.fillRect(rx - thick/2, ry - up, thick, up + down);
      }
    }
  }

  // Board border
  gridCtx.strokeStyle = 'rgba(0,0,0,0.6)';
  gridCtx.lineWidth = 1;
  gridCtx.strokeRect(offsetX + 0.5, offsetY + 0.5, Math.round(BOARD_WIDTH * scale), Math.round(BOARD_HEIGHT * scale));
}

function drawGridIfDirty() {
  const scaleChanged  = scale   !== lastGridScale;
  const offsetChanged = offsetX !== lastGridOffsetX || offsetY !== lastGridOffsetY;
  if (!scaleChanged && !offsetChanged) return;
  lastGridScale   = scale;
  lastGridOffsetX = offsetX;
  lastGridOffsetY = offsetY;
  drawGrid();
}

function toggleGrid() {
  gridEnabled = !gridEnabled;
  const toggleGridBtn = document.getElementById('toggle-grid');
  if (toggleGridBtn) toggleGridBtn.classList.toggle('active', gridEnabled);
  lastGridScale = null;
  redraw();
}

// ── Cursor ─────────────────────────────────────────────────────────

function drawCursor() {
  if (!cursorPosition || tool === 'hand' || tool === 'none') return;

  const dpr = window.devicePixelRatio || 1;
  const { x, y } = cursorPosition;

  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const ox = offsetX;
  const oy = offsetY;

  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);

  const sizeX = Math.floor((x + 1) * scale + ox) - px;
  const sizeY = Math.floor((y + 1) * scale + oy) - py;

  const isRulerMode = tool === 'ruler';
  const activeColor = isRulerMode
    ? '#00e5ff'
    : (tool === 'eraser' ? '#ffffff' : (color || '#000000'));
  const rgba = hexToRgba(activeColor);
  const rulerAlpha = isRulerMode
    ? 0.25 + 0.25 * Math.sin(performance.now() / 180)
    : 0.45;
  overlayCtx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rulerAlpha})`;
  overlayCtx.fillRect(px, py, sizeX, sizeY);

  overlayCtx.lineWidth = 1;
  overlayCtx.strokeStyle = 'rgba(0,0,0,0.8)';
  overlayCtx.strokeRect(px - 0.5, py - 0.5, sizeX + 1, sizeY + 1);

  if (sizeX >= 4 && sizeY >= 4) {
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    overlayCtx.strokeRect(px + 0.5, py + 0.5, sizeX - 1, sizeY - 1);
  }
}

// ── Render loop ────────────────────────────────────────────────────

let isRedrawPending        = false;
let isOverlayRedrawPending = false;

function redrawOverlay() {
  if (isOverlayRedrawPending) return;
  isOverlayRedrawPending = true;
  requestAnimationFrame(() => {
    isOverlayRedrawPending = false;
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    drawCursor();
    rulerDrawOverlay();
  });
}

function clampOffsets() {
  const dpr = window.devicePixelRatio || 1;
  const vpW = canvas.width / dpr;
  const vpH = canvas.height / dpr;
  const scaledWidth  = BOARD_WIDTH  * scale;
  const scaledHeight = BOARD_HEIGHT * scale;

  const padX = Math.round(vpW * 0.30);
  const padY = Math.round(vpH * 0.30);

  if (vpW >= scaledWidth) {
    const centered = Math.round((vpW - scaledWidth) / 2);
    offsetX = clamp(offsetX, centered - padX, centered + padX);
  } else {
    offsetX = clamp(offsetX, vpW - scaledWidth - padX, padX);
  }

  if (vpH >= scaledHeight) {
    const centered = Math.round((vpH - scaledHeight) / 2);
    offsetY = clamp(offsetY, centered - padY, centered + padY);
  } else {
    offsetY = clamp(offsetY, vpH - scaledHeight - padY, padY);
  }
}

/** The actual render work — called from inside a rAF callback. */
function _doRender() {
  clampOffsets();

  const dpr = window.devicePixelRatio || 1;
  const ox  = offsetX;
  const oy  = offsetY;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const boardW = Math.round(BOARD_WIDTH  * scale);
  const boardH = Math.round(BOARD_HEIGHT * scale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, boardW, boardH);

  // Occlusion culling — blit only the visible slice of the buffer
  const vpW_css = canvas.width  / dpr;
  const vpH_css = canvas.height / dpr;
  const visL = Math.max(0, ox);
  const visT = Math.max(0, oy);
  const visR = Math.min(vpW_css, ox + boardW);
  const visB = Math.min(vpH_css, oy + boardH);

  if (visR > visL && visB > visT) {
    const srcX = (visL - ox) / scale;
    const srcY = (visT - oy) / scale;
    const srcW = (visR - visL) / scale;
    const srcH = (visB - visT) / scale;
    ctx.drawImage(bufferCanvas, srcX, srcY, srcW, srcH, visL, visT, visR - visL, visB - visT);
  }

  drawGridIfDirty();

  if (isPanning) {
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    if (rulers.length > 0 || (rulerState === 'drawing' && rulerStart)) {
      rulerDrawOverlay();
    }
    return;
  }

  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  drawCursor();
  rulerDrawOverlay();
}

function redraw() {
  if (isRedrawPending) return;
  isRedrawPending = true;
  requestAnimationFrame(() => {
    isRedrawPending = false;
    _doRender();
  });
}

// ── Coordinate math ────────────────────────────────────────────────

function getCanvasCoords(clientX, clientY) {
  const rect    = viewport.getBoundingClientRect();
  const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;
  const ox = offsetX / vvScale;
  const oy = offsetY / vvScale;
  const s  = scale   / vvScale;
  const x  = (clientX - rect.left - ox) / s;
  const y  = (clientY - rect.top  - oy) / s;
  return {
    x: clamp(Math.floor(x), 0, BOARD_WIDTH  - 1),
    y: clamp(Math.floor(y), 0, BOARD_HEIGHT - 1),
  };
}

// ── Viewport resize ────────────────────────────────────────────────

function resizeViewport() {
  const dpr  = window.devicePixelRatio || 1;
  const rect = viewport.getBoundingClientRect();
  const w    = Math.max(1, Math.floor(rect.width));
  const h    = Math.max(1, Math.floor(rect.height));

  canvas.width       = w * dpr;
  canvas.height      = h * dpr;
  gridCanvas.width   = w * dpr;
  gridCanvas.height  = h * dpr;
  overlay.width      = w * dpr;
  overlay.height     = h * dpr;

  lastGridScale = null;
  clampOffsets();
  redraw();
}

window.addEventListener('resize', resizeViewport);

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resizeViewport);
  window.visualViewport.addEventListener('scroll', resizeViewport);
}

// ── Export ─────────────────────────────────────────────────────────

function exportPng() {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width  = BOARD_WIDTH;
  exportCanvas.height = BOARD_HEIGHT;
  const exportCtx = exportCanvas.getContext('2d');
  exportCtx.fillStyle = '#ffffff';
  exportCtx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  exportCtx.drawImage(bufferCanvas, 0, 0, BOARD_WIDTH, BOARD_HEIGHT, 0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  const link = document.createElement('a');
  link.download = 'saint-pixels.png';
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
}
