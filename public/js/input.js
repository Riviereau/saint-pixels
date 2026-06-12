// ═══════════════════════════════════════════════════════════════════
// input.js — Input handling
// Mouse, touch, keyboard, wheel/zoom, pan, tool switching.
// Depends on: canvas.js, palette.js, cooldown.js, broadcast.js,
//             ruler engine (ruler.js), state variables
// ═══════════════════════════════════════════════════════════════════

// ── DOM refs ────────────────────────────────────────────────────────
// overlay and viewport are already declared as globals in canvas.js
const zoomInput    = document.getElementById('zoom');
const toggleGridBtn = document.getElementById('toggle-grid');
const exportButton  = document.getElementById('export-png');
const toolButtons   = document.querySelectorAll('[data-tool]');
const coordLabel    = document.getElementById('coord');

// ── State ────────────────────────────────────────────────────────────
let tool          = 'brush';
let pixelSize     = 1;
let isMouseDown   = false;
let isPanning     = false;
let panStartX     = 0;
let panStartY     = 0;

let _longPressPanTimer  = null;
let _longPressAnchorX   = 0;
let _longPressAnchorY   = 0;
const LONG_PRESS_MOVE_THRESHOLD = 6;
const LONG_PRESS_PAN_DELAY_MS   = 400;

let lastArrowKeyMoveAt    = 0;
let lastPointerClientX    = 0;
let lastPointerClientY    = 0;
let keyboardCursorArmored = false;
let mouseArmorAnchorX     = 0;
let mouseArmorAnchorY     = 0;
let _eyedropperJustFired  = false;
let _lastPlacedCell       = null;

const ARROW_KEY_REPEAT_MS   = 110;
const MOUSE_CURSOR_ARMOR_PX = 36;

// ── Tool management ───────────────────────────────────────────────────
function setTool(newTool) {
  const prevTool = tool;
  tool = newTool;
  toolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === newTool));
  dispatchStateChange({ currentTool: newTool.charAt(0).toUpperCase() + newTool.slice(1) });

  if (prevTool !== newTool) {
    if      (newTool === 'eyedropper') SFX.play('eyedropper',   200, 0.5);
    else if (newTool === 'hand')       SFX.play('hand',          200, 0.45);
    else if (newTool === 'ruler')      SFX.play('ruler',         150, 0.4);
    else if (newTool === 'none')       SFX.play('none',          150, 0.4);
    else                               SFX.play('tool-changed',  150, 0.4);
  }

  if (tool === 'hand') {
    rulerFlashStop();
    viewport.classList.add('tool-hand-active');
    canvas.style.cursor = overlay.style.cursor = 'grab';
  } else if (tool === 'none') {
    rulerFlashStop();
    viewport.classList.remove('tool-hand-active', 'tool-hand-dragging');
    canvas.style.cursor = overlay.style.cursor = 'default';
  } else if (tool === 'ruler') {
    viewport.classList.remove('tool-hand-active', 'tool-hand-dragging');
    canvas.style.cursor = overlay.style.cursor = 'crosshair';
    rulerFlashStart();
  } else {
    viewport.classList.remove('tool-hand-active', 'tool-hand-dragging');
    canvas.style.cursor = overlay.style.cursor = 'crosshair';
    rulerFlashStop();
  }
  _updateRulerStopBtn?.();
}

// ── Status display ────────────────────────────────────────────────────
function updateStatus(x, y) {
  const txt = `${x}, ${y}`;
  coordLabel.textContent = txt;
  const topbarCoord = document.getElementById('coord-topbar');
  if (topbarCoord) topbarCoord.textContent = txt;
}

