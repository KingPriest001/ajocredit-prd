# Regulatory Path (distilled from Regulatory & Licensing Options Memo — NOT legal advice)

**Standing rule:** Nigerian regulation is activity-based. "It's just an Ajo app" is no defence. Every item below needs Nigerian fintech counsel sign-off before build-around. Unlicensed deposit-taking is a **criminal** offence under BOFIA, reaching directors personally.

## Functional mapping (what we do → what it resembles)
Pooling pots = deposit-taking/custody · rotating payout = fund disbursement · Credit Power = credit scoring · Passport sharing = bureau-adjacent sharing · USSD/lending V2 = digital consumer lending · BVN/NIN/selfie = sensitive data under NDPA 2023.

## Structure: Option A/D (tech layer + licensed custodian + separate collection rails)
- AJOCREDIT stays a technology company. Licensed MFB/PSB/DMB holds pooled funds in a **segregated designated account** (never a standard business account); licensed PSSP/MMO runs collection rails.
- Own MFB licence deferred (Tier 2 Unit ₦50M rural → Tier 1 Unit ₦200M → State ₦1B → National ₦5B; 12+ months typical). Revisit at scale (Flutterwave-2026 precedent). Cooperative registration = single-state pilot only, not national architecture.

## Credit Power / Passport — the delicate one
- In-app only (user sees own behaviour): low exposure, engagement mechanic. Keep gamified.
- Shared/sold to lenders for decisions: resembles **credit bureau business (Credit Reporting Act 2017, only 3 CBN-licensed bureaus)**. Route external verification via data-exchange with an existing bureau (CRC, CreditRegistry, FirstCentral) — never issue what reads as a credit report ourselves. Keep underwriting model separate from the gamified score (avoids "app said ₦750k, lender said ₦80k").

## Gates by phase
- **V1 launch:** custodian MOU (segregated account), PSSP/MMO rails, DCPMI plan, no lending, no bureau activity, no BVN/NIN.
- **V2 (Passport sharing + any loan):** FCCPC DEON registration FIRST (2025 regs, upheld July 2026; 2022 precedent: mass delisting), bureau data-exchange agreement.
- **Scale:** revisit own MFB licence when volume/funding justify capital.

## AML/CFT
Program ownership sits with licensed custodian/PSSP under CBN; AJOCREDIT runs a contractually-aligned KYC/CDD program. Counsel to confirm any separate NFIU/SCUML registration for our facilitator role.

## Counsel questions (decide before sprint planning)
1. Custody partner licensed + segregated-account term sheet/MOU in discussion?
2. Does "Share my Passport" need a bureau data-exchange agreement?
3. FCCPC DEON timeline/budget once V2 lending is scheduled?
4. DCPMI now or at a user-count threshold — who files?
5. BVN/NIN linkage under CBN's tightened 2026 BVN framework + partner AML compatibility?
