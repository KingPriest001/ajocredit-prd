# Production Deploy Runbook â€” AJOCREDIT

Technical runbook for taking the API from "pilot open" to "locked production".
The legal/compliance gate lives separately in `LAUNCH-CHECKLIST.md` and is unchanged.

- **Release:** `v1.0.1` (GitHub Release, signed with the permanent `ajocredit` keystore)
- **Render service:** `srv-db44g5e0tbcc73d3d7tg`
- **App:** <https://kingpriest001.github.io/ajocredit-prd/> Â· APK: `/releases/ajocredit.apk` (also at `/ajocredit.apk`)
- **API:** <https://ajocredit.ng>

## Current live state (verified)

| Item | State |
|---|---|
| Flutterwave | **LIVE** â€” hosted checkout link issues correctly |
| Paystack | **TEST key** (`pk_test_â€¦`) â€” fallback stays blocked until `pk_live_` |
| Termii API key | live key valid (Zenonmag Concepts Ventures, â‚¦28 balance), **but 0 sender IDs registered** â†’ SMS is rejected |
| Termii OTP/Verify product | **inactive for Nigeria** on the new workspace ("Country Inactive") â†’ `TERMII_OTP_MODE=local` covers it |
| Email (Resend) | **not configured** â€” welcome + reset emails are recorded in `email_log` but not delivered |
| WhatsApp | token valid locally, **not set on Render**, no `ajocredit_otp` template |
| `REQUIRE_AUTH` | **off** â€” API is open (pilot) |
| `REQUIRE_LOGIN` | **on** â€” sign-in/account-creation page is live |

## Web-bundle updates (Capacitor Updater)

Installed apps can pull a new **web bundle** (a zip of the web assets) without a
new APK. CI publishes the bundle and a manifest to the static site:

- `https://kingpriest001.github.io/ajocredit-prd/bundle.json` â†’ `{ version, url, sha256, rollback }`
- `https://kingpriest001.github.io/ajocredit-prd/bundles/<version>.zip`

The updater plugin (`@capgo/capacitor-updater`, pinned to **6.7.8** â€” the newest
release that supports Capacitor 6 *and* builds with the Android toolchain
Capacitor 6 ships with) asks the API who should get the new bundle:

`POST /api/app/update` with `{ device_id, version_name, platform, app_id, â€¦ }`

The answer is `{ version, url, checksum }`:

- `checksum` â€” SHA-256 of the zip. **Required**: without it the plugin refuses
  to download ("Checksum required").
- `version` â€” the bundle version. When it equals the version the phone is
  already running, the plugin installs nothing. That is how "no update for you"
  is expressed.
- `url` â€” must always be present and valid, even when there is nothing to
  install, or the plugin rejects the whole response.

`GET /api/app/update?device_id=â€¦&current=â€¦` answers the same thing (used for
manual checks).

| Env var | Meaning |
|---|---|
| `APP_UPDATE_ROLLOUT` | 0â€“100. Percentage of devices that get the new bundle. Stable per device (hash bucket), so nobody flip-flops between launches. **Default 5.** |
| `APP_UPDATE_ROLLBACK` | `1` = hand **every** device the last known good bundle (`bundle.json â†’ rollback`) instead of the new one. |
| `APP_BUNDLE_MANIFEST` | Where the manifest lives (default: the static site above). |

**What is live right now:**

```
GET https://ajocredit.ng/api/app/update/status
â†’ { rollout, rollback, serving, current, rollback_bundle }
```

`current` is the bundle being offered, `rollback_bundle` is what a rollback
would send people back to, and `serving` says which of the two is live.

**Staged rollout:** the code starts at **5 %**. Raise it on Render
(`APP_UPDATE_ROLLOUT=25`, then `50`, then `100`) as you watch. Each device is in
a fixed bucket, so it keeps getting the same answer.

**Rollback:** set `APP_UPDATE_ROLLBACK=1` and save. Devices that already took the
bad bundle get the previous good one on their next launch. The rollback bundle is
the previous entry in `bundle.json` â€” always one build behind, so it is never lost.
A rollback is never staged: it goes to every device.

