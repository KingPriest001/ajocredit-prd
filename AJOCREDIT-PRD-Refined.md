# AJOCREDIT — Refined PRD V2

**Product:** AJOCREDIT — *Turn Your Ajo Into Bank Credit*
**Owner:** Boniface Samuel / KingPriest001
**Market:** Nigeria (V1), Africa/emerging (V3)
**Source:** Refinement of `Untitled document (1).md` Parts 1-6
**Status:** Draft — requires legal/partner validation where flagged

---

## 1. Product Identity (unchanged strategy)

**V1:** Credit-Building Platform powered by community savings (Ajo/Esusu/Adashe).
**Long-term:** Alternative Credit Infrastructure.
**Progression:** Community Savings → Transactions → Behaviour → Financial Identity → Trust → Credit → Access → Infrastructure.
**Core asset:** AJOCREDIT Financial Identity™ (identity + savings + reliability + participation + reputation + verification) → Score 0-1000 + Trust Tiers (Bronze 0-399, Silver 400-599, Gold 600-799, Platinum 800-1000).
**V1 customer:** Existing Ajo groups (e.g. Aunty Bola: 10 members, ₦10k-₦50k weekly/monthly, WhatsApp + transfers + sheets today).

---

## 2. V1 MVP Detail

### 2.1 Roles
| Capability | Admin | Member | Viewer |
|---|---|---|---|
| Signup OTP + KYC-lite | Yes | Yes | Yes |
| Create group, invite/approve, set payout mode | Yes | No | No |
| Vote/vouch | If contributor | Yes | No |
| Contribute, receive payout | Yes | Yes | No |
| Early exit/refund request, dispute + evidence | Yes | Yes | No |
| Resolve group dispute | Yes (group only) | No | No |
| View full ledger/reports | Yes | Own + summary | Summary |
| Move safeguarded funds directly | **No — payout engine only** | No | No |

### 2.2 Scope IN / OUT
**IN:** Rotational Ajo + Target Savings; 1-min group creation; link/code invite; payout order admin/random/voting; card + bank transfer; dedicated VA per member per group; fee pre-display (₦20,000 + ₦200 = ₦20,200; pot gets ₦20,000); reminders/grace/penalty/default; system payouts; rule-based exit/refund; multi-group; dispute centre + audit; Financial Identity + Score + basic report; governance (late fee, grace, voting threshold).
**OUT:** Lending disbursement, marketplace, institution portal/API, USSD, insurance/guarantee, BVN/NIN, native apps (V1 = mobile web/PWA), SaaS billing, data sale.

### 2.3 User Stories + Acceptance (Given/When/Then)
- **US-01 Signup/OTP:** NG phone → 6-digit OTP <60s, 5-min expiry, lock 15-min after 5 fails; verify → `User.status=active`.
- **US-02 KYC-lite:** Name + DOB 18+ (+optional selfie) → `verification_level=KYC_LITE`, AJOCREDIT ID + QR. No BVN in V1.
- **US-03 Group creation:** Name, amount, size, frequency, start, payout mode, rules → created <60s, `status=forming`, ledger opened.
- **US-04 Invite/join:** Link/code + US-01/02 + admin approve → `Membership.active`, VA assigned, slots lock at capacity.
- **US-05 Payout order:** Admin|random|voting frozen pre-start in governance record; random = server-seeded shuffle logged; voting = >50% threshold, 1 vote/member, deadline.
- **US-06 Contribution:** Due cycle + card/transfer to VA → pre-confirm shows principal + fee + total; `confirmed` → `LedgerEntry(pot ₦20k, fee ₦200)`; auto-match <5min.
- **US-07 Escalation:** T-24h/T-0 reminders → 48h grace (config) → late fee → 2 missed cycles = `default` + Score hit + GTI update.
- **US-08 Payout:** Full collection (or rule partial) + beneficiary KYC-lite → transfer <24h, `completed`, ledger balanced, no manual admin transfer.
- **US-09 Exit/refund:** Pre-start + no payout → full refund - fees (3-day SLA); mid-cycle + payout received → block until settlement; mid-cycle + not received → net refund - penalties (7 days); Target → pro-rata per policy.
- **US-10 Multi-group:** 2nd/3rd join → separate Membership + VA, single Identity aggregates; Score recalcs.
- **US-11 Dispute:** Category + evidence (≤5 files, 10MB) within 14 days → `open` → resolution + reason <7 days, immutable audit.

