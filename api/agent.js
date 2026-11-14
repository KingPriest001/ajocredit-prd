// AJOCREDIT Agent Module.
//
// Agents bring Ajo groups to AJOCREDIT and earn a commission. An agent is ALSO
// a member - the same phone, the same login - with an agent record next to
// their user record.
//
// The three rules this module enforces in code, not just in words:
//   * An agent NEVER collects cash. Nothing here moves money out of a member;
//     money only moves through the normal contribution routes.
//   * An agent NEVER collects member balances. The endpoints here return
//     counts, group names and commission totals - never a wallet balance.
//   * A corporate agent cannot open the dashboard until an admin approves it.
//
// Commission:
//   * N500, created when a member joins through an agent link. It stays PENDING
//     until that member makes their first contribution, then it is released.
//   * 1% of that member's FIRST contribution, and nothing after that.
//   * A sub-agent's group counts for the corporate parent at half rate (0.5%).

const crypto = require('crypto');
const core = require('./agent-core');
const T = require('./agent-templates');

const {
  STATUS, CAN_WORK, SIGNUP_COMMISSION, FIRST_CONTRIBUTION_RATE,
  SUB_AGENT_RATE, agentCodeFor, parseCode,
} = core;

// The public site that hosts the agent pages.
const SITE = process.env.AGENT_SITE_URL || 'https://ajocredit.pages.dev';

function rid(p) { return `${p}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`; }

