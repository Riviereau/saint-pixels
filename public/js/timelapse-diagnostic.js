/**
 * public/timelapse-diagnostic.js
 *
 * Drop this script into your page BEFORE timelapse-ui.js (and before any other
 * scripts if possible).  It silently collects:
 *
 *   • Every uncaught JS error (window.onerror / window.onunhandledrejection)
 *   • Every console.error / console.warn call (including ones from timelapse-ui.js)
 *   • Every fetch() made to /api/timelapse/* — status, timing, headers
 *   • Timelapse-specific milestones (modal open, load start, load ok, seek, etc.)
 *   • Browser / environment info (UA, viewport, connection, storage availability)
 *
 * When errors are collected a floating "🔴 Errors – Download Report" button
 * appears in the bottom-right corner.  Clicking it downloads a timestamped
 * timelapse-diagnostic-<date>.json file you can share for debugging.
 *
 * Nothing is sent to any server.  Everything stays in-browser.
 *
 * USAGE
 *   Add to index.html BEFORE timelapse-ui.js:
 *     <script src="/public/timelapse-diagnostic.js"></script>
 *
 *   Or load it dynamically from the browser console at any time:
 *     const s = document.createElement('script');
 *     s.src = '/public/timelapse-diagnostic.js';
 *     document.head.appendChild(s);
 */