// ── Cursor helpers ────────────────────────────────────────────────────
function armKeyboardCursorAfterArrow() {
  keyboardCursorArmored = true;
  mouseArmorAnchorX = lastPointerClientX;
  mouseArmorAnchorY = lastPointerClientY;
}
function disarmKeyboardCursor() { keyboardCursorArmored = false; }
function pointerMovedPastArmor(clientX, clientY) {
  const dx = clientX - mouseArmorAnchorX;
  const dy = clientY - mouseArmorAnchorY;
  return dx * dx + dy * dy >= MOUSE_CURSOR_ARMOR_PX * MOUSE_CURSOR_ARMOR_PX;
}
function ensureBoardCursor() {
  if (!cursorPosition) cursorPosition = { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
}

function moveCursor(dx, dy) {
  if (!cursorPosition) return;
  const x = clamp(cursorPosition.x + dx, 0, BOARD_WIDTH  - 1);
  const y = clamp(cursorPosition.y + dy, 0, BOARD_HEIGHT - 1);
  cursorPosition = { x, y };
  updateStatus(x, y);
  redrawOverlay();
}

function moveCursorFromArrow(dx, dy, event) {
  ensureBoardCursor();
  if (event.repeat) {
    const now = Date.now();
    if (now - lastArrowKeyMoveAt < ARROW_KEY_REPEAT_MS) return;
    lastArrowKeyMoveAt = now;
  } else {
    lastArrowKeyMoveAt = Date.now();
  }
  moveCursor(dx, dy);
  armKeyboardCursorAfterArrow();
}

// ── Tool application ──────────────────────────────────────────────────
function applyToolAtCell(x, y) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  if (tool === 'none' || tool === 'hand') return;
  if (tool === 'ruler') { rulerHandleClick(x, y); return; }

  updateStatus(x, y);
  cursorPosition = { x, y };

  if (tool === 'eyedropper') {
    const pixel  = bufferCtx.getImageData(x, y, 1, 1).data;
    const picked = pixel[3] === 0 ? '#ffffff' : rgbToHex(pixel[0], pixel[1], pixel[2]);
    const norm   = normalizeHexColor(picked);
    const [pH, pS, pL] = hexToHsl(norm);

    let bestIdx = -1, bestDist = Infinity;
    paletteColors.forEach((entry, i) => {
      const base = normalizeHexColor(entry.color);
      const [bH, bS, bL] = hexToHsl(base);
      const dH = Math.min(Math.abs(pH - bH), 360 - Math.abs(pH - bH));
      const dist = dH + Math.abs(pS - bS) * 0.3 + Math.abs(pL - bL) * 0.5;
      const EPSILON = 1.0;
      const isBetter = dist < bestDist - EPSILON;
      const isTieWithRecent = Math.abs(dist - bestDist) <= EPSILON && i === lastUsedPaletteIdx;
      if (isBetter || isTieWithRecent) { bestDist = dist; bestIdx = i; }
    });

    const HUE_THRESHOLD = 30;
    const eyedropperBtns = [];
    if (bestIdx !== -1 && bestDist <= HUE_THRESHOLD) {
      const slotColor = normalizeHexColor(paletteColors[bestIdx].color);
      paletteColors[bestIdx] = asPaletteEntry({ ...paletteColors[bestIdx], color: norm });
      document.querySelectorAll('#palette button, #fullscreen-palette button').forEach(btn => {
        if (normalizeHexColor(btn.dataset.color) === slotColor) {
          btn.style.background = norm;
          btn.dataset.color = norm;
          btn.title = norm.toUpperCase();
          eyedropperBtns.push(btn);
        }
      });
    } else {
      const alreadyIn = paletteColors.some(e => normalizeHexColor(e.color) === norm);
      if (!alreadyIn) { paletteColors.push(asPaletteEntry({ id: null, label: norm, color: norm })); renderPalette(); }
    }

    setColor(norm, eyedropperBtns[0] || null);
    if (eyedropperBtns.length > 1) eyedropperBtns.forEach(btn => btn.classList.add('selected'));
    _eyedropperJustFired = true;
    cancelLongPressPan();
    if (window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => { setTool('brush'); _eyedropperJustFired = false; }, 320);
    } else {
      setTool('brush');
    }
    redraw();
    return;
  }

  if (!canPlacePixel()) { updateCooldownLabel(); redraw(); return; }

  let prevColor = null;
  const prevPixel = bufferCtx.getImageData(x, y, 1, 1).data;
  if (prevPixel[3] > 0) prevColor = rgbToHex(prevPixel[0], prevPixel[1], prevPixel[2]);

  paintPixel(x, y);
  lastPlaceAt = Date.now();
  _markLocalCell(x, y);

  if (tool === 'eraser') SFX.play('pixel-erased', 80, 0.4);
  if (tool === 'brush') {
    SFX.play(Math.random() < 0.5 ? 'pixel-placed2' : 'pixel-placed3', 80, 0.45);
    spawnParticles(x, y, color || '#ffffff');
  }

  redraw();

  setTimeout(() => {
    updateCooldownLabel();
    broadcastEvent({
      type: 'pixel', x, y,
      color:     tool === 'eraser' ? null : color,
      prevColor: prevColor,
      size:      pixelSize,
      tool,
      user:      currentUser,
      time:      lastPlaceAt
    });
  }, 0);
}

