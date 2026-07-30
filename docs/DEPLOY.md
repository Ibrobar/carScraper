# Putting the dashboard on fitra.us

Goal: you and 2 other people can open **https://fitra.us**, log in with your email, and see the car
dashboard — from anywhere, on a phone.

The old fitra.us website and its email stop working. That's fine and expected.

> Only thing worth a thought first: if any account anywhere uses an `@fitra.us` address to log in or
> reset a password, move it to another address before you start. After step 1 those addresses stop
> receiving mail.

**Time:** about 30 minutes, plus waiting for the domain to switch over.
**Cost:** nothing.

---

## The short version

Tick these off. Details for any step are further down.

```
□ 1  cloudflare.com → sign up → Add a site → fitra.us → Free
       copy the 2 nameservers it gives you

□ 2  godaddy.com → My Products → fitra.us → Nameservers → Change
       → "I'll use my own" → paste both → save → wait for Cloudflare's email

□ 3  Cloudflare → DNS → delete the "fitra.us" and "www" rows of type A or CNAME

□ 4  PowerShell:
       winget install --id Cloudflare.cloudflared
       (close PowerShell, open it again)
       cloudflared tunnel login
       cloudflared tunnel create carscraper        ← copy the long ID
       cloudflared tunnel route dns carscraper fitra.us

□ 5  notepad $env:USERPROFILE\.cloudflared\config.yml
       paste the 6 lines from step 3 below, with your ID

□ 6  Two PowerShell windows:
       npm run dashboard
       cloudflared tunnel run carscraper
     Check https://fitra.us loads.   ← OPEN TO EVERYONE right now

□ 7  Cloudflare → Zero Trust → Access → Applications → Add → Self-hosted
       name: carscraper      domain: fitra.us
       Policy → Allow → Emails → your 3 email addresses

□ 8  Copy the app's AUD tag into .env, plus your team name:
       REQUIRE_AUTH=1
       ACCESS_AUD=<the long string>
       ACCESS_TEAM_DOMAIN=<yourteam>.cloudflareaccess.com
     Restart the dashboard.

□ 9  curl.exe -i http://127.0.0.1:5174/
     MUST say 403. If it shows a web page, step 8 didn't work — stop and fix it.

□ 10 Auto-start:
       cloudflared service install        (PowerShell as Administrator)
       Task Scheduler → new task → At startup → node dashboard/server.js
```

---

## How it works, in one picture

Your computer keeps doing everything. It just gets a doorway to the internet.

```
   Your PC                                   Cloudflare            People
┌────────────────┐
│ scraper        │  ← stays here, on your home internet
│ dashboard      │
│ cloudflared ───┼──── calls out ────▶  [ login wall ]  ◀──── you + 2 others
└────────────────┘                                             fitra.us
```

`cloudflared` is a small program that makes an outgoing connection to Cloudflare. Nothing gets
opened on your router, and the dashboard is never directly on the internet. Cloudflare puts a login
page in front and only lets your 3 email addresses through.

**Your PC has to be turned on** for anyone to see the site.

---

## Step 1 — Move fitra.us to Cloudflare

Cloudflare has to be in charge of the domain for any of this to work.

1. Make a free account at **cloudflare.com**.
2. Click **Add a site**, type `fitra.us`, pick the **Free** plan.
3. It shows your existing records, then gives you **two nameservers** that look like:
   ```
   xxxx.ns.cloudflare.com
   yyyy.ns.cloudflare.com
   ```
   Write them down.
4. Go to **godaddy.com** → **My Products** → `fitra.us` → **DNS** → **Nameservers** → **Change** →
   **I'll use my own nameservers**.
5. Delete what's there, put in the two Cloudflare ones, save.
6. Wait. Usually 10-30 minutes, sometimes a few hours. Cloudflare emails you when it's active.

**Then clear out the old website records.** In Cloudflare click **DNS** in the left sidebar. Delete
any record named `fitra.us` or `www` whose type is **A** or **CNAME**. That's the old GoDaddy site.
If you leave them, step 3 fails with "record already exists".

---

## Step 2 — Install the connector

Open **PowerShell** and run:

```powershell
winget install --id Cloudflare.cloudflared
```

**Close PowerShell and open it again** so it can find the new program, then:

```powershell
cloudflared tunnel login
```

A browser opens. Pick `fitra.us` and authorize.

```powershell
cloudflared tunnel create carscraper
```

This prints a long ID like `6ff42ae2-765d-4adf-8112-31c55c1551ef`. **Copy it** — you need it next.

---

## Step 3 — Point fitra.us at your computer

```powershell
cloudflared tunnel route dns carscraper fitra.us
```

Now the settings file:

```powershell
notepad $env:USERPROFILE\.cloudflared\config.yml
```

Say yes to creating it, then paste this in — **swap in your own ID from step 2**:

```yaml
tunnel: carscraper
credentials-file: C:\Users\ibrah\.cloudflared\6ff42ae2-765d-4adf-8112-31c55c1551ef.json

ingress:
  - hostname: fitra.us
    service: http://127.0.0.1:5174
  - service: http_status:404
```

Save and close.

