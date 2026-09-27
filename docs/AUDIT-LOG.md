# Audit Log Convention

Every money/score/consent mutation writes `audit_log(actor_id, action, entity, entity_id, prev_hash, hash, created_at)` — append-only, no UPDATE/DELETE.

- Ledger: `ledger_entries` hash-chained per group; reversals are new rows (`type=reversal`, `ref_id` → original).
- Score: `score_history(user_id, score, inputs_json, weights_version=v1.0, prev_hash, hash)`.
- Consent: `consents(user_id, purpose, granted_bool, scope_hash, created_at, revoked_at)`.
- Payouts: maker (`initiated_by`) ≠ checker (`approved_by`); both logged.