(function () {
  'use strict';

  // ── Storage ────────────────────────────────────────────────────────────────────
  const _log = [];        // all collected entries
  let   _errorCount = 0;  // how many error-level entries
  const _startTime  = performance.now();
  const _startDate  = new Date().toISOString();

  function _now() {
    return (performance.now() - _startTime).toFixed(1) + 'ms';
  }

  function _entry(type, data) {
    const entry = { type, t: _now(), wallclock: new Date().toISOString(), ...data };
    _log.push(entry);
    return entry;
  }

  function _errorEntry(type, data) {
    _errorCount++;
    const entry = _entry(type, data);
    _updateBadge();
    return entry;
  }

  // ── Environment snapshot ───────────────────────────────────────────────────────
  function _envSnapshot() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let storageOk = true, storageError = null;
    try { localStorage.setItem('__tl_diag_test', '1'); localStorage.removeItem('__tl_diag_test'); }
    catch (e) { storageOk = false; storageError = String(e); }

    return {
      url:          location.href,
      userAgent:    navigator.userAgent,
      viewport:     { w: window.innerWidth, h: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      online:       navigator.onLine,
      connection:   conn ? { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt } : null,
      localStorage: { available: storageOk, error: storageError },
      spToken:      (() => { try { return !!localStorage.getItem('sp_token'); } catch { return null; } })(),
      windowToken:  typeof window.__token !== 'undefined' ? (window.__token ? '[present]' : '[null]') : '[not set]',
    };
  }

  _entry('env', _envSnapshot());

  // ── Global error handlers ──────────────────────────────────────────────────────
  const _origOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    _errorEntry('uncaught_error', {
      message,
      source,
      lineno,
      colno,
      stack: error?.stack ?? null,
    });
    if (_origOnError) return _origOnError.apply(this, arguments);
    return false;
  };

  const _origOnUnhandled = window.onunhandledrejection;
  window.addEventListener('unhandledrejection', function (e) {
    _errorEntry('unhandled_rejection', {
      reason: String(e.reason),
      stack:  e.reason?.stack ?? null,
    });
  });

  // ── Console intercept ──────────────────────────────────────────────────────────
  ['error', 'warn'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      const serialised = args.map(a => {
        if (a instanceof Error) return { message: a.message, stack: a.stack };
        try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
      });
      if (level === 'error') {
        _errorEntry('console_error', { args: serialised });
      } else {
        _entry('console_warn', { args: serialised });
      }
      orig(...args);
    };
  });

  // ── Fetch intercept — only for /api/timelapse/* ────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url    = typeof input === 'string' ? input : input?.url ?? String(input);
    const isTL   = url.includes('/api/timelapse');

    if (!isTL) return _origFetch.apply(this, arguments);

    const fetchId  = 'fetch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const fetchStart = performance.now();
    _entry('fetch_start', { fetchId, url, method: init?.method ?? 'GET' });

    return _origFetch.apply(this, arguments).then(res => {
      const elapsed = (performance.now() - fetchStart).toFixed(0) + 'ms';
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const entry = {
        fetchId, url,
        status:  res.status,
        ok:      res.ok,
        elapsed,
        headers: {
          'content-length': headers['content-length'] ?? null,
          'content-type':   headers['content-type']   ?? null,
          'cache-control':  headers['cache-control']  ?? null,
        },
      };
      if (!res.ok) {
        _errorEntry('fetch_error_status', entry);
      } else {
        _entry('fetch_ok', entry);
      }
      return res;
    }).catch(err => {
      const elapsed = (performance.now() - fetchStart).toFixed(0) + 'ms';
      _errorEntry('fetch_network_error', {
        fetchId, url, elapsed,
        message: String(err),
        stack:   err?.stack ?? null,
      });
      throw err;
    });
  };

  // ── Timelapse milestone events ─────────────────────────────────────────────────
  // Patch into the DOM once the modal exists (it's appended by timelapse-ui.js
  // at script run time, which is synchronous, so by the time our next
  // microtask runs the modal should be in the DOM).
  function _hookTimelapseElements() {
    const loadBtn = document.getElementById('tl-load-btn');
    const playBtn = document.getElementById('tl-play-btn');
    const resetBtn = document.getElementById('tl-reset-btn');
    const progressBg = document.getElementById('tl-progress-bg');
    const topbarBtn = document.getElementById('timelapse-topbar-btn');
    const mobBtn    = document.getElementById('mob-timelapse-btn');
    const closeBtn  = document.getElementById('tl-close-btn');
    const loadBarWrap = document.getElementById('tl-load-bar-wrap');

    if (!loadBtn) {
      // Modal not in DOM yet — retry once after a short delay
      setTimeout(_hookTimelapseElements, 200);
      return;
    }

    _entry('diag_hooks_installed', { at: _now() });

    // Intercept style.display mutations on the load bar to confirm visibility
    if (loadBarWrap) {
      const _origDispProp = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
      // Use a MutationObserver instead — simpler and reliable
      const obs = new MutationObserver(() => {
        const vis = loadBarWrap.style.display;
        _entry('loadbar_visibility_change', { display: vis === '' ? 'visible (block from CSS)' : vis });
      });
      obs.observe(loadBarWrap, { attributes: true, attributeFilter: ['style'] });
    }

    [
      [topbarBtn, 'topbar_open_click'],
      [mobBtn,    'mobile_open_click'],
      [closeBtn,  'modal_close_click'],
    ].forEach(([el, name]) => {
      if (el) el.addEventListener('click', () => _entry('milestone', { name }), { capture: true });
    });

    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        _entry('milestone', { name: 'load_btn_click', token: (() => { try { return !!localStorage.getItem('sp_token'); } catch { return null; } })() });
      }, { capture: true });
    }

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        _entry('milestone', { name: 'play_btn_click', disabled: playBtn.disabled });
      }, { capture: true });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        _entry('milestone', { name: 'reset_btn_click' });
      }, { capture: true });
    }

    if (progressBg) {
      progressBg.addEventListener('mousedown', (e) => {
        const rect  = progressBg.getBoundingClientRect();
        const ratio = ((e.clientX - rect.left) / rect.width).toFixed(3);
        _entry('milestone', { name: 'seek_click', ratio });
      }, { capture: true });
    }
  }

  // Hook after a microtask so timelapse-ui.js's IIFE has run
  Promise.resolve().then(_hookTimelapseElements);

  // ── CSS check — verify the load bar CSS rule exists ───────────────────────────
  function _checkCSS() {
    // Inject a hidden test element and check computed display
    const probe = document.createElement('div');
    probe.className = 'tl-load-bar-wrap';
    probe.style.position = 'fixed';
    probe.style.top = '-9999px';
    document.body.appendChild(probe);
    const computed = window.getComputedStyle(probe).display;
    document.body.removeChild(probe);

    const hasCssDisplay = computed !== 'none' && computed !== '';
    _entry('css_check', {
      selector: '.tl-load-bar-wrap',
      computedDisplay: computed,
      // 'block' or 'flex' means the CSS rule exists — good.
      // 'none' or '' means the CSS rule is missing — load bar will stay invisible.
      verdict: hasCssDisplay
        ? `OK — computed display is "${computed}"`
        : `BUG — computed display is "${computed}". The CSS file may not be loaded, or the .tl-load-bar-wrap rule is missing a display property. Without it, loadBarWrap.style.display = "" will not make the element visible.`,
      pass: hasCssDisplay,
    });

    if (!hasCssDisplay) {
      _errorEntry('css_bug_load_bar_invisible', {
        detail: 'The .tl-load-bar-wrap element has no CSS display rule. Setting style.display="" will not show it.',
        fix: 'Add "display: block;" to .tl-load-bar-wrap in timelapse.css',
      });
    }
  }

  // Run the CSS check after styles have loaded
  if (document.readyState === 'complete') {
    _checkCSS();
  } else {
    window.addEventListener('load', _checkCSS);
  }

  // ── Badge UI ───────────────────────────────────────────────────────────────────
  const badge = document.createElement('button');
  badge.id = 'tl-diag-badge';
  badge.type = 'button';
  Object.assign(badge.style, {
    position:     'fixed',
    bottom:       '12px',
    right:        '12px',
    zIndex:       '999999',
    background:   '#1e1e2e',
    border:       '1px solid rgba(255,255,255,0.15)',
    borderRadius: '10px',
    color:        '#94a3b8',
    cursor:       'pointer',
    fontSize:     '0.75rem',
    fontFamily:   'ui-monospace, monospace',
    fontWeight:   '600',
    padding:      '6px 10px',
    display:      'none',
    gap:          '6px',
    alignItems:   'center',
    boxShadow:    '0 4px 20px rgba(0,0,0,0.5)',
    lineHeight:   '1.4',
  });
  badge.title = 'Timelapse diagnostic — click to download JSON report';

  function _updateBadge() {
    if (_errorCount === 0) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display    = 'flex';
    badge.style.borderColor = 'rgba(239,68,68,0.6)';
    badge.style.color       = '#fca5a5';
    badge.textContent = `🔴 ${_errorCount} error${_errorCount !== 1 ? 's' : ''} — Download Report`;
  }

  badge.addEventListener('click', _downloadReport);
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(badge));
  // If DOM is already ready, append immediately
  if (document.readyState !== 'loading') document.body.appendChild(badge);

  // Also expose a green "Download Report" button always accessible via console:
  // window.__tlDiagDownload()
  window.__tlDiagDownload = _downloadReport;
  window.__tlDiagLog      = () => _log;

  // ── Report download ────────────────────────────────────────────────────────────
  function _downloadReport() {
    const report = {
      generated:   new Date().toISOString(),
      sessionStart: _startDate,
      errorCount:  _errorCount,
      totalEntries: _log.length,
      environment: _envSnapshot(),
      bugChecklist: _buildChecklist(),
      log: _log,
    };

    const json = JSON.stringify(report, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `timelapse-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    _entry('report_downloaded', { entries: _log.length, errors: _errorCount });
  }

  // ── Checklist — summarises known bugs and whether they were detected ───────────
  function _buildChecklist() {
    const fetchErrors    = _log.filter(e => e.type === 'fetch_error_status' || e.type === 'fetch_network_error');
    const consoleErrors  = _log.filter(e => e.type === 'console_error');
    const cssCheck       = _log.find(e => e.type === 'css_check');
    const loadbarChanges = _log.filter(e => e.type === 'loadbar_visibility_change');
    const loadBtnClicks  = _log.filter(e => e.type === 'milestone' && e.name === 'load_btn_click');
    const fetchOks       = _log.filter(e => e.type === 'fetch_ok');

    return {
      'BUG-1 CSS display missing (load bar invisible)': {
        detected: cssCheck ? !cssCheck.pass : 'unknown — CSS check not run yet',
        detail:   cssCheck?.verdict ?? 'CSS check pending',
      },
      'BUG-2 Pulse animation broken (transform-origin)': {
        detected: 'manual — check if the indeterminate bar animates visually',
        detail:   'Fixed in timelapse.css by adding transform-origin: left center to .tl-load-bar-fill and rewriting @keyframes tl-load-pulse',
      },
      'BUG-3 Load bar not hidden on error paths': {
        detected: fetchErrors.length > 0 ? 'fetch errors occurred — check log for loadbar_visibility_change after them' : false,
        fetchErrors: fetchErrors.map(e => ({ url: e.url, status: e.status, t: e.t })),
      },
      'BUG-4 TextDecoder not flushed (corrupted JSON tail)': {
        detected: consoleErrors.some(e => JSON.stringify(e.args).includes('JSON parse error')),
        parseErrors: consoleErrors.filter(e => JSON.stringify(e.args).includes('JSON parse error')).map(e => e.args),
      },
      'BUG-5 res.body null guard missing': {
        detected: consoleErrors.some(e => JSON.stringify(e.args).includes('getReader')),
        detail:   'Patched — null body now falls back to res.text()',
      },
      'BUG-6 seekTo O(n) main-thread block': {
        detected: 'manual — seek near end of large history and check for freeze',
        detail:   'Patched — seekTo now yields with setTimeout(0) and shows Seeking… label',
      },
      'BUG-7 updateETA overwrites Starting… label on first tick': {
        detected: 'manual — check ETA bar label immediately after pressing Play',
        detail:   'Patched — updateETA now skips first 300ms',
      },
      'Load button clicked': loadBtnClicks.length,
      'Successful timelapse fetches': fetchOks.length,
      'Load bar visibility changes': loadbarChanges.map(e => ({ t: e.t, display: e.display })),
      'Console errors': consoleErrors.map(e => ({ t: e.t, args: e.args })),
    };
  }

  console.log(
    '[timelapse-diagnostic] loaded — errors will appear as a badge.\n' +
    'Call window.__tlDiagDownload() at any time to download the report.\n' +
    'Call window.__tlDiagLog() to inspect the raw log array.'
  );

})();
