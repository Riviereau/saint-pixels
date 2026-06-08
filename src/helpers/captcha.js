/**
 * hCaptcha server-side verification helper.
 * Docs: https://docs.hcaptcha.com/#server
 */

const https = require('https');
const querystring = require('querystring');

const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';

/**
 * Verify an hCaptcha token sent by the browser.
 *
 * @param {string} token  - The h-captcha-response value from the form
 * @returns {Promise<{ success: boolean, errorCodes?: string[] }>}
 */
function verifyCaptcha(token, { isMobileDebug = false } = {}) {
  return new Promise((resolve) => {
    const secret = process.env.HCAPTCHA_SECRET;

    // If no secret is configured (local dev without .env), skip verification.
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[captcha] HCAPTCHA_SECRET not set in production');
        return resolve({ success: false, errorCodes: ['missing-secret'] });
      }
      console.warn('[captcha] HCAPTCHA_SECRET not set — skipping captcha verification (dev mode)');
      return resolve({ success: true });
    }

    // Accept the dev-bypass token when the mobileDebug flag is active on the
    // server. This lets phones on the LAN log in without a real captcha solve,
    // matching the client-side isLocalDev() bypass in auth.js.
    if (token === 'dev-bypass' && isMobileDebug) {
      console.warn('[captcha] dev-bypass accepted (mobileDebug mode)');
      return resolve({ success: true });
    }

    if (!token) {
      return resolve({ success: false, errorCodes: ['missing-input-response'] });
    }

    const postData = querystring.stringify({ secret, response: token });

    const options = {
      method: 'POST',
      hostname: 'hcaptcha.com',
      path: '/siteverify',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({
            success: !!data.success,
            errorCodes: data['error-codes'] || [],
          });
        } catch {
          resolve({ success: false, errorCodes: ['parse-error'] });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[captcha] hCaptcha request failed:', err.message);
      resolve({ success: false, errorCodes: ['network-error'] });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Returns true if the request originates from loopback or RFC-1918 private
 * address space — mirrors the client-side isLocalDev() check in auth.js.
 * Works behind a local reverse proxy via x-forwarded-for.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isPrivateIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6

  if (raw === '127.0.0.1' || raw === '::1' || raw === 'localhost') return true;

  const parts = raw.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) return false;
  const [, a, b] = parts.map(Number);
  return (
    a === 10 ||                          // 10.x.x.x
    (a === 172 && b >= 16 && b <= 31) || // 172.16–31.x.x
    (a === 192 && b === 168)             // 192.168.x.x
  );
}

/**
 * Express middleware — rejects the request with 400 if captcha is invalid.
 * Reads `req.body.captchaToken`.
 *
 * Accepts the 'dev-bypass' token when the request comes from loopback or a
 * private-network IP (LAN phones, etc.), matching the client-side isLocalDev()
 * logic in auth.js. app.locals.mobileDebug can still be set to force this on
 * for non-standard setups, but is no longer required.
 */
async function requireCaptcha(req, res, next) {
  const token = req.body?.captchaToken;
  const isMobileDebug = !!req.app.locals.mobileDebug || isPrivateIp(req);
  const result = await verifyCaptcha(token, { isMobileDebug });
  if (!result.success) {
    return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
  }
  next();
}

module.exports = { verifyCaptcha, requireCaptcha, isPrivateIp };
