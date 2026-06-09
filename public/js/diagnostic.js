/**
 * saint-pixels-diagnostic.js  (was: timelapse-diagnostic.js)
 *
 * Global diagnostic — drop this FIRST in index.html, before every other <script>.
 * It instruments the entire page:
 *
 *   ✔ Every uncaught JS error + unhandled promise rejection
 *   ✔ Every console.error / console.warn (with source location)
 *   ✔ Every fetch() — URL, method, status, timing, headers
 *   ✔ EventSource (SSE) lifecycle — open, message, error, close
 *   ✔ Alpine.js component state snapshots (all x-data roots)
 *   ✔ DOM MutationObserver — modal open/close, overlay visiblity
 *   ✔ Canvas state (timelapse canvas + main pixel canvas)
 *   ✔ Auth overlay visibility vs window.__token / localStorage token
 *   ✔ CSS computed-style checks for every major UI element
 *   ✔ Timelapse-specific milestones (same as before, extended)
 *   ✔ window.performance timeline (navigation + resource)
 *   ✔ Online/offline / visibility change events
 *   ✔ localStorage / sessionStorage availability + token presence
 *   ✔ Environment snapshot (UA, viewport, devicePixelRatio, connection)
 *
 * UI:
 *   • 🔴 N errors badge bottom-right — click to download JSON report
 *   • window.__diagDownload()  → download report at any time
 *   • window.__diagLog()       → raw log array in console
 *   • window.__diagAlpine()    → current Alpine state snapshot
 *   • window.__diagCSS()       → re-run CSS checks
 *
 * Nothing is ever sent to any server. All data stays in-browser.
 *
 * USAGE — index.html, BEFORE every other <script>:
 *   <script nonce="__CSP_NONCE__" src="/js/timelapse-diagnostic.js"></script>
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════
     STORAGE
  ═══════════════════════════════════════════════════════════════════════════ */
  const _log       = [];
  let   _errCount  = 0;
  const _t0        = performance.now();
  const _startISO  = new Date().toISOString();

  const _rel = () => (performance.now() - _t0).toFixed(1) + 'ms';

  function _entry(type, data) {
    const e = { type, t: _rel(), iso: new Date().toISOString(), ...data };
    _log.push(e);
    return e;
  }

  function _err(type, data) {
    _errCount++;
    const e = _entry(type, data);
    _updateBadge();
    return e;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ENVIRONMENT
  ═══════════════════════════════════════════════════════════════════════════ */
  function _env() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let lsOk = true, lsErr = null;
    try { localStorage.setItem('__diag_probe', '1'); localStorage.removeItem('__diag_probe'); }
    catch (e) { lsOk = false; lsErr = String(e); }
    let ssOk = true, ssErr = null;
    try { sessionStorage.setItem('__diag_probe', '1'); sessionStorage.removeItem('__diag_probe'); }
    catch (e) { ssOk = false; ssErr = String(e); }

    return {
      url:              location.href,
      userAgent:        navigator.userAgent,
      viewport:         { w: window.innerWidth, h: window.innerHeight },
      dpr:              window.devicePixelRatio,
      online:           navigator.onLine,
      connection:       conn ? { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt } : null,
      localStorage:     { ok: lsOk, error: lsErr },
      sessionStorage:   { ok: ssOk, error: ssErr },
      spToken:          (() => { try { return !!localStorage.getItem('sp_token'); } catch { return null; } })(),
      windowToken:      typeof window.__token !== 'undefined' ? (window.__token ? '[present]' : '[null/falsy]') : '[not set]',
      alpineVersion:    typeof window.Alpine !== 'undefined' ? (window.Alpine.version || '[loaded, no .version]') : '[not loaded yet]',
    };
  }

  _entry('env', _env());

  /* ═══════════════════════════════════════════════════════════════════════════
     GLOBAL ERROR HANDLERS
  ═══════════════════════════════════════════════════════════════════════════ */
  const _origOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    _err('uncaught_error', { message, source, lineno, colno, stack: error?.stack ?? null });
    return _origOnError ? _origOnError.apply(this, arguments) : false;
  };

  window.addEventListener('unhandledrejection', function (e) {
    _err('unhandled_rejection', { reason: String(e.reason), stack: e.reason?.stack ?? null });
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     CONSOLE INTERCEPT  (error + warn, all sources)
  ═══════════════════════════════════════════════════════════════════════════ */
  ['error', 'warn'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      const ser = args.map(a => {
        if (a instanceof Error) return { __Error: true, message: a.message, stack: a.stack };
        try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
      });
      if (level === 'error') _err('console_error', { args: ser });
      else _entry('console_warn', { args: ser });
      orig(...args);
    };
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     FETCH INTERCEPT  (all URLs, not just /api/timelapse)
  ═══════════════════════════════════════════════════════════════════════════ */
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url   = typeof input === 'string' ? input : (input?.url ?? String(input));
    const id    = 'f_' + Math.random().toString(36).slice(2, 7);
    const t0    = performance.now();

    _entry('fetch_start', { id, url, method: init?.method ?? 'GET' });

    return _origFetch.apply(this, arguments).then(res => {
      const ms  = (performance.now() - t0).toFixed(0) + 'ms';
      const hdrs = {};
      try { res.headers.forEach((v, k) => { hdrs[k] = v; }); } catch {}
      const data = {
        id, url, status: res.status, ok: res.ok, ms,
        'content-type':   hdrs['content-type']   ?? null,
        'content-length': hdrs['content-length'] ?? null,
        'cache-control':  hdrs['cache-control']  ?? null,
      };
      if (!res.ok) _err('fetch_error', data);
      else         _entry('fetch_ok', data);
      return res;
    }).catch(err => {
      _err('fetch_network_error', {
        id, url, ms: (performance.now() - t0).toFixed(0) + 'ms',
        message: String(err), stack: err?.stack ?? null,
      });
      throw err;
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENTSOURCE (SSE) INTERCEPT
  ═══════════════════════════════════════════════════════════════════════════ */
  const _OrigES = window.EventSource;
  if (_OrigES) {
    window.EventSource = function (url, init) {
      const es = new _OrigES(url, init);
      const id = 'sse_' + Math.random().toString(36).slice(2, 7);
      _entry('sse_open_attempt', { id, url });

      es.addEventListener('open',  () => _entry('sse_open',    { id, url }));
      es.addEventListener('error', () => _err('sse_error',     { id, url, readyState: es.readyState }));
      es.addEventListener('message', e => _entry('sse_message', { id, url, dataPreview: String(e.data).slice(0, 120) }));

      return es;
    };
    // Copy static properties so instanceof checks etc. still work
    Object.assign(window.EventSource, _OrigES);
    window.EventSource.prototype = _OrigES.prototype;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ONLINE / OFFLINE / VISIBILITY
  ═══════════════════════════════════════════════════════════════════════════ */
  window.addEventListener('online',  () => _entry('network_online',  {}));
  window.addEventListener('offline', () => _err('network_offline',   {}));
  document.addEventListener('visibilitychange', () =>
    _entry('visibility_change', { hidden: document.hidden }));

  /* ═══════════════════════════════════════════════════════════════════════════
     CSS CHECKS — every major UI region
  ═══════════════════════════════════════════════════════════════════════════ */
  const CSS_PROBES = [
    // [className,            friendlyName,           expectedDisplay]
    ['tl-load-bar-wrap',      'timelapse load bar',   'block'],
    ['tl-modal',              'timelapse modal',       null],      // null = just report, don't fail
    ['tl-progress-bg',        'timelapse progress',   null],
    ['achievement-container', 'achievement container', null],
    ['attack-warning',        'attack warning toast', null],
    ['leaderboard-panel',     'leaderboard panel',    null],
    ['chat-panel',            'chat panel',           null],
    ['toolbar',               'toolbar',              null],
    ['palette-panel',         'palette panel',        null],
    ['auth-overlay',          'auth overlay',         null],
  ];

  function _runCSSChecks() {
    const results = CSS_PROBES.map(([cls, label, expectedDisplay]) => {
      const probe = document.createElement('div');
      probe.className = cls;
      probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;visibility:hidden;';
      document.body.appendChild(probe);
      const computed = window.getComputedStyle(probe).display;
      document.body.removeChild(probe);

      const ok = expectedDisplay === null || (computed !== '' && computed !== 'none');
      const result = {
        class: cls, label, computedDisplay: computed,
        expected: expectedDisplay ?? '(any)',
        pass: ok,
        verdict: ok
          ? `OK (display: ${computed})`
          : `BUG — display is "${computed}". Add display property to .${cls} in CSS.`,
      };
      if (!ok) _err('css_bug', result);
      else     _entry('css_check', result);
      return result;
    });
    return results;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ALPINE.JS STATE SNAPSHOT
  ═══════════════════════════════════════════════════════════════════════════ */
  function _alpineSnapshot() {
    if (typeof window.Alpine === 'undefined') return { error: 'Alpine not loaded' };
    try {
      const roots = document.querySelectorAll('[x-data]');
      const snap = {};
      roots.forEach((el, i) => {
        const comp = window.Alpine.$data ? window.Alpine.$data(el) : el._x_dataStack?.[0];
        const key = el.id || el.className.split(' ')[0] || `root_${i}`;
        try { snap[key] = JSON.parse(JSON.stringify(comp ?? '[no data]')); }
        catch { snap[key] = '[circular / unserializable]'; }
      });
      return snap;
    } catch (e) { return { error: String(e) }; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CANVAS CHECKS
  ═══════════════════════════════════════════════════════════════════════════ */
  function _canvasSnapshot() {
    const results = [];
    document.querySelectorAll('canvas').forEach(c => {
      results.push({
        id:     c.id || '(no id)',
        width:  c.width,
        height: c.height,
        hasCtx2d:   !!c.getContext('2d'),
        hasCtxWebgl: !!c.getContext('webgl'),
        display: window.getComputedStyle(c).display,
        visibility: window.getComputedStyle(c).visibility,
      });
    });
    return results;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DOM MUTATION OBSERVER — track modal/overlay visibility changes
  ═══════════════════════════════════════════════════════════════════════════ */
  function _installMutationWatcher() {
    const watchedIds = [
      'authOverlay', 'tl-modal', 'tl-load-bar-wrap',
      'leaderboard-panel', 'chat-panel', 'attack-warning',
    ];

    // Watch body subtree for attribute/style/class mutations on watched elements
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        const el = m.target;
        if (!watchedIds.includes(el.id)) continue;
        const style   = el.style.display || el.style.visibility;
        const classes = el.className;
        _entry('dom_mutation', {
          id: el.id,
          attr: m.attributeName,
          display: window.getComputedStyle(el).display,
          style,
          classes: typeof classes === 'string' ? classes.slice(0, 200) : '[SVGAnimatedString]',
        });
      }
    });

    obs.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
    });

    _entry('mutation_watcher_installed', { watching: watchedIds });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     TIMELAPSE MILESTONE HOOKS
  ═══════════════════════════════════════════════════════════════════════════ */
  function _hookTimelapse() {
    const hooks = [
      ['tl-load-btn',          'tl_load_btn_click'],
      ['tl-play-btn',          'tl_play_btn_click'],
      ['tl-reset-btn',         'tl_reset_btn_click'],
      ['tl-close-btn',         'tl_modal_close'],
      ['timelapse-topbar-btn', 'tl_topbar_open'],
      ['mob-timelapse-btn',    'tl_mobile_open'],
    ];

    const missing = [];
    hooks.forEach(([id, name]) => {
      const el = document.getElementById(id);
      if (!el) { missing.push(id); return; }
      el.addEventListener('click', () => {
        _entry('milestone', {
          name,
          token: (() => { try { return !!localStorage.getItem('sp_token'); } catch { return null; } })(),
          extra: el.disabled !== undefined ? { disabled: el.disabled } : {},
        });
      }, { capture: true });
    });

    // Progress bar seek
    const prog = document.getElementById('tl-progress-bg');
    if (prog) {
      prog.addEventListener('mousedown', e => {
        const r = prog.getBoundingClientRect();
        _entry('milestone', { name: 'tl_seek', ratio: ((e.clientX - r.left) / r.width).toFixed(3) });
      }, { capture: true });
    }

    // Load bar visibility via MutationObserver (already covered globally, but log specifically)
    const lb = document.getElementById('tl-load-bar-wrap');
    if (lb) {
      new MutationObserver(() => {
        _entry('tl_loadbar_visibility', {
          display: lb.style.display,
          computed: window.getComputedStyle(lb).display,
        });
      }).observe(lb, { attributes: true, attributeFilter: ['style'] });
    }

    _entry('tl_hooks_installed', { missing, hooked: hooks.length - missing.length });
  }

  function _tryHookTimelapse() {
    if (document.getElementById('tl-load-btn')) {
      _hookTimelapse();
    } else {
      setTimeout(_tryHookTimelapse, 250);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     AUTH CONSISTENCY CHECK
  ═══════════════════════════════════════════════════════════════════════════ */
  function _authCheck() {
    let token = null;
    try { token = localStorage.getItem('sp_token'); } catch {}

    const overlay = document.getElementById('authOverlay');
    const overlayVisible = overlay ? window.getComputedStyle(overlay).display !== 'none' : null;

    const result = {
      hasToken:       !!token,
      windowToken:    typeof window.__token !== 'undefined' ? !!window.__token : null,
      overlayVisible,
      mismatch:       overlayVisible !== null && !!token !== !overlayVisible,
    };

    if (result.mismatch) {
      _err('auth_state_mismatch', {
        ...result,
        detail: `Token present: ${result.hasToken}, auth overlay visible: ${result.overlayVisible}. These should be opposite.`,
      });
    } else {
      _entry('auth_check', result);
    }
    return result;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PERFORMANCE TIMELINE SNAPSHOT
  ═══════════════════════════════════════════════════════════════════════════ */
  function _perfSnapshot() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource').map(r => ({
        name: r.name.replace(location.origin, ''),
        type: r.initiatorType,
        ms:   Math.round(r.duration),
        size: r.transferSize ?? null,
      })).filter(r => r.ms > 200); // only slow resources

      return {
        ttfb:       nav ? Math.round(nav.responseStart - nav.requestStart) : null,
        domContent: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
        loadEvent:  nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
        slowResources: resources,
      };
    } catch { return { error: 'unavailable' }; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CHECKLIST
  ═══════════════════════════════════════════════════════════════════════════ */
  function _buildChecklist() {
    const fetchErrs   = _log.filter(e => e.type === 'fetch_error' || e.type === 'fetch_network_error');
    const consoleErrs = _log.filter(e => e.type === 'console_error');
    const cssErrs     = _log.filter(e => e.type === 'css_bug');
    const sseErrs     = _log.filter(e => e.type === 'sse_error');
    const domErrs     = _log.filter(e => e.type === 'uncaught_error' || e.type === 'unhandled_rejection');
    const authIssues  = _log.filter(e => e.type === 'auth_state_mismatch');
    const fetchOks    = _log.filter(e => e.type === 'fetch_ok');
    const milestones  = _log.filter(e => e.type === 'milestone');
    const lbChanges   = _log.filter(e => e.type === 'tl_loadbar_visibility');

    return {
      summary: {
        totalErrors: _errCount,
        fetchErrors: fetchErrs.length,
        cssErrors:   cssErrs.length,
        sseErrors:   sseErrs.length,
        jsErrors:    domErrs.length,
        consoleErrors: consoleErrs.length,
        authIssues:  authIssues.length,
      },
      'CSS display issues':          cssErrs.map(e => ({ class: e.class, verdict: e.verdict })),
      'Fetch errors':                fetchErrs.map(e => ({ url: e.url, status: e.status, ms: e.ms, t: e.t })),
      'SSE errors':                  sseErrs.map(e => ({ url: e.url, readyState: e.readyState, t: e.t })),
      'Uncaught JS errors':          domErrs.map(e => ({ message: e.message || e.reason, stack: (e.stack || '').slice(0, 300), t: e.t })),
      'Console errors':              consoleErrs.map(e => ({ t: e.t, preview: JSON.stringify(e.args).slice(0, 200) })),
      'Auth mismatches':             authIssues,
      'Successful fetches':          fetchOks.length,
      'User milestones':             milestones.map(e => ({ name: e.name, t: e.t })),
      'Timelapse load bar changes':  lbChanges.map(e => ({ t: e.t, display: e.display, computed: e.computed })),

      'Known bug checklist': {
        'BUG-1 CSS display missing (load bar invisible)': {
          detected: cssErrs.some(e => e.class === 'tl-load-bar-wrap'),
          fix: 'Add "display: block" to .tl-load-bar-wrap in timelapse.css',
        },
        'BUG-2 TextDecoder not flushed (JSON corruption)': {
          detected: consoleErrs.some(e => JSON.stringify(e.args).includes('JSON')),
        },
        'BUG-3 res.body null guard missing': {
          detected: consoleErrs.some(e => JSON.stringify(e.args).includes('getReader')),
        },
        'BUG-4 seekTo O(n) UI freeze': {
          detected: 'manual — seek near end of large history, look for freeze',
        },
        'BUG-5 updateETA overwrites Starting… label': {
          detected: 'manual — check ETA label right after Play',
        },
        'BUG-6 Load bar not hidden after error': {
          detected: fetchErrs.length > 0
            ? 'fetch errors occurred — check tl_loadbar_visibility entries after error'
            : false,
        },
      },
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     REPORT DOWNLOAD
  ═══════════════════════════════════════════════════════════════════════════ */
  function _download() {
    const report = {
      generated:    new Date().toISOString(),
      sessionStart: _startISO,
      errorCount:   _errCount,
      totalEntries: _log.length,
      environment:  _env(),
      performance:  _perfSnapshot(),
      alpine:       _alpineSnapshot(),
      canvas:       _canvasSnapshot(),
      auth:         _authCheck(),
      checklist:    _buildChecklist(),
      log:          _log,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `saint-pixels-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    _entry('report_downloaded', { entries: _log.length, errors: _errCount });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BADGE UI
  ═══════════════════════════════════════════════════════════════════════════ */
  const badge = document.createElement('button');
  badge.id    = 'sp-diag-badge';
  badge.type  = 'button';
  Object.assign(badge.style, {
    position: 'fixed', bottom: '12px', right: '12px', zIndex: '999999',
    background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '10px', color: '#94a3b8', cursor: 'pointer',
    fontSize: '0.75rem', fontFamily: 'ui-monospace, monospace', fontWeight: '600',
    padding: '6px 10px', display: 'none', gap: '6px', alignItems: 'center',
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)', lineHeight: '1.4',
  });
  badge.title = 'Saint-Pixels diagnostic — click to download JSON report';
  badge.addEventListener('click', _download);

  function _updateBadge() {
    if (_errCount === 0) { badge.style.display = 'none'; return; }
    badge.style.display     = 'flex';
    badge.style.borderColor = 'rgba(239,68,68,0.6)';
    badge.style.color       = '#fca5a5';
    badge.textContent       = `🔴 ${_errCount} error${_errCount !== 1 ? 's' : ''} – Download Report`;
  }

  function _appendBadge() { document.body.appendChild(badge); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _appendBadge);
  else _appendBadge();

  /* ═══════════════════════════════════════════════════════════════════════════
     STARTUP SEQUENCE (after DOM is ready)
  ═══════════════════════════════════════════════════════════════════════════ */
  function _onDomReady() {
    _installMutationWatcher();
    _runCSSChecks();
    // Auth check is deferred — window.__token is null until auth.js finishes
    // its /api/me fetch (~200-500ms after load). Running it here produces a
    // false-positive mismatch: localStorage has the token but the overlay is
    // still visible because Alpine hasn't received sp-state-change yet.
    _tryHookTimelapse();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _onDomReady);
  } else {
    _onDomReady();
  }

  // Re-run CSS checks after full page load (stylesheets definitely applied)
  window.addEventListener('load', () => {
    _runCSSChecks();
    _entry('page_load_complete', _perfSnapshot());
  });

  // Auth check: deferred until auth.js has actually resolved.
  //
  // WHY THIS IS TRICKY:
  //   Alpine.js initialises x-data on DOMContentLoaded and immediately
  //   dispatches sp-state-change with currentUser: null — before auth.js
  //   has even started its /api/me fetch. If we run _authCheck() then,
  //   window.__token is still null while sp_token exists in localStorage,
  //   producing a false-positive mismatch every single page load.
  //
  // SOLUTION: listen to sp-state-change but only act when the event
  //   carries a real resolved state — indicated by window.__token being
  //   set (auth succeeded) OR the authOverlay being hidden (Alpine hid it
  //   because currentUser is now truthy). Fall back to a 3 s timeout so
  //   we still catch the no-token / logged-out case.
  (function () {
    let _authCheckDone = false;
    function _runAuthCheckOnce() {
      if (_authCheckDone) return;
      _authCheckDone = true;
      _authCheck();
    }
    function _onStateChange() {
      // window.__token is set by setAuthToken() in auth.js only after
      // /api/me resolves successfully. If it's still falsy, Alpine just
      // initialised with the default currentUser: null — ignore this event
      // and keep waiting for the real resolution.
      const tokenReady  = !!window.__token;
      const overlay     = document.getElementById('authOverlay');
      const overlayGone = overlay ? window.getComputedStyle(overlay).display === 'none' : false;
      if (tokenReady || overlayGone) {
        // Defer by two animation frames so Alpine's x-show directive has time
        // to evaluate and update the overlay's display before we read it.
        // Without this delay the check fires synchronously right after
        // setAuthToken() sets window.__token, catching a 1-3 ms window where
        // window.__token is truthy but Alpine hasn't hidden the overlay yet —
        // producing a spurious auth_state_mismatch error on every page load.
        requestAnimationFrame(() => requestAnimationFrame(_runAuthCheckOnce));
      } else {
        // Re-register for the next sp-state-change (Alpine init fired, not auth)
        window.addEventListener('sp-state-change', _onStateChange, { once: true });
      }
    }
    // Primary trigger: wait for a sp-state-change that carries real auth state
    window.addEventListener('sp-state-change', _onStateChange, { once: true });
    // Fallback: 3 s is enough for /api/me to complete or fail even on slow connections
    setTimeout(_runAuthCheckOnce, 3000);
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════════════════════ */
  window.__diagDownload = _download;
  window.__diagLog      = () => _log;
  window.__diagAlpine   = _alpineSnapshot;
  window.__diagCSS      = _runCSSChecks;
  window.__diagCanvas   = _canvasSnapshot;
  window.__diagAuth     = _authCheck;
  // Backward-compat aliases from old timelapse-diagnostic.js
  window.__tlDiagDownload = _download;
  window.__tlDiagLog      = () => _log;

  console.log(
    '[saint-pixels-diagnostic] loaded — all JS, fetch, SSE, DOM, Alpine, canvas instrumented.\n' +
    'window.__diagDownload() → JSON report  |  window.__diagLog() → raw log\n' +
    'window.__diagAlpine()  → Alpine state  |  window.__diagCSS() → re-run CSS checks'
  );

})();
