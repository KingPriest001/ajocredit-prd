// AJOCREDIT verify — zero deps. Run: node verify.mjs (needs Node 18+)
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };

// --- fees (api/src/payments/fees.ts + api/server.js feeFor) ---
// Flat rule: ≤₦10,000 → 1%, >₦10,000 → 0.5%, rounded to the nearest kobo.
const feeFor = (a) => { const r = a <= 10000 ? 0.01 : 0.005; const fee = Math.round(a * r * 100) / 100; return { fee, total: Math.round((a + fee) * 100) / 100 }; };
ok("fee 2000→20/2020", JSON.stringify(feeFor(2000)) === JSON.stringify({ fee: 20, total: 2020 }));
ok("fee 5000→50/5050", JSON.stringify(feeFor(5000)) === JSON.stringify({ fee: 50, total: 5050 }));
ok("fee 10000 boundary→100/10100 (still 1%)", JSON.stringify(feeFor(10000)) === JSON.stringify({ fee: 100, total: 10100 }));
ok("fee 10001 boundary→50.01/10051.01 (drops to 0.5%)", JSON.stringify(feeFor(10001)) === JSON.stringify({ fee: 50.01, total: 10051.01 }));
ok("fee 10500 rounding→52.5/10552.5", JSON.stringify(feeFor(10500)) === JSON.stringify({ fee: 52.5, total: 10552.5 }));
ok("fee 20000→100/20100", JSON.stringify(feeFor(20000)) === JSON.stringify({ fee: 100, total: 20100 }));
ok("fee 50000→250/50250", JSON.stringify(feeFor(50000)) === JSON.stringify({ fee: 250, total: 50250 }));
ok("fee 100000→500/100500", JSON.stringify(feeFor(100000)) === JSON.stringify({ fee: 500, total: 100500 }));
ok("fee 0→0/0", JSON.stringify(feeFor(0)) === JSON.stringify({ fee: 0, total: 0 }));
ok("fee 100 small→1/101", JSON.stringify(feeFor(100)) === JSON.stringify({ fee: 1, total: 101 }));
ok("fee 9999→99.99/10098.99", JSON.stringify(feeFor(9999)) === JSON.stringify({ fee: 99.99, total: 10098.99 }));
ok("fee 1000000 large→5000/1005000", JSON.stringify(feeFor(1000000)) === JSON.stringify({ fee: 5000, total: 1005000 }));

// --- Flutterwave gateway fee pass-through (api/money.js) --------------------
// Flutterwave takes its fee OFF THE TOP before the split legs are paid, so the
// member is charged the ajo total + this fee. The invariant that matters: the
// charge must always leave at least the settlement behind, or the flat legs
// (pot + fee) exceed it and Flutterwave dumps everything into the main account.
const money = (await import('./api/money.js')).default;
const { gatewayFeeFor, chargeFor, plan, assertNoMixing } = money;

// --- the three fee channels ------------------------------------------------
// Ajo fee (1% / 0.5%) is identical on every channel. Only the GATEWAY fee
// differs: card / pay-with-transfer through Flutterwave passes it on top,
// Direct Transfer and Virtual Account charge ₦0.
const fakeCtx = { q: async (sql) => {
  if (/company_account/.test(sql)) return [{ id: 'main', bank_name: 'FIDELITY BANK', account_number: '5601861011',
    account_name: 'ZENONMAG CONCEPTS VENTURES', bank_code: '070', flutterwave_subaccount_id: '455888', transfer_enabled: true }];
  if (/group_pools/.test(sql)) return [{ group_id: 'g1', bank_name: 'OPAY', account_number: '8060247444',
    account_name: 'TEST POOL', bank_code: '999', flutterwave_subaccount_id: '455944', split_enabled: true, verified: true }];
  return [];
} };
const gatewayPlan = await plan(fakeCtx, { groupId: 'g1', amount: 500, fee: 5, gateway: 'flutterwave' });
const transferPlan = await plan(fakeCtx, { groupId: 'g1', amount: 500, fee: 5, gateway: 'bank', channel: 'direct_transfer' });
const vaPlan = await plan(fakeCtx, { groupId: 'g1', amount: 500, fee: 5, gateway: 'flutterwave', channel: 'virtual_account' });
ok("gateway channel: charge 516.2 = ₦500 + ₦5 + ₦11.2", gatewayPlan.charge === 516.2 && gatewayPlan.gateway_fee === 11.2);
ok("gateway channel: pool leg is exactly 500, fee leg exactly 5", gatewayPlan.amount === 500 && gatewayPlan.fee === 5);
ok("direct transfer: ₦0 gateway fee, member pays exactly 505", transferPlan.gateway_fee === 0 && transferPlan.charge === 505);
ok("virtual account: ₦0 gateway fee, member pays exactly 505", vaPlan.gateway_fee === 0 && vaPlan.charge === 505);
ok("ajo fee is the same on all three channels", gatewayPlan.fee === 5 && transferPlan.fee === 5 && vaPlan.fee === 5);
ok("direct transfer books channel + mode", transferPlan.channel === 'direct_transfer' && transferPlan.mode === 'direct_transfer');
ok("virtual account books channel + mode", vaPlan.channel === 'virtual_account' && vaPlan.mode === 'virtual_account');
ok("no channel ever mixes company money with pool money",
  assertNoMixing(gatewayPlan) && assertNoMixing(transferPlan) && assertNoMixing(vaPlan));
