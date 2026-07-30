// Cloudflare Access token verification.
//
// This is the one file in the project where a bug means strangers reading the
// dashboard, so the tests are mostly about what must be REFUSED. Tokens are
// signed with a throwaway RSA key generated per run — no fixtures, nothing to
// leak, and the signature path is exercised for real rather than stubbed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';

import { verifyAccessJwt, createAccessGuard, readCookie } from '../lib/auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const AUD = 'aud-for-this-app';
const TEAM = 'carscraper.cloudflareaccess.com';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeToken({
  alg = 'RS256', kid = KID, aud = AUD, iss = `https://${TEAM}`,
  email = 'ibrahim@example.com', exp = Math.floor(Date.now() / 1000) + 3600,
  nbf, signWith = privateKey, tamper = false,
} = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ aud, iss, email, exp, nbf, sub: 'user-1' }));
  if (alg === 'none') return `${header}.${payload}.`;
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = b64url(signer.sign(signWith));
  return `${header}.${payload}.${tamper ? b64url('nonsense') : sig}`;
}

/** Stand-in for the live JWKS endpoint. `publicKey` is already a KeyObject. */
const jwks = {
  async keyFor(kid) {
    return kid === KID ? publicKey : null;
  },
};

const verify = (token, over = {}) =>
  verifyAccessJwt(token, { jwks, aud: AUD, teamDomain: TEAM, ...over });

describe('a good token', () => {
  test('is accepted and yields the email', async () => {
    const result = await verify(makeToken());
    assert.equal(result.ok, true);
    assert.equal(result.email, 'ibrahim@example.com');
  });

  test('is accepted when aud is an array containing ours', async () => {
    const result = await verify(makeToken({ aud: ['other-app', AUD] }));
    assert.equal(result.ok, true);
  });
});

describe('forged and broken tokens are refused', () => {
  const rejects = [
    ['no token at all', undefined],
    ['empty string', ''],
    ['not a JWT', 'garbage'],
    ['only two segments', 'a.b'],
    ['undecodable segments', '!!!.???.zzz'],
  ];
  for (const [label, token] of rejects) {
    test(label, async () => {
      const result = await verify(token);
      assert.equal(result.ok, false);
    });
  }

  test('alg:none — the classic forgery — is refused', async () => {
    const result = await verify(makeToken({ alg: 'none' }));
    assert.equal(result.ok, false);
    assert.match(result.error, /alg/);
  });

  test('a tampered signature is refused', async () => {
    const result = await verify(makeToken({ tamper: true }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bad signature');
  });

  test('a token signed by someone else is refused', async () => {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const result = await verify(makeToken({ signWith: attacker.privateKey }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bad signature');
  });

  test('an unknown signing key is refused', async () => {
    const result = await verify(makeToken({ kid: 'some-other-kid' }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown signing key');
  });
});

describe('a validly signed token for the wrong thing is still refused', () => {
  // These are the subtle ones. Cloudflare signs tokens for every Access app in
  // an account with the same keys, so a real signature proves nothing on its
  // own about which app the token was for.
  test('aud belonging to a different Access app', async () => {
    const result = await verify(makeToken({ aud: 'a-different-app' }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'aud mismatch');
  });

  test('a different Cloudflare team', async () => {
    const result = await verify(makeToken({ iss: 'https://someone-else.cloudflareaccess.com' }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'issuer mismatch');
  });

  test('an expired token', async () => {
    const result = await verify(makeToken({ exp: Math.floor(Date.now() / 1000) - 60 }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'token expired');
  });

  test('a token that is not valid yet', async () => {
    const result = await verify(makeToken({ nbf: Math.floor(Date.now() / 1000) + 600 }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'token not yet valid');
  });
});

describe('the request guard', () => {
  const fakeRes = () => {
    const res = { statusCode: null, body: '', headers: null };
    res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
    res.end = (body) => { res.body = body ?? ''; };
    return res;
  };

  test('passes everything through when auth is disabled', async () => {
    const guard = createAccessGuard({ enabled: false });
    const identity = await guard({ headers: {} }, fakeRes());
    assert.equal(identity.email, 'local');
  });

  test('refuses to start when enabled but unconfigured', () => {
    // Booting misconfigured would serve the dashboard to anyone who found the
    // hostname. Failing loudly at startup is the whole point.
    assert.throws(
      () => createAccessGuard({ enabled: true, aud: '', teamDomain: '' }),
      /REQUIRE_AUTH/,
    );
  });

  test('accepts the Cf-Access-Jwt-Assertion header', async () => {
    const guard = createAccessGuard({ enabled: true, aud: AUD, teamDomain: TEAM, jwks });
    const req = { headers: { 'cf-access-jwt-assertion': makeToken() } };
    const identity = await guard(req, fakeRes());
    assert.equal(identity.email, 'ibrahim@example.com');
  });

  test('falls back to the CF_Authorization cookie', async () => {
    const guard = createAccessGuard({ enabled: true, aud: AUD, teamDomain: TEAM, jwks });
    const req = { headers: { cookie: `foo=bar; CF_Authorization=${makeToken()}; baz=qux` } };
    const identity = await guard(req, fakeRes());
    assert.equal(identity.email, 'ibrahim@example.com');
  });

  test('answers 403 and returns null when there is no token', async () => {
    const guard = createAccessGuard({ enabled: true, aud: AUD, teamDomain: TEAM, jwks });
    const res = fakeRes();
    const identity = await guard({ headers: {} }, res);
    assert.equal(identity, null);
    assert.equal(res.statusCode, 403);
  });

  test('a stranger reaching the port directly gets nothing', async () => {
    // The realistic failure: something else on this machine, or a second
    // tunnel, hits 127.0.0.1:5174 with no Cloudflare headers at all.
    const guard = createAccessGuard({ enabled: true, aud: AUD, teamDomain: TEAM, jwks });
    const res = fakeRes();
    const identity = await guard({ headers: { cookie: 'CF_Authorization=' } }, res);
    assert.equal(identity, null);
    assert.equal(res.statusCode, 403);
  });
});

describe('readCookie', () => {
  test('finds a cookie among others', () => {
    assert.equal(readCookie('a=1; CF_Authorization=tok; b=2', 'CF_Authorization'), 'tok');
  });
  test('does not match a suffix of another name', () => {
    assert.equal(readCookie('XCF_Authorization=nope', 'CF_Authorization'), null);
  });
  test('is safe on missing input', () => {
    assert.equal(readCookie(undefined, 'CF_Authorization'), null);
  });
});
