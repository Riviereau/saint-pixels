// ═══════════════════════════════════════════════════════════════════
// auth.js — Authentication
// Login, register, logout, ban screen, password reset, captcha helpers,
// auth mode tabs, email verification banner, password visibility toggle.
// Depends on: currentUser, lastPlaceAt, _activeCooldownMs (state.js)
//             dispatchStateChange (state.js)
//             updateCooldownLabel (cooldown.js)
//             fetchStreakAndStats (events.js)
// ═══════════════════════════════════════════════════════════════════

// ── DOM refs ────────────────────────────────────────────────────────
const authUsername      = document.getElementById('authUsername');
const authPassword      = document.getElementById('authPassword');
const authEmail         = document.getElementById('authEmail');
const authEmailLabel    = document.getElementById('authEmailLabel');
const authMessage       = document.getElementById('authMessage');

// ── Environment helpers ──────────────────────────────────────────────
/**
 * Returns true when the captcha bypass should be active.
 * Matches the server-side isPrivateIp() logic in captcha.js so that loopback
 * AND LAN phones are bypassed without needing the server to inject any
 * data-local-bypass attribute on <html> (which was never being set anyway).
 */
function isLocalDev() {
  const { hostname } = window.location;

  // Loopback — always bypass
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

  // IPv6 link-local
  if (/^\[?fe80:/i.test(hostname)) return true;

  // RFC-1918 private ranges — bypass unconditionally, no server flag needed
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    return (
      a === 10 ||                          // 10.x.x.x
      (a === 172 && b >= 16 && b <= 31) || // 172.16-31.x.x
      (a === 192 && b === 168)             // 192.168.x.x
    );
  }

  return false;
}

// ── Storage keys ────────────────────────────────────────────────────
// TOKEN_KEY ('sp_token') is declared in app.js — do NOT redeclare it here.
const EMAIL_VERIFIED_KEY = 'sp_email_verified';

// ── Token helpers ────────────────────────────────────────────────────
function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function saveToken(token) {
  // Keep localStorage in sync AND update window.__token via setAuthToken
  // (defined in app.js) so chat.js and timelapse-ui.js always see the
  // current token without each having to read localStorage themselves.
  setAuthToken(token);
}
function clearToken() {
  setAuthToken(null);
  localStorage.removeItem(EMAIL_VERIFIED_KEY);
}

// ── Ban screen ───────────────────────────────────────────────────────
/** Escape a string for safe insertion into HTML (prevents XSS). */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showBanScreen(info = {}) {
  let expiryLine = '';
  if (info.expiresAt) {
    const d = new Date(info.expiresAt);
    expiryLine = `<p style="margin:.4em 0 0;font-size:.9em;opacity:.75;">
      Ban expires: ${escapeHtml(d.toLocaleString())}
    </p>`;
  }
  const reason  = escapeHtml(info.reason  || 'No reason provided.');
  const message = escapeHtml(info.message || 'You are banned from Saint Pixels.');

  const screen = document.createElement('div');
  screen.id = 'ban-screen';
  screen.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'background:rgba(10,10,15,0.97)',
    'color:#fff', 'font-family:sans-serif',
    'text-align:center', 'padding:2rem',
    'pointer-events:all',
  ].join(';');
  screen.innerHTML = `
    <div style="font-size:3rem;margin-bottom:.5rem;">🔨</div>
    <h1 style="margin:0 0 .5rem;font-size:1.6rem;">${message}</h1>
    <p  style="margin:0;opacity:.8;max-width:480px;">${reason}</p>
    ${expiryLine}
    <p style="margin:1.5rem 0 0;font-size:.8em;opacity:.5;">
      If you believe this is a mistake, contact a moderator.
    </p>`;
  document.body.classList.remove('auth-open');
  document.body.appendChild(screen);
}

function handleApiBanResponse(data, response) {
  if (response.status === 403 && data?.error === 'banned') {
    showBanScreen(data);
    return true;
  }
  return false;
}

