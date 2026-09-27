# DPIA Draft (NDPA 2023 / GAID 2025 — requires counsel sign-off)

**Purpose:** Ajo digitisation + Financial Identity + Score. Lawful basis: consent (explicit, per-purpose) + contract (group participation).
**Data:** phone, name, DOB, optional selfie, group/ledger/score history, device fingerprint, bank hash only (no raw acct storage), dispute evidence (≤5 files/10MB).
**Minimisation:** KYC-lite V1 (no BVN/NIN); evidence auto-retain 24 months then delete; logs redact OTP/PIN.
**Consent:** per-request lender sharing (purpose-specific, revocable in-app, logged with timestamp + scope hash). No bulk screening. Privacy notice EN + Pidgin 1-pager.
**Rights:** access / correction / erasure / withdraw consent via Profile → request (SLA 30d); export score report.
**Security:** TLS1.2+, AES-256-GCM PII (KMS), private S3 + presigned, role access (admin/member/viewer), audit_log immutable.
**Transfers:** PSP/VA/SMS processors under DPA; no cross-border V1; NIBSS recon in-country.
**Retention:** active + 24mo post-exit (regulatory), then anonymise. Backups PITR 30d, encrypted.
**RoPA/DPO:** RoPA entry TODO (owner PM), DPO contact TODO, CAR filing via DPCO by 31 Mar if Major Importance — counsel to confirm.
**Risks:** SIM-swap account linkage; group admin sees member phones — mitigate with masked display + code invites; evidence over-collection — mitigate with 5-file cap + notice.
