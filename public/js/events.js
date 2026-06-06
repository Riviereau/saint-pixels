// ═══════════════════════════════════════════════════════════════════
// events.js — Cooldown event system + streak/stats
// Polls /api/event on load and listens to SSE for live updates.
// Shows a countdown banner in the topbar. Adjusts client COOLDOWN_MS.
// Depends on: currentUser, getStoredToken (auth.js)
// ═══════════════════════════════════════════════════════════════════

/** Normal per-pixel cooldown in ms — must match cooldown.js on the server. */
const COOLDOWN_MS = 3000;
let _activeCooldownMs = COOLDOWN_MS; // starts at default; overridden by event

function updateEventBanner(active, endsAt, cooldownMs) {
  const banner = document.getElementById('event-banner');
  const countdown = document.getElementById('event-countdown');
  if (!banner) return;
  if (active && endsAt) {
    _activeCooldownMs = cooldownMs || 1500;
    banner.style.display = '';
    // Tick countdown every second
    clearInterval(banner._tickInterval);
    banner._tickInterval = setInterval(() => {
      const rem = endsAt - Date.now();
      if (rem <= 0) {
        banner.style.display = 'none';
        _activeCooldownMs = COOLDOWN_MS;
        clearInterval(banner._tickInterval);
        return;
      }
      const m = Math.floor(rem / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      if (countdown) countdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);
  } else if (endsAt && !active) {
    // Event is upcoming — show "in X hours" teaser
    const rem = endsAt - Date.now();
    if (rem > 0 && countdown) {
      const h = Math.floor(rem / 3600000);
      const m = Math.floor((rem % 3600000) / 60000);
      banner.style.display = '';
      banner.classList.add('event-banner--upcoming');
      if (countdown) countdown.textContent = `in ${h}h ${m}m`;
    }
  } else {
    banner.style.display = 'none';
    _activeCooldownMs = COOLDOWN_MS;
  }
}

async function fetchEventStatus() {
  try {
    const res = await fetch('/api/event');
    if (!res.ok) return;
    const data = await res.json();
    updateEventBanner(data.active, data.endsAt, data.cooldownMs);
    // Schedule next upcoming check using next event if server provides it
    if (!data.active && data.nextEventAt) {
      const delay = Math.max(0, data.nextEventAt - Date.now());
      setTimeout(fetchEventStatus, Math.min(delay, 60_000));
    }
  } catch { /* non-fatal */ }
}

// ── Streak state (loaded once after login) ────────────────────────────────────
let _currentStreak  = 0;
let _longestStreak  = 0;
let _totalPixelCount = 0; // approximate running count for achievement checks

async function fetchStreakAndStats() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/streak', {
      headers: { 'Authorization': `Bearer ${getStoredToken()}` }
    });
    if (!res.ok) return;
    const d = await res.json();
    _currentStreak  = d.currentStreak  || 0;
    _longestStreak  = d.longestStreak  || 0;
    updateStreakBadge();
  } catch { /* non-fatal */ }
}

function updateStreakBadge() {
  const badge = document.getElementById('streak-badge');
  if (!badge) return;
  if (_currentStreak >= 2) {
    badge.textContent = `🔥 ${_currentStreak}`;
    badge.title = `${_currentStreak}-day streak! Longest: ${_longestStreak}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}
