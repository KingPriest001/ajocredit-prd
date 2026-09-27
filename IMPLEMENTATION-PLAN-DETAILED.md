# AJOCREDIT — Detailed Implementation Plan (Design → Architecture → Build → Launch)

**Repo:** https://github.com/KingPriest001/ajocredit-prd
**PRD:** `AJOCREDIT-PRD-Refined.md` (weights v1.0) + `Untitled document (1).md` Parts 1-6
**V1 goal:** Real group → real contributions → safeguarded reconciliation → rule-based payouts → credible Score.
**Audience:** Market women/traders, low-end Android 360px, patchy network, WhatsApp-first. Brand: trust + community + credit.

---

## PHASE 0 — Product Foundations (Wk 1-2)

**Owner:** PM + Counsel. Exit: partner LOI shortlist, threat model + DPIA draft, stack frozen.
- Legal: CBN/BOFIA memo (no deposit-taking/lending), partner bank/MFB/PSB safeguarded deed (holder, liability, refund SLA), NDPA 2023/GAID 2025 (consent, RoPA, DPIA, DPO), fee VAT + penalty caps, BVN/NIN deferred to V2.
- Repo: archive `Untitled document (1).md`, CI lint/test, env/vault, audit-log convention, protected `main`.
- Team: PM 1, Designer 1, FE 2, BE 2, QA 1, DevOps 0.5, Counsel external, Ops/Pilot 1.

## PHASE 1 — Design System + UX (Wk 1-3, overlaps 0)

