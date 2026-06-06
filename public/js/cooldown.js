// ═══════════════════════════════════════════════════════════════════
// cooldown.js — Cooldown bar UI + placement gate
// Updates the fill-bar and label in real time via rAF.
// Depends on: currentUser, lastPlaceAt, _activeCooldownMs (state.js)
// ═══════════════════════════════════════════════════════════════════

const cooldownBar      = document.getElementById('cooldownBar');
const cooldownFill     = document.getElementById('cooldownFill');
const cooldownBarLabel = document.getElementById('cooldownBarLabel');

let _cooldownRafId   = null;
let _cooldownLastPct = -1;
let _cooldownLastLabel = '';
let _cooldownLastSec = -1;

function _setCooldownWidth(pct) {
  const rounded = Math.round(Math.max(0, Math.min(100, pct)) * 100) / 100;
  if (rounded === _cooldownLastPct) return;
  _cooldownLastPct = rounded;
  cooldownFill.style.width = rounded + '%';
}

function _setCooldownLabel(text) {
  if (text === _cooldownLastLabel) return;
  _cooldownLastLabel = text;
  cooldownBarLabel.textContent = text;
}

function updateCooldownLabel() {
  if (!cooldownBar || !cooldownFill || !cooldownBarLabel) return;
  if (!currentUser) {
    cooldownBar.classList.add('cooldown-bar--guest');
    cooldownBar.classList.remove('cooldown-bar--cooling');
    _setCooldownWidth(100);
    _setCooldownLabel('Sign in to place pixels');
    if (_cooldownRafId) { cancelAnimationFrame(_cooldownRafId); _cooldownRafId = null; }
    return;
  }

  cooldownBar.classList.remove('cooldown-bar--guest');
  const remaining = Math.max(0, _activeCooldownMs - (Date.now() - lastPlaceAt));
  _setCooldownWidth((1 - remaining / _activeCooldownMs) * 100);

  if (remaining > 0) {
    cooldownBar.classList.add('cooldown-bar--cooling');
    _setCooldownLabel(`Cooldown · ${Math.ceil(remaining / 1000)}s`);

    if (!_cooldownRafId) {
      const tick = () => {
        const rem = Math.max(0, _activeCooldownMs - (Date.now() - lastPlaceAt));
        _setCooldownWidth((1 - rem / _activeCooldownMs) * 100);
        if (rem > 0) {
          const sec = Math.ceil(rem / 1000);
          if (sec !== _cooldownLastSec) {
            _cooldownLastSec = sec;
            _setCooldownLabel(`Cooldown · ${sec}s`);
          }
          _cooldownRafId = requestAnimationFrame(tick);
        } else {
          _setCooldownWidth(100);
          cooldownBar.classList.remove('cooldown-bar--cooling');
          _setCooldownLabel('Ready to place');
          _cooldownLastSec = -1;
          _cooldownRafId = null;
        }
      };
      _cooldownRafId = requestAnimationFrame(tick);
    }
  } else {
    cooldownBar.classList.remove('cooldown-bar--cooling');
    _setCooldownLabel('Ready to place');
    _cooldownLastSec = -1;
    if (_cooldownRafId) { cancelAnimationFrame(_cooldownRafId); _cooldownRafId = null; }
  }
}

/**
 * Returns true when the user is allowed to place a pixel.
 * Adds a 150 ms grace margin so the fetch reliably reaches the server
 * after the server-side cooldown window has fully closed.
 */
function canPlacePixel() {
  return !!currentUser && Date.now() - lastPlaceAt >= _activeCooldownMs + 150;
}
