# Threat Model (draft — V1)

**Assets:** safeguarded funds (via partner), ledger, PII (phone/name/DOB), bank hashes, scores, evidence files.
**Actors:** member, admin, outsider fraudster (sibyl, SIM-swap), malicious admin, PSP/bank partner, insider ops.
**Trust boundaries:** PWA → API → PSP/VA provider → safeguarded bank → payout; evidence bucket; SMS provider.

| # | Threat | Mitigation (implemented/planned) |
|---|---|---|
| T1 | OTP brute-force / SMS pumping | 6-digit, 5-min expiry, 5 fails→15-min lock, Termii throttle, rate-limit IP+phone |
| T2 | Double-credit via replayed webhook | HMAC verify + `rail_ref UNIQUE` + idempotency `group+member+cycle+rail_ref`, suspense on mismatch |
| T3 | Payout to wrong account | NUBAN name enquiry, source-account-only, maker-checker, threshold approval |
| T4 | Admin drains pot | No direct fund access; payout engine only; immutable ledger + audit_log |
| T5 | Sibyl / multi-account / collusion vouch | Device fingerprint + velocity, endorsement weight by ITI, circular-vouch 80% discount, Fraud separate from Score; fraud-confirmed → hard Bronze cap 12 months (manual override) |
| T5b | Ghost members (fake members to pad pot/order) | Counted members must meet Profile Strength threshold; flag same-device / near-simultaneous creation for manual review |
| T5c | Admin–member collusion (skip contribution, release payout) | System-verified complete pot required — NO V1 admin override; future override needs second approver + mandatory post-hoc audit |
| T6 | SIM-swap takeover | Refresh rotation + reuse detection, device change → step-up + Fraud review, payout hold 24h on new device |
| T7 | PII leak / bucket open | AES-256-GCM PII, bank SHA-256+salt only, private bucket + presigned 15-min, scan uploads |
| T8 | Settlement delay / PSP down | 2 PSP failover, batch cutoffs 10:00/15:00 WAT, status comms, daily recon + suspense SLA 24h |
| T9 | Dispute evidence tamper | Append-only audit, hash-chained score_history, evidence URL+hash immutable |

**Open:** partner trust deed review, pen-test before pilot scale, incident runbook drill (SEV1 freeze-payouts switch).
