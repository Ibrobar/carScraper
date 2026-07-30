// Cloudflare Access identity, verified here rather than trusted.
//
// The dashboard reaches the internet through a Cloudflare Tunnel, and
// Cloudflare Access sits in front of it asking for an email login. Access
// stamps every allowed request with a signed JWT in `Cf-Access-Jwt-Assertion`.
//
// Why verify it ourselves when Access already blocked the request:
// `cloudflared` connects OUT to Cloudflare and forwards to 127.0.0.1:5174.
// Anything else that can reach that port — another process on this machine, a
// second tunnel someone points at it, an Access policy edited to "allow
// everyone" by mistake — reaches the dashboard with no login at all. Checking
// the signature makes the app itself refuse those, so a tunnel misconfiguration
// is a locked door instead of an open one.
//
// Zero dependency: RS256 is `crypto.verify` and the JWKS is public JSON.
// See docs/DEPLOY.md for where TEAM_DOMAIN and AUD come from.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const b64urlToBuffer = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const decodeJson = (s) => JSON.parse(b64urlToBuffer(s).toString('utf8'));

/**
 * Fetch and cache Cloudflare's signing keys.
 *
 * Cached because this is on every request. Cloudflare rotates keys, so the
 * cache expires; a miss on an unknown `kid` also forces a refetch so rotation
 * doesn't lock everyone out until the TTL lapses.
 */
export function createJwksCache(teamDomain, { ttlMs = 60 * 60 * 1000, fetchImpl = fetch } = {}) {
  let keys = new Map();
  let fetchedAt = 0;

  async function refresh() {
    const url = `https://${teamDomain}/cdn-cgi/access/certs`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    if (!next.size) throw new Error('JWKS contained no usable keys');
    keys = next;
    fetchedAt = Date.now();
  }

  return {
    async keyFor(kid) {
      const stale = Date.now() - fetchedAt > ttlMs;
      if (stale || !keys.has(kid)) await refresh();
      return keys.get(kid) ?? null;
    },
    // Test seam.
    _set(kid, key) { keys.set(kid, key); fetchedAt = Date.now(); },
  };
}

/**
 * Verify an Access JWT.
 *
 * @returns {Promise<{ ok: true, email: string, sub: string } | { ok: false, error: string }>}
 */
export async function verifyAccessJwt(token, { jwks, aud, teamDomain, now = Date.now() } = {}) {
  if (!token) return { ok: false, error: 'no token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed token' };
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header;
  let payload;
  try {
    header = decodeJson(rawHeader);
    payload = decodeJson(rawPayload);
  } catch {
    return { ok: false, error: 'undecodable token' };
  }

  // Only RS256. Notably this rejects `alg: none`, the classic JWT forgery.
  if (header.alg !== 'RS256') return { ok: false, error: `unexpected alg ${header.alg}` };
  if (!header.kid) return { ok: false, error: 'no kid' };

  const key = await jwks.keyFor(header.kid);
  if (!key) return { ok: false, error: 'unknown signing key' };

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
  const valid = cryptoVerify('RSA-SHA256', signed, key, b64urlToBuffer(rawSignature));
  if (!valid) return { ok: false, error: 'bad signature' };

  // A valid signature from Cloudflare is not enough on its own: `aud` is what
  // ties the token to THIS application. Without it, a token minted for any
  // other app in the same Cloudflare account would be accepted here.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud || !audiences.includes(aud)) return { ok: false, error: 'aud mismatch' };

  if (teamDomain && payload.iss !== `https://${teamDomain}`) {
    return { ok: false, error: 'issuer mismatch' };
  }

  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp === 'number' && seconds >= payload.exp) {
    return { ok: false, error: 'token expired' };
  }
  if (typeof payload.nbf === 'number' && seconds < payload.nbf) {
    return { ok: false, error: 'token not yet valid' };
  }

  return { ok: true, email: payload.email ?? null, sub: payload.sub ?? null };
}

/**
 * Request guard for the dashboard.
 *
 * Returns the identity when the request may proceed, or null after having
 * already written a response.
 *
 * When auth is disabled (the default, for localhost use) every request passes
 * as the local user — that keeps `npm run dashboard` working with no setup.
 */
export function createAccessGuard({ enabled, aud, teamDomain, jwks }) {
  if (!enabled) {
    return async () => ({ email: 'local', sub: 'local' });
  }
  if (!aud || !teamDomain) {
    throw new Error(
      'REQUIRE_AUTH is on but ACCESS_AUD / ACCESS_TEAM_DOMAIN are unset. ' +
      'Refusing to start: that combination would serve the dashboard unprotected.',
    );
  }
  const cache = jwks ?? createJwksCache(teamDomain);

  return async function guard(req, res) {
    const token = req.headers['cf-access-jwt-assertion']
      ?? readCookie(req.headers.cookie, 'CF_Authorization');

    const result = await verifyAccessJwt(token, { jwks: cache, aud, teamDomain });
    if (result.ok) return { email: result.email, sub: result.sub };

    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Forbidden: ${result.error}\n`);
    return null;
  };
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