function placeFromKeyboard() {
  if (!currentUser) return;
  ensureBoardCursor();
  cursorPosition = {
    x: clamp(cursorPosition.x, 0, BOARD_WIDTH  - 1),
    y: clamp(cursorPosition.y, 0, BOARD_HEIGHT - 1),
  };
  if (tool === 'none' || tool === 'hand') setTool('brush');
  applyToolAtCell(cursorPosition.x, cursorPosition.y);
}

// ── Pan helpers ───────────────────────────────────────────────────────
function cancelLongPressPan() {
  if (_longPressPanTimer !== null) { clearTimeout(_longPressPanTimer); _longPressPanTimer = null; }
}

function handlePanStart(event) {
  isPanning = true;
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
  canvas.classList.remove('shift-pan');
  viewport.classList.remove('tool-hand-active');
  viewport.classList.add('tool-hand-dragging');
}

function handlePanMove(event) {
  if (!isPanning) return;
  offsetX = Math.round(event.clientX - panStartX);
  offsetY = Math.round(event.clientY - panStartY);
  redraw();
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
}

function handlePanEnd() {
  if (!isPanning) return;
  isPanning = false;
  viewport.classList.remove('tool-hand-dragging');
  if (tool === 'hand') viewport.classList.add('tool-hand-active');
  redrawOverlay();
}

// ── Mouse actions ─────────────────────────────────────────────────────
function startAction(event) {
  if (event.button === 2) return;
  if (event.shiftKey || event.button === 1 || tool === 'hand') { handlePanStart(event); return; }
  if (!currentUser) return;
  _lastPlacedCell = null;
  _longPressAnchorX = event.clientX;
  _longPressAnchorY = event.clientY;
  _longPressPanTimer = setTimeout(() => {
    _longPressPanTimer = null;
    if (isMouseDown) {
      isMouseDown = false;
      handlePanStart({ clientX: lastPointerClientX, clientY: lastPointerClientY });
    }
  }, LONG_PRESS_PAN_DELAY_MS);
  isMouseDown = true;
}

function moveAction(event) {
  const _coordPos = getCanvasCoords(event.clientX, event.clientY);
  updateStatus(_coordPos.x, _coordPos.y);

  if (_longPressPanTimer !== null) {
    const dx = event.clientX - _longPressAnchorX;
    const dy = event.clientY - _longPressAnchorY;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD) {
      cancelLongPressPan();
      if (isMouseDown && !isPanning) handleAction(event);
    }
  }

  if (isPanning) { offsetX = event.clientX - panStartX; offsetY = event.clientY - panStartY; redraw(); return; }
  if (!isMouseDown) return;
  handleAction(event);
}

function handleAction(event) {
  disarmKeyboardCursor();
  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  if (_lastPlacedCell && _lastPlacedCell.x === x && _lastPlacedCell.y === y) return;
  _lastPlacedCell = { x, y };
  applyToolAtCell(x, y);
}

