// ═══════════════════════════════════════════════════════════════════
// stars.js — Saint-Pixels Falling Star System
//
// Stars are drawn as pixel-art canvas elements (no image files needed).
// Each star has a unique twinkle/rotation animation driven by rAF.
// SFX: 'failling-star' plays when a star spawns; 'star-picked' plays
//      when the player collects it.
//
// Depends on: window.SFX (sfx.js), #viewport, #star-balance-val
// Public API: window.StarSystem.getBalance(), .addBalance(n)
// ═══════════════════════════════════════════════════════════════════

'use strict';

window.StarSystem = (() => {

  // ── Constants ───────────────────────────────────────────────────────────
  const STORAGE_KEY   = 'sp_star_balance';
  const STAR_VALUE    = 50;          // stars awarded per collect
  const STAR_SIZE_PX  = 20;          // canvas element size (logical px, 1:1 with pixel art)
  const MIN_DELAY_MS  = 18_000;      // minimum ms between spawns
  const MAX_DELAY_MS  = 45_000;      // maximum ms between spawns
  const FALL_DURATION = 9_000;       // ms for a star to fall off screen
  const MAX_ON_SCREEN = 3;           // never more than this many visible at once

  // ── Pixel-art star shape ────────────────────────────────────────────────
  // 9×9 grid, 1 = core, 2 = bright tip, 3 = glow fringe, 0 = transparent
  // Designed to read as a classic 4-point star at small sizes.
  //
  //   . . . . 2 . . . .
  //   . . . . 1 . . . .
  //   . . 3 . 1 . 3 . .
  //   . . . . 1 . . . .
  //   2 1 1 1 1 1 1 1 2
  //   . . . . 1 . . . .
  //   . . 3 . 1 . 3 . .
  //   . . . . 1 . . . .
  //   . . . . 2 . . . .
  //
  const STAR_GRID = 9;
  const STAR_PIXELS = [
    // [col, row, type]  — type: 1=core, 2=tip, 3=fringe
    [4, 0, 2], [4, 1, 1],
    [2, 2, 3], [4, 2, 1], [6, 2, 3],
    [4, 3, 1],
    [0, 4, 2], [1, 4, 1], [2, 4, 1], [3, 4, 1], [4, 4, 1], [5, 4, 1], [6, 4, 1], [7, 4, 1], [8, 4, 2],
    [4, 5, 1],
    [2, 6, 3], [4, 6, 1], [6, 6, 3],
    [4, 7, 1], [4, 8, 2],
  ];

  // Colour palette — warm gold / pixel-bright
  const COLOURS = {
    tip:    '#FFFFFF',   // bright white tips
    core:   '#FFE566',   // warm gold body
    fringe: '#FFAA00',   // amber fringe
    glow:   'rgba(255, 215, 0, 0.18)',
  };

  // ── State ───────────────────────────────────────────────────────────────
  let _balance  = 0;
  let _active   = [];   // array of live star objects
  let _spawnTid = null;

  // ── Balance helpers ──────────────────────────────────────────────────────
  function _loadBalance() {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEY) ?? '0', 10);
      _balance = isNaN(v) ? 0 : Math.max(0, v);
    } catch { _balance = 0; }
  }

  function _saveBalance() {
    try { localStorage.setItem(STORAGE_KEY, String(_balance)); } catch {}
  }

  function _updateUI() {
    const el = document.getElementById('star-balance-val');
    if (el) el.textContent = String(_balance);
    // Pop animation on the chip
    const chip = document.getElementById('star-balance-chip');
    if (chip) {
      chip.classList.remove('sp-pop');
      // Force reflow so the animation re-fires even on rapid updates
      void chip.offsetWidth;
      chip.classList.add('sp-pop');
    }
  }

  function getBalance() { return _balance; }

  function addBalance(n) {
    _balance += n;
    _saveBalance();
    _updateUI();
  }

  // ── Draw a pixel-art star onto a canvas ──────────────────────────────────
  // `phase` (0–1) drives the twinkle: tips brighten/dim, fringe pulses.
  function _drawStar(ctx, size, phase) {
    const cell = size / STAR_GRID;   // px per pixel-art cell
    ctx.clearRect(0, 0, size, size);

    // Glow halo — soft circle behind the star
    const glowAlpha = 0.12 + 0.10 * Math.sin(phase * Math.PI * 2);
    ctx.save();
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(255, 215, 0, ${glowAlpha + 0.15})`);
    grad.addColorStop(1, 'rgba(255, 215, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    // Tip brightness pulses with phase
    const tipAlpha = 0.75 + 0.25 * Math.sin(phase * Math.PI * 2);

    for (const [col, row, type] of STAR_PIXELS) {
      const x = col * cell;
      const y = row * cell;
      if (type === 2) {
        // Tip — white, alpha-pulsed
        ctx.fillStyle = `rgba(255, 255, 255, ${tipAlpha.toFixed(2)})`;
      } else if (type === 1) {
        ctx.fillStyle = COLOURS.core;
      } else {
        // Fringe — amber, slightly dimmed
        const fringeAlpha = 0.55 + 0.25 * Math.sin(phase * Math.PI * 2 + Math.PI);
        ctx.fillStyle = `rgba(255, 170, 0, ${fringeAlpha.toFixed(2)})`;
      }
      ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(cell), Math.ceil(cell));
    }
  }

  // ── Create one live star ─────────────────────────────────────────────────
  function _spawnStar() {
    const viewport = document.getElementById('viewport');
    if (!viewport) return;
    if (_active.length >= MAX_ON_SCREEN) return;

    const vpW  = viewport.clientWidth;
    const vpH  = viewport.clientHeight;
    const size = STAR_SIZE_PX * (window.devicePixelRatio >= 2 ? 2 : 1);

    // Canvas element
    const canvas  = document.createElement('canvas');
    canvas.className = 'sp-star-canvas';
    canvas.width  = size;
    canvas.height = size;
    canvas.style.cssText = `
      width: ${STAR_SIZE_PX}px;
      height: ${STAR_SIZE_PX}px;
      position: absolute;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      cursor: pointer;
      z-index: 395;
      user-select: none;
      pointer-events: auto;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      will-change: top, opacity;
    `;

    // Random horizontal position, start just above viewport
    const startX = Math.floor(Math.random() * (vpW - STAR_SIZE_PX - 20)) + 10;
    const startY = -STAR_SIZE_PX - 4;
    canvas.style.left = startX + 'px';
    canvas.style.top  = startY + 'px';

    // Slight random sway
    const swayAmp    = 18 + Math.random() * 22;   // px horizontal sway amplitude
    const swayFreq   = 0.4 + Math.random() * 0.6; // Hz
    const swayOffset = Math.random() * Math.PI * 2;

    const ctx  = canvas.getContext('2d');
    const star = {
      canvas,
      ctx,
      size,
      startX,
      spawnAt: performance.now(),
      phase: Math.random(),        // start twinkle at random phase
      phaseSpeed: 0.6 + Math.random() * 0.8,  // twinkle cycles per second
      swayAmp, swayFreq, swayOffset,
      collected: false,
      rafId: null,
    };
    _active.push(star);
    viewport.appendChild(canvas);

    // ── rAF animation loop ──────────────────────────────────────────────
    function tick(now) {
      if (star.collected) return;

      const elapsed = now - star.spawnAt;
      const t       = Math.min(elapsed / FALL_DURATION, 1); // 0→1 over fall duration

      // Vertical: ease-in fall
      const fallY = t * t * (vpH + STAR_SIZE_PX * 2);
      // Horizontal sway
      const swayX = Math.sin(now * 0.001 * star.swayFreq * Math.PI * 2 + star.swayOffset) * star.swayAmp;

      canvas.style.top  = (startY + fallY) + 'px';
      canvas.style.left = (startX + swayX) + 'px';

      // Fade out in the last 15% of fall
      if (t > 0.85) {
        canvas.style.opacity = String(1 - (t - 0.85) / 0.15);
      }

      // Twinkle phase
      star.phase = (star.phase + star.phaseSpeed / 60) % 1;
      _drawStar(ctx, size, star.phase);

      if (t >= 1) {
        // Fell off screen without being collected — remove
        _removeStar(star);
        return;
      }
      star.rafId = requestAnimationFrame(tick);
    }
    star.rafId = requestAnimationFrame(tick);

    // ── Collect on click / touch ──────────────────────────────────────
    function collect(e) {
      e.stopPropagation();
      if (star.collected) return;
      star.collected = true;

      // Stop intercepting pointer events immediately so the underlying
      // #overlay receives the mouseup/touchend that startAction() in
      // input.js is waiting for. Without this, mousedown fires on #overlay
      // (arming the long-press-pan timer / isMouseDown) but the matching
      // mouseup gets swallowed by this star canvas during its 280ms removal
      // delay, leaving the canvas stuck in pan mode until the next click.
      canvas.style.pointerEvents = 'none';

      // SFX
      if (window.SFX) window.SFX.play('star-picked', 0, 0.75);

      // Award balance
      addBalance(STAR_VALUE);

      // Burst animation: scale up + fade
      canvas.style.transition = 'transform 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.22s ease';
      canvas.style.transform  = 'scale(2.4) rotate(20deg)';
      canvas.style.opacity    = '0';

      // Floating reward text
      _showReward(canvas, STAR_VALUE);

      cancelAnimationFrame(star.rafId);
      setTimeout(() => _removeStar(star), 280);
    }
    canvas.addEventListener('click',      collect, { once: true });
    canvas.addEventListener('touchstart', collect, { once: true, passive: false });
  }

  // ── Remove a star cleanly ────────────────────────────────────────────────
  function _removeStar(star) {
    cancelAnimationFrame(star.rafId);
    star.canvas.remove();
    _active = _active.filter(s => s !== star);
  }

  // ── Floating "+50 ⭐" reward text ────────────────────────────────────────
  function _showReward(canvas, amount) {
    const viewport = document.getElementById('viewport');
    if (!viewport) return;

    const rect  = canvas.getBoundingClientRect();
    const vpRect = viewport.getBoundingClientRect();
    const x = rect.left - vpRect.left + rect.width  / 2;
    const y = rect.top  - vpRect.top  + rect.height / 2;

    const el = document.createElement('div');
    el.className   = 'sp-star-reward';
    el.textContent = `+${amount} ⭐`;
    el.style.left  = x + 'px';
    el.style.top   = y + 'px';
    viewport.appendChild(el);

    // Trigger fly-up transition on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add('sp-star-reward--fly');
      });
    });

    setTimeout(() => el.remove(), 1200);
  }

  // ── Spawn scheduler ─────────────────────────────────────────────────────
  function _scheduleNext() {
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    _spawnTid = setTimeout(() => {
      _spawnStar();
      _scheduleNext();
    }, delay);
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    _loadBalance();
    _updateUI();

    // Wait until viewport exists (may be rendered before DOMContentLoaded)
    const viewport = document.getElementById('viewport');
    if (!viewport) {
      // Retry once DOM is ready
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }

    // Spawn first star after a short random delay so it doesn't appear
    // immediately on page load when the user is still orienting.
    const firstDelay = 8_000 + Math.random() * 12_000;
    _spawnTid = setTimeout(() => {
      _spawnStar();
      _scheduleNext();
    }, firstDelay);

    // Pause spawning when tab is hidden, resume when visible
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(_spawnTid);
        _spawnTid = null;
        // Remove any stars currently falling — tab was backgrounded
        [..._active].forEach(_removeStar);
      } else {
        if (!_spawnTid) _scheduleNext();
      }
    });
  }

  // Kick off once the page is interactive
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  return { getBalance, addBalance };

})();
