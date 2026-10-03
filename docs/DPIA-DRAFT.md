# DPIA Draft (NDPA 2023 / GAID 2025 — requires counsel sign-off)

**Purpose:** Ajo digitisation + Financial Identity + Score. Lawful basis: consent (explicit, per-purpose) + contract (group participation).
**Data:** phone, name, DOB, optional selfie, group/ledger/score history, device fingerprint, bank hash only (no raw acct storage), dispute evidence (≤5 files/10MB).
**Minimisation:** KYC-lite V1 (no BVN/NIN); evidence auto-retain 24 months then delete; logs redact OTP/PIN.
**Consent:** per-request lender sharing (purpose-specific, revocable in-app, logged with timestamp + scope hash). No bulk screening. Privacy notice EN + Pidgin 1-pager.
**Rights:** access / correction / erasure / withdraw consent via Profile → request (SLA 30d); export score report.
**Security:** TLS1.2+, AES-256-GCM PII (KMS), private S3 + presigned, role access (admin/member/viewer), audit_log immutable.
**Transfers:** PSP/VA/SMS processors under DPA; no cross-border V1; NIBSS recon in-country.
**Retention:** active + 24mo post-exit (regulatory), then anonymise. Backups PITR 30d, encrypted.
**RoPA/DPO:** Given nationwide 1M+ target + selfie/biometrics + BVN/NIN roadmap, plan to register as **Data Controller/Processor of Major Importance (DCPMI)** — fee band ₦250,000. Appoint DPO or engage licensed DPCO; file annual Compliance Audit Return (CAR). RoPA entry TODO (owner PM). Run a dedicated DPIA for selfie/liveness + BVN/NIN linkage (sensitive data). NDPC now in active enforcement (through 2026) — not a later item. Counsel to confirm pre-launch vs threshold timing + filing owner.
**Risks:** SIM-swap account linkage; group admin sees member phones — mitigate with masked display + code invites; evidence over-collection — mitigate with 5-file cap + notice.
