// ═══════════════════════════════════════════════════════════════════
// sfx.js — Sound effects engine
// Loads audio from /sfx/<name>.wav. Plays are rate-limited per sound
// (minInterval) so spamming pixels never floods the audio channel.
// All sounds are disabled while the tab is hidden (visibilitychange).
// ═══════════════════════════════════════════════════════════════════

const SFX = (() => {
  const cache   = {};
  const lastAt  = {};
  let   enabled = true;
  const SFX_VERSION = Date.now(); // cache-bust: forces browser to re-fetch on every page load

  // ── Master volume (persisted to localStorage) ──────────────────────
  const VOL_KEY = 'sp_sfx_volume';
  const _parsed = parseFloat(localStorage.getItem(VOL_KEY) ?? '1');
  let masterVolume = isNaN(_parsed) ? 1 : Math.max(0, Math.min(1, _parsed));

  function setVolume(v) {
    masterVolume = Math.max(0, Math.min(1, isNaN(v) ? 1 : v));
    localStorage.setItem(VOL_KEY, String(masterVolume));
  }

  function getVolume() {
    return masterVolume;
  }

  document.addEventListener('visibilitychange', () => {
    enabled = !document.hidden;
  });

  // ── iOS / Safari audio unlock ──────────────────────────────────────
  // iOS requires a user gesture before any Audio element can play.
  // On the first touchstart or click we silently play a blank audio
  // element to promote the browser's internal audio session from
  // "suspended" to "running". Without this the very first SFX after
  // opening the page is silently dropped on iOS.
  let _iosUnlocked = false;
  function _unlockAudio() {
    if (_iosUnlocked) return;
    _iosUnlocked = true;
    try {
      // Minimal valid WAV: 44-byte header + 4 bytes of silence
      const silent = new Audio(
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAACABAAZGF0YQQAAAAAAA=='
      );
      silent.volume = 0;
      silent.play().catch(() => {});
    } catch { /* ignore */ }
  }
  document.addEventListener('touchstart', _unlockAudio, { once: true, passive: true });
  document.addEventListener('mousedown',  _unlockAudio, { once: true, passive: true });

  function load(name) {
    if (cache[name]) return cache[name];
    const a = new Audio(`/sfx/${name}.wav?v=${SFX_VERSION}`);
    a.preload = 'auto';
    cache[name] = a;
    return a;
  }

  // Pre-warm the sounds that will be needed immediately
  ['pixel-placed','pixel-placed2','pixel-placed3','pixel-erased','tool-changed','eyedropper',
   'hand','ruler','none','click','notification','achievement','ultra-achivement', 'error', 'equiping',
   'leaderboard-open','leaderboard-close','chat-open','chat-close',
   'star-picked'].forEach(load);

  /**
   * Play a sound.
   * @param {string} name        — filename without extension (e.g. 'pixel-placed')
   * @param {number} minInterval — minimum ms between plays of this sound (default 80)
   * @param {number} volume      — 0-1 relative volume, scaled by masterVolume (default 0.5)
   *
   * iOS note: we create a fresh Audio element each time instead of using
   * cloneNode(). Safari/iOS requires every HTMLAudioElement to be individually
   * "unlocked" via a user gesture. cloneNode() copies an element created at
   * load time (before any gesture) and inherits its locked state, so plays are
   * silently dropped on iOS. A fresh new Audio() whose .play() is called
   * inside a user-gesture call stack is treated as unlocked by iOS.
   */
  function play(name, minInterval = 80, volume = 0.5) {
    if (!enabled) return;
    if (masterVolume === 0) return; // hard mute — don't create Audio elements at all
    const now = Date.now();
    if (lastAt[name] && now - lastAt[name] < minInterval) return;
    lastAt[name] = now;
    try {
      const src = load(name).src; // reuse the resolved URL from cache
      const a = new Audio(src);
      a.volume = Math.max(0, Math.min(1, volume * masterVolume));
      a.play().catch(() => {}); // ignore NotAllowedError before first interaction
    } catch { /* ignore */ }
  }

  return { play, enabled: () => enabled, setVolume, getVolume };
})();

// Expose globally so settings.js (and any other module) can call SFX.setVolume / getVolume
window.SFX = SFX;
