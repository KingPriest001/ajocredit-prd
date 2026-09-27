# Architecture (V1) — ADRs + Contracts

**Stack:** Next.js 14 PWA · NestJS/TS monolith · Postgres 15 + Prisma · Redis BullMQ · Paystack/Flutterwave · Termii/Africa's Talking · S3-compatible evidence.
**Source:** `IMPLEMENTATION-PLAN-DETAILED.md` Phase 2. Schema: `api/prisma/schema.prisma`. API: `api/openapi.yaml`.

## ADR-01 PWA (Next.js, Capacitor-ready)
Context: low-end Android, WhatsApp-first, V1 OUT native. Decision: Next.js App Router PWA + SW + IndexedDB outbox; `/mobile` Capacitor wrapper later. +1 codebase/fast deploy; -iOS push gaps. Rejects Flutter/RN, pure web.

## ADR-02 API (NestJS + PG + Prisma + BullMQ)
Modular monolith (TS strict); PG system of record; Prisma migrations; queues `webhooks, payouts, scoring, notify, recon`. +ACID/velocity; -scale ceiling (stateless + split later). Rejects Express bare, microservices, Mongo.

## ADR-03 Auth (OTP + KYC-lite)
6-digit OTP (<60s, 5-min expiry, 5 fails→15-min lock); KYC-lite name+DOB 18+; JWT 15-min + rotating refresh + reuse detection; device fingerprint → Fraud. Rejects passwords/OAuth, long JWT, V1 BVN.

## ADR-04 Ledger (append-only, idempotent)
`ledger_entries(group, debit, credit, amount, type, ref_id, idempotency_key UNIQUE, status, hash→prev_hash)`; no UPDATE/DELETE (reversals = new rows); `pending→confirmed|failed→reversed`; only `confirmed` mutates pot/score; suspense + daily close + T+0/T+1 NIBSS match; monthly partitions. Key: `group+member+cycle+rail_ref`.

## ADR-05 Payments (PSP adapter + VA/member)
`IPspAdapter{createVA, verifyWebhook, initiateTransfer, nameEnquiry}` (Paystack + Flutterwave failover); HMAC → dedupe `rail_ref` → queue → confirm; NUBAN VA per Membership; payouts source-only + name enquiry.

## ADR-06 Scoring (worker, versioned)
BullMQ `scoring` on ledger-confirmed; `scoring_config v1.0`; `score_history(user, score, inputs_json, version, prev_hash+hash)`; decay `0.5^(age/90)`, `0.6*recent90+0.4*older365`, inactivity >60d `*0.5^(inactive/180)`; PROVISIONAL if N<3 or tenure<21d; p95 <5s.

## ADR-07 Evidence (S3 presigned + scan)
Private bucket, presigned PUT/GET 15-min, 10MB + MIME enforce, scan → clean/quarantined, store URL+hash only.

## ADR-08 Notify (Termii → AT + push)
`ISMS` Termii primary, Africa's Talking failover + web-push VAPID; templates `OTP, PAY_REM_T24/T0, GRACE_T1, PENALTY_T4, PAYOUT_DONE`; queued + logged.

## ADR-09 Infra (Docker + GHA + managed data + OTel)
Compose dev / images + GH Actions (lint→test→migrate-dry→staging→prod gate); managed PG PITR 30d + Redis; vault secrets; OTel → Grafana/Loki. Rejects K8s V1, self-host PG.

## ADR-10 Security (MASVS + AES-256 + maker-checker)
OWASP MASVS, TLS1.2+, PII AES-256-GCM (KMS), `bank_hash` SHA-256+salt, OTP throttles, maker≠checker payouts + thresholds, immutable `audit_log`.

## ADR-11 Multi-country (abstract, no overbuild)
Abstract `currencies, rails, id_providers, fee_policies` + country flag; no extra rails V1.

## Schema summary
users→memberships→groups→cycles→contributions/payouts; ledger append-only; score_history chained; disputes→evidence; consents; devices; `webhook_events(rail_ref UNIQUE)`; notifications. Idx `(group,status)`, `(user,status)`, `idempotency_key`, `due_date`. See `api/prisma/schema.prisma`.

## Endpoint map
Auth `/auth/otp/*` · Groups `/groups*` · Contributions `/contributions/init`, `/webhooks/psp/:provider` · Payouts `/payouts/initiate|approve` · Ledger `/groups/:id/ledger`, `/ledger/recon|close` · Score `/score/me|history` · Disputes `/disputes*` · Consents `/consents*`. Full: `api/openapi.yaml`.
