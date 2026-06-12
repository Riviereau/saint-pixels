// ═══════════════════════════════════════════════════════════════════
// particles.js — Pixel-place burst particle system
// Spawns small colored squares that fly outward from a placed pixel.
// Runs on a dedicated canvas layered above the overlay.
// Depends on: scale, offsetX, offsetY (from canvas.js)
// ═══════════════════════════════════════════════════════════════════

const _particleCanvas = document.createElement('canvas');
_particleCanvas.id = 'particle-canvas';
_particleCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
const _pCtx = _particleCanvas.getContext('2d');
let   _particles = [];

function _ensureParticleCanvas() {
  const vp = document.getElementById('viewport');
  if (vp && !vp.contains(_particleCanvas)) {
    vp.style.position = 'relative';
    vp.appendChild(_particleCanvas);
    _resizeParticleCanvas();
  }
}

function _resizeParticleCanvas() {
  const vp = document.getElementById('viewport');
  if (!vp) return;
  const r = vp.getBoundingClientRect();
  _particleCanvas.width  = r.width  * (window.devicePixelRatio || 1);
  _particleCanvas.height = r.height * (window.devicePixelRatio || 1);
  _particleCanvas.style.width  = r.width  + 'px';
  _particleCanvas.style.height = r.height + 'px';
}
window.addEventListener('resize', _resizeParticleCanvas);

/**
 * Spawn a burst of particles at a board-pixel coordinate.
 * @param {number} bx       board x
 * @param {number} by       board y
 * @param {string} hexColor e.g. '#ef4444'
 */
function spawnParticles(bx, by, hexColor) {
  _ensureParticleCanvas();
  const dpr = window.devicePixelRatio || 1;
  // Screen position of the board pixel's centre
  const cx = (bx + 0.5) * scale + offsetX;
  const cy = (by + 0.5) * scale + offsetY;
  const count = 16;
  for (let i = 0; i < count; i++) {
    const angle  = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
    const speed  = 1.5 + Math.random() * 2.5;
    _particles.push({
      x:  cx * dpr, y:  cy * dpr,
      vx: Math.cos(angle) * speed * dpr,
      vy: Math.sin(angle) * speed * dpr,
      size: (2 + Math.random() * 3) * dpr,
      alpha: 1,
      color: hexColor,
      decay: 0.035 + Math.random() * 0.025,
    });
  }
  _runParticleLoop();
}

let _particleRaf = null;
function _runParticleLoop() {
  if (_particleRaf) return;
  function tick() {
    _pCtx.clearRect(0, 0, _particleCanvas.width, _particleCanvas.height);
    _particles = _particles.filter(p => p.alpha > 0.02);
    _particles.forEach(p => {
      p.x     += p.vx;
      p.y     += p.vy;
      p.vy    += 0.12 * (window.devicePixelRatio || 1); // tiny gravity
      p.alpha -= p.decay;
      _pCtx.globalAlpha = Math.max(0, p.alpha);
      _pCtx.fillStyle   = p.color;
      _pCtx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    _pCtx.globalAlpha = 1;
    if (_particles.length > 0) {
      _particleRaf = requestAnimationFrame(tick);
    } else {
      _particleRaf = null;
    }
  }
  _particleRaf = requestAnimationFrame(tick);
}
