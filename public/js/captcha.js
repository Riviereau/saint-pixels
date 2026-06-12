/**
 * public/captcha.js — Explicit hCaptcha render
 *
 * Why this exists
 * ────────────────
 * hCaptcha's api.js auto-renders any element with class="h-captcha" +
 * data-sitekey exactly ONCE, the moment api.js finishes loading. On mobile,
 * #authOverlay is still x-cloak'd (display:none) at that moment far more
 * reliably than on desktop (Alpine boot delay), so the auto-render scan sees
 * a 0×0 container and silently skips it — permanently, since auto-render
 * only fires once. Result: the reserved space (auth.css) is there, but the
 * widget never appears.
 *
 * Fix: don't use class="h-captcha"/data-sitekey (that triggers auto-render).
 * Instead use data-hcaptcha-sitekey on the container, load api.js with
 * onload=spHcaptchaOnLoad, and call hcaptcha.render(...) explicitly once
 * the container is actually visible. If it's not visible yet (overlay still
 * hidden), retry on a short interval until it is, or until a timeout —
 * at which point we render anyway into the (now presumably visible) node
 * since hCaptcha tolerates being rendered slightly before paint as long as
 * the element has non-zero size at the time of the render call.
 *
 * Exposes:
 *   window.__hcaptchaWidgetId — the rendered widget ID, used by
 *     getCaptchaToken() / resetCaptcha() in auth.js so they operate on
 *     the correct (and only) widget.
 *
 * index.html changes required:
 *   <script src="https://js.hcaptcha.com/1/api.js?onload=spHcaptchaOnLoad&render=explicit" async defer></script>
 *   <script src="/js/captcha.js"></script>
 *
 *   #authCaptchaWrapper's inner container should be:
 *     <div id="hcaptchaContainer" data-hcaptcha-sitekey="YOUR_SITE_KEY"></div>
 *   (remove class="h-captcha" and data-sitekey from it — those trigger
 *   the implicit auto-render path we're avoiding)
 */

(function () {
  'use strict';

  var RETRY_INTERVAL_MS = 200;
  var MAX_WAIT_MS        = 10000;

  var _rendered = false;
  var _hcaptchaApiReady = false;
  var _startTime = null;

  function getContainer() {
    return document.getElementById('hcaptchaContainer');
  }

  function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // Fallback for environments where layout hasn't settled but the
    // element isn't display:none (offsetParent is null for display:none
    // and for fixed-position elements without a positioned ancestor —
    // #authOverlay is fixed, so also check computed display directly).
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function doRender() {
    if (_rendered) return true;
    var container = getContainer();
    if (!container) return false;
    if (typeof hcaptcha === 'undefined') return false;

    try {
      var sitekey = container.getAttribute('data-hcaptcha-sitekey');
      var theme   = container.getAttribute('data-theme') || 'light';
      var size    = container.getAttribute('data-size')  || 'normal';
      window.__hcaptchaWidgetId = hcaptcha.render(container, {
        sitekey: sitekey,
        theme: theme,
        size: size,
      });
      _rendered = true;
      return true;
    } catch (err) {
      // "already contains a hcaptcha iframe" or similar — treat as rendered
      console.warn('[captcha] hcaptcha.render() failed:', err);
      return false;
    }
  }

  function attemptRender() {
    if (_rendered) return;
    if (!_hcaptchaApiReady) return;

    var container = getContainer();
    var visible   = isVisible(container);
    var timedOut  = _startTime !== null && (Date.now() - _startTime) > MAX_WAIT_MS;

    if (visible || timedOut) {
      doRender();
      if (_rendered) return;
    }

    setTimeout(attemptRender, RETRY_INTERVAL_MS);
  }

  // ── hCaptcha API ready callback ───────────────────────────────────────
  // Referenced by the api.js <script> tag: ?onload=spHcaptchaOnLoad
  window.spHcaptchaOnLoad = function () {
    _hcaptchaApiReady = true;
    _startTime = Date.now();
    attemptRender();
  };

  // ── Render-on-visible triggers ────────────────────────────────────────
  // Even after api.js loads, the overlay may still be hidden (Alpine not
  // booted yet). Re-attempt whenever something likely made it visible:
  //   - Alpine removes [x-cloak] / sets display on #authOverlay
  //   - sp-state-change fires with currentUser:null (auth.js shows overlay)
  //   - DOMContentLoaded / load, as a final safety net

  function watchOverlay() {
    var overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    new MutationObserver(function () {
      if (!_rendered && _hcaptchaApiReady) attemptRender();
    }).observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  window.addEventListener('sp-state-change', function (e) {
    if (e && e.detail && e.detail.currentUser === null) {
      if (!_rendered && _hcaptchaApiReady) attemptRender();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchOverlay);
  } else {
    watchOverlay();
  }

  window.addEventListener('load', function () {
    if (!_rendered && _hcaptchaApiReady) attemptRender();
  });
})();
