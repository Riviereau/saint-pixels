// ═══════════════════════════════════════════════════════════════════
// achievements.js — Achievement engine + attack detection
// Client-side unlock checks; server DB is the authoritative record.
// Depends on: SFX (sfx.js), currentUser (auth.js)
// ═══════════════════════════════════════════════════════════════════

const ACHIEVEMENT_DEFS = [
  { id: 'first_pixel',   label: 'First Pixel!',       desc: 'Place your very first pixel.',         icon: '🎨', ultra: false },
  { id: 'pixels_10',     label: 'Getting Started',    desc: 'Place 10 pixels.',                     icon: '✏️',  ultra: false },
  { id: 'pixels_100',    label: 'Dedicated Artist',   desc: 'Place 100 pixels.',                    icon: '🖌️',  ultra: false },
  { id: 'pixels_1000',   label: 'Pixel Veteran',      desc: 'Place 1,000 pixels.',                  icon: '⭐',  ultra: false },
  { id: 'pixels_10000',  label: 'Grand Master',       desc: 'Place 10,000 pixels.',                 icon: '👑',  ultra: true  },
  { id: 'streak_3',      label: '3-Day Streak',       desc: 'Paint 3 days in a row.',               icon: '🔥',  ultra: false },
  { id: 'streak_7',      label: 'Week Warrior',       desc: 'Paint 7 days in a row.',               icon: '🔥',  ultra: false },
  { id: 'streak_30',     label: 'Month of Madness',   desc: 'Paint 30 days in a row.',              icon: '🔥',  ultra: true  },
];
// Expose to settings.js (must come after the const declaration)
window.ACHIEVEMENT_DEFS = ACHIEVEMENT_DEFS;

const ACHIEVEMENT_LS_KEY = 'sp_achievements_unlocked';

function getUnlockedAchievements() {
  try { return new Set(JSON.parse(localStorage.getItem(ACHIEVEMENT_LS_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveUnlockedAchievement(id) {
  const set = getUnlockedAchievements();
  set.add(id);
  localStorage.setItem(ACHIEVEMENT_LS_KEY, JSON.stringify([...set]));
}

function checkAchievements({ totalPixels, currentStreak }) {
  const unlocked = getUnlockedAchievements();
  const toUnlock = [];

  const milestones = [
    { id: 'first_pixel',  threshold: 1     },
    { id: 'pixels_10',    threshold: 10    },
    { id: 'pixels_100',   threshold: 100   },
    { id: 'pixels_1000',  threshold: 1000  },
    { id: 'pixels_10000', threshold: 10000 },
  ];
  milestones.forEach(m => {
    if (!unlocked.has(m.id) && totalPixels >= m.threshold) toUnlock.push(m.id);
  });

  const streakMilestones = [
    { id: 'streak_3',  threshold: 3  },
    { id: 'streak_7',  threshold: 7  },
    { id: 'streak_30', threshold: 30 },
  ];
  streakMilestones.forEach(m => {
    if (!unlocked.has(m.id) && currentStreak >= m.threshold) toUnlock.push(m.id);
  });

  toUnlock.forEach(id => {
    saveUnlockedAchievement(id);
    const def = ACHIEVEMENT_DEFS.find(d => d.id === id);
    if (def) showAchievementPopup(def);
  });
}

function showAchievementPopup(def) {
  const container = document.getElementById('achievement-container');
  if (!container) return;
  SFX.play(def.ultra ? 'ultra-achivement' : 'achievement', 1000, 0.7);

  const el = document.createElement('div');
  el.className = 'achievement-popup' + (def.ultra ? ' achievement-popup--ultra' : '');
  el.innerHTML = `
    <span class="achievement-icon">${def.icon}</span>
    <div class="achievement-text">
      <div class="achievement-label">${def.ultra ? '✨ ULTRA ACHIEVEMENT' : 'Achievement Unlocked'}</div>
      <div class="achievement-name">${def.label}</div>
      <div class="achievement-desc">${def.desc}</div>
    </div>`;
  container.appendChild(el);

  // Animate in, hold, then remove
  requestAnimationFrame(() => { el.classList.add('achievement-popup--visible'); });
  setTimeout(() => {
    el.classList.remove('achievement-popup--visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }, 4000);
}

// ═══════════════════════════════════════════════════════════════════
// ── ATTACK DETECTION ────────────────────────────────────────────────
// Counts how many of the current user's pixels have been overwritten
// in a sliding 10-second window. If > ATTACK_THRESHOLD, show a warning.
// ═══════════════════════════════════════════════════════════════════

const ATTACK_THRESHOLD = 15;
const ATTACK_WINDOW_MS = 10_000;
let _attackTimestamps = [];
let _attackCooldownUntil = 0;

function recordAttackPixel() {
  if (!currentUser) return;
  const now = Date.now();
  _attackTimestamps.push(now);
  // Prune old events outside window
  _attackTimestamps = _attackTimestamps.filter(t => now - t < ATTACK_WINDOW_MS);
  if (_attackTimestamps.length >= ATTACK_THRESHOLD && now > _attackCooldownUntil) {
    _attackCooldownUntil = now + 30_000; // suppress re-notification for 30s
    _attackTimestamps = [];
    showAttackWarning();
  }
}

function showAttackWarning() {
  const el = document.getElementById('attack-warning');
  if (!el) return;
  SFX.play('notification', 5000, 0.8);
  el.classList.add('attack-warning--visible');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('attack-warning--visible'), 6000);
}
