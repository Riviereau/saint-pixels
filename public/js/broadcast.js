// ═══════════════════════════════════════════════════════════════════
// broadcast.js — SSE real-time sync + pixel broadcast
// Connects to /api/stream, applies pixels from other users, broadcasts
// local placements to the server and other same-origin tabs.
// Depends on: currentUser, lastPlaceAt, _activeCooldownMs, bufferCtx (state/canvas.js)
//             paintPixel, redraw, _doRender (canvas.js)
//             _markLocalCell, paintInitPixelsChunked (state.js)
//             updateCooldownLabel (cooldown.js)
//             updateEventBanner (events.js)
//             recordAttackPixel (achievements.js)
//             checkAchievements, updateStreakBadge (achievements.js / events.js)
//             appendHistory, safeParse (state.js)
//             dispatchStateChange (state.js)
//             getStoredToken (auth.js)
// ═══════════════════════════════════════════════════════════════════

// ── SSE connection ───────────────────────────────────────────────────
let _sseSource = null;
let _sseRetryDelay = 2000;
const SSE_RETRY_BASE = 2000;
const SSE_RETRY_MAX  = 30000;

// Batch rapid remote-pixel events into a single rAF redraw
let _remoteRedrawPending = false;
function scheduleRemoteRedraw() {
  if (_remoteRedrawPending) return;
  _remoteRedrawPending = true;
  requestAnimationFrame(() => {
    _remoteRedrawPending = false;
    redraw();
  });
}

function connectSSE() {
  if (_sseSource) { _sseSource.close(); }
  _sseSource = new EventSource('/api/stream');

  _sseSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      // Ignore server heartbeat pings — they exist only to keep the proxy alive
      if (event.type === 'ping') return;
      if (event.type === 'init') {
        if (Array.isArray(event.pixels)) {
          _sseRetryDelay = SSE_RETRY_BASE;
          paintInitPixelsChunked(event.pixels);
        }
      } else if (event.type === 'pixel') {
        if (event.user !== currentUser) {
          applyRemotePixel(event);
          scheduleRemoteRedraw();
          if (currentUser && event.user !== currentUser) {
            const existing = bufferCtx.getImageData(event.x, event.y, 1, 1).data;
            if (existing[3] > 0) recordAttackPixel();
          }
        }
        window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
      } else if (event.type === 'erase') {
        if (event.user !== currentUser) {
          paintPixel(event.x, event.y, 1, 'eraser', null);
          scheduleRemoteRedraw();
        }
      } else if (event.type === 'clients') {
        dispatchStateChange({ liveCount: event.count });
        _sseRetryDelay = SSE_RETRY_BASE;
      } else if (event.type === 'event') {
        updateEventBanner(event.active, event.endsAt, event.cooldownMs);
      } else if (event.type === 'chat') {
        if (typeof window.__chatIncoming === 'function') window.__chatIncoming(event);
      } else if (event.type === 'email_verified') {
        if (event.username && event.username === currentUser) {
          localStorage.setItem(EMAIL_VERIFIED_KEY, '1');
          dispatchStateChange({ emailVerified: true });
        }
      }
    } catch { /* ignore malformed events */ }
  };

  _sseSource.onerror = () => {
    // Guard: only the source that triggered the error should reconnect.
    // Without this, switching tabs or a brief network blip can spawn
    // multiple concurrent retry timers all calling connectSSE().
    const failedSource = _sseSource;
    if (!failedSource) return;

    // readyState 2 = CLOSED: the browser already closed it, nothing to do.
    if (failedSource.readyState === EventSource.CLOSED) return;

    failedSource.close();
    _sseSource = null;

    // readyState 0 = CONNECTING when the error fires means the server dropped
    // an established stream (e.g. a keep-alive timeout while the tab was hidden).
    // This is a routine mid-session drop — reset backoff so we reconnect at
    // SSE_RETRY_BASE (2 s) rather than continuing an exponential ramp.
    if (failedSource.readyState === EventSource.CONNECTING) {
      _sseRetryDelay = SSE_RETRY_BASE;
    }

    const delay = _sseRetryDelay;
    _sseRetryDelay = Math.min(_sseRetryDelay * 2, SSE_RETRY_MAX);
    setTimeout(() => { if (!_sseSource) connectSSE(); }, delay);
  };
}

window.addEventListener('beforeunload', () => {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
});

// ── Chunked init-pixel painting ──────────────────────────────────────
const SSE_INIT_CHUNK_SIZE = 5000;

function paintInitPixelsChunked(pixels) {
  let i = 0;
  const _protected = new Set(_recentLocalCells.keys());
  function paintChunk() {
    const end = Math.min(i + SSE_INIT_CHUNK_SIZE, pixels.length);
    for (; i < end; i++) {
      const p = pixels[i];
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      if (_protected.has(`${p.x},${p.y}`)) continue;
      if (p.color === 'erase') {
        paintPixel(p.x, p.y, 1, 'eraser', null);
      } else if (typeof p.color === 'string') {
        paintPixel(p.x, p.y, 1, 'brush', p.color.startsWith('#') ? p.color : '#' + p.color);
      }
    }
    _doRender();
    if (i < pixels.length) requestAnimationFrame(paintChunk);
  }
  requestAnimationFrame(paintChunk);
}