> **If there is no rollback bundle yet** (`rollback_bundle` is null), setting
> `APP_UPDATE_ROLLBACK=1` moves nobody â€” it cannot roll back to something that
> was never published. It never falls back to serving the *new* bundle.

**After a bad web bundle, also re-cut a good APK** (the APK embeds the same assets).

The plugin's usage stats and channel calls are pointed at our own API
(`/api/app/stats`, `/api/app/channel`), so nothing about a member's phone is
sent to Capgo's servers.

**A second safety net:** the plugin rolls a bundle back on its own if the app
does not report itself ready within `appReadyTimeout` (30 s). That is why
`prototype/index.html` calls `notifyAppReady()` as soon as the app has loaded.

## The agent programme

Agents bring Ajo groups to AJOCREDIT and earn **â‚¦500 per member** (held until
that member's first contribution) **plus 1% of that first contribution, once**.

The percentage is deliberately a one-time bonus. AJOCREDIT collects **1% up
to â‚¦10,000 and 0.5% above that** on every contribution, so a percentage that
kept running would hand the agent the whole fee and leave AJOCREDIT nothing.
The standing reward is the flat â‚¦500 per member who joins and becomes active.

| Page | What it is |
|---|---|
| `become-agent.html` | "Become an Agent" â€” individual or corporate |
| `agent/code-of-conduct.html` | The Agent Code of Conduct (must be ticked) |
| `agent-dashboard.html` | Groups, members, earnings, payouts |
| `agent/migrate-group.html` | The 5-step group migration checklist |
| `agent/share-flyer.html` | The agent link, the QR flyer and the 3 WhatsApp templates |
| `admin/agents.html` | The admin panel (approve / need info / reject / suspend, pay commission) |
| `join.html` | The landing page for `ajocredit.app/join/<code>` |

**Rules the code enforces (not just the words):**

- An agent **never collects cash** â€” nothing in the agent API moves money.
- An agent **never sees a member's balance** â€” the endpoints return counts and
  commission totals only.
- A corporate agent **cannot open the dashboard until an admin approves it**.
- A migration **cannot be completed if the group leader said no**.
- An agent **cannot edit their own Agent Code**.
- The admin panel is **switched off** until `AGENT_ADMIN_TOKEN` is set on the
  server (the page sends it as the `x-admin-token` header).

**Env vars:**

| Var | Meaning |
|---|---|
| `AGENT_ADMIN_TOKEN` | Shared secret for `/admin/agents.html`. Unset = the panel is closed. |
| `AGENT_SITE_URL` | The public site used in the WhatsApp links (default `https://ajocredit.pages.dev`). |

### Switching the admin panel on

The panel is closed until `AGENT_ADMIN_TOKEN` is set on the server. It is one
secret, used in two places â€” the server and the panel.

**Route A â€” the Render dashboard (no API key needed)**

1. Render â†’ your **AJOCREDIT API** service â†’ **Environment**.
2. **Add Environment Variable** â†’ key `AGENT_ADMIN_TOKEN`.
   - For the value, generate a long random one and copy it. Any of these work
     (the first is the one to use on Windows PowerShell 5.1):
     ```powershell
     # 1. node - simplest
     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

     # 2. PowerShell 5.1 (Windows PowerShell - not PowerShell 7)
     $b = New-Object byte[] 24
     $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
     $rng.GetBytes($b); $rng.Dispose()
     ($b | ForEach-Object { $_.ToString('x2') }) -join ''

     # 3. a GUID - one line, no crypto API needed
     [guid]::NewGuid().ToString('N')
     ```
   - Anything long and random works. Nothing is stored in the browser unless
     you tick "Remember on this phone", and it is only compared on the server.
3. **Save** â†’ Render redeploys (1â€“3 minutes).
4. Open <https://ajocredit.pages.dev/admin/agents.html>, paste the **same**
   string into the **Admin Key** box â†’ **Open the list**.

**Route B â€” the API script (if you have a Render API key)**

```powershell
cd "C:\Users\unsto\OneDrive\Documents\QUBATORS PROJECT\NEW PRD\api"
$env:RENDER_API_KEY = "rnd_xxxxxxxxxxxxxxxx"   # Render â†’ Account Settings â†’ API Keys
node render-env.mjs
```

The script merges into the live service (it never deletes your other
variables) and **prints the admin key** â€” copy that into the panel's Admin Key
box. It reuses the token already on the service, so running it twice does not
rotate the key. To rotate it on purpose:

```powershell
$env:AGENT_ADMIN_TOKEN = "your-new-long-random-string"; node render-env.mjs
```

**Check it worked:**

```powershell
curl.exe -s -H "x-admin-token: YOUR_KEY" https://ajocredit.ng/api/admin/agents
```

- `{"ok":true,...}` â†’ the key is right.
- `403 {"error":"Admin access is not switched on."}` â†’ the variable is not set
  on Render yet, or the key does not match exactly.

**Wiping test data so live starts at ₦0** (PowerShell, replace `YOUR_KEY`):

```powershell
$h = @{ "x-admin-token" = "YOUR_KEY" }
# What is on the ledger right now:
Invoke-RestMethod https://ajocredit.ng/api/admin/transactions -Headers $h | ConvertTo-Json -Depth 6
# Remove the known QA fixtures (AJO-ACC-/DEMO-/MVP-/TEST-):
Invoke-RestMethod -Method Post https://ajocredit.ng/api/admin/transactions/clear `
  -Headers $h -ContentType "application/json" -Body '{"scope":"test","confirm":"CLEAR"}'
# Or wipe every transaction + contribution record:
Invoke-RestMethod -Method Post https://ajocredit.ng/api/admin/transactions/clear `
  -Headers $h -ContentType "application/json" -Body '{"scope":"all","confirm":"CLEAR"}'
```

Both clears return the deleted row counts and the totals that remain - the
response should end with `"totals":{"contributions":0,"fees":0,"total":0,"count":0}`.

**WhatsApp:** the agent module records every message it prepares in
`agent_messages` and gives the agent a `wa.me` link to send it from their own
phone. Messages are not sent through the WhatsApp Business API yet â€” the
`WHATSAPP_TOKEN` keys in the environment are not wired into this module.

## Notifications (MVP)

| Channel | What goes out |
|---|---|
| SMS (Termii) | OTP code Â· welcome message after a verified sign-up Â· password-reset code |
| In-app | contribution recorded Â· payout due Â· member joined (plus join requests, approvals, payouts completed) |
| Email (Resend) | welcome after sign-up Â· password-reset notice |

**No bulk SMS to groups, no push notifications, no WhatsApp.** The reset code always
goes by SMS to the phone â€” it is never emailed. Every transactional email is written
to `email_log` with a `sent` / `not_configured` / `failed` status.

## Environment variables on Render

Verified present: `USE_EXTERNAL_DB`, `DATABASE_URL`, `PAYSTACK_PUBLIC_KEY`,
`PAYSTACK_SECRET_KEY`, `TERMII_API_KEY`, `PAYMENTS_MODE`, `FLUTTERWAVE_*`,
`FLW_WEBHOOK_HASH`, `REQUIRE_AUTH`.

To add (Render â†’ Environment):

| Key | Value | When |
|---|---|---|
| `TERMII_API_KEY` | live key | **required** â€” currently Render still holds the old key/workspace |
| `TERMII_SENDER_ID` | `Ajocredit` | after Termii approves the sender ID |
| `TERMII_BASE_URL` | `https://v4.api.termii.com` | default |
| `TERMII_OTP_MODE` | `termii` (default) or `local` | use `local` if Termii's OTP/Verify product stays inactive |
| `RESEND_API_KEY` | Resend key | needed for the welcome + password-reset emails |
| `RESEND_FROM` | `AJOCREDIT <no-reply@ajocredit.app>` | needed for the welcome + password-reset emails |
| `WHATSAPP_TOKEN` | from `../.env` | if using WhatsApp OTP |
| `WHATSAPP_PHONE_ID` | from `../.env` | if using WhatsApp OTP |
| `WHATSAPP_OTP_TEMPLATE` | `ajocredit_otp` | default, only change if renamed |
| `WHATSAPP_OTP_LANG` | `en_US` | default â€” **must match the template's locale** |
| `SMS_MAX_PER_DAY` | `5` | default â€” per-member SMS cap |
| `REQUIRE_LOGIN` | `0` | set only to hide the sign-in page |

> `api/render-env.mjs` now **merges** instead of replacing, because Render replaces the
> whole `envVars` array on PATCH â€” the old version would have deleted the Flutterwave keys.

## Go-live sequence

Do these **in order**. Each step is reversible.

### 1. Get one OTP channel really delivering
- **Termii:** console â†’ Sender ID â†’ register `AJOCREDIT` â†’ wait for DND approval.
- **WhatsApp (faster):** Business Manager â†’ Message Templates â†’ create
  `ajocredit_otp`, category **AUTHENTICATION**, language **en_US**, body
  `Your AJOCREDIT code is {{1}}. Expires in 5 minutes.`
- Add the WhatsApp keys to Render (table above).
- **Verify:** `POST /api/otp/send` must return `{"ok":true,"mode":"termii"|"whatsapp"}`
  and the phone must actually buzz. A `503` means it did **not** send.

### 2. Prove sign-in works end to end
Open the app â†’ enter name + phone â†’ receive code â†’ sign in â†’ land on the home
screen with the Account screen showing your name. Existing members keep their
account (same phone â†’ same user, name preserved).

### 3. Cut the release (if the app changed since `v1.0.1`)
`gh run list --workflow apk` â†’ download the `ajocredit-release-signed` artifact â†’
`gh release create vX.Y.Z <apk> <aab>`. Same keystore â‡’ in-place upgrade for
existing installs. Verify the signer is `CN=AJOCREDIT, O=Qubators, L=Lagos, C=NG`.

### 4. Turn the hard lock on
Render â†’ Environment â†’ `REQUIRE_AUTH` = `1` â†’ save (triggers a redeploy).

The same moment is the right place to start the **staged bundle rollout**:
`APP_UPDATE_ROLLOUT=5` â†’ watch â†’ 25 â†’ 50 â†’ 100. `APP_UPDATE_ROLLBACK=0`.

### 5. Verify
- `GET /api/auth/config` â†’ `{"require_auth":true,"require_login":true}`
- `GET /api/groups/mine?phone=â€¦` **without** a token â†’ **401**
- With a valid token â†’ **200**
- Sign in on a real phone; confirm the code arrives and the app loads.
- `POST /api/app/update` â†’ `{"version":â€¦,"url":â€¦,"checksum":â€¦}` (the plugin's
  exact contract â€” see above).

## Rollback

| Symptom | Action |
|---|---|
| Codes not arriving | `REQUIRE_AUTH` back to `0` â†’ app reopens immediately (the sign-in page keeps a "Continue without signing in" escape hatch while the API is open) |
| Bad release | publish `v1.0.2`; the debug APK on Pages always carries the newest build |
| Payments failing | check `GET /api/health`; Flutterwave is primary and Paystack only takes over on a `pk_live_` key |
| Stale app on a user's phone | the shell is network-first now, so a normal reload fetches the new build; if the SW is stuck, remove the site from the home screen and reinstall |

## Notes

- The **sign-in page** and the **hard lock** are independent switches on purpose:
  `REQUIRE_LOGIN` shows the page, `REQUIRE_AUTH` locks the API. Keeping them
  separate means a messaging outage can never lock every member out of a live group.
- SMS notifications are limited to decision-critical events (join request, approved,
  payout pending) with a per-member daily cap, so a busy group cannot drain the
  SMS budget.
- A duplicate payment reference is now reported as `duplicate: true` and does not
  re-announce to the group.
