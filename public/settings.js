/**
 * public/settings.js — Settings panel (achievements + volume)
 *
 * Adds a ⚙ button to the topbar that opens a modal with:
 *   • Achievements tab  — shows all achievements, locked/unlocked state
 *   • Sound tab         — master volume slider (persisted to localStorage)
 *
 * Requires app.js to expose:
 *   window.SFX.setVolume(0–1)
 *   window.SFX.getVolume() → number
 *   window.ACHIEVEMENT_DEFS  — array of achievement definitions
 *   localStorage key 'sp_achievements_unlocked' — JSON array of unlocked IDs
 */

(function () {
  'use strict';

  // ── Achievement definitions (mirrors app.js — kept in sync) ──────────────────
  // We read from window.ACHIEVEMENT_DEFS if available (set by app.js),
  // otherwise fall back to the local copy so settings.js works standalone.
  const DEFS = window.ACHIEVEMENT_DEFS || [
    { id: 'first_pixel',   label: 'First Pixel!',     desc: 'Place your very first pixel.',  icon: '🎨', ultra: false },
    { id: 'pixels_10',     label: 'Getting Started',  desc: 'Place 10 pixels.',              icon: '✏️',  ultra: false },
    { id: 'pixels_100',    label: 'Dedicated Artist', desc: 'Place 100 pixels.',             icon: '🖌️',  ultra: false },
    { id: 'pixels_1000',   label: 'Pixel Veteran',    desc: 'Place 1,000 pixels.',           icon: '⭐',  ultra: false },
    { id: 'pixels_10000',  label: 'Grand Master',     desc: 'Place 10,000 pixels.',          icon: '👑',  ultra: true  },
    { id: 'streak_3',      label: '3-Day Streak',     desc: 'Paint 3 days in a row.',        icon: '🔥',  ultra: false },
    { id: 'streak_7',      label: 'Week Warrior',     desc: 'Paint 7 days in a row.',        icon: '🔥',  ultra: false },
    { id: 'streak_30',     label: 'Month of Madness', desc: 'Paint 30 days in a row.',       icon: '🔥',  ultra: true  },
  ];

  const ACHIEVEMENT_LS_KEY = 'sp_achievements_unlocked';

  function getUnlocked() {
    try { return new Set(JSON.parse(localStorage.getItem(ACHIEVEMENT_LS_KEY) || '[]')); }
    catch { return new Set(); }
  }

  // ── Inject HTML ───────────────────────────────────────────────────────────────

  // Topbar button — styled to match the existing topbar pill buttons exactly
  const topbarBtn = document.createElement('button');
  topbarBtn.id        = 'settings-topbar-btn';
  topbarBtn.type      = 'button';
  topbarBtn.title     = 'Settings';
  // Mirror the exact Tailwind classes used by Rules / Contribute / etc. in the topbar
  topbarBtn.className = 'px-2 py-1.5 rounded-xl border border-white/30 bg-white/90 text-slate-900 font-semibold text-sm inline-flex items-center justify-center hover:-translate-y-px hover:bg-white transition-all';
  topbarBtn.style.cursor = 'pointer';
  topbarBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

  // Insert into the header — before the right-side status group [role="group"]
  const header = document.querySelector('header');
  const rightGroup = header?.querySelector('[role="group"]');
  if (header && rightGroup) {
    header.insertBefore(topbarBtn, rightGroup);
  } else if (header) {
    header.appendChild(topbarBtn);
  }

  // Modal overlay
  const overlay = document.createElement('div');
  overlay.id        = 'settings-overlay';
  overlay.className = 'settings-overlay hidden';
  overlay.innerHTML = `
    <div class="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">

      <div class="settings-header">
        <span class="settings-title">⚙ Settings</span>
        <button id="settings-close-btn" class="settings-close-btn" type="button" title="Close">✕</button>
      </div>

      <div class="settings-tabs" role="tablist">
        <button class="settings-tab active" data-tab="achievements" role="tab" type="button">🏆 Achievements</button>
        <button class="settings-tab" data-tab="sound" role="tab" type="button">🔊 Sound</button>
      </div>

      <!-- Achievements tab -->
      <div id="settings-tab-achievements" class="settings-tab-panel">
        <p class="settings-section-label">Your progress</p>
        <ul class="settings-achievements-list" id="settings-achievements-list"></ul>
      </div>

      <!-- Sound tab -->
      <div id="settings-tab-sound" class="settings-tab-panel hidden">
        <p class="settings-section-label">Master Volume</p>
        <div class="settings-volume-row">
          <span class="settings-vol-icon" id="settings-vol-icon">🔊</span>
          <input
            type="range"
            id="settings-volume-slider"
            class="settings-volume-slider"
            min="0" max="100" step="1"
            value="100"
          />
          <span class="settings-vol-label" id="settings-vol-label">100%</span>
        </div>
        <p class="settings-vol-hint">Adjusts all in-game sound effects.</p>
      </div>

    </div>
  `;
  document.body.appendChild(overlay);

  // ── Tab switching ─────────────────────────────────────────────────────────────

  const tabBtns   = overlay.querySelectorAll('.settings-tab');
  const tabPanels = overlay.querySelectorAll('.settings-tab-panel');

  function switchTab(name) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPanels.forEach(p => p.classList.toggle('hidden', p.id !== `settings-tab-${name}`));
  }

  tabBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // ── Open / close ──────────────────────────────────────────────────────────────

  function openSettings() {
    renderAchievements();
    syncVolumeUI();
    overlay.classList.remove('hidden');
    switchTab('achievements');
    if (window.SFX) SFX.play('click', 200, 0.4);
  }

  function closeSettings() {
    overlay.classList.add('hidden');
  }

  topbarBtn.addEventListener('click', openSettings);

  // Also wire the mobile topbar settings button (visible on small screens)
  const mobSettingsBtn = document.getElementById('mob-settings-btn');
  if (mobSettingsBtn) mobSettingsBtn.addEventListener('click', openSettings);
  document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeSettings();
  });

  // ── Achievements renderer ─────────────────────────────────────────────────────

  function renderAchievements() {
    const list     = document.getElementById('settings-achievements-list');
    const unlocked = getUnlocked();
    list.innerHTML = '';

    let unlockedCount = 0;
    DEFS.forEach(def => {
      const isUnlocked = unlocked.has(def.id);
      if (isUnlocked) unlockedCount++;

      const li = document.createElement('li');
      li.className = 'settings-achievement-item' +
        (isUnlocked ? ' unlocked' : ' locked') +
        (def.ultra   ? ' ultra'   : '');

      const iconEl = document.createElement('span');
      iconEl.className   = 'sa-icon';
      iconEl.textContent = isUnlocked ? def.icon : '🔒';

      const infoEl = document.createElement('div');
      infoEl.className = 'sa-info';

      const labelEl = document.createElement('span');
      labelEl.className   = 'sa-label';
      labelEl.textContent = def.label;

      const descEl = document.createElement('span');
      descEl.className   = 'sa-desc';
      descEl.textContent = isUnlocked ? def.desc : '???';

      infoEl.appendChild(labelEl);
      infoEl.appendChild(descEl);

      if (def.ultra) {
        const badge = document.createElement('span');
        badge.className   = 'sa-ultra-badge';
        badge.textContent = '✨ ULTRA';
        li.appendChild(iconEl);
        li.appendChild(infoEl);
        li.appendChild(badge);
      } else {
        li.appendChild(iconEl);
        li.appendChild(infoEl);
      }

      list.appendChild(li);
    });

    // Progress summary at top
    let summary = list.previousElementSibling;
    if (!summary || !summary.classList.contains('settings-ach-progress')) {
      summary = document.createElement('p');
      summary.className = 'settings-ach-progress';
      list.parentNode.insertBefore(summary, list);
    }
    summary.textContent = `${unlockedCount} / ${DEFS.length} unlocked`;
  }

  // ── Volume ────────────────────────────────────────────────────────────────────

  const slider   = document.getElementById('settings-volume-slider');
  const volLabel = document.getElementById('settings-vol-label');
  const volIcon  = document.getElementById('settings-vol-icon');

  // ── Initialise volume from localStorage, falling back to 25% ─────────────────
  const DEFAULT_VOLUME = 0.25;
  const _saved = parseFloat(localStorage.getItem('sp_sfx_volume'));
  const initialVolume = !isNaN(_saved) ? _saved : DEFAULT_VOLUME;

  // Persist default so SFX module can read it on startup
  if (isNaN(_saved)) localStorage.setItem('sp_sfx_volume', String(DEFAULT_VOLUME));

  // Apply immediately if SFX is already loaded
  if (window.SFX) SFX.setVolume(initialVolume);

  // Seed the slider before the panel is ever opened
  slider.value = Math.round(initialVolume * 100);

  function syncVolumeUI() {
    const raw = window.SFX ? SFX.getVolume() : parseFloat(localStorage.getItem('sp_sfx_volume') ?? String(DEFAULT_VOLUME));
    const v   = isNaN(raw) ? DEFAULT_VOLUME : Math.max(0, Math.min(1, raw));
    const pct = Math.round(v * 100);
    slider.value         = pct;
    volLabel.textContent = pct + '%';
    volIcon.textContent  = pct === 0 ? '🔇' : pct < 50 ? '🔉' : '🔊';
  }

  // applyVolume is called from 'input', 'change', and the pointer/touch
  // fallback below.  Always commits the new volume to SFX and localStorage.
  function applyVolume() {
    const raw = parseInt(slider.value, 10);
    const v = isNaN(raw) ? 1 : Math.max(0, Math.min(1, raw / 100));
    if (window.SFX) SFX.setVolume(v);
    else localStorage.setItem('sp_sfx_volume', String(v));
    volLabel.textContent = Math.round(v * 100) + '%';
    volIcon.textContent  = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
  }

  // 'input'  — fires continuously on desktop while dragging; gives live feedback.
  // 'change' — fires on iOS on release; always commit here and play preview.
  slider.addEventListener('input',  applyVolume);
  slider.addEventListener('change', () => {
    applyVolume(); // ensure volume is committed on iOS before playing preview
    if (window.SFX && SFX.getVolume() > 0) SFX.play('click', 0, 0.6);
  });

  // ── iOS Safari pointer/touch fallback for range inputs ────────────────────
  // iOS WebKit sometimes fails to fire 'input' events during a range drag when
  // the slider is inside a scrollable container or modal with backdrop-filter.
  // We listen to pointermove (or touchmove if pointer events aren't available)
  // directly on the slider and call applyVolume() ourselves so the label and
  // SFX volume update in real-time even when the native event is swallowed.
  function _rangeFromPointer(e) {
    const touch = e.touches ? e.touches[0] : e;
    const rect  = slider.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    const newVal = Math.round(ratio * 100);
    if (slider.value !== String(newVal)) {
      slider.value = newVal;
      applyVolume();
    }
  }

  // Use pointer events when available (Chrome, modern Safari), fall back to touch
  if (window.PointerEvent) {
    slider.addEventListener('pointermove', (e) => {
      if (e.buttons > 0 || (e.pointerType === 'touch')) _rangeFromPointer(e);
    }, { passive: true });
  } else {
    slider.addEventListener('touchmove', _rangeFromPointer, { passive: true });
  }

  // Expose re-render so app.js can call window.__refreshAchievements() after unlock
  window.__refreshAchievements = renderAchievements;

})();