// ── Remote pixel helpers ─────────────────────────────────────────────
function applyRemotePixel(event) {
  const remoteTool = event.tool || 'brush';
  const remoteColor =
    remoteTool === 'eraser'
      ? null
      : event.color != null && event.color !== ''
        ? normalizeHexColor(String(event.color))
        : '#000000';
  paintPixel(event.x, event.y, event.size || 1, remoteTool, remoteColor);
  // Callers must call redraw() — batching is handled by scheduleRemoteRedraw
}

function handleRemoteEvent(event) {
  if (!event || !event.type) return;
  if (event.type === 'pixel') {
    applyRemotePixel(event);
    redraw();
  } else if (event.type === 'clear') {
    clearCanvasLocal(false);
  } else if (event.type === 'palette') {
    customPalette = Array.isArray(event.palette)
      ? event.palette.map(entry =>
          normalizeHexColor(typeof entry === 'string' ? entry : String(entry?.color ?? ''))
        )
      : [];
    saveCustomPalette(customPalette);
    renderPalette();
  }
}

function replayHistory() {
  // No-op: Pixel history is now stored entirely server-side.
  // The SSE 'init' event provides the necessary canvas state on boot.
}

// ── Broadcast (send to server + other tabs) ──────────────────────────
function broadcastEvent(event) {
  function rollbackPixel() {
    if (event.prevColor) {
      paintPixel(event.x, event.y, event.size || 1, 'brush', event.prevColor);
    } else {
      paintPixel(event.x, event.y, event.size || 1, 'eraser', null);
    }
    redraw();
  }

  localStorage.setItem(EVENT_KEY, JSON.stringify(event));

  if (event.type === 'pixel') {
    const token = getStoredToken();
    if (token) {
      const endpoint = event.tool === 'eraser' ? '/api/erase' : '/api/pixel';
      const payload = event.tool === 'eraser'
        ? { x: Math.round(event.x), y: Math.round(event.y) }
        : { x: Math.round(event.x), y: Math.round(event.y), color: event.color, prevColor: event.prevColor || null };

      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      }).then(res => {
        if (res.ok) {
          window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
          _markLocalCell(event.x, event.y);
          _totalPixelCount++;
          _currentStreak = Math.max(_currentStreak, 1);
          checkAchievements({ totalPixels: _totalPixelCount, currentStreak: _currentStreak });
          updateStreakBadge();
        } else {
          res.json().then(data => {
            console.warn('[sp] pixel save failed:', res.status, data?.error);
            if (res.status === 429) {
              const remaining = data?.cooldown ?? 0;
              if (remaining <= 150) {
                window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
                _totalPixelCount++;
                _currentStreak = Math.max(_currentStreak, 1);
                checkAchievements({ totalPixels: _totalPixelCount, currentStreak: _currentStreak });
                updateStreakBadge();
                lastPlaceAt = Date.now();
              } else {
                rollbackPixel();
                lastPlaceAt = Date.now() - (_activeCooldownMs - remaining);
              }
              updateCooldownLabel();
            } else {
              rollbackPixel();
              updateCooldownLabel();
            }
          }).catch(() => {
            console.warn('[sp] pixel save failed (unparseable response):', res.status);
            rollbackPixel();
            updateCooldownLabel();
          });
        }
      }).catch(err => {
        console.warn('[sp] pixel save network error (will retry once):', err.message);
        rollbackPixel();
        lastPlaceAt = 0;
        updateCooldownLabel();

        const retryTimeout = setTimeout(() => {
          const retryToken = getStoredToken();
          if (!retryToken || !currentUser) return;
          const retryEndpoint = event.tool === 'eraser' ? '/api/erase' : '/api/pixel';
          const retryPayload  = event.tool === 'eraser'
            ? { x: Math.round(event.x), y: Math.round(event.y) }
            : { x: Math.round(event.x), y: Math.round(event.y), color: event.color };
          fetch(retryEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${retryToken}` },
            body: JSON.stringify(retryPayload),
          }).then(retryRes => {
            if (retryRes.ok) {
              paintPixel(event.x, event.y, event.size || 1, event.tool, event.tool === 'eraser' ? null : event.color);
              redraw();
              lastPlaceAt = Date.now();
              window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
              _markLocalCell(event.x, event.y);
              _totalPixelCount++;
              _currentStreak = Math.max(_currentStreak, 1);
              checkAchievements({ totalPixels: _totalPixelCount, currentStreak: _currentStreak });
              updateStreakBadge();
              updateCooldownLabel();
              console.info('[sp] pixel retry succeeded');
            } else if (retryRes.status === 429) {
              console.warn('[sp] pixel retry hit cooldown — user can click again');
            } else {
              console.warn('[sp] pixel retry also failed:', retryRes.status);
            }
          }).catch(retryErr => {
            console.warn('[sp] pixel retry also failed (network):', retryErr.message);
          });
        }, 1500);

        window.addEventListener('sp-pixel-placed', () => { clearTimeout(retryTimeout); }, { once: true });
      });
    }
  }
}