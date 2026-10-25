/**
 * web_fetch 私网 / 回环目的地判定（供 lh-web 与单测共用）。
 */

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHostname(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (isPrivateIp(h)) return true;
  // IPv4-mapped IPv6
  const v4mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4mapped && isPrivateIp(v4mapped[1])) return true;
  return false;
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  const s = String(ip || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!s) return true;
  if (s === '::1' || s === '::' || s === '0.0.0.0') return true;

  // IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split('.').map((x) => Number(x));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // IPv6 ULA fc00::/7, link-local fe80::/10
  if (s.includes(':')) {
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (/^fe[89ab]/i.test(s)) return true;
    if (s === '::1') return true;
    const v4m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4m) return isPrivateIp(v4m[1]);
  }
  return false;
}

/**
 * @param {string} hostname
 * @param {boolean} allowPrivate
 * @returns {boolean} true = 应拦截
 */
export function shouldBlockHost(hostname, allowPrivate = false) {
  if (allowPrivate) return false;
  return isPrivateHostname(hostname);
}

/**
 * @param {string} ip
 * @param {boolean} allowPrivate
 * @returns {boolean}
 */
export function shouldBlockIp(ip, allowPrivate = false) {
  if (allowPrivate) return false;
  return isPrivateIp(ip);
}
