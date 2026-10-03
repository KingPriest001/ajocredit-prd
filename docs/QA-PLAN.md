# QA Plan (V1) — fixtures, gates, NFRs

**Run (needs Node 20):** `npm test` runs `api/src/ledger/money.test.ts` + `api/src/scoring/score.test.ts`.
**Prototype checks (no install):** open `prototype/index.html` → create group <60s, pay ₦20,200 → receipt + Score +5, offline toggle → queue banner, failed card → retry, vote → quorum bar.

## Fixtures (must pass)
- Money: fee ₦20k→₦200/₦20,200; 10x replay→1 confirmed; double webhook→ignored; payout shortfall/unbalanced/self-approve/duplicate→blocked.
- Score: 12/12→≥700 Gold; Ada→700-799 Gold; 3/10 defaults→drop ≥100; N=2→PROVISIONAL; 90d inactive→drop ≥50; 3 accts/1 device→Fraud High + share blocked.

## NFR gates (measure before pilot scale)
- p95 API <300ms (p99 <800ms); webhook→confirmed <5min p95; unmatched <5%; payout <24h ≥98%; score recalc <5s; uptime 99.5%; RPO <15m RTO <2h.
- OTP 5 fails→15-min lock; PII AES-256, bank hash only; maker≠checker payouts; audit rows on every money/score/consent write.

## UAT (2 → 20 groups, Aunty Bola: 10 × ₦10-50k)
Scripts EN+Pidgin: T1 create <60s; T2 contribute + fee recall; T3 payout countdown; T4 score explainer; T5 offline dispute. Bar: ≥4/5 unaided, SUS ≥78, on-time ≥85%, dispute <7d.

## Analytics events
`otp_success, kyc_completed, group_created, member_joined, contribution_confirmed, payout_completed, score_viewed, report_shared, dispute_opened/resolved, refund_completed` (+group/cycle/amount/fee/method/latency/score/tier/fraud/weights v1.0). Dashboard: activation ≥60% 7d, full ≥80%, on-time ≥85%, payout ≥98%, coverage 100%.

## Exit to Phase 6
All fixtures green, 2 sandbox groups balanced, P0/P1 closed, counsel sign-off on DPIA/threat model.

## Functional-Spec acceptance (from v1 Draft §10 — all must hold)
- [ ] No double-charge on retry after failure (idempotency verified).
- [ ] Cycle can't reach paid_out with any pending/partial/failed contribution (no V1 admin override).
- [ ] Late inside grace → no score penalty; FAILED is technical, never penalized if retried in grace.
- [ ] Disputed penalty excluded from live Credit Power while under_review.
- [ ] Pre-payout exit → slot + obligations transfer to replacement member.
- [ ] Post-payout stop → immediate defaulted, no grace ladder.
- [ ] Offline-queued payment for closed cycle → redirected to next open cycle, notified.
- [ ] <50% cycles done → admin alone cannot dissolve (majority required).
- [ ] Every manual admin action on order/status writes a visible audit entry.
