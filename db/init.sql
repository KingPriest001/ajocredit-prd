-- AJOCREDIT V1 schema — mirrors api/prisma/schema.prisma + Functional Spec §1 enums
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  dob DATE,
  verification TEXT NOT NULL DEFAULT 'OTP',
  ajocredit_id TEXT UNIQUE NOT NULL,
  score INT NOT NULL DEFAULT 250,
  tier TEXT NOT NULL DEFAULT 'Bronze',
  provisional BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'ROTATIONAL',
  amount INT NOT NULL,
  size INT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'Weekly',
  start_date DATE,
  payout_mode TEXT NOT NULL DEFAULT 'random',
  payout_seed TEXT,
  rules JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'FORMING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  va_no TEXT UNIQUE,
  payout_slot INT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_membership_group_status ON memberships(group_id, status);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  due_date DATE NOT NULL,
  pot_expected INT NOT NULL DEFAULT 0,
  pot_collected INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  UNIQUE(group_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cycles_due ON cycles(due_date);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  amount INT NOT NULL,
  fee INT NOT NULL DEFAULT 0,
  total INT NOT NULL,
  method TEXT NOT NULL DEFAULT 'transfer',
  reference TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  beneficiary_id TEXT NOT NULL,
  amount INT NOT NULL,
  bank_hash TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  idempotency_key TEXT UNIQUE NOT NULL,
  executed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  debit_acct TEXT NOT NULL,
  credit_acct TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount > 0),
  type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  hash TEXT NOT NULL,
  prev_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_group_status ON ledger_entries(group_id, status);

CREATE TABLE IF NOT EXISTS score_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '{}',
  version TEXT NOT NULL DEFAULT '1.0.0',
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL,
  raised_by TEXT NOT NULL,
  category TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  scope_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  invited_phone TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  reward_naira INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

-- Seed: Aunty Bola Market Women AJ-4821 (20 members, 15 paid, cycle 1)
INSERT INTO users (id, phone, name, verification, ajocredit_id, score, tier, provisional) VALUES
 ('u-bola', '+2348030000001', 'Aunty Bola', 'KYC_LITE', 'AJ-774821', 520, 'Silver', FALSE)
 ON CONFLICT (id) DO NOTHING;

INSERT INTO groups (id, name, type, amount, size, frequency, start_date, payout_mode, payout_seed, status, rules) VALUES
 ('g-aj4821', 'Aunty Bola Market Women', 'ROTATIONAL', 5000, 20, 'Weekly', '2026-05-26', 'random', 'seed-aj4821-auditable', 'ACTIVE',
  '{"grace_hours":48,"late_fee":500,"vote_threshold":0.5,"replacement_days":7}')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (id, user_id, group_id, role, va_no, payout_slot, status) VALUES
 ('m-bola', 'u-bola', 'g-aj4821', 'admin', 'VA4821001', 7, 'ACTIVE')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO cycles (id, group_id, seq, due_date, pot_expected, pot_collected, status) VALUES
 ('c-aj4821-1', 'g-aj4821', 1, '2026-05-26', 100000, 75000, 'COLLECTING')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status) VALUES
 ('ct-seed-1', 'm-bola', 'c-aj4821-1', 5000, 75, 5075, 'transfer', 'AJ-4821-C1-Bola', 'CONFIRMED')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash) VALUES
 ('le-seed-1', 'g-aj4821', 'psp:paystack', 'pot:g-aj4821', 5000, 'contribution', 'AJ-4821-C1-Bola', 'g-aj4821:m-bola:1:AJ-4821-C1-Bola', 'CONFIRMED', 'seedhash1'),
 ('le-seed-2', 'g-aj4821', 'member:m-bola', 'revenue:fees', 75, 'fee', 'AJ-4821-C1-Bola', 'g-aj4821:m-bola:1:AJ-4821-C1-Bola:fee', 'CONFIRMED', 'seedhash2')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO score_history (id, user_id, score, inputs, version, hash) VALUES
 ('sh-seed-1', 'u-bola', 520, '{"components":{"payment_consistency":{"points":380,"max":400,"delta_30d":60},"contribution_history":{"points":210,"max":250,"delta_30d":40},"tenure":{"points":90,"max":150,"delta_30d":20},"diversity_trust":{"points":40,"max":100,"delta_30d":0},"profile_strength":{"points":80,"max":100,"delta_30d":0}},"penalties":{"late_payments":{"points":-20,"count_30d":1}}}', '1.0.0', 'seedscorehash')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO disputes (id, group_id, raised_by, category, status) VALUES
 ('d-231', 'g-aj4821', 'u-bola', 'non-payment', 'UNDER_REVIEW')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO notifications (id, user_id, kind, title, body) VALUES
 ('n1', 'u-bola', 'due', 'Contribution due in 3 days', '₦5,000 + ₦75 fee for Bodija Weekly. Due May 25.'),
 ('n2', 'u-bola', 'payout', 'Payout in 2 days', 'Aunty Ngozi receives ₦100,000. 15 of 20 paid.'),
 ('n3', 'u-bola', 'credit', 'Credit Power up +₦25,000', 'Consistency 95% for 4 months. Silver · 80 to Gold.')
 ON CONFLICT (id) DO NOTHING;

INSERT INTO referrals (id, inviter_id, code, invited_phone, status, reward_naira) VALUES
 ('r1', 'u-bola', 'AJ-4821', '+2348050000002', 'joined', 500),
 ('r2', 'u-bola', 'AJ-4821-B', '+2347020000003', 'sent', 0)
 ON CONFLICT (id) DO NOTHING;
