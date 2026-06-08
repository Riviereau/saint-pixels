/**
 * stars.js — Saint-Pixels Star Currency System
 *
 * Stars are a cosmetic currency that fall from the sky.
 * - Big star  (16×16 px art): gives 50 stars on click/tap
 * - Small star (8×8 px art):  gives 25 stars on click/tap
 *
 * FAIRNESS DESIGN:
 *   Spawn schedule (which minute, how many stars, big/small mix) is derived
 *   from a seeded PRNG keyed to the UTC day+hour+minute, so every client
 *   gets the exact same number of stars per session — leaderboard-fair.
 *
 *   Which visual *pattern* is drawn and where the star drifts is determined
 *   by a separate client-local random (Math.random), so it looks different
 *   for each player without affecting the economy.
 */

(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────
  const STORAGE_KEY   = 'sp_stars_v1';
  const BIG_PX        = 4;   // CSS pixels per art pixel for big star (16×16 art → 64×64 rendered)
  const SMALL_PX      = 3;   // CSS pixels per art pixel for small star (8×8 art → 24×24 rendered)
  const BIG_REWARD    = 50;
  const SMALL_REWARD  = 25;

  // How many stars spawn per minute slot (seeded, same for all clients)
  const STARS_PER_MINUTE_MIN = 2;
  const STARS_PER_MINUTE_MAX = 5;
  // Fraction of stars that are "big" (rest are small)
  const BIG_FRACTION = 0.45;

  // Fall duration range (ms)
  const FALL_MIN = 7000;
  const FALL_MAX = 14000;

  // Horizontal drift range (px, can be negative)
  const DRIFT_MIN = -60;
  const DRIFT_MAX = 60;

  // ─── 16×16 Big Star pixel art patterns (1 = filled, 0 = empty) ───────────
  // Each row is 16 bits; we store as arrays of 16 numbers (0/1).
  // Multiple designs; one is picked randomly per-spawn (client-side random).

  const BIG_STAR_PATTERNS = [
    // Classic 8-point star
    [
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,1,0,0,0,0,0,1,1,0,0,0,0,0,1,0],
      [0,0,1,0,0,0,0,1,1,0,0,0,0,1,0,0],
      [0,0,0,1,0,0,0,1,1,0,0,0,1,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,1,0,0,0,1,1,0,0,0,1,0,0,0],
      [0,0,1,0,0,0,0,1,1,0,0,0,0,1,0,0],
      [0,1,0,0,0,0,0,1,1,0,0,0,0,0,1,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
    ],
    // 5-point star (chunky pixel)
    [
      [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,1,1,0,0,1,1,1,0,0,1,1,0,0,0],
      [0,1,1,0,0,0,0,1,0,0,0,0,1,1,0,0],
      [1,1,0,0,0,0,0,0,0,0,0,0,0,1,1,0],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ],
    // Diamond star
    [
      [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ],
    // Cross/sparkle star
    [
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
    ],
  ];

  // ─── 8×8 Small Star pixel art patterns ────────────────────────────────────
  const SMALL_STAR_PATTERNS = [
    // Classic small star
    [
      [0,0,0,1,0,0,0,0],
      [0,0,1,1,1,0,0,0],
      [1,1,1,1,1,1,1,0],
      [0,1,1,1,1,1,0,0],
      [0,0,1,1,1,0,0,0],
      [0,1,0,1,0,1,0,0],
      [1,0,0,0,0,0,1,0],
      [0,0,0,0,0,0,0,0],
    ],
    // Diamond small
    [
      [0,0,0,1,0,0,0,0],
      [0,0,1,1,1,0,0,0],
      [0,1,1,1,1,1,0,0],
      [1,1,1,1,1,1,1,0],
      [0,1,1,1,1,1,0,0],
      [0,0,1,1,1,0,0,0],
      [0,0,0,1,0,0,0,0],
      [0,0,0,0,0,0,0,0],
    ],
    // Cross small
    [
      [0,0,0,1,1,0,0,0],
      [0,0,0,1,1,0,0,0],
      [0,1,1,1,1,1,1,0],
      [1,1,1,1,1,1,1,1],
      [0,1,1,1,1,1,1,0],
      [0,0,0,1,1,0,0,0],
      [0,0,0,1,1,0,0,0],
      [0,0,0,0,0,0,0,0],
    ],
    // Sparkle small
    [
      [0,0,0,1,0,0,0,0],
      [0,0,0,1,0,0,0,0],
      [0,0,1,1,1,0,0,0],
      [1,1,1,1,1,1,1,0],
      [0,0,1,1,1,0,0,0],
      [0,0,0,1,0,0,0,0],
      [0,0,0,1,0,0,0,0],
      [0,0,0,0,0,0,0,0],
    ],
  ];

  // ─── Star color palettes (gold/silver/rainbow sparkle variants) ───────────
  const BIG_PALETTES = [
    { fill: '#FFD700', shine: '#FFF8A0', outline: '#B8860B' }, // gold
    { fill: '#E8C840', shine: '#FFFACD', outline: '#C8A000' }, // warm gold
    { fill: '#FFC0CB', shine: '#FFE8EE', outline: '#C08090' }, // pink
    { fill: '#87CEEB', shine: '#E0F4FF', outline: '#4A90B8' }, // sky blue
  ];
  const SMALL_PALETTES = [
    { fill: '#C0C0C0', shine: '#F0F0F0', outline: '#808080' }, // silver
    { fill: '#FFD700', shine: '#FFF8A0', outline: '#B8860B' }, // gold
    { fill: '#DDA0DD', shine: '#F8E0F8', outline: '#9060A0' }, // plum
  ];

  // ─── Seeded PRNG (mulberry32) — determines spawn schedule ─────────────────
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Build a seed from the current UTC day (resets daily so star counts restart)
  function daySeed() {
    const now = new Date();
    return (now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate());
  }

  // Pre-generate the full day's spawn schedule:
  // Array of { minuteOffset, isBig } sorted by minuteOffset (0..1439)
  function buildDaySchedule() {
    const rng  = mulberry32(daySeed());
    const schedule = [];
    for (let m = 0; m < 1440; m++) {
      const count = STARS_PER_MINUTE_MIN + Math.floor(rng() * (STARS_PER_MINUTE_MAX - STARS_PER_MINUTE_MIN + 1));
      for (let i = 0; i < count; i++) {
        const offsetSec = rng() * 60; // spread within the minute
        schedule.push({
          spawnAt: m * 60 + offsetSec, // seconds since midnight UTC
          isBig: rng() < BIG_FRACTION,
        });
      }
    }
    return schedule;
  }

  // ─── Canvas-based pixel art renderer ─────────────────────────────────────
  function renderPixelArt(pattern, px, palette) {
    const rows = pattern.length;
    const cols = pattern[0].length;
    const canvas = document.createElement('canvas');
    canvas.width  = cols * px;
    canvas.height = rows * px;
    const ctx = canvas.getContext('2d');

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!pattern[r][c]) continue;
        // Shine on top-left quadrant, normal fill elsewhere
        const isShine = r < rows / 3 && c < cols / 3;
        ctx.fillStyle = isShine ? palette.shine : palette.fill;
        ctx.fillRect(c * px, r * px, px, px);
      }
    }
    // 1px outline pass (draw outline pixels)
    ctx.fillStyle = palette.outline;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!pattern[r][c]) continue;
        // Check neighbours — draw outline where neighbour is empty/out-of-bounds
        const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
        for (const [dr, dc] of dirs) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || !pattern[nr][nc]) {
            ctx.fillRect(
              (c + (dc === 1 ? 1 : 0)) * px - (dc === 1 ? 1 : 0),
              (r + (dr === 1 ? 1 : 0)) * px - (dr === 1 ? 1 : 0),
              dc !== 0 ? 1 : px,
              dr !== 0 ? 1 : px,
            );
          }
        }
      }
    }
    return canvas.toDataURL();
  }

  // Pre-render all patterns once on load (client-local random for visual only)
  function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ─── Star Balance (localStorage) ─────────────────────────────────────────
  function loadBalance() {
    try { return parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0; }
    catch { return 0; }
  }
  function saveBalance(n) {
    try { localStorage.setItem(STORAGE_KEY, String(n)); } catch {}
  }

  let balance = loadBalance();
  const balanceEl = document.getElementById('star-balance-val');
  function updateBalanceUI() {
    if (balanceEl) balanceEl.textContent = balance.toLocaleString();
  }
  updateBalanceUI();

  function awardStars(amount, x, y) {
    balance += amount;
    saveBalance(balance);
    updateBalanceUI();
    showFloatingText(`+${amount} ⭐`, x, y);
  }

  function showFloatingText(text, x, y) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position:   'fixed',
      left:       x + 'px',
      top:        y + 'px',
      color:      '#FFD700',
      fontWeight: '800',
      fontSize:   '1.1rem',
      textShadow: '0 2px 6px rgba(0,0,0,0.8)',
      pointerEvents: 'none',
      zIndex:     '99998',
      transform:  'translateX(-50%)',
      transition: 'transform 1.1s ease, opacity 1.1s ease',
      opacity:    '1',
      willChange: 'transform, opacity',
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = 'translateX(-50%) translateY(-60px)';
      el.style.opacity   = '0';
    });
    setTimeout(() => el.remove(), 1200);
  }

  // ─── Spawn a falling star ─────────────────────────────────────────────────
  function spawnStar(isBig) {
    const pattern  = isBig ? pickRandom(BIG_STAR_PATTERNS)   : pickRandom(SMALL_STAR_PATTERNS);
    const palette  = isBig ? pickRandom(BIG_PALETTES)        : pickRandom(SMALL_PALETTES);
    const px       = isBig ? BIG_PX : SMALL_PX;
    const reward   = isBig ? BIG_REWARD : SMALL_REWARD;
    const imgSrc   = renderPixelArt(pattern, px, palette);

    const img = document.createElement('img');
    img.src   = imgSrc;
    img.alt   = isBig ? 'Big Star (50 ⭐)' : 'Small Star (25 ⭐)';
    img.title = `Click for ${reward} ⭐!`;

    const size = pattern[0].length * px;

    // Random horizontal start position (avoid edges)
    const startX = size + Math.random() * (window.innerWidth - size * 2);
    const drift  = DRIFT_MIN + Math.random() * (DRIFT_MAX - DRIFT_MIN);
    const dur    = FALL_MIN  + Math.random() * (FALL_MAX  - FALL_MIN);

    // Slight rotation wobble
    const rot1 = -15 + Math.random() * 30;
    const rot2 = rot1 + (-10 + Math.random() * 20);

    Object.assign(img.style, {
      position:   'fixed',
      top:        `-${size}px`,
      left:       startX + 'px',
      width:      size + 'px',
      height:     size + 'px',
      imageRendering: 'pixelated',
      cursor:     'pointer',
      zIndex:     '99997',
      userSelect: 'none',
      filter:     'drop-shadow(0 0 6px rgba(255,215,0,0.7))',
      transition: `top ${dur}ms linear, left ${dur}ms ease-in-out, transform ${dur}ms ease-in-out, opacity 0.3s ease`,
      transform:  `rotate(${rot1}deg)`,
    });

    document.body.appendChild(img);

    // Trigger animation
    requestAnimationFrame(() => {
      img.style.top       = `${window.innerHeight + size}px`;
      img.style.left      = `${startX + drift}px`;
      img.style.transform = `rotate(${rot2}deg)`;
    });

    // Click / tap handler
    let collected = false;
    function collect(e) {
      if (collected) return;
      collected = true;
      e.stopPropagation();
      const rect = img.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top;
      // Burst animation
      img.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
      img.style.transform  = 'scale(2) rotate(30deg)';
      img.style.opacity    = '0';
      awardStars(reward, cx, cy);
      setTimeout(() => img.remove(), 280);
    }
    img.addEventListener('click',      collect, { once: true });
    img.addEventListener('touchstart', collect, { once: true, passive: true });

    // Auto-remove when it exits the screen
    setTimeout(() => { if (!collected) img.remove(); }, dur + 500);
  }

  // ─── Scheduler ────────────────────────────────────────────────────────────
  const schedule = buildDaySchedule();

  function secondsFromMidnightUTC() {
    const now = new Date();
    return now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  }

  function scheduleNext() {
    const nowSec = secondsFromMidnightUTC();
    // Find the next un-spawned event after now (or wrapping to tomorrow)
    const upcoming = schedule.filter(e => e.spawnAt > nowSec);
    if (!upcoming.length) {
      // Near midnight — wait until next day schedule reloads
      setTimeout(scheduleNext, 60_000);
      return;
    }
    const next = upcoming[0];
    const delay = (next.spawnAt - nowSec) * 1000;
    setTimeout(() => {
      spawnStar(next.isBig);
      scheduleNext();
    }, Math.max(0, delay));
  }

  // Kick off
  scheduleNext();

  // ─── Expose API for other scripts ─────────────────────────────────────────
  window.SP_Stars = {
    getBalance: () => balance,
    addBalance: (n) => { balance += n; saveBalance(balance); updateBalanceUI(); },
  };

})();