### 2.4 Data Model
`User(id, phone, name, dob, verification_level, ajocredit_id, score, tier)` · `Group(id, name, type, amount, size, frequency, start_date, payout_mode, rules_json, status)` · `Membership(id, user_id, group_id, role, va_no, payout_slot, status)` · `Cycle(id, group_id, seq, due_date, pot_expected, pot_collected, status)` · `Contribution(id, membership_id, cycle_id, amount, fee, total, method, ref, status)` · `Payout(id, group_id, cycle_id, beneficiary_id, amount, bank_hash, status, idempotency_key)` · `LedgerEntry(id, group_id, debit, credit, amount, type, ref_id)` · `Dispute(id, group_id, cycle_id, raised_by, evidence_urls[], status, resolution_note)`

### 2.5 V1 Success Metrics
Activation ≥60% join in 7d; ≥80% groups reach full; on-time ≥85% by due+grace; unmatched <5%; payouts ≥98% <24h balanced; 100% contributors with ≥1 confirmed have Score; dispute SLA <7d.

---

## 3. Money Engine + Compliance (requires counsel validation)

**Custody:** AJOCREDIT never holds funds. Member → Collection (PSP e.g. Paystack/Flutterwave) → Partner Bank Safeguarded Account (DMB/MFB/PSB/MMO TBD) → Ledger → Payout Engine → Beneficiary. Separation: Rail → Safeguarded → Ledger → Rules → Payout.
**Ledger:** Double-entry, append-only; idempotency `group+member+cycle+rail_ref`; states `pending→confirmed|failed→reversed`; only `confirmed` mutates pot + Score; 1 VA per member per group (NUBAN); realtime webhook + T+0/T+1 NIBSS match; suspense ledger + daily close; payout batches 10:00/15:00 WAT.
**Rails/fees:** V1 card + transfer; V2 USSD. Contribution intact; fee to revenue account, never co-mingled; tiers as assumptions (<₦10k 1.5%, ₦10k-100k 1.0%, >₦100k 0.75%); mandatory pre-pay display + split receipt.
**Escalation defaults:** Reminder T+0+2h, Reminder2 T+1, grace T+1..T+3, penalty T+4 (cap TBD), default T+7/cycle close.
**Exit/refund matrix:** See US-09; no arbitrary withdrawals; refunds to verified source account only; failed → auto-reverse 1-3d.
**Nigeria 2026 checklist:** No deposit-taking/lending without CBN licence (BOFIA 2020); operate via licensed partner + PSP; NDPA 2023 + GAID 2025 (explicit/logged/revocable consent, RoPA/DPIA/DPO); AML/CFT CBN Mar 2026 + NFIU STR/CTR (post-grey-list scrutiny); KYC tiers V1 OTP (low limits) / V2 BVN via licensed partner / V3 NIN; transfer limits + NUBAN traceability + full audit trail.
**Risks:** Double-credit (dedupe), wrong-account payout (name enquiry + source-only + maker-checker), settlement delay (2 PSP failover), collusion (separate Fraud Score).
**Open legal questions:** Settlement account holder/trust deed? Refund SLA liability? Penalty caps? BVN/NIN lawful basis? Reserve/guarantor treatment? Fee VAT?

---

## 4. Credit Engine — Methodology v1 (model_version 1.0.0, canonical: `api/src/scoring/methodology.ts`)

