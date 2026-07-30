# Going live — Cloudflare Tunnel

Puts the dashboard on a real HTTPS address that you and 1-2 trusted people can log into, **without
moving the scraper off your home IP and without opening a port on your router.**

Read this if you're standing the deployment up, changing who has access, or the tunnel broke.

---

## Why this shape

The scraper is the fragile, valuable half. It logs into Facebook with a real account, and Facebook
treats a datacenter IP far more harshly than a residential one — a login from a Hetzner or
DigitalOcean range is the single most likely thing to get the account checkpointed. So the scraper
stays exactly where it is, on your machine, on your home connection, on the existing scheduled task.

Only the *view* goes public, and it goes public by dialling out rather than opening up:

```
Your Windows PC                                    Internet
┌────────────────────────────────┐
│ scrape (task, 2x/day) ─────────┼──── home IP ────────────▶ Facebook
│ data/carscraper.db             │
│ dashboard  127.0.0.1:5174      │
│      ▲                         │
│      │ localhost only          │
│ cloudflared ───────────────────┼──── outbound ──────────▶ Cloudflare
└────────────────────────────────┘                              │
                                                    Cloudflare Access
                                                    (email login, 3 users)
                                                                │
                                                  https://crm.yourdomain.com
```

Two independent locks, which matters because either one alone has a bad failure mode:

1. **Cloudflare Access** turns strangers away at the edge, before traffic reaches your machine.
2. **The app verifies the token itself** (`lib/auth.js`). Access can be misconfigured — a policy
   set to "allow everyone", a second tunnel pointed at the same port, another process on your
   machine hitting `localhost:5174`. Checking the signature means those get a 403 instead of your
   business.

The dashboard binds `127.0.0.1` and there is no setting to change that. Exposing the port directly
is the mistake this design exists to prevent.

---

## What you need first

- A domain on Cloudflare (any plan, free is fine). Adding one is Cloudflare's "Add a site" flow;
  it takes changing your nameservers at the registrar and ~10 minutes to propagate.
- The PC on and awake when someone wants to browse. Sleep settings matter — see Troubleshooting.

Cost: the domain (~$10/yr). Tunnel and Access are free at this size (Access is free up to 50 users).

---

## 1. Install cloudflared

```powershell
winget install --id Cloudflare.cloudflared
```

Close and reopen the terminal so it lands on `PATH`, then:

```powershell
cloudflared --version
```

## 2. Log in and create the tunnel

```powershell
cloudflared tunnel login
```

Opens a browser; pick your domain. This writes a certificate to `%USERPROFILE%\.cloudflared\`.

```powershell
cloudflared tunnel create carscraper
```

Prints a tunnel UUID and writes `%USERPROFILE%\.cloudflared\<UUID>.json`.

> **That JSON is a credential.** It is outside the repo, which is where it belongs — never move it
> into the project folder. `data/` is gitignored but `.cloudflared/` is not part of this repo at all,
> and that separation is deliberate.

## 3. Point a hostname at it

```powershell
cloudflared tunnel route dns carscraper crm.yourdomain.com
```

Then create `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: carscraper
credentials-file: C:\Users\ibrah\.cloudflared\<UUID>.json

ingress:
  - hostname: crm.yourdomain.com
    service: http://127.0.0.1:5174
  # Anything not matched above is refused rather than forwarded.
  - service: http_status:404
```

Test it in the foreground, with the dashboard already running in another terminal:

```powershell
cloudflared tunnel run carscraper
```

Visit `https://crm.yourdomain.com`. **It should load with no login at this point** — that's expected
and is exactly why you do not stop here. Access goes on next.

## 4. Put Access in front

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an application →
Self-hosted**.

- **Application domain:** `crm.yourdomain.com`
- **Session duration:** 24 hours is reasonable; you'll re-login daily.
- **Policy:** name it `owners`, action **Allow**, include **Emails** → your address and the 1-2
  people you trust. Use *Emails*, not *Everyone*, and not *Email domain* unless you actually mean
  everyone at that domain.

