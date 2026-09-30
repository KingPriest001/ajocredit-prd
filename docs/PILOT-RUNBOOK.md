# Pilot Runbook (2 → 20 groups)

**Who:** Ops/Pilot lead + PM + BE on-call. Hours: Mon-Sat 8:00-20:00 WAT, WhatsApp support.
**Recruit:** Aunty Bola archetype (10 members, ₦10-50k weekly). Collect: group name, admin phone, member list, bank details (verified), consent.

## Daily 09:00 WAT triage (15 min)
1. Open suspense queue (unmatched transfers) → match by VA+amount+ref <24h.
2. Wrong amount → WhatsApp member: top-up or refund; never auto-confirm.
3. Grace/penalty check (48h grace, late fee per rules) → reminders T-24/T-0.
4. Payout batch check (10:00/15:00 cutoffs) → confirm balanced ledger before release.

## Money SLAs
- Refunds: pre-start 3 days, mid-cycle 7 days, source-account only; failed → auto-reverse 1-3 days + ticket.
- Payouts: <24h ≥98%; shortfall → cite rule, no partial without quorum; duplicate job → idempotency blocks.
- Disputes: ack 24h, resolve <7d, evidence ≤5 files/10MB, reason code + audit.

## Comms templates (EN + Pidgin)
- Reminder: `Mama Nkechi, ₦20,000 due by 6pm. Fee ₦200. Pay to VA 9876… / *347*20000*AJ4821#`
- Cutoff miss: `Batch missed 15:00 → next 10:00 WAT. ETA …`
- Payout done: `₦100,000 sent to GTB ••0123. Receipt + Score updated.`

## Incidents
- SEV1 money-loss / down >15min → freeze payouts, page BE+DevOps+PM, post-mortem 48h.
- SEV2 webhook delay / wrong score → fix 4h. SEV3 copy/UI → next sprint.

## Scale gate (2 → 20)
Go when: on-time ≥85%, payout ≥98% <24h, unmatched <5%, zero manual fund moves, 0 SEV1 open.
