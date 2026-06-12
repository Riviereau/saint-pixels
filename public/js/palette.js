// ═══════════════════════════════════════════════════════════════════
// palette.js — Color palette, variation picker, color helpers
// Manages paletteColors[], renders swatches, handles double-tap picker.
// Depends on: color, paletteColors (state.js)
//             setTool, tool (input.js)
//             redraw (canvas.js)
//             SFX (sfx.js)
//             cancelLongPressPan, _eyedropperJustFired (input.js)
// ═══════════════════════════════════════════════════════════════════

// ── Color storage ────────────────────────────────────────────────────
const CUSTOM_PALETTE_KEY    = 'sp_customPalette';
const SELECTED_COLOR_COOKIE = 'sp_selected_color';

const DEFAULT_PALETTE = [
  { id: 0,  label: 'Black',        color: '#000000' },
  { id: 1,  label: 'White',        color: '#ffffff' },
  { id: 2,  label: 'Red',          color: '#ef4444' },
  { id: 3,  label: 'Orange',       color: '#fb923c' },
  { id: 4,  label: 'Yellow',       color: '#facc15' },
  { id: 5,  label: 'Green',        color: '#22c55e' },
  { id: 6,  label: 'Cyan',         color: '#06b6d4' },
  { id: 7,  label: 'Blue',         color: '#3b82f6' },
  { id: 8,  label: 'Indigo',       color: '#6366f1' },
  { id: 9,  label: 'Violet',       color: '#8b5cf6' },
  { id: 10, label: 'Pink',         color: '#ec4899' },
  { id: 11, label: 'Light Brown',  color: '#a0785a' },
  { id: 12, label: 'Beige',        color: '#f5deb3' },
  { id: 13, label: 'Gray',         color: '#888888' },
  { id: 14, label: 'Dark Amber',   color: '#925c01' },
  { id: 15, label: 'Dark Sienna',  color: '#6d2300' },
  { id: 16, label: 'Sandy Orange', color: '#df8f5c' },
  { id: 17, label: 'Burnt Sienna', color: '#d38252' }
];

const paletteColors = [];
let customPalette = [];
/** Index of the palette slot most recently activated — eyedropper prefers it on ties. */
let lastUsedPaletteIdx = -1;