**Test it** with two PowerShell windows:

```powershell
# Window 1 — the dashboard
cd C:\Users\ibrah\Desktop\Coding\carScraper
npm run dashboard
```

```powershell
# Window 2 — the doorway
cloudflared tunnel run carscraper
```

Open **https://fitra.us** on your phone. You should see your cars.

⚠️ **Right now anyone on the internet can see it too.** Step 4 fixes that. Don't stop here.

---

## Step 4 — Add the login wall

1. In Cloudflare, click **Zero Trust** in the left sidebar. It may ask you to pick a team name —
   anything is fine, but write down what you chose.
2. Go to **Access** → **Applications** → **Add an application** → **Self-hosted**.
3. Fill in:
   - **Application name:** `carscraper`
   - **Domain:** `fitra.us`
   - **Session duration:** 24 hours
4. Click **Next**. Now the rule for who gets in:
   - **Policy name:** `us`
   - **Action:** Allow
   - **Include:** pick **Emails**, then type your email and the other 2 people's emails
5. Save.

Open **https://fitra.us** in a private/incognito window. You should get a Cloudflare login page that
emails you a code. That's it working.

---

## Step 5 — Tell the app to check the login too

Cloudflare now guards the door. The app should also check for itself — so that if the rule in step 4
ever gets edited wrong, the dashboard doesn't end up wide open.

1. In Cloudflare: **Zero Trust** → **Access** → **Applications** → click `carscraper` → copy the
   **Application Audience (AUD) Tag**. Long string of letters and numbers.
2. Open `C:\Users\ibrah\Desktop\Coding\carScraper\.env` in Notepad and add these 3 lines. (If there's
   no `.env` file, make one by copying `.env.example`.)

```
REQUIRE_AUTH=1
ACCESS_AUD=paste-the-long-string-here
ACCESS_TEAM_DOMAIN=yourteamname.cloudflareaccess.com
```

`yourteamname` is the team name from step 4.

3. Stop the dashboard with Ctrl+C and start it again. It should now say:

```
Auth:      Cloudflare Access (yourteamname.cloudflareaccess.com)
```

If it still says `Auth: OFF`, the `.env` file isn't being read — check it's in the project folder and
named exactly `.env`.

If it refuses to start and complains about `REQUIRE_AUTH`, one of the two values is missing. That's
on purpose — it won't run half-configured.

---

## Step 6 — Check it's actually locked

Do **all three**. The first one passing is not enough.

```powershell
# 1. Should print 403 Forbidden
curl.exe -i http://127.0.0.1:5174/
```

2. Open **https://fitra.us** in a private window → should show the Cloudflare login page.
3. Get someone whose email you did *not* add to try it → they should be refused.

If test 1 shows a web page instead of `403 Forbidden`, step 5 didn't take and the dashboard is
unprotected.

---

## Step 7 — Make it all start by itself

Right now everything stops when you close PowerShell.

**The connector** — PowerShell **as Administrator**:

```powershell
cloudflared service install
```

**The dashboard** — open **Task Scheduler** → **Create Task**:

- **General:** name it `CarScraper Dashboard`, tick **Run whether user is logged on or not**
- **Triggers:** New → **At startup**
- **Actions:** New → Start a program
  - Program: `node`
  - Arguments: `--disable-warning=ExperimentalWarning dashboard/server.js`
  - Start in: `C:\Users\ibrah\Desktop\Coding\carScraper`
- **Settings:** tick **restart if the task fails**

Reboot and check https://fitra.us still loads.

Your twice-daily scrape task is separate and isn't affected by any of this.

---

## Adding or removing a person

**Cloudflare → Zero Trust → Access → Applications → carscraper → Policies** → edit the email list.

Takes effect immediately. There are no accounts or passwords on your side, so removing someone from
that list is the whole job.

Everyone who gets in sees the **same** dashboard. There are no private or per-person views.

---

## When something breaks

| What you see | What's wrong | Fix |
|---|---|---|
| `403 Forbidden: no token` | You used `localhost` instead of the real address | Go to https://fitra.us |
| `403 Forbidden: aud mismatch` | Wrong AUD in `.env` | Recopy it, step 5 |
| `403 Forbidden: issuer mismatch` | Wrong team name in `.env` | Check `ACCESS_TEAM_DOMAIN` |
| Site won't load at all | PC asleep or off | Turn off sleep in Windows power settings |
| `Error 502` | Dashboard isn't running | Start it, or check the Task Scheduler entry |
| Site loads with no login | Step 4 didn't apply | Check the Access app domain is exactly `fitra.us` |
| `record already exists` in step 3 | Old GoDaddy records still there | Delete the A/CNAME records for `fitra.us` in Cloudflare DNS |

**This protects the dashboard, not the Facebook account.** That risk is unchanged, and it lives in
the scraper — which is exactly why the scraper stays on your home internet instead of moving to a
rented server. Facebook is far more suspicious of logins from data centres.

---

## For reference

- `lib/auth.js` — the login check, and why it exists on top of Cloudflare's
- `tests/auth.test.js` — what must be refused
- `docs/OPERATIONS.md` — the scrape schedule
