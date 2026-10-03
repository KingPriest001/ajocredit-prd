# Alignment Log — 3 Companion Docs → Project (2026-10-03)

Source docs (PDFs, pasted in chat): **Credit Scoring Methodology v1** · **Regulatory & Licensing Memo (Nigeria)** · **Functional Spec: Payout, Default & Dispute Edge Cases v1**. Status in all three: *Draft for review — not legal advice; validate with counsel.*

## Adopted (in this repo)
**Scoring (→ `api/src/scoring/methodology.ts` v1.0.0, tests, `verify.mjs`, UI):**
- Additive components 400/250/150/100/100 − penalties (−20/−50/−150); tiers Bronze 0–349 / Silver 350–599 / Gold 600–799 / Platinum 800–1000; power interpolation (520 → ≈₦559,639); cold start 250; delta-driven UI panel; fraud Bronze hard-cap; versioned breakdown object (audit-ready).
- Replaces our earlier 35/20/10/15/10/5/5 weights sketch (kept in git history). `trust.ts` tier bands updated to match.
- UI variance logged: mock shows ₦450,000 at 520 (placeholder) vs formula ≈₦559,600 — Risk/Finance to reconcile before build (methodology §2/§7).

**Functional spec (→ schema enums, `docs/EDGE-CASES.md`, QA checklist, runbook, openapi):**
- Status enums enriched (OBLIGATED/REMOVED, SHORT, PARTIAL/WAIVED, HELD, TRIAGED/APPEAL); Random Draw default for new groups; Policy A short-handling; 4-rung default ladder; replacement-member exit (7-day window recommended); dissolution >50%/<50% rules; 6 dispute categories + SLAs (24h/5d standard, 48h updates high); system-txn-ID evidence standard; under-review score exclusion; idempotent failures never penalized; offline redirect; ghost/collusion guards; 9-item QA checklist; 3d+1d reminders.

**Regulatory (→ `docs/REGULATORY.md`, DPIA, threat model, launch gates):**
- Option A/D phased path; bureau data-exchange (CRC/CreditRegistry/FirstCentral) for Passport sharing; FCCPC DEON before any lending; DCPMI ₦250k + DPO/DPCO + CAR; MFB capital ladder; 5 counsel questions.

## Conflicts resolved (doc wins over our earlier text)
1. Tier bands: 350/600/800 (methodology) over our 400/600/800. ✅ adopted everywhere incl. prototype 520 Silver.
2. Penalty scale: flat −20/−50/−150 over our rate-based n5. ✅ adopted.
3. Reminders: 3d+1d (spec matrix) over our T-24/T-0. ✅ adopted in runbook/templates note.
4. Dispute SLA: 24h/5d (+48h high) over our <7d. ✅ adopted.
5. New-group order default: Random Draw (spec) — PRD allowed all three; prototype wizard doesn't select order → default recorded as Random unless admin picks otherwise. ✅ noted in EDGE-CASES.
6. Cold start: 250 baseline over our PROVISIONAL-cap-Silver. ✅ adopted (250 = low Bronze; provisional concept retired).

## OPEN product decisions (need YOU + Risk/Legal — not engineering)
1. Post-payout default penalty: **DECIDED 2026-10-03 — −300 (2× pre-payout −150).** Matches the real exposure (money taken, side unfinished). In `methodology.ts`, tests, `verify.mjs`, prototype exit screen, EDGE-CASES.
2. Peer-cover (Policy C): **DECIDED 2026-10-03 — LATER, not V1/V1.1.** Revisit post-pilot with counsel (inter-member loans carry regulatory shading). Never presented as closing group risk.
3. Replacement-member window: **DECIDED 2026-10-03 — 7 days confirmed.** Matches refund-SLA rhythm; in EDGE-CASES + prototype exit screen.
4. Tier ₦ ceilings: **DECIDED 2026-10-03 — B now, A pre-scale.** Placeholders stay in V1 UI with honest "ESTIMATED illustrative value" labels (shipped); formula-vs-mock variance (≈₦559,600 vs ₦450,000 at 520) documented, not hidden. Risk/Finance to model real exposure limits and lock copy before pilot scale / before any lender sees a Passport. Owner: TBD (assign a name).
5. Dispute/appeal SLA: **DECIDED 2026-10-03 — commit 24h ack + 5 business days standard, founder-owned at pilot.** Auto-ack is instant; human first response within 24h; standard resolution 5 business days; high-severity updates every 48h, no fixed close. Rationale: at 2–20 groups the founder IS support (WhatsApp Mon–Sat) — volume is low enough to honor personally, and the UI already promises exactly this. Review trigger: weekly caseload over 10, or any SLA breached twice in a month → assign dedicated support BEFORE passing 20 groups. No UI/code changes needed.
6. Peer-endorsement gaming: accept cap-40 + monitoring, or tighten further?
7. Loan-trigger threshold/owner: **DECIDED 2026-10-03 — no in-app loan offers in V1; V2 referral trigger = Gold+ (600+) AND 3+ completed cycles AND zero defaults AND BVN-linked, owned as: licensed lending partner owns the APPROVAL, AJOCREDIT PM owns the REFERRAL trigger + data handoff.** Rationale: methodology §8 + regulatory memo both forbid conflating gamified power with underwriting ("app said ₦750k, lender said ₦80k"). Gated on FCCPC DEON registration + bureau agreement first. No UI loan offers until then — Passport stays informational.
8. BVN/NIN at launch: **DECIDED 2026-10-03 — OPTIONAL in V1, mandatory track in V2.** V1 stays KYC-lite (phone+DOB+selfie); profile maxes at 80/100 until BVN/NIN arrives via licensed partner (methodology already prices it at +20, no formula change). Rationale: mandatory BVN adds pilot friction for market women AND triggers CBN 2026 BVN-framework obligations, sensitive-data DPIA scope, and partner-AML alignment — all still counsel-gated. V2 gate: partner signed + counsel clears framework, then flip to required for Silver+ advancement.
9. Bureau agreement: **DECIDED 2026-10-03 — as PROCESS, not a pick: RFP all three (CRC Credit Bureau, CreditRegistry, FirstCentral) on coverage + verification-API quality + commercial terms + SLA; default candidate CRC subject to that review; owner: founder; deadline: before V2 Passport-sharing ships.** Honest note: picking a winner blind in a repo doc would be theater — pricing/API reality decides. Selection recorded here when signed.
10. DCPMI filing: pre-launch now, or at a user-count threshold — who files?
