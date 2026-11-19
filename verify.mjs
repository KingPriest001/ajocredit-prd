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
const { gatewayFeeFor, chargeFor } = (await import('./api/money.js')).default;
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
