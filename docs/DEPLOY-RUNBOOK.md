# Production Deploy Runbook — AJOCREDIT

Technical runbook for taking the API from "pilot open" to "locked production".
The legal/compliance gate lives separately in `LAUNCH-CHECKLIST.md` and is unchanged.

- **Release:** `v1.0.1` (GitHub Release, signed with the permanent `ajocredit` keystore)
- **Render service:** `srv-db44g5e0tbcc73d3d7tg`
- **App:** <https://kingpriest001.github.io/ajocredit-prd/> · APK: `/releases/ajocredit.apk` (also at `/ajocredit.apk`)
- **API:** <https://ajocredit-api.onrender.com>

## Current live state (verified)

| Item | State |
|---|---|
| Flutterwave | **LIVE** — hosted checkout link issues correctly |
| Paystack | **TEST key** (`pk_test_…`) — fallback stays blocked until `pk_live_` |
| Termii API key | live key valid (Zenonmag Concepts Ventures, ₦28 balance), **but 0 sender IDs registered** → SMS is rejected |
| Termii OTP/Verify product | **inactive for Nigeria** on the new workspace ("Country Inactive") → `TERMII_OTP_MODE=local` covers it |
| Email (Resend) | **not configured** — welcome + reset emails are recorded in `email_log` but not delivered |
| WhatsApp | token valid locally, **not set on Render**, no `ajocredit_otp` template |
| `REQUIRE_AUTH` | **off** — API is open (pilot) |
| `REQUIRE_LOGIN` | **on** — sign-in/account-creation page is live |

## Notifications (MVP)

| Channel | What goes out |
|---|---|
| SMS (Termii) | OTP code · welcome message after a verified sign-up · password-reset code |
| In-app | contribution recorded · payout due · member joined (plus join requests, approvals, payouts completed) |
| Email (Resend) | welcome after sign-up · password-reset notice |

**No bulk SMS to groups, no push notifications, no WhatsApp.** The reset code always
goes by SMS to the phone — it is never emailed. Every transactional email is written
to `email_log` with a `sent` / `not_configured` / `failed` status.

## Environment variables on Render

Verified present: `USE_EXTERNAL_DB`, `DATABASE_URL`, `PAYSTACK_PUBLIC_KEY`,
`PAYSTACK_SECRET_KEY`, `TERMII_API_KEY`, `PAYMENTS_MODE`, `FLUTTERWAVE_*`,
`FLW_WEBHOOK_HASH`, `REQUIRE_AUTH`.

To add (Render → Environment):

| Key | Value | When |
|---|---|---|
| `TERMII_API_KEY` | live key | **required** — currently Render still holds the old key/workspace |
| `TERMII_SENDER_ID` | `Ajocredit` | after Termii approves the sender ID |
| `TERMII_BASE_URL` | `https://v4.api.termii.com` | default |
| `TERMII_OTP_MODE` | `termii` (default) or `local` | use `local` if Termii's OTP/Verify product stays inactive |
| `RESEND_API_KEY` | Resend key | needed for the welcome + password-reset emails |
| `RESEND_FROM` | `AJOCREDIT <no-reply@ajocredit.app>` | needed for the welcome + password-reset emails |
| `WHATSAPP_TOKEN` | from `../.env` | if using WhatsApp OTP |
| `WHATSAPP_PHONE_ID` | from `../.env` | if using WhatsApp OTP |
| `WHATSAPP_OTP_TEMPLATE` | `ajocredit_otp` | default, only change if renamed |
| `WHATSAPP_OTP_LANG` | `en_US` | default — **must match the template's locale** |
| `SMS_MAX_PER_DAY` | `5` | default — per-member SMS cap |
| `REQUIRE_LOGIN` | `0` | set only to hide the sign-in page |

> `api/render-env.mjs` now **merges** instead of replacing, because Render replaces the
> whole `envVars` array on PATCH — the old version would have deleted the Flutterwave keys.

## Go-live sequence

Do these **in order**. Each step is reversible.

### 1. Get one OTP channel really delivering
- **Termii:** console → Sender ID → register `AJOCREDIT` → wait for DND approval.
- **WhatsApp (faster):** Business Manager → Message Templates → create
  `ajocredit_otp`, category **AUTHENTICATION**, language **en_US**, body
  `Your AJOCREDIT code is {{1}}. Expires in 5 minutes.`
- Add the WhatsApp keys to Render (table above).
- **Verify:** `POST /api/otp/send` must return `{"ok":true,"mode":"termii"|"whatsapp"}`
  and the phone must actually buzz. A `503` means it did **not** send.

### 2. Prove sign-in works end to end
Open the app → enter name + phone → receive code → sign in → land on the home
screen with the Account screen showing your name. Existing members keep their
account (same phone → same user, name preserved).

### 3. Cut the release (if the app changed since `v1.0.1`)
`gh run list --workflow apk` → download the `ajocredit-release-signed` artifact →
`gh release create vX.Y.Z <apk> <aab>`. Same keystore ⇒ in-place upgrade for
existing installs. Verify the signer is `CN=AJOCREDIT, O=Qubators, L=Lagos, C=NG`.

### 4. Turn the hard lock on
Render → Environment → `REQUIRE_AUTH` = `1` → save (triggers a redeploy).

### 5. Verify
- `GET /api/auth/config` → `{"require_auth":true,"require_login":true}`
- `GET /api/groups/mine?phone=…` **without** a token → **401**
- With a valid token → **200**
- Sign in on a real phone; confirm the code arrives and the app loads.

## Rollback

| Symptom | Action |
|---|---|
| Codes not arriving | `REQUIRE_AUTH` back to `0` → app reopens immediately (the sign-in page keeps a "Continue without signing in" escape hatch while the API is open) |
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