// ------------------------------------------------------------------ schema --
async function installSchema(deps) {
  const exec = deps.exec;   // raw DDL
  const q = deps.q;         // parameterised statements
  await exec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_ref TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS source TEXT;

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT NOT NULL,
      agent_code TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      market_location TEXT,
      code_of_conduct_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      accepted_at TIMESTAMPTZ,
      shares_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agents_code_idx ON agents (agent_code) WHERE agent_code IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_groups (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      group_id TEXT,
      source TEXT,
      leader_name TEXT,
      leader_phone TEXT,
      members_count INT NOT NULL DEFAULT 0,
      migration_completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_members (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      member_id TEXT,
      group_id TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_commissions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      member_id TEXT,
      group_id TEXT,
      amount NUMERIC NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      template TEXT NOT NULL,
      to_phone TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS message_templates (
      id TEXT PRIMARY KEY,
      template TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_links (
      code TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      group_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_invites (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      group_id TEXT,
      phone TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'INVITED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_drafts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      step INT NOT NULL DEFAULT 1,
      payload TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // The table may already exist from an earlier version, so every column the
  // module uses is added here as well.
  await exec(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS organization TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS organization_type TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS cac_number TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS contact_name TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS contact_phone TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS contact_email TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS estimated_members INT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS estimated_groups INT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS locations TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS nin TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS whatsapp TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS selfie_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS cac_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS director_id_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_reason TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS admin_note TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS application_ref TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE agent_groups ADD COLUMN IF NOT EXISTS leader_name TEXT;
    ALTER TABLE agent_groups ADD COLUMN IF NOT EXISTS leader_phone TEXT;
    ALTER TABLE agent_groups ADD COLUMN IF NOT EXISTS migration_completed_at TIMESTAMPTZ;
    ALTER TABLE agent_commissions ADD COLUMN IF NOT EXISTS reference TEXT;
  `);

  // The official message templates live in the database so the agent screens
  // and the API always use the same approved words.
  for (const t of T.ALL) {
    await q(
      `INSERT INTO message_templates (id, template, title, body, channel)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE
         SET template=$2, title=$3, body=$4, channel=$5`,
      [t.id, t.id, t.title, t.body, t.channel || 'whatsapp']
    );
  }
  // Templates that are no longer part of the approved set are removed, so the
  // agent never sees an old draft next to the current one.
  await q('DELETE FROM message_templates WHERE NOT (id = ANY($1))', [T.ALL.map((t) => t.id)]);
}

// --------------------------------------------------------------- commission --
// N500 held as PENDING when a member joins through an agent link. It is
// released the moment that member makes their FIRST contribution, together
// with 1% of that contribution - and nothing after that.
//
// The percentage is a one-time bonus on the first contribution only. AJOCREDIT
// collects about 1% in fees on every contribution, so a percentage that kept
// running would pay the agent the entire fee and leave us nothing.
async function releaseOnFirstContribution(ctx, membershipId, amount) {
  const { q } = ctx;
  if (!membershipId) return;
  const m = await q('SELECT user_id, group_id FROM memberships WHERE id=$1', [membershipId]);
  if (!m.length) return;
  const userId = m[0].user_id;
  const u = await q('SELECT agent_id FROM users WHERE id=$1', [userId]);
  if (!u.length || !u[0].agent_id) return;
  const agentId = u[0].agent_id;

  // The N500 is released exactly once - on the member's first contribution.
  // If this update changes a row, this IS that first contribution.
  const released = await q(
    `UPDATE agent_commissions SET status='EARNED'
      WHERE agent_id=$1 AND member_id=$2 AND type='signup' AND status='PENDING'
      RETURNING id`,
    [agentId, userId]
  );
  if (!released.length) return;   // not the first contribution - nothing more is due

  // 1% of this first contribution, and only this one.
  const pct = Math.round(Number(amount) * FIRST_CONTRIBUTION_RATE * 100) / 100;
  if (pct <= 0) return;
  await q(
    `INSERT INTO agent_commissions (id, agent_id, member_id, group_id, amount, type, status)
     VALUES ($1,$2,$3,$4,$5,'first_contribution','EARNED')`,
    [rid('ac'), agentId, userId, m[0].group_id, pct]
  );
}

// A member joins through an agent link -> hold their N500.
async function linkReferral(ctx, userId, phone, referralCode) {
  const { q } = ctx;
  const parsed = parseCode(referralCode);
  if (!parsed) return null;
  const link = await q('SELECT * FROM agent_links WHERE code=$1', [parsed.code]);
  if (!link.length) return null;
  const agent = await q('SELECT id, status FROM agents WHERE id=$1', [link[0].agent_id]);
  if (!agent.length || agent[0].status !== STATUS.ACTIVE) return null;
  await q(
    `INSERT INTO agent_members (id, agent_id, member_id, group_id)
     VALUES ($1,$2,$3,$4)`,
    [rid('am'), link[0].agent_id, userId, link[0].group_id]
  );
  await q('UPDATE users SET agent_id=$1 WHERE id=$2', [link[0].agent_id, userId]);
  await q(
    `INSERT INTO agent_commissions (id, agent_id, member_id, group_id, amount, type, status)
     VALUES ($1,$2,$3,$4,$5,'signup','PENDING')`,
    [rid('ac'), link[0].agent_id, userId, link[0].group_id, SIGNUP_COMMISSION]
  );
  return { agent_id: link[0].agent_id, group_id: link[0].group_id };
}

// ------------------------------------------------------------------ helpers --
// Placeholders look like [NAME], [REASON — e.g. blah], [ZEN-CORP-XXXX]. We try
// the whole thing first, then the part before the dash.
function fillTemplate(text, values) {
  return String(text || '').replace(/\[([^\]]+)\]/g, (m, key) => {
    const raw = key.trim();
    const head = raw.split(/\s+[—-]\s+/)[0].trim();
    for (const k of [raw, head, head.toUpperCase(), raw.toUpperCase()]) {
      const v = values[k];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    return m;
  });
}

// The values that fill an agent's own templates.
function agentValues(agent, extra) {
  const code = agent.agent_code || '';
  const link = `ajocredit.app/join/${code}`;
  const phone = agent.phone || '';
  const v = {
    'AGENT NAME': agent.name || agent.organization || 'Agent',
    'AGENT CODE': code,
    'ZEN-AG-XXXX': code,
    'ZEN-CORP-XXXX': code,
    CODE: code,
    LINK: link,
    'AGENT WHATSAPP': agent.whatsapp || phone,
    'ORGANIZATION NAME': agent.organization || agent.name || '',
    'GROUP NAME': (extra && extra.group_name) || '',
    'COOPERATIVE NAME': agent.organization || '',
    'CONTACT PERSON NAME': agent.contact_name || agent.name || 'Agent',
    PHONE: phone,
    'PHONE NUMBER': phone,
  };
  return Object.assign(v, extra || {});
}

async function uniqueCode(ctx, type) {
  const { q } = ctx;
  for (let i = 0; i < 20; i++) {
    const code = agentCodeFor(type);
    const hit = await q('SELECT id FROM agents WHERE agent_code=$1', [code]);
    if (!hit.length) return code;
  }
  return agentCodeFor(type) + crypto.randomInt(10, 99);
}

// ------------------------------------------------------------------- routes --
function installRoutes(ctx) {
  const { app, q, normPhone, sendSms } = ctx;

  // An agent route always needs a real session - even while the API is open
  // for the pilot. The shared auth middleware lets requests through when
  // REQUIRE_AUTH is not set, which is not good enough for an agent dashboard.
  async function requireSession(req, res, next) {
    const t = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!t) return res.status(401).json({ error: 'Please sign in to use the agent pages.' });
    const h = crypto.createHash('sha256').update(t).digest('hex');
    const s = await q('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > NOW()', [h]);
    if (!s.length) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    req.user = s[0].user_id;
    next();
  }

  // Admin access: a shared secret in the x-admin-token header. If the secret is
  // not set the admin panel stays switched off (fail closed).
  function requireAdmin(req, res, next) {
    const secret = process.env.AGENT_ADMIN_TOKEN || '';
    const got = String(req.headers['x-admin-token'] || req.query.admin_token || '');
    if (!secret || !got || got !== secret) {
      return res.status(403).json({ error: 'Admin access is not switched on.' });
    }
    next();
  }

  // ---- public --------------------------------------------------------------
  // What an agent earns, in the words we show. Used by the agent pages.
  app.get('/api/agent/public-info', async (req, res) => {
    try {
      const rows = await q(
        `SELECT id, template, title, body, channel FROM message_templates
          WHERE channel IN ('whatsapp','sms') ORDER BY id`
      );
      res.json({
        ok: true,
        signup_commission: SIGNUP_COMMISSION,
        contribution_rate: FIRST_CONTRIBUTION_RATE,
        sub_agent_rate: SUB_AGENT_RATE,
        explainer: T.COMMISSION_EXPLAINER,
        site: SITE,
        templates: rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Look up an agent code so the join page can say who invited you.
  app.get('/api/agent/code/:code', async (req, res) => {
    try {
      const p = parseCode(req.params.code);
      if (!p) return res.json({ ok: true, valid: false });
      const a = await q('SELECT id, agent_code, status, type, name, organization FROM agents WHERE agent_code=$1', [p.code]);
      if (!a.length) return res.json({ ok: true, valid: false });
      res.json({
        ok: true, valid: true,
        code: a[0].agent_code,
        type: a[0].type,
        status: a[0].status,
        name: a[0].organization || a[0].name || null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Individual agent: a signed-in member becomes an agent.
  app.post('/api/agent/apply/individual', requireSession, async (req, res) => {
    try {
      const b = req.body || {};
      const u = await q('SELECT * FROM users WHERE id=$1', [req.user]);
      if (!u.length) return res.status(404).json({ error: 'Account not found.' });
      const phone = normPhone(b.phone) || u[0].phone;
      const ex = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (ex.length) {
        await q(
          `UPDATE agents SET name=$1, phone=$2, market_location=$3, bank_name=$4,
             account_number=$5, account_name=$6, nin=$7, whatsapp=$8,
             code_of_conduct_accepted=TRUE, accepted_at=COALESCE(accepted_at,NOW()),
             updated_at=NOW()
           WHERE id=$9`,
          [b.name || u[0].name, phone, b.market_location || null, b.bank_name || null,
            b.account_number || null, b.account_name || null, b.nin || null,
            b.whatsapp || null, ex[0].id]
        );
        return res.json({ ok: true, agent_id: ex[0].id, agent_code: ex[0].agent_code, status: ex[0].status });
      }
      if (b.code_of_conduct_accepted !== true && b.code_of_conduct_accepted !== 'true') {
        return res.status(400).json({ error: 'Please accept the Agent Code of Conduct first.' });
      }
      const code = await uniqueCode(ctx, 'individual');
      const id = rid('ag');
      await q(
        `INSERT INTO agents (id, user_id, type, agent_code, status, name, phone, market_location,
           bank_name, account_number, account_name, nin, whatsapp,
           code_of_conduct_accepted, accepted_at)
         VALUES ($1,$2,'individual',$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,TRUE,NOW())`,
        [id, req.user, code, b.name || u[0].name, phone, b.market_location || null,
          b.bank_name || null, b.account_number || null, b.account_name || null,
          b.nin || null, b.whatsapp || null]
      );
      await q('UPDATE users SET user_type=$1, agent_id=$2 WHERE id=$3', ['agent_individual', id, req.user]);
      await q(`INSERT INTO agent_links (code, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [code, id]);
      res.json({
        ok: true, agent_id: id, agent_code: code, status: STATUS.ACTIVE,
        link: `ajocredit.app/join/${code}`,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Corporate agent: apply, wait for the team to call.
  app.post('/api/agent/apply/corporate', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.organization || !b.contact_name || !b.contact_phone) {
        return res.status(400).json({ error: 'Organisation name, contact person and contact phone are required.' });
      }
      const phone = normPhone(b.contact_phone);
      if (!phone) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });
      const code = await uniqueCode(ctx, 'corporate');
      const id = rid('ag');
      const ref = 'ZEN-CORP-' + String(Date.now()).slice(-4);
      await q(
        `INSERT INTO agents (id, user_id, type, agent_code, status, name, phone, organization,
           organization_type, cac_number, contact_name, contact_phone, contact_email,
           estimated_members, estimated_groups, locations, market_location,
           code_of_conduct_accepted, accepted_at, application_ref)
         VALUES ($1,$2,'corporate',$3,'PENDING',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,NOW(),$16)`,
        [id, b.user_id || null, code, b.contact_name, phone, b.organization,
          b.organization_type || null, b.cac_number || null, b.contact_name, phone,
          b.contact_email || null, Number(b.estimated_members) || null,
          Number(b.estimated_groups) || null, b.locations || null,
          b.market_location || null, ref]
      );
      // Template A goes out straight away: the pending-application notice.
      const body = fillTemplate(T.WHATSAPP.A_PENDING.body, agentValues(
        { name: b.contact_name, organization: b.organization, phone, agent_code: ref },
        { 'APPLICATION ID': ref }
      ));
      await q(
        `INSERT INTO agent_messages (id, agent_id, template, to_phone, body, status)
         VALUES ($1,$2,'A_PENDING',$3,$4,'QUEUED')`,
        [rid('msg'), id, phone, body]
      );
      res.json({
        ok: true, agent_id: id, application_ref: ref,
        status: 'PENDING',
        agent_code: code,
        message: 'Pending - we will call you within 24 hours.',
        template: { id: 'A_PENDING', title: T.WHATSAPP.A_PENDING.title, subject: T.WHATSAPP.A_PENDING.subject, body },
        wa_link: `https://wa.me/${phone.replace('+', '')}?text=${encodeURIComponent(body)}`,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- the agent themselves -------------------------------------------------
  app.get('/api/agent/me', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.json({ ok: true, agent: null });
      const stats = await q(
        `SELECT
           (SELECT COUNT(*)::int FROM agent_groups WHERE agent_id=$1) AS groups_total,
           (SELECT COUNT(*)::int FROM agent_members WHERE agent_id=$1) AS members_total,
           (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions WHERE agent_id=$1 AND status='EARNED') AS earned,
           (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions WHERE agent_id=$1 AND status='PENDING') AS pending,
           (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions WHERE agent_id=$1 AND status='PAID') AS paid`,
        [a[0].id]
      );
      res.json({ ok: true, agent: a[0], stats: stats[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/agent/dashboard', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      if (!CAN_WORK.includes(a[0].status)) {
        return res.status(403).json({
          error: 'Your agent account is not active yet.', status: a[0].status, agent: a[0],
        });
      }
      const stats = await q(
        `SELECT
           (SELECT COUNT(*)::int FROM agent_groups WHERE agent_id=$1) AS groups_total,
           (SELECT COUNT(*)::int FROM agent_groups WHERE agent_id=$1 AND source='migrated') AS groups_migrated,
           (SELECT COUNT(*)::int FROM agent_groups WHERE agent_id=$1 AND source='new') AS groups_new,
           (SELECT COUNT(*)::int FROM agent_members WHERE agent_id=$1) AS members_total,
           (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions WHERE agent_id=$1 AND status='EARNED') AS earned,
           (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions WHERE agent_id=$1 AND status='PENDING') AS pending,
           (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions WHERE agent_id=$1 AND status='PAID') AS paid`,
        [a[0].id]
      );
      const groups = await q(
        `SELECT ag.id, ag.source, ag.leader_name, ag.leader_phone, ag.members_count,
                ag.migration_completed_at, ag.created_at, g.name AS group_name, g.invite_code, g.amount
           FROM agent_groups ag LEFT JOIN groups g ON g.id=ag.group_id
          WHERE ag.agent_id=$1 ORDER BY ag.created_at DESC`,
        [a[0].id]
      );
      const payouts = await q(
        `SELECT id, amount, type, status, reference, created_at FROM agent_commissions
          WHERE agent_id=$1 AND status='PAID' ORDER BY created_at DESC LIMIT 20`,
        [a[0].id]
      );
      res.json({
        ok: true, agent: a[0], stats: stats[0], groups, payouts,
        link: `ajocredit.app/join/${a[0].agent_code}`,
        site: SITE,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/agent/groups', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      const rows = await q(
        `SELECT ag.id, ag.source, ag.leader_name, ag.leader_phone, ag.members_count,
                ag.migration_completed_at, ag.created_at, g.name AS group_name, g.invite_code, g.amount
           FROM agent_groups ag LEFT JOIN groups g ON g.id=ag.group_id
          WHERE ag.agent_id=$1 ORDER BY ag.created_at DESC`,
        [a[0].id]
      );
      res.json({ ok: true, groups: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create a group for the agent. Members who join through its invite code are
  // linked to the agent.
  app.post('/api/agent/groups', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      if (!CAN_WORK.includes(a[0].status)) return res.status(403).json({ error: 'Your agent account is not active yet.' });
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ error: 'Group name is required.' });
      const gid = rid('g');
      const invite = 'AJ-' + crypto.randomInt(100000, 999999);
      const amount = Number(b.amount) || 5000;
      const size = Math.min(30, Math.max(5, Number(b.size) || 10));
      await q(
        `INSERT INTO groups (id, name, type, amount, size, frequency, payout_mode, status, rules, invite_code, agent_id, source)
         VALUES ($1,$2,'ROTATIONAL',$3,$4,$5,'random','FORMING','{}',$6,$7,'new')`,
        [gid, b.name, amount, size, b.frequency || 'Weekly', invite, a[0].id]
      );
      // The agent is the group's admin, and cycle 1 must exist at birth -
      // contributions.cycle_id is a real foreign key.
      await q(
        `INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'admin','ACTIVE')`,
        [rid('m'), req.user, gid]
      );
      const cycleId = 'c-' + gid.slice(-6) + '-1';
      await q(
        `INSERT INTO cycles (id, group_id, seq, due_date, pot_expected, pot_collected, status)
         VALUES ($1,$2,1,NOW() + INTERVAL '7 days',$3,0,'COLLECTING')`,
        [cycleId, gid, amount * size]
      );
      const agid = rid('ag');
      await q(
        `INSERT INTO agent_groups (id, agent_id, group_id, source, leader_name, leader_phone, members_count)
         VALUES ($1,$2,$3,'new',$4,$5,0)`,
        [agid, a[0].id, gid, b.leader_name || null, b.leader_phone || null]
      );
      await q(`INSERT INTO agent_links (code, agent_id, group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [invite, a[0].id, gid]);
      await q(
        `INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'agent.group.create','group',$3)`,
        [rid('al'), req.user, gid]
      );
      res.json({
        ok: true, id: agid, group_id: gid, cycle_id: cycleId, invite_code: invite,
        link: `ajocredit.app/join/${invite}`,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // One group: who has been invited and who has joined. Counts only - never a
  // member's balance.
  app.get('/api/agent/groups/:id', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      const g = await q('SELECT * FROM agent_groups WHERE id=$1 AND agent_id=$2', [req.params.id, a[0].id]);
      if (!g.length) return res.status(404).json({ error: 'Group not found.' });
      const invites = await q(
        `SELECT id, phone, name, status, created_at FROM agent_invites
          WHERE agent_id=$1 AND group_id=$2 ORDER BY created_at DESC`,
        [a[0].id, g[0].group_id]
      );
      const joined = await q(
        'SELECT COUNT(*)::int AS n FROM agent_members WHERE agent_id=$1 AND group_id=$2',
        [a[0].id, g[0].group_id]
      );
      res.json({ ok: true, group: g[0], invites, joined: joined[0] ? joined[0].n : 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Invite members by phone. They get the join link by SMS.
  app.post('/api/agent/groups/:id/invite', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      const g = await q('SELECT * FROM agent_groups WHERE id=$1 AND agent_id=$2', [req.params.id, a[0].id]);
      if (!g.length) return res.status(404).json({ error: 'Group not found.' });
      const raw = Array.isArray(req.body && req.body.phones) ? req.body.phones : [(req.body || {}).phone];
      const phones = raw.map((p) => normPhone(p)).filter(Boolean);
      if (!phones.length) return res.status(400).json({ error: 'Enter at least one valid Nigerian phone number.' });
      const link = await q('SELECT code FROM agent_links WHERE group_id=$1 LIMIT 1', [g[0].group_id]);
      const code = link.length ? link[0].code : a[0].agent_code;
      const text = fillTemplate(T.SMS.A_INVITE.body, {
        CODE: code,
        LINK: `ajocredit.app/join/${code}`,
        'ORGANIZATION NAME': a[0].organization || a[0].name || 'our Ajo group',
      });
      const sent = [];
      for (const p of phones) {
        await q(
          `INSERT INTO agent_invites (id, agent_id, group_id, phone, name, status) VALUES ($1,$2,$3,$4,$5,'INVITED')`,
          [rid('ai'), a[0].id, g[0].group_id, p, (req.body || {}).name || null]
        );
        await q(
          `INSERT INTO agent_messages (id, agent_id, template, to_phone, body, status) VALUES ($1,$2,'A_INVITE',$3,$4,'QUEUED')`,
          [rid('msg'), a[0].id, p, text]
        );
        let delivered = false;
        try { const r = await sendSms(p, text); delivered = !!(r && r.delivered); } catch (e) { }
        sent.push({ phone: p, delivered });
      }
      res.json({ ok: true, invited: sent.length, sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The templates the agent can send, with their details filled in.
  app.get('/api/agent/templates', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      const rows = await q('SELECT id, template, title, body, channel FROM message_templates ORDER BY id');
      const link = `ajocredit.app/join/${a[0].agent_code}`;
      const values = agentValues(a[0]);
      res.json({
        ok: true, agent_code: a[0].agent_code, link, site: SITE,
        explainer: T.COMMISSION_EXPLAINER,
        templates: rows.map((r) => ({
          id: r.id, template: r.template, title: r.title, channel: r.channel,
          body: fillTemplate(r.body, values),
          raw: r.body,
        })),
        recruiter_scripts: Object.values(T.RECRUIT_SCRIPTS).map((r) => ({
          id: r.id, title: r.title, body: r.body,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Record a share, so the agent can see how many links went out.
  app.post('/api/agent/share', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      await q('UPDATE agents SET shares_count=shares_count+1 WHERE id=$1', [a[0].id]);
      const link = `ajocredit.app/join/${a[0].agent_code}`;
      const body = fillTemplate((req.body || {}).body || '', {
        'AGENT NAME': a[0].name || 'Agent', 'AGENT CODE': a[0].agent_code,
        CODE: a[0].agent_code, LINK: link,
      });
      if (body) {
        await q(
          `INSERT INTO agent_messages (id, agent_id, template, to_phone, body, status)
           VALUES ($1,$2,$3,$4,$5,'SHARED')`,
          [rid('msg'), a[0].id, (req.body || {}).template || 'SHARE', null, body]
        );
      }
      res.json({ ok: true, shares: (a[0].shares_count || 0) + 1 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The migration checklist keeps a draft, so the agent can close the app and
  // come back to it.
  app.get('/api/agent/migrate/draft', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT id FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      const d = await q('SELECT * FROM agent_drafts WHERE agent_id=$1 ORDER BY updated_at DESC LIMIT 1', [a[0].id]);
      if (!d.length) return res.json({ ok: true, draft: null });
      res.json({ ok: true, draft: { id: d[0].id, step: d[0].step, payload: JSON.parse(d[0].payload || '{}') } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/migrate/draft', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT id FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      const step = Number((req.body || {}).step) || 1;
      const payload = JSON.stringify((req.body || {}).payload || {});
      const ex = await q('SELECT id FROM agent_drafts WHERE agent_id=$1 LIMIT 1', [a[0].id]);
      if (ex.length) {
        await q('UPDATE agent_drafts SET step=$1, payload=$2, updated_at=NOW() WHERE id=$3', [step, payload, ex[0].id]);
      } else {
        await q('INSERT INTO agent_drafts (id, agent_id, step, payload) VALUES ($1,$2,$3,$4)', [rid('ad'), a[0].id, step, payload]);
      }
      res.json({ ok: true, step, saved: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Close a migration. The group leader must have agreed - we never move a
  // group that has not said yes.
  app.post('/api/agent/migrate/complete', requireSession, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE user_id=$1', [req.user]);
      if (!a.length) return res.status(404).json({ error: 'You are not an agent yet.' });
      if (!CAN_WORK.includes(a[0].status)) return res.status(403).json({ error: 'Your agent account is not active yet.' });
      const b = req.body || {};
      if (b.leader_agrees !== true && b.leader_agrees !== 'yes' && b.leader_agrees !== 'true') {
        return res.status(400).json({ error: 'The group leader has not agreed to move. Do not force it.' });
      }
      const gid = rid('g');
      const invite = 'AJ-' + crypto.randomInt(100000, 999999);
      const amount = Number(b.amount) || 5000;
      const size = Math.min(30, Math.max(5, Number(b.members_count) || 10));
      await q(
        `INSERT INTO groups (id, name, type, amount, size, frequency, payout_mode, status, rules, invite_code, agent_id, source)
         VALUES ($1,$2,'ROTATIONAL',$3,$4,$5,'random','FORMING','{}',$6,$7,'migrated')`,
        [gid, b.group_name || 'Ajo Group', amount, size, b.frequency || 'Weekly', invite, a[0].id]
      );
      // The agent is the group's admin until the real leader takes over.
      await q(
        `INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'admin','ACTIVE')`,
        [rid('m'), req.user, gid]
      );
      const cycleId = 'c-' + gid.slice(-6) + '-1';
      await q(
        `INSERT INTO cycles (id, group_id, seq, due_date, pot_expected, pot_collected, status)
         VALUES ($1,$2,1,NOW() + INTERVAL '7 days',$3,0,'COLLECTING')`,
        [cycleId, gid, amount * size]
      );
      const agid = rid('ag');
      await q(
        `INSERT INTO agent_groups (id, agent_id, group_id, source, leader_name, leader_phone, members_count, migration_completed_at)
         VALUES ($1,$2,$3,'migrated',$4,$5,$6,NOW())`,
        [agid, a[0].id, gid, b.leader_name || null, b.leader_phone || null, Number(b.members_count) || 0]
      );
      await q(`INSERT INTO agent_links (code, agent_id, group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [invite, a[0].id, gid]);
      // Everyone the agent invited is linked to the agent, so their commission
      // starts counting.
      const invites = await q('SELECT id, phone FROM agent_invites WHERE agent_id=$1 AND group_id=$2', [a[0].id, gid]);
      let linked = 0;
      for (const iv of invites) {
        const u = await q('SELECT id FROM users WHERE phone=$1', [iv.phone]);
        if (!u.length) continue;
        await q(
          'INSERT INTO agent_members (id, agent_id, member_id, group_id) VALUES ($1,$2,$3,$4)',
          [rid('am'), a[0].id, u[0].id, gid]
        );
        await q('UPDATE users SET agent_id=$1 WHERE id=$2', [a[0].id, u[0].id]);
        await q(
          `INSERT INTO agent_commissions (id, agent_id, member_id, group_id, amount, type, status)
           VALUES ($1,$2,$3,$4,$5,'signup','PENDING')`,
          [rid('ac'), a[0].id, u[0].id, gid, SIGNUP_COMMISSION]
        );
        linked++;
      }
      await q('DELETE FROM agent_drafts WHERE agent_id=$1', [a[0].id]);
      res.json({
        ok: true, id: agid, group_id: gid, invite_code: invite,
        members_linked: linked,
        link: `ajocredit.app/join/${invite}`,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- admin ----------------------------------------------------------------
  app.get('/api/admin/agents', requireAdmin, async (req, res) => {
    try {
      const f = req.query || {};
      const where = [];
      const params = [];
      if (f.type) { params.push(f.type); where.push(`type=$${params.length}`); }
      if (f.status) { params.push(f.status); where.push(`status=$${params.length}`); }
      const rows = await q(
        `SELECT a.*, u.name AS user_name, u.phone AS user_phone,
                (SELECT COUNT(*)::int FROM agent_groups ag WHERE ag.agent_id=a.id) AS groups_total,
                (SELECT COUNT(*)::int FROM agent_members am WHERE am.agent_id=a.id) AS members_total,
                (SELECT COALESCE(SUM(amount),0)::float FROM agent_commissions ac WHERE ac.agent_id=a.id AND ac.status='EARNED') AS earned
           FROM agents a LEFT JOIN users u ON u.id=a.user_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.created_at DESC`,
        params
      );
      res.json({ ok: true, agents: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/agents/:id', requireAdmin, async (req, res) => {
    try {
      const a = await q('SELECT * FROM agents WHERE id=$1', [req.params.id]);
      if (!a.length) return res.status(404).json({ error: 'Agent not found.' });
      const commissions = await q(
        'SELECT id, amount, type, status, reference, created_at FROM agent_commissions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 50',
        [req.params.id]
      );
      const messages = await q(
        'SELECT id, template, to_phone, body, status, created_at FROM agent_messages WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 20',
        [req.params.id]
      );
      res.json({ ok: true, agent: a[0], commissions, messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Approve / reject / suspend / need-info. Each sends the matching official
  // template and logs it.
  app.post('/api/admin/agents/:id/:action', requireAdmin, async (req, res) => {
    try {
      const action = req.params.action;
      const a = await q('SELECT * FROM agents WHERE id=$1', [req.params.id]);
      if (!a.length) return res.status(404).json({ error: 'Agent not found.' });
      const reason = String((req.body || {}).reason || '').trim();
      let status, template;
      if (action === 'approve') {
        status = STATUS.ACTIVE; template = 'B_APPROVED';
        let code = a[0].agent_code;
        if (!code || a[0].status === 'PENDING' || a[0].status === 'NEEDS_INFO') {
          code = await uniqueCode(ctx, a[0].type);
          await q('UPDATE agents SET agent_code=$1 WHERE id=$2', [code, req.params.id]);
        }
        await q('UPDATE agents SET status=$1 WHERE id=$2', [status, req.params.id]);
        if (a[0].user_id) {
          await q('UPDATE users SET user_type=$1 WHERE id=$2',
            [a[0].type === 'corporate' ? 'agent_corporate' : 'agent_individual', a[0].user_id]);
        }
        await q('INSERT INTO agent_links (code, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [code, req.params.id]);
      } else if (action === 'reject') {
        if (!reason) return res.status(400).json({ error: 'Please say why it is being rejected.' });
        status = STATUS.REJECTED; template = 'D_REJECTED';
        await q('UPDATE agents SET status=$1, status_reason=$2 WHERE id=$3', [status, reason, req.params.id]);
      } else if (action === 'suspend') {
        if (!reason) return res.status(400).json({ error: 'Please say why it is being suspended.' });
        status = STATUS.SUSPENDED; template = 'E_SUSPENDED';
        await q('UPDATE agents SET status=$1, status_reason=$2 WHERE id=$3', [status, reason, req.params.id]);
      } else if (action === 'needs-info' || action === 'need-info') {
        if (!reason) return res.status(400).json({ error: 'Please say what is missing.' });
        status = STATUS.NEEDS_INFO; template = 'C_NEED_INFO';
        await q('UPDATE agents SET status=$1, status_reason=$2 WHERE id=$3', [status, reason, req.params.id]);
      } else {
        return res.status(400).json({ error: 'Unknown action.' });
      }
      const fresh = await q('SELECT * FROM agents WHERE id=$1', [req.params.id]);
      const code = fresh[0].agent_code || '';
      const body = fillTemplate(T.WHATSAPP[template].body, agentValues(fresh[0], {
        REASON: reason,
        'APPLICATION ID': fresh[0].application_ref || code,
        'ACTIVATION LINK': `ajocredit.app/join/${code}`,
        'FLYER LINK': `${SITE}/agent/share-flyer.html?code=${code}`,
        'DASHBOARD LINK': `${SITE}/agent-dashboard.html`,
        'SUPPORT PHONE': '+234 907 3892 436',
      }));
      const toPhone = fresh[0].phone || null;
      await q(
        `INSERT INTO agent_messages (id, agent_id, template, to_phone, body, status)
         VALUES ($1,$2,$3,$4,$5,'QUEUED')`,
        [rid('msg'), req.params.id, template, toPhone, body]
      );
      res.json({
        ok: true, status, template, agent_code: code,
        message: body,
        wa_link: toPhone ? `https://wa.me/${String(toPhone).replace('+', '')}?text=${encodeURIComponent(body)}` : null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The commission payout queue.
  app.get('/api/admin/commissions', requireAdmin, async (req, res) => {
    try {
      const rows = await q(
        `SELECT c.id, c.agent_id, c.member_id, c.group_id, c.amount, c.type, c.status, c.created_at,
                a.agent_code, a.name AS agent_name
           FROM agent_commissions c LEFT JOIN agents a ON a.id=c.agent_id
          WHERE c.status='EARNED' ORDER BY c.created_at DESC LIMIT 100`
      );
      res.json({ ok: true, commissions: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/commissions/:id/pay', requireAdmin, async (req, res) => {
    try {
      const reference = String((req.body || {}).reference || '').trim();
      const c = await q('SELECT * FROM agent_commissions WHERE id=$1', [req.params.id]);
      if (!c.length) return res.status(404).json({ error: 'Commission not found.' });
      if (c[0].status === 'PAID') return res.json({ ok: true, already_paid: true });
      await q('UPDATE agent_commissions SET status=$1, reference=$2 WHERE id=$3', ['PAID', reference || null, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { installSchema, installRoutes, releaseOnFirstContribution, linkReferral, fillTemplate };
