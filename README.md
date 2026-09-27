# AJOCREDIT

Turn Your Ajo Into Bank Credit.

**Repo:** https://github.com/KingPriest001/ajocredit-prd
**Docs:**
- `AJOCREDIT-PRD-Refined.md` — V2 PRD (weights v1.0)
- `IMPLEMENTATION-PLAN.md` + `IMPLEMENTATION-PLAN-DETAILED.md` — phases
- `archive/Original-PRD-Parts-1-6.md` — source Parts 1-6
- `prototype/index.html` — clickable PWA (open in browser, no build)
- `docs/` — threat model, DPIA draft, audit log, decisions

**Stack (V1):** PWA (Next.js, Capacitor-ready) + API (NestJS/TS) + Postgres + Prisma + Redis BullMQ + Paystack/Flutterwave + Termii SMS.
**Principle:** AJOCREDIT never holds funds. Member → PSP → Partner safeguarded account → Ledger → Payout Engine → Beneficiary.

**Quick start (prototype):** open `prototype/index.html` in browser.
**Quick start (full stack):** see `app/README.md` + `api/README.md` (requires Node 20 — not installed in this env yet).
