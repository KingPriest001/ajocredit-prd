# api (NestJS + Postgres + Prisma + Redis BullMQ)

**Status:** scaffold pending Node 20.

Planned modules: `auth` (OTP/KYC-lite) · `groups` · `memberships` · `cycles` · `contributions` · `ledger` (append-only + idempotency) · `payouts` (maker-checker + batches) · `scoring` (weights v1.0 + decay + ITI/GTI/Fraud) · `disputes` · `consents` · `notify` · `recon`.

Queues: `webhooks, payouts, scoring, notify, recon`. Cron: payout batches 10:00/15:00 WAT, daily close.

TODO (needs Node): `nest new`, Prisma schema from `AJOCREDIT-PRD-Refined.md` §2.4, BullMQ workers, PSP adapter (Paystack/Flutterwave), Jest fixtures (perfect/defaulter/thin/inactive/sibyl).