**Principles:** Pidgin-first P6 level; one-thumb one-task 48-56px targets; offline-first (queue, `Saved — go send when network come`); fee/pot/payer transparency; Score updates live with explainer; forgiving (10s undo, Naira words+digits).
**IA:** Onboarding 3-step <90s (Phone+OTP → Name/Market/Language → Create/Join) · Home/Groups · Group detail (pot/cycles/members/order) · Contribute (fee breakdown → Pay → Receipt) · Payout (countdown + recipient checklist) · Score/Passport · Disputes · Profile. Bottom nav: Home, Pots, Pay, Score, You + Offline banner + WhatsApp Help.
**Key screens/states:** Group create 1-min (name + amount chips ₦1/2/5/10k + frequency + size stepper + start; success `AJ-4821 [QR][WhatsApp][SMS]`); Contribute (`You dey pay ₦5,000` = Pot ₦4,950 + Fee ₦50; fail → Retry/USSD); Payout countdown (`₦100k go land in 2d 4h` + 16/20); Score (`620 Bronze→Silver need +80; 12/12 +60, 1 late -20`); Dispute (chips + evidence + 30s voice note, `Case #231 — respond in 48h`).
**Tokens:** Trust Green #0E7A4F / #0A5C3D, Credit Gold #D9A441 / bg #FFF6E0, Ink #101828, Bg #F8FAF7; type Display 28 Bold → Caption 12, Money 24 tabular; spacing 4pt (16 pad, 24 section); radius 8/12/20/pill; E1/E2 shadows (no blur); 24px icons + labels; contrast ≥4.5:1, focus 3px gold.
**Components:** Button 56h full-width, Input 56h 16px, OTP 4-box + SMS/Call fallback, Group/Payout Cards, Tier Badge, Pot progress 12px + member dots, Avatar + verified check, QR + `AJ-4821`, Receipt (words+digits, ref, fee, Score delta, PNG <80kb), SMS/USSD fallback link.
**a11y/i18n:** Base 16px to 200%, 48dp targets, voice input + audio confirm; 40 core strings in Pidgin/EN/Yor/Hau/Igbo (e.g. `pay.success`: `Payment don land! / Isanwo ti wole! / Biya ya shiga! / Ugwo abatala!`); USSD `*347*Amt*Code#` mirrors pay.
**PWA:** Install prompt after 1st success, shell <1.5MB, Workbox + IndexedDB outbox with backoff, push VAPID T-24/T-2h + SMS failover (Termii primary, Africa's Talking backup), quiet 21:00-06:00, LCP <2.5s 3G, skeletons.
**UX validation:** 5-user market test (Tecno/Infinix, 3G + offline): create <60s, contribute <2min + fee recall, payout countdown, score explainer, offline dispute. Bar: ≥4/5 unaided T1/T2, SUS ≥78. Metrics: OTP >85%, queue >95%, D7 >40%.

## PHASE 2 — Architecture Decisions (Wk 2-3)

**ADR-01 PWA:** Next.js 14 PWA (App Router, SW, installable, offline queue), Capacitor-ready `/mobile` wrapper. +1 codebase/fast deploy; -iOS push gaps. Rejects Flutter/RN (cost/store friction), pure web (no offline).
**ADR-02 API:** NestJS TS strict modular monolith, Postgres 15 + Prisma, Redis + BullMQ (`webhooks, payouts, scoring, notify, recon`). +ACID/velocity; -scale ceiling (stateless + queue split later). Rejects Express/Django bare, microservices, Mongo.
**ADR-03 Auth:** 6-digit OTP (<60s, 5-min expiry, 5 fails→15-min lock), KYC-lite (name+DOB 18+ +optional selfie → KYC_LITE), JWT 15-min + rotating refresh + reuse detection, device fingerprint. Rejects passwords/OAuth, long JWT, V1 BVN.
**ADR-04 Ledger:** `ledger_entries(id, group_id, debit, credit, amount, type, ref_id, idempotency_key UNIQUE, status, hash_chain)` append-only (reversals as new rows), `pending→confirmed|failed→reversed`, only `confirmed` mutates pot/score, suspense account, daily close + T+0/T+1 NIBSS match, monthly partitions. Key: `group+member+cycle+rail_ref`. Rejects single-entry/mutable.
**ADR-05 Payments:** `IPspAdapter{createVA, verifyWebhook, initiateTransfer, nameEnquiry}` (Paystack + Flutterwave failover); HMAC verify → dedupe `rail_ref` → queue → confirm; VA NUBAN per Membership; payouts source-only + name enquiry. Rejects single PSP, direct bank V1, pooled VA.
**ADR-06 Scoring:** BullMQ `scoring` on ledger-confirmed; `scoring_config v1.0` versioned; `score_history(user, score, inputs_json, version, prev_hash+hash)` chained; decay `0.5^(age/90)`, `n=0.6*recent90+0.4*older365`, inactivity >60d `Score*0.5^(inactive/180)`; PROVISIONAL if N<3 or tenure<21d; p95 <5s. Rejects inline calc, ML V1, nightly-only.
**ADR-07 Evidence:** S3-compatible private bucket, presigned PUT/GET 15-min, 10MB + MIME enforce, scan → clean/quarantined, store URL+hash only.
**ADR-08 Notify:** `ISMS` Termii → Africa's Talking + web-push; templates `OTP, PAY_REM_T24/T0, GRACE_T1, PENALTY_T4, PAYOUT_DONE`; queued + logged.
**ADR-09 Infra:** Docker Compose dev / images + GH Actions (lint→test→migrate-dry→staging→prod gate); managed PG PITR 30d + Redis; vault secrets; OTel → Grafana/Loki. Rejects K8s V1, self-host PG.
**ADR-10 Security:** OWASP MASVS, TLS1.2+, PII AES-256-GCM (KMS), `bank_hash` SHA-256+salt only, OTP throttles, maker-checker payouts + thresholds, immutable `audit_log`. Rejects plain PII, single-approver.
**ADR-11 Multi-country:** Abstract `currencies, rails, id_providers, fee_policies` + country flag; no extra rails now. Rejects hard-code NGN or full multi-currency V1.
**Schema:** users→memberships→groups→cycles→contributions/payouts; ledger append-only; score_history chained; disputes→evidence; consents; devices; `webhook_events(rail_ref UNIQUE)`; notifications. Idx: `(group,status)`, `(user,status)`, `idempotency_key`, `due_date`.
**API:** `POST /auth/otp/request|verify|refresh|logout` · `POST/GET /groups, GET/PATCH /groups/:id, POST /groups/:id/join|approve|payout-order` · `GET /memberships/me` · `POST /contributions/init, POST /webhooks/psp/:provider` · `POST /payouts/initiate|approve` · `GET /groups/:id/ledger, POST /ledger/close` · `GET /score/me|history` · `POST/GET /disputes, POST /disputes/:id/evidence|resolve` · `POST/GET/DELETE /consents`.

## PHASE 3 — Ajo + Money Build (Wk 3-6)

Stories US-01..11. Auth + ID/QR; create/invite/approve + order freeze (random seeded, voting >50%); VA/member; card+transfer + fee split receipt + auto-match <5min; reminders T-24/T-0, grace 48h, late fee, default; payouts quorum + maker-checker + batches 10:00/15:00 WAT + balanced-guard + <24h; exit/refund matrix (pre-start 3d, mid-cycle 7d, post-payout block); disputes + audit.
Demo Wk4: create→join→frozen. Demo Wk6: contribute→match→payout balanced. Exit: 2 sandbox groups, no manual moves.

## PHASE 4 — Credit Engine Build (Wk 7-8)

Weights v1.0 + norms + thin-file + confidence; decay + history + audit; ITI/GTI + Fraud separate + share-freeze High; Passport (ID/QR/link, tier/trend, breakdown, consent); Basic report free. Fixtures: 12/12→≥700 Gold; 2/10→-120pts; N=2→PROVISIONAL + Inst 403; 90d inactive ex-750→-80..120; 3 accts/1 device→Fraud High blocked; recalc <5s. Exit: 100% scored + explainer. Demo: `2 lates −85pts`.

## PHASE 5 — QA + Non-Functionals (continuous + Wk 9-12 gate)

Unit Jest ≥80% (OTP, fee ₦20k+₦200, order freeze, grace→default); contract Supertest/Pact + 4xx/409; ledger property (balanced, 10x replay→1 confirmed, only confirmed mutates); E2E Playwright (happy, shortfall block, dup payout→single transfer, refund variants); UAT 2→20 groups (Aunty Bola 10×₦10-50k, EN+Pidgin scripts, WhatsApp log); chaos (double webhook, PSP down→failover, wrong amount→suspense, NIBSS mismatch).
NFRs: p95 API <300ms (p99 <800ms), webhook→confirmed <5min p95, unmatched <5%, payout <24h ≥98%, uptime 99.5%, RPO <15m RTO <2h, offline queue idempotent, OTP 5/15m.
Analytics: `otp_success, kyc_completed, group_created, member_joined, contribution_confirmed, payout_completed, score_viewed, report_shared, dispute_opened/resolved, refund_completed` (+group/cycle/amount/fee/method/latency/score/tier/fraud/weights_hash). Dashboard: activation ≥60% 7d, full ≥80%, on-time ≥85%, payout ≥98%, coverage 100%, SLA, suspense, revenue. Alerts: funnel drop >10% WoW, unmatched spike, payout breach.

## PHASE 6 — Pilot + Ops (Wk 9-12)

2→20 live groups. Runbook: suspense triage daily 09:00 WAT (<24h match; wrong amount→contact/refund-or-topup); refunds source-only (3d/7d, failed 1-3d auto-reverse); disputes ack 24h <7d resolve (≤5 files/10MB, admin first, Ops escalate, reason codes); payout comms T-24h EN+Pidgin, cutoff miss→next batch + ETA, shortfall cites rule; SEV1 money-loss/down>15m→freeze payouts + page BE/DevOps/PM, SEV2 4h, SEV3 next sprint, post-mortem 48h. Dashboard live. Exit: ≥85% on-time, ≥98% payout, unmatched <5%, P0/P1 closed.

## PHASE 7 — Launch (Wk 12) + V2/V3 Gates

Checklist (counsel-gated): safeguarded deed + PSP live + 2nd failover; NDPA (consent logs, RoPA/DPIA, DPO, retention/deletion); terms/privacy + Pidgin 1-pager; fee disclosure pre-pay + split receipt; PWA install guide; WhatsApp support + hours + escalation; QA exit + 20-group UAT + rollback + payout-freeze switch tested. Go/no-go: SLA 4 wks + retention.
V2 triggers: retention >60% + SLA → BVN via licensed partner; install <40% or offline >15% → native; ≥3 institutions → portal/API (Starter 1k/Growth 10k/Enterprise; Standard ₦500/Verified ₦1500/Institutional ₦5000); fees cover PSP+ops. V3: multi-country (currency/rails/ID/tax), marketplace via authorised lenders only, SME/coop financing.
Risks: delay→2 PSPs; wrong payout→enquiry+source-only+checker; double-credit→idempotency; collusion→vouch weighting + Fraud split; regulatory→gate; creep→enforce V1 OUT (no BVN/native/portal/USSD/lending).
Open Qs: settlement holder? refund liability? penalty caps? BVN DPA? reserve custody? fee VAT? PSP/VA choice? PWA→native trigger?