**Supersedes the earlier weights sketch below with the adopted Credit Scoring Methodology:** additive components (Consistency 400 + History 250 + Tenure 150 + Diversity/Trust 100 + Profile 100 = 1000) minus penalties (late −20, open dispute −50, default −150; post-payout default −300 OPEN). Tiers: Bronze 0–349 / Silver 350–599 / Gold 600–799 / Platinum 800–1000. Credit Power = linear interpolation within tier (520 → ≈₦559,600; UI ₦450,000 is a placeholder pending Risk). Cold start 250. "What moves your score" shows 30-day DELTAS. Score is gamified/user-facing only — never the underwriting artifact (separate model with Risk/Legal before any lending).

**Dimensions:** Reliability (pay when due?) + Savings Behaviour (sustainably?) + Community Trust (in groups?).
- `on_time_rate`, `default_rate`, `completion_rate`, `consistency = 1-CV(intervals)`, `streak_factor=min(streak/12,1)`, `total_saved/avg/tenure`, `group_trust_contrib`, `vouch_net`, `L={0:OTP,1:BVN,2:NIN}`.
**Normalization:** n1=on_time_rate (35%); n2=0.6*(1-min(CV,1))+0.4*streak (20%); n3=min(log10(1+total)/log10(1+5M),1) (10%); n4=min(G_clean/5,1)*completion_rate (15%); n5=max(1-2*default_rate,0) (10%); n6=GTI/1000 (5%); n7={0:0.4,1:0.8,2:1.0} (5%). Thin-file: N_due<3 or tenure<21d → PROVISIONAL (cap Silver, exclude Institutional), confidence = min(N/10,1)*0.6+min(tenure/180,1)*0.4.
**Formula:** `Score = round(1000*Σ(w*n))`. Example Ada (11/12 on-time, CV 0.15, ₦220k, 1/1 groups, GTI 720, L0) → 742 Gold.
**Decay:** `d(t)=0.5^(age/90)`; `n_i = 0.6*n_recent90 + 0.4*n_older365`; inactivity >60d → `Score_eff = Score*0.5^(inactive/180)` (~-50pts/mo at Gold). Anti-gaming: log-cap, CV penalty, reconciled-only entries.
**ITI/GTI/Fraud:** ITI=1000*(0.5*on_time+0.2*completion+0.15*(1-dispute_loss)+0.15*vouch); GTI=1000*(0.3*on_time+0.25*(1-default)+0.15*completion+0.15*governance+0.15*reserve). Fraud separate (device reuse, multi-account, SIM-swap, velocity) — perfect payer on cloned device keeps Score, trips Fraud=High + freezes passport.
**Lifecycle:** Recalc on settle/payout/late/default/dispute/IDV; store `score_history`; audit `{inputs_hash, weights_v1.0, prev→new}`; trend sparkline.
**Consent/Passport:** Explicit per-request, purpose-specific, revocable, logged. Passport: ID + signed QR/link + tier/trend + breakdown + groups/defaults + IDV + controls. Reports: Basic free / Standard ₦500 / Verified ₦1500 / Institutional ₦5000 (assumptions).
**Acceptance:** Perfect 12/12 → ≥700 Gold; 2/10 defaults → drop ≥120pts; N=2 → PROVISIONAL + Institutional 403; 90d inactive ex-750 → -80..120pts; 3 accts/1 device → Fraud High + share blocked; recalc <5s + audit row.

---

## 5. Business + Evolution (unchanged)

Basic Groups Free + Premium Paid; member-paid fee; Basic Identity free, verified reports paid; Credit API tiered (1k/10k/Enterprise); SaaS ~₦50k+/mo indicative; only anonymised insights, never sell individual records; volume pricing; global arch + country economics. V1 Community+Credit → V2 Identity Infra (native, BVN, portal, API) → V3 Alt Credit Infra (multi-country, marketplace via authorised partners, no AJOCREDIT lending without licence).

**Flywheel:** Community → Transactions → Behaviour → Identity → Trust → Credit → Access → Infrastructure.