function stopAction(event) {
  const wasShortClick = _longPressPanTimer !== null;
  cancelLongPressPan();
  if (wasShortClick && isMouseDown && !isPanning && !_eyedropperJustFired) {
    _lastPlacedCell = null;
    handleAction(event);
  }
  _eyedropperJustFired = false;
  _lastPlacedCell = null;
  isMouseDown = false;
  if (isPanning) {
    isPanning = false;
    viewport.classList.remove('tool-hand-dragging');
    if (tool === 'hand') viewport.classList.add('tool-hand-active');
  }
}

// ── Wheel / zoom ──────────────────────────────────────────────────────
let _wheelRafId = null, _wheelPivotX = 0, _wheelPivotY = 0, _wheelFactor = 1;

function handleWheel(event) {
  event.preventDefault();
  const direction = -Math.sign(event.deltaY);
  if (scale === MAX_ZOOM_SCALE && direction > 0) return;
  if (scale === MIN_ZOOM_SCALE && direction < 0) return;

  const rect   = viewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  if (_wheelRafId === null) {
    _wheelPivotX = mouseX; _wheelPivotY = mouseY; _wheelFactor = 1;
    _wheelRafId = requestAnimationFrame(() => {
      _wheelRafId = null;
      const boardX = (_wheelPivotX - offsetX) / scale;
      const boardY = (_wheelPivotY - offsetY) / scale;
      scale = clamp(scale * _wheelFactor, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
      offsetX = Math.round(_wheelPivotX - boardX * scale);
      offsetY = Math.round(_wheelPivotY - boardY * scale);
      clampOffsets();
      if (isPanning) {
        panStartX = _wheelPivotX + rect.left - offsetX;
        panStartY = _wheelPivotY + rect.top  - offsetY;
      }
      zoomInput.value = Math.round(scale * 100);
      dispatchStateChange({ zoomLevel: Math.round(scale * 100) });
      const newCoords = getCanvasCoords(_wheelPivotX + rect.left, _wheelPivotY + rect.top);
      cursorPosition = { x: newCoords.x, y: newCoords.y };
      redraw();
    });
  }
  _wheelFactor *= (direction > 0 ? 1.12 : 0.88);
}

// ── Mouse event wiring ────────────────────────────────────────────────
overlay.addEventListener('mousedown',  startAction);
overlay.addEventListener('mousemove',  event => {
  lastPointerClientX = event.clientX;
  lastPointerClientY = event.clientY;

  if (isPanning) { handlePanMove(event); return; }

  if (keyboardCursorArmored && cursorPosition) {
    if (!pointerMovedPastArmor(event.clientX, event.clientY)) {
      updateStatus(cursorPosition.x, cursorPosition.y); redraw(); return;
    }
    disarmKeyboardCursor();
  }

  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  updateStatus(x, y);
  const cellChanged = !cursorPosition || cursorPosition.x !== x || cursorPosition.y !== y;
  cursorPosition = { x, y };

  if (tool === 'ruler') { rulerUpdateLiveEnd(x, y); redraw(); return; }
  if (cellChanged || isMouseDown) {
    if (isMouseDown) redraw(); else redrawOverlay();
  }

  if (isMouseDown && !isPanning && _longPressPanTimer === null) moveAction(event);
});
overlay.addEventListener('mouseup', event => { if (isPanning) { handlePanEnd(); return; } stopAction(event); });
overlay.addEventListener('wheel', handleWheel, { passive: false });
overlay.addEventListener('mouseleave', () => { /* intentionally empty — keep cursor on board */ });

document.addEventListener('mousemove', event => { if (isPanning) handlePanMove(event); });
document.addEventListener('mouseup',   event => { if (isPanning) handlePanEnd(); });

// ── Touch state ────────────────────────────────────────────────────────
let lastTouchDistance = 0, isTouchDragging = false;
let lastTouchX = 0, lastTouchY = 0;
let isTouchPanning = false, _touchPinchRafId = null;
let touchStartX = 0, touchStartY = 0, touchTotalTravel = 0;
let touchStartedOnUI = false;

const _uiLayersInsideViewport = [
  document.getElementById('fullscreen-palette'),
  document.getElementById('fullscreen-btn'),
  // Chat+clan toggle tab sits at the bottom of the viewport on mobile;
  // touches on it must not trigger canvas pixel placement.
  document.getElementById('chatclan-toggle-btn'),
  document.getElementById('chatclan-panel'),
];

document.addEventListener('touchstart', (e) => {
  const target = e.target;
  const insideViewport = viewport.contains(target);
  const onUILayer = _uiLayersInsideViewport.some(el => el && el.contains(target));
  // Also catch any touch on fixed overlays/panels that may visually overlap the viewport
  const onFixedOverlay = !!target.closest(
    '#chatclan-panel, #chatclan-toggle-btn, .lb-panel, .lb-toggle, ' +
    '#lb-panel, .profile-modal-overlay, #chatclan-panel, ' +
    '.gm-observer-banner, .gm-hud, .gm-conversion-overlay, .gm-upgrade-strip'
  );
  touchStartedOnUI = !insideViewport || onUILayer || onFixedOverlay;
}, { passive: true, capture: true });

viewport.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    lastTouchX = touchStartX = e.touches[0].clientX;
    lastTouchY = touchStartY = e.touches[0].clientY;
    touchTotalTravel = 0;
    isTouchDragging = false;
  } else if (e.touches.length === 2) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDistance = Math.hypot(dx, dy);
  }
}, { passive: false });

