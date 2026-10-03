# Edge-Case Rules (adopted from Functional Spec v1 Draft — the operational backbone)

Status: adopted into schema (`api/prisma/schema.prisma`), QA (`docs/QA-PLAN.md`), runbook (`docs/PILOT-RUNBOOK.md`).
Anything marked OPEN needs a product decision — see `docs/ALIGNMENT-3DOCS.md`.

## 1. Payout order
- V1 default for NEW groups: **Random Draw** (auditable seed, shown to all at creation — kills favoritism disputes).
- Admin-Assigned allowed with reason (optional text) + full order visible pre-activation + 24h member objection window → Dispute "Group Setup Objection".
- Bid-based ordering: OUT of V1 (V2, needs fee/incentive design).
- Mid-group swaps: only before either cycle starts + both members' in-app consent + admin confirm, logged. Unilateral admin change post-activation → any objection opens "Group Admin Misconduct".

## 2. Short pot at due date → Policy A only (V1)
- Payout HELD (`cycle = SHORT`), recipient sees live X-of-Y progress. No partial release without quorum.
- Policy B (platform advances shortfall): OUT — lending activity, needs FCCPC/CBN path first.
- Policy C (peer cover "Cover for Aunty Ngozi"): OPEN, V1.1 at earliest — opt-in, logged inter-member loan, never presented as closing group risk.

## 3. Default ladder
1. 1 late (past 48h grace): auto reminder (push+SMS/WhatsApp), −20 score (decays if not repeated).
2. 3 lates in rolling 12 cycles: "at risk" flag to admin; member can't CREATE groups until resolved.
3. Full default (silent 7 days / 3 reminders): admin marks `defaulted` → auto-opens "Member Default" dispute, −150, account frozen from joining/creating until resolved.
4. Post-payout stop: immediate `defaulted`, no ladder. Penalty OPEN (recommended −300, needs Risk sign-off).

## 4. Exit & removal
- Pre-payout exit: NO cash refund (contributions may have funded earlier payouts). Slot + remaining schedule transfer to a Replacement Member (admin-invited). None in 7 days (recommended) → short-handling + resequence prompt. All notified, audited.
- Post-payout exit: treated as default (above), likely partner-collections referral (closest thing to unpaid debt).
- Forced removal: same bifurcation + auto-dispute for independent review + stated reason + appeal. Admin can never remove unilaterally without a trail.

## 5. Disputes
- Categories (6): non-payment · payout-not-received · wrong-amount · fraud/impersonation · admin-misconduct · score-dispute (also "Group Setup Objection" at creation).
- Flow: Open → Triaged → Under Review → Resolved → Closed, with Escalated / Appeal (different reviewer) branches.
- SLAs: Standard (cats 1–3, 6): respond 24h, resolve 5 business days. High (cats 4–5, funds missing): respond 24h auto-escalated, updates every 48h, no fixed close (partner may be involved).
- Evidence: system transaction IDs are AUTHORITATIVE; screenshots supplement only. Every resolution cites txn IDs.
- Open dispute: penalty flagged "under review", EXCLUDED from Credit Power until resolved (reverse or confirm).

## 6. Dissolution
- >50% cycles done: admin may dissolve with notice; undistributed pot refunded pro-rata to members unpaid.
- <50% done: majority member confirmation required (admin alone cannot — abscond risk).
- Platform-initiated (fraud): freeze, notify, hold funds, per-member net-position (refund / nothing / default referral) — never blanket.

## 7. Technical guarantees
- Idempotent retries: failed attempt never double-charges; FAILED is technical, never penalized if retried in grace.
- Offline conflict: queued payment for a since-closed cycle auto-redirects to next open cycle + notify. Never drop/misapply.
- Ghost members: counted members must meet Profile Strength threshold; flag multi-member same-device / near-simultaneous creation for review.
- Collusion: payout needs system-verified complete pot — NO admin override in V1. Future override needs second approver + mandatory post-hoc audit.

## 8. Notifications (Push + SMS)
- Due soon: 3 days + 1 day before. Late: immediately at grace expiry (member + admin).
- Short pot: immediately (recipient + admin). Defaulted: immediately (member + admin + queue, auto-dispute).
- Dispute opened: immediately (parties + support). Escalated: internal alert within 1 hour. Dissolved: immediately + reason + refund status.