// ── Captcha helpers ──────────────────────────────────────────────────
// captcha.js renders the hCaptcha widget explicitly (avoids the
// auto-render-skips-hidden-elements bug on mobile) and stores the
// resulting widget ID on window.__hcaptchaWidgetId. We pass that ID
// to getResponse()/reset() so they target the right (and only) widget
// even if hCaptcha hasn't finished rendering yet.
function getCaptchaToken() {
  if (isLocalDev()) return 'dev-bypass';
  if (typeof hcaptcha !== 'undefined' && window.__hcaptchaWidgetId !== undefined) {
    const response = hcaptcha.getResponse(window.__hcaptchaWidgetId);
    return response || null;
  }
  // hCaptcha widget failed to load/render — return null so the caller shows
  // the "please complete the captcha" message rather than sending a
  // 'dev-bypass' token that the server will reject with a confusing error.
  return null;
}

function resetCaptcha() {
  if (isLocalDev()) return;
  if (typeof hcaptcha !== 'undefined' && window.__hcaptchaWidgetId !== undefined) {
    hcaptcha.reset(window.__hcaptchaWidgetId);
  }
  window.__hcaptchaExpired = false;
}

/**
 * Returns a user-facing string for why we don't have a usable captcha
 * token right now. Distinguishes "never solved it" from "solved it, but
 * it expired" (captcha.js sets window.__hcaptchaExpired via the
 * expired-callback) so the message actually matches what happened.
 */
function getCaptchaMissingMessage() {
  return window.__hcaptchaExpired
    ? 'Your captcha expired — please solve it again.'
    : 'Please complete the captcha.';
}

// ── Auth message ─────────────────────────────────────────────────────
function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

// ── Alpine bridge ─────────────────────────────────────────────────────
// #authOverlay's visibility is driven by Alpine's x-show on <body>'s
// x-data (currentUser / showAuth / guestObserver) — NOT by the legacy
// `currentUser` global variable or the `auth-open` body class used
// throughout this file. dispatchStateChange() (state.js) only fires the
// 'sp-state-change' DOM event; nothing was applying that to Alpine's
// reactive data, so logging in successfully never closed the overlay
// (and logging out never reliably reopened it). Mirror every state
// change into Alpine here.
window.addEventListener('sp-state-change', function (e) {
  if (!window.Alpine || typeof window.Alpine.$data !== 'function') return;
  const data = window.Alpine.$data(document.body);
  if (!data || !e || !e.detail) return;
  if ('currentUser' in e.detail) {
    data.currentUser = e.detail.currentUser;
    // Logged in: drop the forced-open flag so the (!currentUser && ...)
    // half of x-show is what's actually deciding visibility from here on.
    if (e.detail.currentUser) data.showAuth = false;
  }
  if ('emailVerified' in e.detail) data.emailVerified = e.detail.emailVerified;
  // liveCount (Live Players chip, desktop + mobile) is only ever pushed
  // through dispatchStateChange({ liveCount }) in broadcast.js — without
  // mirroring it here it never reaches Alpine's reactive data, so the
  // x-text="liveCount" bindings stay frozen at the x-data default (0)
  // forever, even though the SSE 'clients' event is firing correctly.
  if ('liveCount' in e.detail) data.liveCount = e.detail.liveCount;
});