// ── Cookie helpers ────────────────────────────────────────────────────
function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Strict`;
}
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function saveSelectedColor(hex) { try { setCookie(SELECTED_COLOR_COOKIE, hex, 365); } catch { /* ignore */ } }
function loadSelectedColor()    { try { return getCookie(SELECTED_COLOR_COOKIE) || null; } catch { return null; } }

// ── Palette storage ───────────────────────────────────────────────────
function getCustomPalette() {
  const raw = safeParse(localStorage.getItem(CUSTOM_PALETTE_KEY), []);
  if (!Array.isArray(raw)) return [];
  return raw.map(entry =>
    normalizeHexColor(typeof entry === 'string' ? entry : String(entry?.color ?? ''))
  );
}
function saveCustomPalette(list) {
  localStorage.setItem(CUSTOM_PALETTE_KEY, JSON.stringify(list));
}

// ── Color utilities ───────────────────────────────────────────────────
// normalizeHexColor, hexToRgba, rgbToHex, hexToHsl, hslToHex,
// brightnessRgb, and colorsMatch are all declared globally in canvas.js.
// Do NOT redeclare them here — duplicate declarations in the same global
// scope are a crash risk in strict mode and a maintenance hazard.

function asPaletteEntry(entry) {
  if (typeof entry === 'string') {
    return { id: null, label: normalizeHexColor(entry), color: normalizeHexColor(entry) };
  }
  return {
    id:    entry.id != null ? entry.id : null,
    label: entry.label || normalizeHexColor(entry.color),
    color: normalizeHexColor(entry.color)
  };
}

// ── Server palette load ───────────────────────────────────────────────
async function loadServerPalette() {
  try {
    const response = await fetch('/api/palette');
    if (!response.ok) throw new Error('Palette API failed');
    const data = await response.json();
    if (Array.isArray(data.colors)) {
      paletteColors.length = 0;
      data.colors.forEach(item => paletteColors.push(asPaletteEntry(item)));
      ensureRainbowInPalette(paletteColors);
      _restoreColorFromCookie();
      return;
    }
  } catch (error) {
    console.warn('Unable to load palette from API, using defaults.', error);
  }
  paletteColors.length = 0;
  DEFAULT_PALETTE.forEach(item => paletteColors.push(asPaletteEntry(item)));
  ensureRainbowInPalette(paletteColors);
  _restoreColorFromCookie();
}

function ensureRainbowInPalette(list) {
  if (!Array.isArray(list)) return;
  const present = new Set(list.map(e => normalizeHexColor(e.color)));
  DEFAULT_PALETTE.forEach(entry => {
    const norm = normalizeHexColor(entry.color);
    if (!present.has(norm)) { list.push(asPaletteEntry(entry)); present.add(norm); }
  });
}

function _restoreColorFromCookie() {
  const saved = loadSelectedColor();
  if (!saved) return;
  const norm = normalizeHexColor(saved);
  if (norm === '#000000' && saved !== '#000000' && saved !== '000000') return;
  setColor(norm);
}

// ── Color application ─────────────────────────────────────────────────
function setColor(newColor, preferredBtn) {
  const norm = normalizeHexColor(newColor);
  color = norm;
  const colorInput = document.getElementById('color');
  if (colorInput) colorInput.value = norm;
  dispatchStateChange({ currentColor: norm });
  saveSelectedColor(norm);

  const activatedIdx = paletteColors.findIndex(e => normalizeHexColor(e.color) === norm);
  if (activatedIdx !== -1) lastUsedPaletteIdx = activatedIdx;

  const allBtns = document.querySelectorAll('#palette button, #fullscreen-palette button');
  if (preferredBtn) {
    allBtns.forEach(b => b.classList.remove('selected'));
    preferredBtn.classList.add('selected');
  } else {
    let marked = false;
    allBtns.forEach(b => {
      const matches = !marked && normalizeHexColor(b.dataset.color) === norm;
      b.classList.toggle('selected', matches);
      if (matches) marked = true;
    });
  }

  redraw();
}

function addColorToPalette() {
  const colorInput = document.getElementById('color');
  const newColor = normalizeHexColor(colorInput ? colorInput.value : '#000000');
  const already = paletteColors.some(e => normalizeHexColor(e.color) === newColor);
  if (!already) paletteColors.push(asPaletteEntry({ id: null, label: newColor, color: newColor }));
  renderPalette();
  setColor(newColor);
}

function moveColorFocus(dx, dy) {
  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const cols = 6;
  const currentIndex = sourcePalette.findIndex(p => normalizeHexColor(p.color) === normalizeHexColor(color));
  if (currentIndex === -1) return;
  const row = Math.floor(currentIndex / cols);
  const col = currentIndex % cols;
  const newRow = row + dy;
  const newCol = col + dx;
  if (newCol < 0 || newCol >= cols || newRow < 0) return;
  const newIndex = newRow * cols + newCol;
  if (newIndex >= 0 && newIndex < sourcePalette.length) setColor(sourcePalette[newIndex].color);
}

// ── Variation picker ──────────────────────────────────────────────────
function removeVariationPicker() {
  const existing = document.querySelector('.variation-picker');
  if (existing) existing.remove();
}

function showVariationPicker(button, baseColor) {
  removeVariationPicker();
  const [h, s, l] = hexToHsl(baseColor);
  const variants = [
    hslToHex(h, s, Math.max(0,   l - 25)),
    hslToHex(h, s, Math.max(0,   l - 12)),
    baseColor,
    hslToHex(h, s, Math.min(100, l + 12)),
    hslToHex(h, s, Math.min(100, l + 25)),
  ];

  const currentButtonColor = normalizeHexColor(button.dataset.color || baseColor);
  let activeIdx = 2;
  let bestDist = Infinity;
  variants.forEach((hex, i) => {
    const norm = normalizeHexColor(hex);
    if (norm === currentButtonColor) { activeIdx = i; bestDist = 0; return; }
    if (bestDist > 0) {
      const [,, li] = hexToHsl(hex);
      const [,, lc] = hexToHsl(currentButtonColor);
      const d = Math.abs(li - lc);
      if (d < bestDist) { bestDist = d; activeIdx = i; }
    }
  });

  const picker = document.createElement('div');
  picker.className = 'variation-picker';
  picker.style.cssText = [
    'position:fixed', 'z-index:99999',
    'display:flex', 'gap:6px', 'padding:8px',
    'background:rgba(47,47,48,0.98)',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:12px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
    'touch-action:none',
  ].join(';');

  function cleanupOutside() {
    document.removeEventListener('touchstart', onOutside, true);
    document.removeEventListener('mousedown',  onOutside, true);
  }

  variants.forEach(function(hex, i) {
    const swatch = document.createElement('button');
    swatch.className = 'variation-swatch';
    const isActive = i === activeIdx;
    const sz = isActive ? '36px' : '28px';
    const bd = isActive ? '2px solid rgba(255,255,255,0.5)' : '1px solid rgba(255,255,255,0.2)';
    swatch.style.cssText = `width:${sz};height:${sz};border-radius:6px;background:${hex};border:${bd};cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;`;
    swatch.title = hex.toUpperCase();

    function applyHex(e) {
      e.preventDefault(); e.stopPropagation();
      const normHex = normalizeHexColor(hex);
      if (button) {
        button.style.background = normHex;
        button.dataset.color = normHex;
        button.title = normHex.toUpperCase();
      }
      setColor(normHex);
      removeVariationPicker();
      cleanupOutside();
    }
    swatch.addEventListener('click', applyHex);
    swatch.addEventListener('touchend', applyHex, { passive: false });
    picker.appendChild(swatch);
  });

  document.body.appendChild(picker);

  const rect = button.getBoundingClientRect();
  const pw = picker.offsetWidth || 220;
  const ph = picker.offsetHeight || 52;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  const spaceBelow = window.innerHeight - rect.bottom - 10;
  const top = spaceBelow >= ph ? rect.bottom + 6 : rect.top - ph - 6;
  picker.style.left = left + 'px';
  picker.style.top  = Math.max(8, top) + 'px';

  let dismissReady = false;
  setTimeout(function() { dismissReady = true; }, 200);

  function onOutside(e) {
    if (!dismissReady) return;
    if (picker.contains(e.target)) return;
    removeVariationPicker();
    cleanupOutside();
  }
  document.addEventListener('touchstart', onOutside, { capture: true, passive: true });
  document.addEventListener('mousedown',  onOutside, { capture: true });
}

// ── Palette button factory ────────────────────────────────────────────
function createPaletteButton(entry) {
  const button = document.createElement('button');
  button.style.background  = entry.color;
  button.dataset.color     = entry.color;
  button.dataset.baseColor = entry.color;
  button.title = `${entry.label} (${entry.color.toUpperCase()})`;
  if (entry.color.toLowerCase() === (color || '').toLowerCase()) button.classList.add('selected');

  let _tapTimer = null, _tapCount = 0, _suppressNextClick = false;

  button.addEventListener('click', () => {
    if (_suppressNextClick) { _suppressNextClick = false; return; }
    setColor(normalizeHexColor(button.dataset.color));
  });

  button.addEventListener('dblclick', (e) => {
    e.preventDefault();
    showVariationPicker(button, button.dataset.baseColor);
  });

  button.addEventListener('touchend', (e) => {
    _tapCount++;
    if (_tapCount === 1) {
      _tapTimer = setTimeout(() => { _tapCount = 0; }, 350);
    } else if (_tapCount >= 2) {
      clearTimeout(_tapTimer);
      _tapCount = 0;
      e.preventDefault(); e.stopPropagation();
      _suppressNextClick = true;
      setTimeout(() => { _suppressNextClick = false; }, 600);
      showVariationPicker(button, button.dataset.baseColor);
    }
  }, { passive: false });

  let _longPressTimer = null;
  button.addEventListener('touchstart', () => {
    _longPressTimer = setTimeout(() => { _longPressTimer = null; }, 500);
  }, { passive: true });
  button.addEventListener('touchend',  () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });
  button.addEventListener('touchmove', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });

  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.pointerType === 'touch' || window.matchMedia('(pointer: coarse)').matches) return;
    const idx = paletteColors.findIndex(p => normalizeHexColor(p.color) === normalizeHexColor(entry.color));
    if (idx !== -1) { paletteColors.splice(idx, 1); renderPalette(); }
  });

  return button;
}

// ── Palette render ────────────────────────────────────────────────────
function renderPalette() {
  const paletteEl   = document.getElementById('palette');
  const fsPaletteEl = document.getElementById('fullscreen-palette');
  if (paletteEl)   paletteEl.innerHTML = '';
  if (fsPaletteEl) fsPaletteEl.innerHTML = '';

  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const colors = sourcePalette.map(asPaletteEntry);

  colors.forEach(entry => {
    if (paletteEl)   paletteEl.appendChild(createPaletteButton(entry));
    if (fsPaletteEl) fsPaletteEl.appendChild(createPaletteButton(entry));
  });

  if (fsPaletteEl) {
    const hint = document.createElement('span');
    hint.className = 'mob-variation-hint';
    hint.textContent = 'Double-tap a color for lighter / darker variations';
    fsPaletteEl.appendChild(hint);
  }
}

async function initPalette() {
  customPalette = getCustomPalette();
  await loadServerPalette();
  renderPalette();
}

// ── DOM event wiring ──────────────────────────────────────────────────
const colorInput    = document.getElementById('color');
const addColorButton = document.getElementById('add-color');
if (colorInput)     colorInput.addEventListener('input', event => setColor(event.target.value));
if (addColorButton) addColorButton.addEventListener('click', addColorToPalette);
