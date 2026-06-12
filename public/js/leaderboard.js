// ═══════════════════════════════════════════════════════════════════
// leaderboard.js — Leaderboard panel + profile modal
// Fetches /api/leaderboard, renders rankings, handles period filters,
// opens per-user profile modal, auto-refreshes while open.
// Depends on: currentUser (auth.js)
//             ACHIEVEMENT_DEFS (achievements.js)
//             normalizeHexColor (palette.js / canvas.js)
//             SFX (sfx.js)
//             dispatchStateChange (app.js)
// ═══════════════════════════════════════════════════════════════════

(function initLeaderboard() {
  const panel        = document.getElementById('lb-panel');
  const toggle       = document.getElementById('lb-toggle');
  const list         = document.getElementById('lb-list');
  const dateEl       = document.getElementById('lb-date');
  const filtersEl    = document.getElementById('lb-filters');
  const resetNote    = document.getElementById('lb-reset-note');
  const profileStrip = document.getElementById('lb-profile-strip');
  const profileAvatar= document.getElementById('lb-profile-avatar');
  const profileName  = document.getElementById('lb-profile-name');
  const profileSub   = document.getElementById('lb-profile-sub');

  // Profile modal elements
  const modalOverlay = document.getElementById('profile-modal-overlay');
  const pmAvatar     = document.getElementById('pm-avatar');
  const pmUsername   = document.getElementById('pm-username');
  const pmSub        = document.getElementById('pm-sub');
  const pmTotal      = document.getElementById('pm-total');
  const pmToday      = document.getElementById('pm-today');
  const pmRank       = document.getElementById('pm-rank');
  const pmRecent     = document.getElementById('pm-recent-pixels');
  const pmClose      = document.getElementById('pm-close');

  if (!panel || !toggle || !list) return;

  let isOpen      = false;
  let activePeriod = 'today';

  // ── Period filter buttons ────────────────────────────────────────
  if (filtersEl) {
    filtersEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.lb-filter-btn');
      if (!btn) return;
      filtersEl.querySelectorAll('.lb-filter-btn').forEach(b => b.classList.remove('lb-filter-active'));
      btn.classList.add('lb-filter-active');
      activePeriod = btn.dataset.period;
      hasFetchedOnce = false; // Show loading indicator for the newly selected period
      updatePeriodLabels();
      fetchLeaderboard();
    });
  }

  // ── Date/range label helpers ─────────────────────────────────────
  function fmtDate(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  }
  function fmtYear(d) {
    return d.toLocaleDateString('en-US', { year: 'numeric', timeZone: 'America/New_York' });
  }

  function getPeriodRange(period) {
    const now      = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const todayStr = now.toISOString().slice(0, 10);
    const today    = new Date(todayStr + 'T00:00:00Z');

    if (period === 'today') {
      return { label: fmtDate(today), note: 'Resets at midnight · UTC−4' };
    }
    if (period === 'yesterday') {
      const yest = new Date(today);
      yest.setUTCDate(yest.getUTCDate() - 1);
      return { label: fmtDate(yest), note: fmtDate(yest) };
    }
    if (period === 'week') {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 6);
      return { label: `${fmtDate(from)} – ${fmtDate(today)}`, note: 'Last 7 days' };
    }
    if (period === 'month') {
      const from = new Date(todayStr.slice(0, 7) + '-01T00:00:00Z');
      return {
        label: today.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }),
        note:  `Since ${fmtDate(from)}`
      };
    }
    if (period === 'year') {
      const year = todayStr.slice(0, 4);
      return { label: year, note: `Jan 1 – ${fmtDate(today)} ${year}` };
    }
    if (period === 'decade') {
      const yr          = parseInt(todayStr.slice(0, 4), 10);
      const decadeStart = Math.floor(yr / 10) * 10;
      return { label: `${decadeStart}s`, note: `${decadeStart} – ${decadeStart + 9}` };
    }
    if (period === 'century') {
      const yr           = parseInt(todayStr.slice(0, 4), 10);
      const centuryStart = Math.floor(yr / 100) * 100;
      return { label: `${centuryStart}s`, note: `${centuryStart} – ${centuryStart + 99}` };
    }
    // alltime
    return { label: 'All Time', note: 'All-time totals' };
  }

  function updatePeriodLabels() {
    const { label, note } = getPeriodRange(activePeriod);
    if (dateEl)    dateEl.textContent    = label;
    if (resetNote) resetNote.textContent = note;
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('lb-open');
  }

  toggle.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('lb-open', isOpen);
    SFX.play(isOpen ? 'leaderboard-open' : 'leaderboard-close', 300, 0.45);
    if (isOpen) {
      updatePeriodLabels();
      fetchLeaderboard();
    }
  });

  window.addEventListener('sp-state-change', (e) => {
    if (e.detail && e.detail.currentUser !== undefined) {
      updateProfileStrip(e.detail.currentUser);
      if (e.detail.currentUser === null) closePanel();
    }
  });

  // ── Profile strip update ─────────────────────────────────────────
  function updateProfileStrip(username) {
    if (!profileName || !profileAvatar || !profileSub) return;
    if (!username) {
      profileAvatar.textContent = '?';
      profileName.textContent   = 'Not logged in';
      profileSub.textContent    = 'Sign in to track pixels';
      return;
    }
    profileAvatar.textContent = username.charAt(0);
    profileName.textContent   = username;
    profileSub.textContent    = 'Tap to view your profile';
  }

  // ── Profile modal ────────────────────────────────────────────────
  async function openProfileModal(username) {
    if (!modalOverlay || !username) return;
    pmAvatar.textContent   = username.charAt(0).toUpperCase();
    pmUsername.textContent = username;
    pmSub.textContent      = 'Loading stats…';
    pmTotal.textContent    = '—';
    pmToday.textContent    = '—';
    pmRank.textContent     = '—';
    pmRecent.innerHTML     = '<span class="pm-loading">Loading…</span>';

    // Hide ban badge while loading
    const pmBanBadge = document.getElementById('pm-ban-badge');
    if (pmBanBadge) pmBanBadge.style.display = 'none';

    modalOverlay.classList.add('pm-open');

    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
      if (!res.ok) throw new Error('Profile fetch failed');
      const d = await res.json();

      pmSub.textContent   = `${(d.totalPixels || 0).toLocaleString()} pixels total`;
      pmTotal.textContent = (d.totalPixels || 0).toLocaleString();
      pmToday.textContent = (d.todayPixels  || 0).toLocaleString();
      pmRank.textContent  = d.allTimeRank ? `#${d.allTimeRank}` : '—';

      // Ban badge
      if (pmBanBadge) {
        if (d.banned) {
          pmBanBadge.style.display = '';
          pmBanBadge.title = d.banReason ? `Banned: ${d.banReason}` : 'This player is banned';
        } else {
          pmBanBadge.style.display = 'none';
        }
      }

      // Streak display
      const pmStreakEl = document.getElementById('pm-streak');
      if (pmStreakEl) {
        pmStreakEl.textContent = d.currentStreak
          ? `🔥 ${d.currentStreak} day${d.currentStreak !== 1 ? 's' : ''} (best: ${d.longestStreak})`
          : '—';
      }

      // Most-used color swatch
      const pmColorEl = document.getElementById('pm-fav-color');
      if (pmColorEl) {
        if (d.mostUsedColor) {
          pmColorEl.style.background = d.mostUsedColor;
          pmColorEl.title            = d.mostUsedColor.toUpperCase();
          pmColorEl.style.display    = '';
        } else {
          pmColorEl.style.display = 'none';
        }
      }

      // Achievements
      const pmAchEl = document.getElementById('pm-achievements');
      if (pmAchEl) {
        if (d.achievements && d.achievements.length > 0) {
          pmAchEl.innerHTML = d.achievements.map(a => {
            const def = (window.ACHIEVEMENT_DEFS || []).find(x => x.id === a.achievement_id);
            return def ? `<span class="pm-ach-badge" title="${def.label}: ${def.desc}">${def.icon}</span>` : '';
          }).join('');
        } else {
          pmAchEl.innerHTML = '<span style="color:#475569;font-size:0.8rem">No achievements yet.</span>';
        }
      }

      // Recent pixels
      if (d.recentPixels && d.recentPixels.length > 0) {
        pmRecent.innerHTML = d.recentPixels.map(p => {
          const safeX    = parseInt(p.x, 10) || 0;
          const safeY    = parseInt(p.y, 10) || 0;
          const isErase  = p.color === 'erase';
          const styleRule = isErase
            ? `background-image: url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjMWUyOTNiIiByeD0iMiIvPjxwYXRoIGQ9Ik00IDRsOCA4TTEyIDRMNCAxMiIgc3Ryb2tlPSIjZWY0NDQ0IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==); background-size: cover;`
            : `background: ${normalizeHexColor(String(p.color || '#888'))};`;
          const tooltipText = isErase
            ? `(${safeX},${safeY}) Erased`
            : `(${safeX},${safeY}) ${normalizeHexColor(String(p.color || '#888'))}`;
          return `<div class="pm-pixel-dot" style="${styleRule}" title="${tooltipText}"></div>`;
        }).join('');
      } else {
        pmRecent.innerHTML = '<span style="color:#475569;font-size:0.82rem;font-style:italic;">No pixels placed yet.</span>';
      }
    } catch {
      pmSub.textContent = 'Could not load profile.';
    }
  }

  function closeProfileModal() {
    if (modalOverlay) modalOverlay.classList.remove('pm-open');
  }

  if (profileStrip) {
    profileStrip.addEventListener('click', () => {
      if (currentUser) openProfileModal(currentUser);
    });
  }

  if (pmClose) pmClose.addEventListener('click', closeProfileModal);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeProfileModal();
    });
  }

  // Allow clicking a username in the leaderboard list to open their profile
  if (list) {
    list.addEventListener('click', (e) => {
      const span = e.target.closest('.lb-username');
      if (!span) return;
      const username = span.dataset.username;
      if (username) openProfileModal(username);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function msUntilMidnightUTC4() {
    const now       = new Date();
    const utc4      = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const nextMidnight = new Date(utc4);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    return nextMidnight.getTime() - utc4.getTime();
  }

  // ── Render ───────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(rows) {
    updatePeriodLabels();
    if (!rows || rows.length === 0) {
      list.innerHTML = '<li class="lb-empty">No pixels placed yet.</li>';
      return;
    }

    const rankSymbols = ['🥇', '🥈', '🥉'];
    const rankClasses = ['lb-rank--gold', 'lb-rank--silver', 'lb-rank--bronze'];

    list.innerHTML = rows.map((row, i) => {
      const rankContent = i < 3 ? rankSymbols[i] : `${i + 1}`;
      const rankCls     = i < 3 ? rankClasses[i]  : '';
      const isMe        = currentUser && row.username === currentUser;
      const safeUsername = escHtml(row.username);
      return `
        <li class="${isMe ? 'lb-me' : ''}">
          <span class="lb-rank ${rankCls}">${rankContent}</span>
          <span class="lb-username" data-username="${safeUsername}" title="View ${safeUsername}'s profile">${safeUsername}</span>
          <span class="lb-count">${Number(row.count).toLocaleString()} px</span>
        </li>`;
    }).join('');
  }

  let hasFetchedOnce = false;

  async function fetchLeaderboard() {
    if (!hasFetchedOnce) {
      list.innerHTML = '<li class="lb-loading">Loading…</li>';
    }
    try {
      const res = await fetch(`/api/leaderboard?period=${activePeriod}`);
      if (!res.ok) throw new Error('Leaderboard fetch failed');
      const data = await res.json();
      render(data.leaderboard || []);
      hasFetchedOnce = true;
    } catch {
      if (!hasFetchedOnce) {
        list.innerHTML = '<li class="lb-loading">Unable to load…</li>';
      }
    }
  }

  // Auto-refresh every 10 s when open
  setInterval(() => { if (isOpen) fetchLeaderboard(); }, 10_000);

  // Instant refresh whenever any pixel is placed
  window.addEventListener('sp-pixel-placed', () => {
    if (isOpen) fetchLeaderboard();
  });

  // Scheduled reset at UTC-4 midnight
  function scheduleReset() {
    const delay = msUntilMidnightUTC4();
    setTimeout(() => {
      if (isOpen) fetchLeaderboard();
      scheduleReset();
    }, delay);
  }
  scheduleReset();

  // Expose openProfileModal globally so chat.js can open profiles on username click
  window.__openProfile = function (username) {
    openProfileModal(username);
  };
})();