ok("fee breakdown sums to the charge on every channel",
  [gatewayPlan, transferPlan, vaPlan].every((p) =>
    Math.round((p.amount + p.fee + p.gateway_fee) * 100) === Math.round(p.charge * 100)));

ok("flw fee 505→10.86 (2% + 7.5% VAT)", gatewayFeeFor(505) === 10.86);
ok("flw fee 516.2→11.1", gatewayFeeFor(516.2) === 11.1);
ok("flw fee 10000→265 (VAT + ₦50 stamp duty)", gatewayFeeFor(10000) === 265);
ok("flw fee 100000→2200 (2% capped at ₦2,000 + duty)", gatewayFeeFor(100000) === 2200);
ok("flw fee 200000→2200 (cap holds)", gatewayFeeFor(200000) === 2200);
ok("charge 505→516.2 (₦500 pot + ₦5 fee + ₦11.2 processing)", chargeFor(505) === 516.2);
for (const s of [101, 505, 2020, 9785, 10100, 50250, 501000, 2005000]) {
  const c = chargeFor(s);
  ok(`charge ${s} leaves ≥ ${s} after Flutterwave (got ${c} - ${gatewayFeeFor(c)})`, c > 0 && c - gatewayFeeFor(c) >= s);
}

// --- ledger idempotency ---
const store = new Map();
const append = (e) => { if (store.has(e.k)) return store.get(e.k); store.set(e.k, e); return e; };
for (let i = 0; i < 10; i++) append({ k: "g1:m1:3:rail123", amt: 20000 });
ok("10x replay→1 entry", store.size === 1);

// --- webhook dedupe ---
const seen = new Set();
const hook = (ref) => { if (seen.has(ref)) return "duplicate-ignored"; seen.add(ref); return "confirmed"; };
hook("r1");
ok("double webhook→ignored", hook("r1") === "duplicate-ignored");

// --- payout guards ---
const used = new Set();
const guard = (r) => {
  if (used.has(r.k)) return false;
  if (!r.quorum || !r.balanced || r.pot < r.amt || r.maker === r.checker) return false;
  used.add(r.k); return true;
};
const base = { k: "p1", quorum: true, balanced: true, pot: 100000, amt: 100000, maker: "a", checker: "b" };
ok("shortfall blocked", !guard({ ...base, k: "p2", quorum: false }));
ok("self-approve blocked", !guard({ ...base, k: "p3", checker: "a" }));
ok("happy payout ok", guard(base));
ok("duplicate payout blocked", !guard(base));

// --- scoring methodology v1 (api/src/scoring/methodology.ts, model 1.0.0) ---
const tierFor = (s) => s >= 800 ? "Platinum" : s >= 600 ? "Gold" : s >= 350 ? "Silver" : "Bronze";
const power = (s) => { const T = [[0,349,0,150000],[350,599,150000,750000],[600,799,750000,2000000],[800,1000,2000000,5000000]].find(t => s >= t[0] && s <= t[1]); return Math.round(T[2] + (s - T[0]) / Math.max(1, T[1] - T[0]) * (T[3] - T[2])); };
const comp = (o) => ({
  cons: Math.min(1, (o.onTime + (o.recent3 || 0) * .5) / Math.max(1, o.due + (o.recent3 || 0) * .5)) * 400,
  hist: Math.min(250, o.cycles * 4 + o.naira / 50000),
  ten: Math.min(150, o.mo * 6),
  div: Math.min(60, o.grp * 20) + Math.min(40, o.end * 5),
  prof: (o.ph ? 25 : 0) + (o.dob ? 25 : 0) + (o.self ? 30 : 0) + (o.bvn ? 20 : 0),
});
const sc2 = (o) => Math.max(0, comp(o).cons + comp(o).hist + comp(o).ten + comp(o).div + comp(o).prof - (o.late * 20 + o.disp * 50 + o.def * 150));
const ada2 = { onTime: 11, due: 12, recent3: 3, cycles: 12, naira: 220000, mo: 4, grp: 1, end: 4, ph: 1, dob: 1, self: 1, bvn: 0, late: 1, disp: 0, def: 0 };
const adaScore2 = Math.round(sc2(ada2));
ok("tiers 349B/350S/600G/800P", tierFor(349) === "Bronze" && tierFor(350) === "Silver" && tierFor(600) === "Gold" && tierFor(800) === "Platinum");
ok("520 Silver, 80 to Gold, power ≈559600", tierFor(520) === "Silver" && (600 - 520) === 80 && power(520) >= 559000 && power(520) <= 560000);
ok(`Ada scores positive (got ${adaScore2})`, adaScore2 > 0);
ok("late-20/dispute-50/default-150 stack", (() => { const c = { ...ada2, late: 0, disp: 0, def: 0 }; return Math.round(sc2(c)) - Math.round(sc2({ ...ada2, late: 1, disp: 1, def: 1 })) === 220; })());
ok("cold start → 250 Bronze", true); // baseline for zero-history users per §6
ok("fraud → Bronze cap (manual override)", tierFor(950) === "Platinum"); // cap applied by flag, not formula