// ── Auth state ───────────────────────────────────────────────────────
async function updateAuthState(retryCount = 0) {
  const token = getStoredToken();
  if (!token) {
    currentUser = null;
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        if (response.status === 403) {
          const errData = await response.json().catch(() => ({}));
          if (handleApiBanResponse(errData, response)) return;
        }
        clearToken();
        currentUser = null;
        dispatchStateChange({ currentUser: null, emailVerified: false });
        document.body.classList.add('auth-open');
        authUsername.focus();
        return;
      }
      if (retryCount < 1) {
        setTimeout(() => updateAuthState(retryCount + 1), 2000);
        return;
      }
      clearToken();
      currentUser = null;
      dispatchStateChange({ currentUser: null, emailVerified: false });
      document.body.classList.add('auth-open');
      authUsername.focus();
      return;
    }

    const data = await response.json();
    currentUser = data.username;

    const totalMs = (data.cooldownMs > 0) ? data.cooldownMs : _activeCooldownMs;
    if (totalMs > 0) _activeCooldownMs = totalMs;
    if (data.cooldown && data.cooldown > 0) {
      lastPlaceAt = Date.now() - (totalMs - data.cooldown);
    } else {
      lastPlaceAt = 0;
    }

    const locallyVerified = localStorage.getItem(EMAIL_VERIFIED_KEY) === '1';
    const emailVerified = !!data.emailVerified || locallyVerified;
    if (data.emailVerified) localStorage.setItem(EMAIL_VERIFIED_KEY, '1');

    window.__username = data.username;
    setAuthToken(token);
    dispatchStateChange({ currentUser: data.username, emailVerified });
    document.body.classList.remove('auth-open');
    authMessage.textContent = '';
    updateCooldownLabel();
  } catch (error) {
    if (retryCount < 1) {
      setTimeout(() => updateAuthState(retryCount + 1), 2000);
      return;
    }
    currentUser = null;
    window.__username = null;
    setAuthToken(null);
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
  }
}

