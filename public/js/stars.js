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

  // ─── 16×16 Big Star pixel art patterns ───────────────────────────────────
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

  // ─── Star color palettes ──────────────────────────────────────────────────
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

  // ─── Seeded PRNG (mulberry32) ─────────────────────────────────────────────
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function daySeed() {
    const now = new Date();
    return (now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate());
  }

  function buildDaySchedule() {
    const rng  = mulberry32(daySeed());
    const schedule = [];
    for (let m = 0; m < 1440; m++) {
      const count = STARS_PER_MINUTE_MIN + Math.floor(rng() * (STARS_PER_MINUTE_MAX - STARS_PER_MINUTE_MIN + 1));
      for (let i = 0; i < count; i++) {
        const offsetSec = rng() * 60;
        schedule.push({
          spawnAt: m * 60 + offsetSec,
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
        const isShine = r < rows / 3 && c < cols / 3;
        ctx.fillStyle = isShine ? palette.shine : palette.fill;
        ctx.fillRect(c * px, r * px, px, px);
      }
    }
    ctx.fillStyle = palette.outline;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!pattern[r][c]) continue;
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

  function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ─── Viewport container ───────────────────────────────────────────────────
  // Stars are appended to #viewport so they are contained within the canvas
  // area and don't cover the header/sidebar UI.
  function getViewport() {
    return document.getElementById('viewport') || document.body;
  }

  // ─── Star Balance (localStorage) ─────────────────────────────────────────
  function loadBalance() {
    try { return parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0; }
    catch { return 0; }
  }
  function saveBalance(n) {
    try { localStorage.setItem(STORAGE_KEY, String(n)); } catch {}
  }

  let balance = loadBalance();
  const balanceEl  = document.getElementById('star-balance-val');
  const balanceChip = document.getElementById('star-balance-chip');

  function updateBalanceUI() {
    if (balanceEl) balanceEl.textContent = balance.toLocaleString();
    // Trigger pop animation on the chip
    if (balanceChip) {
      balanceChip.classList.remove('sp-pop');
      // Force reflow so the animation re-triggers if it was already running
      void balanceChip.offsetWidth;
      balanceChip.classList.add('sp-pop');
    }
  }
  updateBalanceUI();

  function awardStars(amount, viewportX, viewportY) {
    balance += amount;
    saveBalance(balance);
    updateBalanceUI();
    showFloatingText(`+${amount} ⭐`, viewportX, viewportY);
  }

  // ─── Floating reward text (viewport-relative) ─────────────────────────────
  // viewportX / viewportY are already relative to #viewport's top-left corner.
  function showFloatingText(text, viewportX, viewportY) {
    const vp = getViewport();
    const el = document.createElement('div');
    el.className = 'sp-star-reward';
    el.textContent = text;
    el.style.left = viewportX + 'px';
    el.style.top  = viewportY + 'px';
    vp.appendChild(el);

    // Double rAF: first frame lets the browser lay out the element at the
    // start position; second frame applies the end-state class so the CSS
    // transition actually fires (single rAF isn't enough in all browsers).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add('sp-star-reward--fly');
      });
    });

    setTimeout(() => el.remove(), 1300);
  }

  // ─── Spawn a falling star ─────────────────────────────────────────────────
  function spawnStar(isBig) {
    const vp = getViewport();
    const vpW = vp.offsetWidth;
    const vpH = vp.offsetHeight;

    const pattern = isBig ? pickRandom(BIG_STAR_PATTERNS)  : pickRandom(SMALL_STAR_PATTERNS);
    const palette = isBig ? pickRandom(BIG_PALETTES)       : pickRandom(SMALL_PALETTES);
    const px      = isBig ? BIG_PX : SMALL_PX;
    const reward  = isBig ? BIG_REWARD : SMALL_REWARD;
    const imgSrc  = renderPixelArt(pattern, px, palette);

    const size  = pattern[0].length * px;
    const startX = size + Math.random() * Math.max(0, vpW - size * 2);
    const drift  = DRIFT_MIN + Math.random() * (DRIFT_MAX - DRIFT_MIN);
    const dur    = FALL_MIN  + Math.random() * (FALL_MAX  - FALL_MIN);
    const rot1   = -15 + Math.random() * 30;
    const rot2   = rot1 + (-10 + Math.random() * 20);

    const img = document.createElement('img');
    img.src      = imgSrc;
    img.alt      = isBig ? 'Big Star (50 ⭐)' : 'Small Star (25 ⭐)';
    img.title    = `Click for ${reward} ⭐!`;
    img.className = 'sp-star';

    Object.assign(img.style, {
      top:        `-${size}px`,
      left:       `${startX}px`,
      width:      `${size}px`,
      height:     `${size}px`,
      transform:  `rotate(${rot1}deg)`,
      touchAction: 'manipulation',
      transition: `top ${dur}ms linear, left ${dur}ms ease-in-out, transform ${dur}ms ease-in-out, opacity 0.3s ease`,
    });

    vp.appendChild(img);

    // Trigger fall animation (single rAF is fine here — transition starts
    // from the appended style, which the browser has already parsed)
    requestAnimationFrame(() => {
      img.style.top       = `${vpH + size}px`;
      img.style.left      = `${startX + drift}px`;
      img.style.transform = `rotate(${rot2}deg)`;
    });

    // Collect handler
    let collected = false;
    function collect(e) {
      if (collected) return;
      collected = true;
      e.stopPropagation();

      // Convert the star's current bounding rect to viewport-local coords
      const vpRect  = vp.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      const cx = imgRect.left + imgRect.width  / 2 - vpRect.left;
      const cy = imgRect.top                       - vpRect.top;

      img.classList.add('sp-star--collected');
      awardStars(reward, cx, cy);
      setTimeout(() => img.remove(), 280);
    }
    img.addEventListener('click',      collect, { once: true });
    img.addEventListener('touchstart', function(e) {
      // Prevent the parent canvas touch-action:none from swallowing this tap
      e.stopPropagation();
      collect(e);
    }, { once: true, passive: true });

    // Auto-remove once it exits the viewport
    setTimeout(() => { if (!collected) img.remove(); }, dur + 500);
  }

  // ─── Scheduler ────────────────────────────────────────────────────────────
  const schedule = buildDaySchedule();

  function secondsFromMidnightUTC() {
    const now = new Date();
    return now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  }

  function scheduleNext() {
    const nowSec   = secondsFromMidnightUTC();
    const upcoming = schedule.filter(e => e.spawnAt > nowSec);
    if (!upcoming.length) {
      setTimeout(scheduleNext, 60_000);
      return;
    }
    const next  = upcoming[0];
    const delay = (next.spawnAt - nowSec) * 1000;
    setTimeout(() => {
      spawnStar(next.isBig);
      scheduleNext();
    }, Math.max(0, delay));
  }

  scheduleNext();

  // ─── Public API ───────────────────────────────────────────────────────────
  window.SP_Stars = {
    getBalance: () => balance,
    addBalance: (n) => { balance += n; saveBalance(balance); updateBalanceUI(); },
  };

})();