Save, then open the application and copy its **Application Audience (AUD) Tag** — a long hex string.

Your **team domain** is under **Zero Trust → Settings → Custom Pages** (or in the URL when you're in
Zero Trust): `something.cloudflareaccess.com`.

## 5. Turn on verification in the app

Add to `.env`:

```
REQUIRE_AUTH=1
ACCESS_AUD=<the AUD tag from step 4>
ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
```

Restart the dashboard. The banner should now read:

```
Dashboard: http://localhost:5174
Auth:      Cloudflare Access (yourteam.cloudflareaccess.com)
```

If `REQUIRE_AUTH=1` and either value is missing, **the server refuses to start**. That is
intentional — booting half-configured would serve the dashboard to anyone who found the hostname.

## 6. Verify it is actually locked

Do all three. The first two passing is not enough.

```powershell
# 1. Through the tunnel, logged out (use a private window):
#    → should redirect to a Cloudflare login page, NOT the dashboard.

# 2. Straight at the local port, no Cloudflare headers:
curl.exe -i http://127.0.0.1:5174/
#    → HTTP/1.1 403 Forbidden
#      Forbidden: no token

# 3. A made-up token:
curl.exe -i -H "Cf-Access-Jwt-Assertion: a.b.c" http://127.0.0.1:5174/
#    → HTTP/1.1 403 Forbidden
```

If #2 returns HTML, `REQUIRE_AUTH` is not on and the dashboard is unprotected the moment the tunnel
is up.

## 7. Run both as services

Cloudflared:

```powershell
# Run as Administrator
cloudflared service install
```

The dashboard needs to come back after a reboot too. Task Scheduler, "At startup", running:

```
node --disable-warning=ExperimentalWarning C:\Users\ibrah\Desktop\Coding\carScraper\dashboard\server.js
```

Set it to **Run whether user is logged on or not** and **Restart on failure**. The existing
`tools/register_task.ps1` scrape task is untouched by any of this.

---

## Changing who has access

**Zero Trust → Access → Applications → carscraper → Policies.** Add or remove an email; it takes
effect on their next request. Removing someone here is the whole revocation — there are no app
accounts, no passwords, nothing stored on your side.

There is deliberately no signup, no password reset, and no user table. For three people, an
allowlist someone else operates is fewer things to get wrong.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403 Forbidden: no token` in a browser | Reaching the app without going through Access | Use the `crm.yourdomain.com` URL, not the IP or localhost |
| `403 Forbidden: aud mismatch` | `ACCESS_AUD` is from a different Access application | Recopy the AUD tag from the right app |
| `403 Forbidden: issuer mismatch` | `ACCESS_TEAM_DOMAIN` is wrong | Check Zero Trust → Settings |
| `403 Forbidden: unknown signing key` | Cloudflare rotated keys and the fetch failed | Check the PC has internet; the JWKS cache refetches on an unknown key |
| Site is down, tunnel shows disconnected | PC asleep or offline | Power settings → never sleep; or accept it and browse when the PC is up |
| Site loads with **no** login prompt | Access application not created, or its domain doesn't match | Redo step 4; the domain must match exactly |
| Dashboard 502 through the tunnel | Dashboard process not running | Start it; check the Task Scheduler startup entry |

**A note on what this does and doesn't protect.** Access controls who reaches the dashboard. It does
nothing about the Facebook account — that risk is unchanged and lives entirely in the scraper, which
is why the scraper stayed home. If exposure ever needs to drop further, the answer is still
`PROVIDER=apify` (`docs/SCRAPER.md` → Providers), which scrapes without your login at all.

---

## Related

- `docs/OPERATIONS.md` — the scrape schedule and what to do when a run fails
- `docs/DASHBOARD.md` — what the dashboard shows
- `lib/auth.js` — the token verification, and why it exists alongside Access
- `tests/auth.test.js` — what must be refused