viewport.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;
    touchTotalTravel += Math.hypot(dx, dy);
    const dragThreshold = tool === 'ruler' ? 20 : 3;
    if (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) {
      isTouchDragging = true; isTouchPanning = true;
    }
    offsetX = Math.round(offsetX + dx);
    offsetY = Math.round(offsetY + dy);
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    clampOffsets();
    if (tool === 'ruler' && rulerState === 'drawing') {
      const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
      rulerUpdateLiveEnd(coords.x, coords.y);
    }
    redraw();
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const distance = Math.hypot(dx, dy);
    if (lastTouchDistance) {
      const delta     = distance - lastTouchDistance;
      const centerCX  = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerCY  = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect      = viewport.getBoundingClientRect();
      const mouseX    = centerCX - rect.left;
      const mouseY    = centerCY - rect.top;
      const boardX    = (mouseX - offsetX) / scale;
      const boardY    = (mouseY - offsetY) / scale;
      scale           = clamp(scale * (1 + delta * 0.005), MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
      offsetX         = Math.round(mouseX - boardX * scale);
      offsetY         = Math.round(mouseY - boardY * scale);
      clampOffsets();
      zoomInput.value = Math.round(scale * 100);
      dispatchStateChange({ zoomLevel: Math.round(scale * 100) });
      if (_touchPinchRafId === null) {
        _touchPinchRafId = requestAnimationFrame(() => { _touchPinchRafId = null; redraw(); });
      }
    }
    lastTouchDistance = distance;
  }
}, { passive: false });

viewport.addEventListener('touchend', (e) => {
  isTouchPanning = false;
  if (e.touches.length === 0) lastTouchDistance = 0;

  const wasRulerTap =
    tool === 'ruler'
    && !touchStartedOnUI
    && e.changedTouches.length === 1
    && e.touches.length === 0
    && touchTotalTravel < 20;

  if ((!isTouchDragging || wasRulerTap) && !touchStartedOnUI && tool !== 'hand'
    && e.changedTouches.length === 1 && e.touches.length === 0) {
    if (_eyedropperJustFired) { _eyedropperJustFired = false; return; }
    const touch = e.changedTouches[0];
    const dpr     = window.devicePixelRatio || 1;
    const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;
    const isIOS   = /iP(hone|ad|od)/.test(navigator.userAgent) ||
                    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const rawRadiusY    = touch.radiusY || 0;
    const radiusCssPx   = isIOS ? rawRadiusY : rawRadiusY / dpr;
    const radiusLayoutPx = radiusCssPx / vvScale;
    const yCorrection   = Math.min(Math.max(radiusLayoutPx * 0.5, 4), 14);
    const adjustedClientY = touch.clientY - yCorrection;
    const coords = getCanvasCoords(touch.clientX, adjustedClientY);
    cursorPosition = { x: coords.x, y: coords.y };
    applyToolAtCell(coords.x, coords.y);
  }
});

