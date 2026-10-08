# WhatsApp — Contact + Auto-Response + APK Notes

## Contact button (live in prototype)
Account → Help → "Chat on WhatsApp" opens `wa.me/<number>` with prefilled text.
**You must supply the number:** in `prototype/index.html`, set `SUPPORT_WA="2348012345678"` (your WhatsApp Business number, country code + no `+`). Current value `2348000000000` is a placeholder.

## Auto-response (Cloud API webhook, in `api/server.js`)
- Verify: `GET /webhooks/whatsapp?hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=...`
- Replies: `POST /webhooks/whatsapp` answers DUE · PAYOUT · SCORE · DISPUTE · JOIN · greetings · HUMAN handoff (EN + small Pidgin/Yoruba), and logs each exchange into `notifications`.
- Without `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` set, it runs in dev mode (returns the reply as JSON, no send).

## Meta setup (your actions, ~1 hour, free)
1. developers.facebook.com → Create App → add **WhatsApp** product.
2. In WhatsApp → API Setup: copy **temporary token** + **Phone Number ID** (test number works immediately).
3. Configuration → Webhook: URL `https://<your-api>/webhooks/whatsapp`, Verify Token = your `WHATSAPP_VERIFY_TOKEN`, Subscribe to **messages**.
4. Env: `WHATSAPP_TOKEN=<token> WHATSAPP_PHONE_ID=<id> WHATSAPP_VERIFY_TOKEN=<same>`.
5. Test: message the test number from your phone → auto-reply arrives.
6. Production: add a real Business number (needs verified Business Manager + display name "AJOCREDIT"); permanent system-user token replaces the 24h test token.

## APK (Capacitor, cloud-built)
ADR-01 planned Capacitor. Path: `.github/workflows/apk.yml` builds a debug APK on every push (Java 17 + Android SDK in CI, no local SDK needed). Download from Actions → Artifacts.
Before first build: `SUPPORT_WA` set, icons PNG (192/512) in place. Play Store release (signed AAB) is a later step with its own keystore — debug APK is for pilot devices.