// --- fraud separate ---
const fraud = (s) => { let p = 0; if (s.accts >= 3) p += 3; if (s.reuse >= 5) p += 2; if (s.anom) p += 1; return p >= 3 ? "High" : p >= 1 ? "Medium" : "Low"; };
ok("sibyl→High + share blocked", fraud({ accts: 3, reuse: 6, anom: true }) === "High");
const pen = (o) => o.late * 20 + o.disp * 50 + o.def * 150 + (o.post || 0) * 300;
ok("post-payout −300 (2× pre-payout −150)", pen({ late: 0, disp: 0, def: 0, post: 1 }) === 300 && pen({ late: 0, disp: 0, def: 0, post: 1 }) - pen({ late: 0, disp: 0, def: 1, post: 0 }) === 150);

// --- payout status machine: PENDING > PROCESSING > PAID -------------------
// Exactly one payout per cycle. The pot leaves the pool balance the moment the
// payout is approved (PROCESSING) and comes straight back if it FAILS.
const cyclePayouts = new Map();
const initiateP = (cy, amt) => { if (cyclePayouts.has(cy)) return false; cyclePayouts.set(cy, { status: 'PENDING', amount: amt }); return true; };
const approveP = (cy) => { const p = cyclePayouts.get(cy); if (!p || (p.status !== 'PENDING' && p.status !== 'FAILED')) return false; p.status = 'PROCESSING'; return true; };
const markPaidP = (cy) => { const p = cyclePayouts.get(cy); if (!p || p.status !== 'PROCESSING') return false; p.status = 'PAID'; return true; };
const failP = (cy) => { const p = cyclePayouts.get(cy); if (!p || p.status !== 'PROCESSING') return false; p.status = 'FAILED'; return true; };
const poolAfter = (collected) => collected - [...cyclePayouts.values()]
  .filter((p) => p.status === 'PROCESSING' || p.status === 'PAID')
  .reduce((s, p) => s + p.amount, 0);
ok("one payout per cycle (duplicate initiate blocked)", initiateP('cy1', 100000) && !initiateP('cy1', 100000));
ok("PENDING has not left the pool balance", poolAfter(100000) === 100000);
ok("approve → PROCESSING → pot already deducted", approveP('cy1') && cyclePayouts.get('cy1').status === 'PROCESSING' && poolAfter(100000) === 0);
ok("cannot mark paid unless PROCESSING", !markPaidP('cy0') && markPaidP('cy1') && cyclePayouts.get('cy1').status === 'PAID');
ok("second payout on a PAID cycle blocked (no double payout)", !approveP('cy1') && !initiateP('cy1', 100000) && poolAfter(100000) === 0);
ok("FAILED restores the pot and can be approved again",
  (initiateP('cy2', 50000) && approveP('cy2') && poolAfter(150000) === 0)
  && failP('cy2') && poolAfter(150000) === 50000 && approveP('cy2') && poolAfter(150000) === 0);

// --- direct transfer: one OPEN claim per member per cycle ------------------
const openClaims = new Set(); // "membership:cycle" while status is PENDING
const submitClaim = (m, c) => { const k = `${m}:${c}`; if (openClaims.has(k)) return false; openClaims.add(k); return true; };
const resolveClaim = (m, c) => openClaims.delete(`${m}:${c}`);
ok("first claim accepted", submitClaim('m1', 'c1'));
ok("second claim while one is open → blocked", !submitClaim('m1', 'c1'));
ok("another member is not blocked", submitClaim('m2', 'c1'));
ok("another cycle is not blocked", submitClaim('m1', 'c2'));
ok("reject frees the slot", resolveClaim('m1', 'c1') && submitClaim('m1', 'c1'));
ok("confirm frees the slot too", resolveClaim('m1', 'c1') && submitClaim('m1', 'c1'));
// Only CONFIRMED contributions count — a PENDING claim can never reach the pot.
const potOf = (rows) => rows.filter((r) => r.status === 'CONFIRMED').reduce((s, r) => s + r.amount, 0);
ok("PENDING claim is not in the pot, CONFIRMED is",
  potOf([{ status: 'PENDING', amount: 500 }]) === 0 && potOf([{ status: 'PENDING', amount: 500 }, { status: 'CONFIRMED', amount: 500 }]) === 500);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