// ── Zoom input ─────────────────────────────────────────────────────────
zoomInput.addEventListener('input', event => {
  const nextZoom = Number(event.target.value) / 100;
  const rect = viewport.getBoundingClientRect();
  const centerX = rect.width  / 2;
  const centerY = rect.height / 2;
  const boardCenterX = (centerX - offsetX) / scale;
  const boardCenterY = (centerY - offsetY) / scale;
  scale   = clamp(nextZoom, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
  offsetX = Math.round(centerX - boardCenterX * scale);
  offsetY = Math.round(centerY - boardCenterY * scale);
  clampOffsets();
  dispatchStateChange({ zoomLevel: Math.round(scale * 100) });
  const newCoords = getCanvasCoords(event.clientX, event.clientY);
  cursorPosition = { x: newCoords.x, y: newCoords.y };
  redraw();
});

// ── Grid toggle ────────────────────────────────────────────────────────
if (toggleGridBtn) {
  toggleGridBtn.addEventListener('click', () => toggleGrid());
  toggleGridBtn.classList.toggle('active', gridEnabled);
}

// ── Export ─────────────────────────────────────────────────────────────
if (exportButton) exportButton.addEventListener('click', exportPng);

// ── Tool buttons ───────────────────────────────────────────────────────
toolButtons.forEach(button => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────
const ARROW_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','PageUp','PageDown','Home','End']);

// Block arrow keys from browser-scrolling sidebars/modals
document.addEventListener('keydown', (e) => {
  if (!ARROW_KEYS.has(e.key)) return;
  if (e.target.closest('input, textarea, select')) return;
  e.preventDefault();
}, { capture: true, passive: false });

document.addEventListener('keydown', event => {
  const target = event.target;
  if (target.closest?.('input, textarea, select')) return;
  if (target.closest?.('button') && event.key === 'Enter') return;

  // Arrow + modifier = jump
  if ((event.shiftKey || event.ctrlKey || event.metaKey) && !event.altKey) {
    const jumpDist = (event.ctrlKey || event.metaKey) ? 10 : event.shiftKey ? 5 : 1;
    switch (event.key) {
      case 'ArrowUp':    moveCursorFromArrow(0, -jumpDist, event); return;
      case 'ArrowDown':  moveCursorFromArrow(0,  jumpDist, event); return;
      case 'ArrowLeft':  moveCursorFromArrow(-jumpDist, 0, event); return;
      case 'ArrowRight': moveCursorFromArrow( jumpDist, 0, event); return;
    }
  }

  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (hasModifier) return;

  switch (event.key) {
    case 'w': case 'W': moveColorFocus( 0, -1); break;
    case 's': case 'S': moveColorFocus( 0,  1); break;
    case 'a': case 'A': moveColorFocus(-1,  0); break;
    case 'd': case 'D': moveColorFocus( 1,  0); break;
    case 'q': case 'Q': window._scrollTopbarLeft?.();  break;
    case 'e': case 'E': window._scrollTopbarRight?.(); break;
    case '1': setTool('brush');       break;
    case '2': setTool('eraser');      break;
    case '3': setTool('eyedropper'); break;
    case '4': setTool('hand');        break;
    case '5': setTool('ruler');       break;
    case '6': setTool('none');        break;
    case 'g': case 'G': toggleGrid(); break;
    case 'Enter': if (!event.repeat) placeFromKeyboard(); break;
    case 'f': case 'F': document.getElementById('fullscreen-btn')?.click(); break;
    case 'ArrowUp':    moveCursorFromArrow(0, -1, event); break;
    case 'ArrowDown':  moveCursorFromArrow(0,  1, event); break;
    case 'ArrowLeft':  moveCursorFromArrow(-1, 0, event); break;
    case 'ArrowRight': moveCursorFromArrow( 1, 0, event); break;
    case 'Shift': canvas.classList.add('shift-pan'); break;
  }
});

window.addEventListener('keyup', event => {
  if (event.key === 'Shift') canvas.classList.remove('shift-pan');
});

// ── Cross-tab storage sync ─────────────────────────────────────────────
window.addEventListener('storage', event => {
  if (!event.key) return;
  if (event.key === EVENT_KEY) {
    const remoteEvent = safeParse(event.newValue, null);
    if (remoteEvent) {
      handleRemoteEvent(remoteEvent);
      if (remoteEvent.type === 'pixel') window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
    }
  }
  if (event.key === CUSTOM_PALETTE_KEY) {
    customPalette = getCustomPalette();
    renderPalette();
  }
});

// ── Fullscreen ──────────────────────────────────────────────────────────
const fullscreenBtn = document.getElementById('fullscreen-btn');
const fsIconEnter   = document.getElementById('fs-icon-enter');
const fsIconExit    = document.getElementById('fs-icon-exit');
if (fullscreenBtn) {
  const toggleFullscreen = (event) => {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    fullscreenBtn.blur();
    const fsTarget = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (fsTarget.requestFullscreen)        fsTarget.requestFullscreen().catch(err => console.error(err));
      else if (fsTarget.webkitRequestFullscreen) fsTarget.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen)          document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  };
  fullscreenBtn.addEventListener('click',    toggleFullscreen);
  fullscreenBtn.addEventListener('touchend', toggleFullscreen, { passive: false });

  const handleFullscreenChange = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (fsIconEnter) fsIconEnter.style.display = isFs ? 'none'  : 'block';
    if (fsIconExit)  fsIconExit.style.display  = isFs ? 'block' : 'none';
    if (typeof resizeViewport === 'function') setTimeout(resizeViewport, 150);
  };
  document.addEventListener('fullscreenchange',       handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}

// ── Wheel block for sidebars ────────────────────────────────────────────
document.addEventListener('wheel', (e) => {
  if (e.target.closest('#viewport')) return;
  const scrollable = e.target.closest(
    'aside, #chat-messages, #pm-modal, [class*="overflow-y-auto"], [class*="overflow-y-scroll"]'
  );
  if (scrollable) { e.preventDefault(); e.stopPropagation(); }
}, { passive: false });

// ── Topbar drag ──────────────────────────────────────────────────────────
(function () {
  const header = document.querySelector('header.flex');
  const handle = document.getElementById('topbar-drag-handle');
  if (!header || !handle) return;
  let dragging = false, startClientX = 0, startScrollLeft = 0;
  function onDown(e)  {
    dragging = true;
    startClientX   = e.touches ? e.touches[0].clientX : e.clientX;
    startScrollLeft = header.scrollLeft;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    header.scrollLeft = Math.max(0, startScrollLeft + (startClientX - clientX));
  }
  function onUp() { if (!dragging) return; dragging = false; document.body.style.userSelect = ''; }
  handle.addEventListener('mousedown',  onDown, { passive: false });
  handle.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup',  onUp);
  document.addEventListener('touchend', onUp);
  window.addEventListener('resize', () => { header.scrollLeft = 0; });
  const STEP = 120;
  window._scrollTopbarLeft  = () => { header.scrollLeft = Math.max(0, header.scrollLeft - STEP); };
  window._scrollTopbarRight = () => { header.scrollLeft += STEP; };
})();

// ── Spawn button (coordinate navigator) ────────────────────────────────
(function () {
  const SPAWN_COOLDOWN_MS = 7000;
  let lastSpawnAt = 0, spawnCooldownTimer = null;
  const spawnBtn = document.getElementById('spawn-btn');
  if (!spawnBtn) return;

  function updateSpawnBtn(remaining) {
    spawnBtn.disabled     = remaining > 0;
    spawnBtn.textContent  = remaining > 0 ? `Go (${Math.ceil(remaining / 1000)}s)` : 'Go';
  }

  spawnBtn.addEventListener('click', () => {
    const now = Date.now();
    if (SPAWN_COOLDOWN_MS - (now - lastSpawnAt) > 0) return;
    const spawnXInput    = document.getElementById('spawn-x');
    const spawnYInput    = document.getElementById('spawn-y');
    const spawnZoomInput = document.getElementById('spawn-zoom');
    const targetX = parseInt(spawnXInput.value, 10);
    const targetY = parseInt(spawnYInput.value, 10);
    let targetZoomPercent = parseInt(spawnZoomInput.value, 10);
    if (isNaN(targetX) || isNaN(targetY)) { alert('Please enter valid X and Y coordinates.'); return; }
    if (isNaN(targetZoomPercent) || targetZoomPercent <= 0) targetZoomPercent = 4500;
    scale = clamp(targetZoomPercent / 100, 0.05, MAX_ZOOM_SCALE);
    const rect = viewport.getBoundingClientRect();
    offsetX = rect.width  / 2 - targetX * scale;
    offsetY = rect.height / 2 - targetY * scale;
    zoomInput.value = Math.round(scale * 100);
    dispatchStateChange({ zoomLevel: Math.round(scale * 100) });
    clampOffsets();
    redraw();
    lastSpawnAt = Date.now();
    if (spawnCooldownTimer) clearInterval(spawnCooldownTimer);
    spawnCooldownTimer = setInterval(() => {
      const rem = SPAWN_COOLDOWN_MS - (Date.now() - lastSpawnAt);
      updateSpawnBtn(rem);
      if (rem <= 0) { clearInterval(spawnCooldownTimer); spawnCooldownTimer = null; }
    }, 200);
    updateSpawnBtn(SPAWN_COOLDOWN_MS);
  });
})();

// ── Mobile ruler stop button ───────────────────────────────────────────
(function () {
  const isMobilePortrait = () =>
    window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
  const stopBtn = document.createElement('button');
  stopBtn.id = 'ruler-stop-btn';
  stopBtn.type = 'button';
  stopBtn.textContent = '✕  Stop Ruler';
  document.body.appendChild(stopBtn);

  window._updateRulerStopBtn = function () {
    const active = tool === 'ruler' && rulerState === 'drawing' && isMobilePortrait();
    stopBtn.classList.toggle('ruler-stop-btn--visible', active);
    const bar = document.getElementById('cooldownBar');
    if (bar) bar.style.setProperty('opacity', active ? '0' : '', 'important');
  };

  stopBtn.addEventListener('click', () => {
    rulerState = 'idle'; rulerStart = null; rulerLiveEnd = null;
    setTool('brush'); redraw();
  });

  window.matchMedia('(max-width: 720px) and (orientation: portrait)')
    .addEventListener('change', () => window._updateRulerStopBtn());
})();

// ── Mobile LB toggle height ────────────────────────────────────────────
(function () {
  function updateLbToggleBottom() {
    const toolList = document.querySelector('.tool-list');
    if (!toolList) return;
    const rect = toolList.getBoundingClientRect();
    document.documentElement.style.setProperty(
      '--lb-tool-list-bottom', (window.innerHeight - rect.top) + 'px'
    );
  }
  updateLbToggleBottom();
  window.addEventListener('resize', updateLbToggleBottom);
  window.addEventListener('orientationchange', updateLbToggleBottom);
  requestAnimationFrame(() => { updateLbToggleBottom(); });
})();

// ── Help section toggle (desktop) ──────────────────────────────────────
(function initHelpToggle() {
  const btn     = document.getElementById('help-toggle-btn');
  const content = document.getElementById('help-section-content');
  if (!btn || !content) return;
  const isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (isDesktop) content.setAttribute('aria-hidden', 'true');
  btn.addEventListener('click', () => {
    const section = btn.closest('section');
    const isOpen  = section.classList.toggle('help-section-open');
    btn.textContent = isOpen ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', String(isOpen));
    content.setAttribute('aria-hidden', String(!isOpen));
  });
})();
