// ═══════════════════════════════════════════════════════════════════
// BAN SCREEN — add this block near the top of app.js,
// just after the DOMContentLoaded opening brace.
// ═══════════════════════════════════════════════════════════════════

/**
 * showBanScreen(message, reason, expiresAt)
 *
 * Replaces the entire page with a full-screen ban notice.
 * Called whenever any API response comes back with { error: 'banned' }.
 *
 * @param {string}      message   - e.g. "Your account has been permanently banned."
 * @param {string}      reason    - The reason stored in ban-list.json
 * @param {string|null} expiresAt - ISO string, or null for permanent
 */
function showBanScreen(message, reason, expiresAt) {
  // Clear stored token — no point retrying
  try { localStorage.removeItem('sp_token'); } catch { /* ignore */ }

  const expiry = expiresAt
    ? `<p style="color:#94a3b8;margin-top:8px;font-size:0.9rem;">
         Expires: <strong style="color:#e2e8f0">${new Date(expiresAt).toUTCString()}</strong>
       </p>`
    : '';

  document.body.innerHTML = `
    <div style="
      display:flex;align-items:center;justify-content:center;
      min-height:100vh;background:#0f172a;font-family:sans-serif;
      padding:2rem;box-sizing:border-box;">
      <div style="
        max-width:480px;width:100%;background:#1e293b;
        border:1px solid #ef4444;border-radius:16px;padding:2.5rem;
        text-align:center;box-shadow:0 0 40px rgba(239,68,68,0.15);">
        <div style="font-size:3rem;margin-bottom:1rem">⛔</div>
        <h1 style="color:#ef4444;font-size:1.6rem;margin:0 0 0.75rem">
          Account Banned
        </h1>
        <p style="color:#e2e8f0;font-size:1rem;margin:0 0 1rem;line-height:1.5">
          ${escapeHtml(message)}
        </p>
        <div style="
          background:#0f172a;border-radius:10px;padding:1rem;
          text-align:left;margin-bottom:1rem;">
          <p style="color:#94a3b8;margin:0 0 4px;font-size:0.8rem;
                    text-transform:uppercase;letter-spacing:0.05em">Reason</p>
          <p style="color:#fca5a5;margin:0;font-size:0.95rem">
            ${escapeHtml(reason || 'No reason provided.')}
          </p>
        </div>
        ${expiry}
        <p style="color:#475569;font-size:0.8rem;margin-top:1.5rem">
          If you believe this is a mistake, contact the server admin.
        </p>
      </div>
    </div>`;
}

/** Minimal HTML escaper — prevents reason text from injecting markup. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * handleApiBanResponse(data, response)
 *
 * Call this inside every fetch() error-handling block.
 * Returns true if the response was a ban (caller should stop processing).
 *
 * Usage:
 *   const data = await response.json();
 *   if (!response.ok) {
 *     if (handleApiBanResponse(data, response)) return;
 *     showAuthMessage(data.error || 'Something went wrong.');
 *     return;
 *   }
 *
 * @param {object} data       - Parsed JSON response body
 * @param {Response} response - The raw fetch Response
 * @returns {boolean}
 */
function handleApiBanResponse(data, response) {
  if (response.status === 403 && data?.error === 'banned') {
    showBanScreen(
      data.message  || 'Your account has been banned.',
      data.reason   || '',
      data.expiresAt || null
    );
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// PATCH EXISTING HANDLERS — find the two spots below in app.js
// and add ONE line each (marked with // ← ADD THIS):
// ═══════════════════════════════════════════════════════════════════

// ── In handleLogin(), replace the !response.ok block: ──────────────
//
//   const data = await response.json();
//   if (!response.ok) {
//     resetCaptcha();
//     if (handleApiBanResponse(data, response)) return;  // ← ADD THIS
//     showAuthMessage(data.error || 'Login failed.');
//     return;
//   }

// ── In updateAuthState(), replace the 401/403 block: ───────────────
//
//   if (!response.ok) {
//     if (response.status === 403) {
//       const data = await response.json().catch(() => ({}));
//       if (handleApiBanResponse(data, response)) return;  // ← ADD THIS
//     }
//     if (response.status === 401 || response.status === 403) {
//       clearToken();
//       ...
//     }
//   }