function setCurrentUser(username, emailVerified = false, cooldown = 0, cooldownMs = 0) {
  currentUser = username;
  const totalMs = cooldownMs > 0 ? cooldownMs : _activeCooldownMs;
  if (totalMs > 0) _activeCooldownMs = totalMs;
  if (cooldown && cooldown > 0) {
    lastPlaceAt = Date.now() - (totalMs - cooldown);
  } else {
    lastPlaceAt = 0;
  }
  window.__username = username;
  setAuthToken(getStoredToken());
  dispatchStateChange({ currentUser: username, emailVerified: !!emailVerified });
  document.body.classList.remove('auth-open');
  showAuthMessage('');
  updateCooldownLabel();
  fetchStreakAndStats().then(() => {
    fetch(`/api/profile/${encodeURIComponent(username)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          _totalPixelCount = d.totalPixels    || 0;
          _currentStreak   = d.currentStreak  || 0;
          _longestStreak   = d.longestStreak  || 0;
          updateStreakBadge();
        }
      }).catch(() => {});
  });
}

async function handleLogout() {
  const token = getStoredToken();
  if (token) {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    } catch { /* ignore */ }
  }
  clearToken();
  currentUser = null;
  window.__username = null;
  setAuthToken(null);
  lastPlaceAt = 0;
  dispatchStateChange({ currentUser: null });
  showAuthMessage('Logged out', false);
  updateCooldownLabel();
}

async function handleLogin(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) { showAuthMessage('Enter username and password.'); return; }

  const captchaToken = getCaptchaToken();
  if (!captchaToken && !isLocalDev()) { showAuthMessage(getCaptchaMissingMessage()); return; }

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, captchaToken })
    });
    const data = await response.json();
    if (!response.ok) {
      resetCaptcha();
      if (handleApiBanResponse(data, response)) return;
      showAuthMessage(data.error || 'Login failed.');
      return;
    }
    resetCaptcha();
    saveToken(data.token);
    setCurrentUser(data.username, data.emailVerified, data.cooldown, data.cooldownMs);
  } catch { resetCaptcha(); showAuthMessage('Unable to reach server.'); }
}

async function handleRegister(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  const email = authEmail ? authEmail.value.trim() : '';

  if (!username || !password) { showAuthMessage('Enter username and password.'); return; }
  if (!email)                  { showAuthMessage('Enter your email address.');    return; }

  const authRulesCheck = document.getElementById('authRulesCheck');
  if (!authRulesCheck || !authRulesCheck.checked) {
    showAuthMessage('Please read and agree to the community rules.');
    return;
  }

  const captchaToken = getCaptchaToken();
  if (!captchaToken && !isLocalDev()) { showAuthMessage(getCaptchaMissingMessage()); return; }

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email, captchaToken })
    });
    const data = await response.json();
    if (!response.ok) {
      resetCaptcha();
      showAuthMessage(data.error || 'Registration failed.');
      return;
    }
    resetCaptcha();
    saveToken(data.token);
    setCurrentUser(data.username, data.emailVerified, data.cooldown, data.cooldownMs);
    if (data.message) setTimeout(() => showAuthMessage(data.message, false), 100);
  } catch { resetCaptcha(); showAuthMessage('Unable to reach server.'); }
}

// ── Auth mode tabs ────────────────────────────────────────────────────
let authMode = 'login';

const authTabLogin    = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');
const authSubmit      = document.getElementById('authSubmit');

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === 'register';

  if (authEmailLabel) authEmailLabel.style.display = isRegister ? '' : 'none';

  const rulesRow   = document.getElementById('authRulesRow');
  const rulesCheck = document.getElementById('authRulesCheck');
  if (rulesRow) rulesRow.style.display = isRegister ? '' : 'none';
  if (!isRegister && rulesCheck) rulesCheck.checked = false;

  const captchaWrapper = document.getElementById('authCaptchaWrapper');
  if (captchaWrapper) captchaWrapper.style.display = '';

  if (authSubmit) authSubmit.textContent = isRegister ? 'Create account' : 'Login';

  if (authTabLogin) {
    authTabLogin.classList.toggle('bg-white/10',        !isRegister);
    authTabLogin.classList.toggle('border-white/20',    !isRegister);
    authTabLogin.classList.toggle('border-transparent',  isRegister);
    authTabLogin.classList.toggle('text-white',         !isRegister);
    authTabLogin.classList.toggle('text-slate-400',      isRegister);
    authTabLogin.classList.toggle('hover:text-white',    isRegister);
  }
  if (authTabRegister) {
    authTabRegister.classList.toggle('bg-white/10',        isRegister);
    authTabRegister.classList.toggle('border-white/20',    isRegister);
    authTabRegister.classList.toggle('border-transparent', !isRegister);
    authTabRegister.classList.toggle('text-white',         isRegister);
    authTabRegister.classList.toggle('text-slate-400',    !isRegister);
    authTabRegister.classList.toggle('hover:text-white',  !isRegister);
  }
}

function syncPasswordAutocomplete() {
  if (authPassword) {
    authPassword.setAttribute('autocomplete',
      authMode === 'register' ? 'new-password' : 'current-password');
  }
}

if (authTabLogin)    authTabLogin.addEventListener('click',    () => { setAuthMode('login');    syncPasswordAutocomplete(); });
if (authTabRegister) authTabRegister.addEventListener('click', () => { setAuthMode('register'); syncPasswordAutocomplete(); });

if (authSubmit) {
  authSubmit.addEventListener('click', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

const authForm = document.getElementById('authForm');
if (authForm) {
  authForm.addEventListener('submit', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

const logoutButton = document.getElementById('logoutButton');
if (logoutButton) {
  logoutButton.addEventListener('click', event => { event.preventDefault(); handleLogout(); });
}

if (authPassword) authPassword.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  }
});
if (authUsername) authUsername.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (authPassword && !authPassword.value) authPassword.focus();
    else if (authMode === 'register') handleRegister(); else handleLogin();
  }
});

// Initialise to login mode
setAuthMode('login');
syncPasswordAutocomplete();

// ── Mobile keyboard scroll fix ────────────────────────────────────────
(function setupAuthKeyboardScroll() {
  if (!window.visualViewport) return;
  const authOverlay = document.getElementById('authOverlay');
  if (!authOverlay) return;
  function scrollFocusedInputIntoView() {
    const focused = document.activeElement;
    if (!focused || !authOverlay.contains(focused)) return;
    requestAnimationFrame(() => { focused.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  }
  window.visualViewport.addEventListener('resize', scrollFocusedInputIntoView);
})();

// ── Rules window link ─────────────────────────────────────────────────
const authRulesLink = document.getElementById('authRulesLink');
function openRulesWindow() {
  const win = document.getElementById('sp-rules-window');
  if (win) win.style.display = 'flex';
}
if (authRulesLink) authRulesLink.addEventListener('click', openRulesWindow);

// ── Forgot password row sync ──────────────────────────────────────────
const forgotPasswordRow = document.getElementById('forgotPasswordRow');
if (forgotPasswordRow) {
  const authTabLoginEl    = document.getElementById('authTabLogin');
  const authTabRegisterEl = document.getElementById('authTabRegister');
  function syncForgotRow() {
    const isRegister = authTabRegisterEl && authTabRegisterEl.classList.contains('bg-white/10');
    forgotPasswordRow.style.display = isRegister ? 'none' : '';
  }
  if (authTabLoginEl)    authTabLoginEl.addEventListener('click',    syncForgotRow);
  if (authTabRegisterEl) authTabRegisterEl.addEventListener('click', syncForgotRow);
}

// ── Email verification banner ─────────────────────────────────────────
const resendVerifyBtn = document.getElementById('resendVerifyBtn');
const resendMsg       = document.getElementById('resendMsg');
if (resendVerifyBtn) {
  let resendCooling = false;
  resendVerifyBtn.addEventListener('click', async () => {
    if (resendCooling) return;
    resendCooling = true;
    resendVerifyBtn.disabled = true;
    resendVerifyBtn.style.opacity = '0.5';
    if (resendMsg) resendMsg.textContent = 'Sending…';
    try {
      const token = getStoredToken();
      const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (resendMsg) resendMsg.textContent = res.ok
        ? (data.message || 'Sent! Check your inbox.')
        : (data.error  || 'Could not send — try again.');
    } catch {
      if (resendMsg) resendMsg.textContent = 'Could not send — try again.';
    }
    setTimeout(() => {
      resendCooling = false;
      resendVerifyBtn.disabled = false;
      resendVerifyBtn.style.opacity = '';
    }, 10000);
  });
}

// Handle ?verified=1 redirect from email link
(function checkVerifiedParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('verified') === '1') {
    localStorage.setItem(EMAIL_VERIFIED_KEY, '1');
    dispatchStateChange({ emailVerified: true });
    history.replaceState(null, '', window.location.pathname);
  }
})();

// ── Password visibility toggle ────────────────────────────────────────
const togglePasswordBtn = document.getElementById('togglePassword');
const EYE_OPEN_SVG   = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

const eyeIconOpen   = document.getElementById('eyeIconOpen');
const eyeIconClosed = document.getElementById('eyeIconClosed');
if (eyeIconOpen   && eyeIconOpen.tagName   === 'IMG') eyeIconOpen.outerHTML   = `<span id="eyeIconOpen"   style="display:inline-flex;align-items:center;pointer-events:none;">${EYE_OPEN_SVG}</span>`;
if (eyeIconClosed && eyeIconClosed.tagName === 'IMG') eyeIconClosed.outerHTML = `<span id="eyeIconClosed" style="display:none;align-items:center;pointer-events:none;">${EYE_CLOSED_SVG}</span>`;

if (togglePasswordBtn && authPassword) {
  const getEyeOpen   = () => document.getElementById('eyeIconOpen');
  const getEyeClosed = () => document.getElementById('eyeIconClosed');
  togglePasswordBtn.addEventListener('click', () => {
    const isHidden = authPassword.type === 'password';
    authPassword.type = isHidden ? 'text' : 'password';
    const eo = getEyeOpen();
    const ec = getEyeClosed();
    if (eo) eo.style.display = isHidden ? 'none'        : 'inline-flex';
    if (ec) ec.style.display = isHidden ? 'inline-flex' : 'none';
  });
}

// ── Forgot / Reset password flow ──────────────────────────────────────
const resetOverlay     = document.getElementById('resetPasswordOverlay');
const resetModalClose  = document.getElementById('resetModalClose');
const resetStep1       = document.getElementById('resetStep1');
const resetStep2       = document.getElementById('resetStep2');
const resetEmailInput  = document.getElementById('resetEmail');
const resetNewPassword = document.getElementById('resetNewPassword');
const resetSendBtn     = document.getElementById('resetSendBtn');
const resetConfirmBtn  = document.getElementById('resetConfirmBtn');
const resetMessage     = document.getElementById('resetMessage');
const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');

const toggleResetPasswordBtn = document.getElementById('toggleResetPassword');
const resetEyeIconOpen       = document.getElementById('resetEyeIconOpen');
const resetEyeIconClosed     = document.getElementById('resetEyeIconClosed');
if (toggleResetPasswordBtn && resetNewPassword && resetEyeIconOpen && resetEyeIconClosed) {
  toggleResetPasswordBtn.addEventListener('click', () => {
    const isHidden = resetNewPassword.type === 'password';
    resetNewPassword.type = isHidden ? 'text' : 'password';
    resetEyeIconOpen.style.display   = isHidden ? 'none' : '';
    resetEyeIconClosed.style.display = isHidden ? ''     : 'none';
  });
}

function showResetMessage(msg, isError = true) {
  if (!resetMessage) return;
  resetMessage.textContent = msg;
  resetMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function openResetModal(showStep2 = false, token = '') {
  if (!resetOverlay) return;
  resetOverlay.style.display = 'grid';
  showResetMessage('');
  if (showStep2) {
    if (resetStep1) resetStep1.style.display = 'none';
    if (resetStep2) resetStep2.style.display = '';
    resetOverlay._resetToken = token;
  } else {
    if (resetStep1) resetStep1.style.display = '';
    if (resetStep2) resetStep2.style.display = 'none';
    resetOverlay._resetToken = '';
    if (resetEmailInput)  resetEmailInput.value  = '';
    if (resetNewPassword) resetNewPassword.value = '';
  }
}

function closeResetModal() {
  if (resetOverlay) resetOverlay.style.display = 'none';
}

if (forgotPasswordBtn) forgotPasswordBtn.addEventListener('click', () => openResetModal(false));
if (resetModalClose)   resetModalClose.addEventListener('click', closeResetModal);
if (resetOverlay)      resetOverlay.addEventListener('click', e => { if (e.target === resetOverlay) closeResetModal(); });

if (resetSendBtn) {
  resetSendBtn.addEventListener('click', async () => {
    const email = resetEmailInput ? resetEmailInput.value.trim() : '';
    if (!email) { showResetMessage('Enter your email address.'); return; }
    resetSendBtn.disabled = true;
    resetSendBtn.textContent = 'Sending…';
    try {
      await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      showResetMessage('If that email is registered, a reset link has been sent. Check your inbox (and spam folder).', false);
      resetSendBtn.textContent = 'Sent!';
    } catch {
      showResetMessage('Unable to reach server. Try again.');
      resetSendBtn.disabled = false;
      resetSendBtn.textContent = 'Send reset link';
    }
  });
}

if (resetConfirmBtn) {
  resetConfirmBtn.addEventListener('click', async () => {
    const password = resetNewPassword ? resetNewPassword.value : '';
    const token = resetOverlay ? resetOverlay._resetToken : '';
    if (!password || password.length < 8) { showResetMessage('Password must be at least 8 characters.'); return; }
    if (!token) { showResetMessage('Missing reset token.'); return; }
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        showResetMessage(data.error || 'Reset failed.');
        resetConfirmBtn.disabled = false;
        resetConfirmBtn.textContent = 'Set new password';
        return;
      }
      showResetMessage('Password updated! You can now log in.', false);
      resetConfirmBtn.textContent = 'Done ✓';
      const url = new URL(window.location.href);
      url.searchParams.delete('resetToken');
      window.history.replaceState({}, '', url.toString());
    } catch {
      showResetMessage('Unable to reach server.');
      resetConfirmBtn.disabled = false;
      resetConfirmBtn.textContent = 'Set new password';
    }
  });
}

(function checkResetToken() {
  const params = new URLSearchParams(window.location.search);
  const rt = params.get('resetToken');
  if (rt) openResetModal(true, rt);
})();
