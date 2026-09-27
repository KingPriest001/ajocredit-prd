# AJOCREDIT — Implementation Plan (V1 → V2 → V3)

**Repo:** https://github.com/KingPriest001/ajocredit-prd
**PRD:** `AJOCREDIT-PRD-Refined.md` (weights v1.0)
**V1 goal:** Prove: real group → real contributions → safeguarded reconciliation → rule-based payouts → credible Score.

---

## Phase 0 — Foundations (Wk 1-2)
- [ ] Legal: partner bank/MFB + PSP selection, trust/safeguarded account terms, NDPA/CBN memo, fee VAT + penalty caps
- [ ] Stack: mobile web PWA (React/Next + Capacitor-ready), API (Node/Nest or Django), Postgres + Prisma/Django ORM, Redis queue, PSP sandbox (Paystack/Flutterwave), VA provider sandbox
- [ ] Repo hygiene: rename `Untitled document (1).md` → `archive/`, CI (lint/test), env + secrets, audit-log convention
- [ ] Exit criteria: partner LOI, threat model + DPIA draft

## Phase 1 — Ajo + Money MVP (Wk 3-6)
- [ ] Auth: OTP (5-min, 5-fail lock), KYC-lite, AJOCREDIT ID + QR
- [ ] Groups: create (1-min), invite/code, approve, payout order admin/random/voting + freeze
- [ ] Ledger: double-entry, idempotency, states, VA per member, webhook + reconciliation job, suspense queue, batch cutoffs 10:00/15:00 WAT
- [ ] Payments: card + transfer, fee pre-display + split receipt, auto-match <5min
- [ ] Escalation: reminders, 48h grace, late fee, default flag
- [ ] Payouts: quorum check, maker-checker, <24h, balanced-ledger guard
- [ ] Exit/refund matrix (US-09) + dispute submit/review + audit
- [ ] Tests: idempotency, double-webhook, wrong-amount, shortfall payout, duplicate payout job
- [ ] Exit: 2 pilot groups, ≥85% on-time, ≥98% payout <24h

## Phase 2 — Credit Engine V1 (Wk 7-8)
- [ ] Implement weights v1.0 + normalization + thin-file/provisional + confidence
- [ ] Decay (90d half-life, 60/40 windows, inactivity multiplier) + `score_history` + audit `{inputs_hash, weights_version}`
- [ ] ITI/GTI + separate Fraud band (device, velocity, multi-account) + passport share-freeze on High
- [ ] Passport: ID/QR/link, tier/trend, breakdown, consent toggles; Basic report free
- [ ] Acceptance: 12/12 → ≥700; 2/10 defaults → -120pts; N=2 → PROVISIONAL; 90d inactive → -80..120; sibyl → Fraud High; recalc <5s
- [ ] Exit: 100% contributors scored, explainer ("2 lates −85pts")

## Phase 3 — Pilot + Hardening (Wk 9-12)
- [ ] 10-20 live groups (Aunty Bola archetype), ops runbook (suspense, refunds 3/7d SLA, dispute <7d)
- [ ] Security: rate-limit OTP, encrypt PII/bank hashes, backups, status page
- [ ] Metrics dashboard: activation, on-time, payout success, score coverage
- [ ] Go/no-go to V2: retention + unit economics (fee tiers) review

## V2 — Identity Infrastructure (Q+1)
Native apps, BVN via licensed partner, open-banking where available, institution portal (verify, consent log, reports), Credit API (Starter 1k / Growth 10k / Enterprise), cooperative infra, advanced reports (Standard ₦500 / Verified ₦1500 / Institutional ₦5000).

## V3 — Alt Credit Infrastructure
Multi-country (currency/rails/ID/tax per country), marketplace via authorised lenders only, embedded lending via partners, SME/coop financing, cross-market identity.

---

## Risks & Mitigations
Settlement delay → 2 PSPs + cutoffs + comms | Wrong payout → name enquiry + source-only | Double-credit → idempotency + dedupe | Collusion/sibyl → vouch weighting + Fraud separation | Regulatory → counsel-gated launch, no deposit-taking/lending | Scope creep → V1 OUT list enforced.

## Open Questions (need owners + dates)
1. Settlement account holder? 2. Refund liability split? 3. Penalty caps? 4. BVN/NIN DPA? 5. Reserve custody? 6. Fee VAT? 7. PSP + VA provider choice? 8. PWA vs native cutover trigger?
