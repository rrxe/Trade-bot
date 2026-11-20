// Node harness: loads the engine region of mid.js and runs the walk-forward backtest on synthetic data.
const fs = require("fs"), vm = require("vm");
// usage: node tools/synthetic_check.js [candles=6000] [noise]
// Loads the engine out of ../index.html and runs the walk-forward backtest on SYNTHETIC data
// (random walk = must never open the 80% gate; planted trend = gate should open). No network needed.
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const src = html.slice(html.indexOf('"use strict";') + 13);
const code = src.slice(0, src.indexOf("/*@@ENGINE_END*/"));
const ctx = { window: {}, setTimeout, console, Math, Date, Object, Array, JSON, Promise, Number, String };
vm.createContext(ctx);
vm.runInContext(code + "\n;this.E={A,councilCore,backtestCore,analyzeBacktest,computeGate,wilson,calcVWAP,SENS};", ctx);
const E = ctx.E;

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// mode: rw = pure random walk with vol clustering; edge = regime switching with persistent drift mu (in sigma units)
function genMinutes(n, seed, mode, mu) {
  const r = rng(seed), out = [], T0 = Date.UTC(2026, 0, 1);
  let p = 90000, vol = 0.0006, reg = 0, left = 0;
  for (let i = 0; i < n; i++) {
    vol = Math.max(0.0002, Math.min(0.003, vol * 0.98 + 0.0006 * 0.02 + 0.00008 * gauss(r)));
    if (mode === "edge") { if (--left <= 0) { reg = [-1, 0, 1][Math.floor(r() * 3)]; left = 40 + Math.floor(r() * 200); } }
    const ret = (mode === "edge" ? reg * mu * vol : 0) + vol * gauss(r);
    const o = p, c = p * (1 + ret);
    const wick = vol * Math.abs(gauss(r)) * 0.6;
    const h = Math.max(o, c) * (1 + wick * r()), l = Math.min(o, c) * (1 - wick * r());
    const v = 5 + 20 * r(), tb = v * (0.5 + 0.1 * Math.sign(ret) * r() + 0.05 * gauss(r));
    out.push({ t: T0 + i * 60000, o, h, l, c, v, tb: Math.max(0, Math.min(v, tb)), ct: T0 + (i + 1) * 60000 - 1, x: true });
    p = c;
  }
  return out;
}
function agg(c, k) {
  const out = [];
  for (let i = 0; i + k <= c.length; i += k) {
    const s = c.slice(i, i + k);
    out.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map(q => q.h)), l: Math.min(...s.map(q => q.l)), c: s[k - 1].c, v: s.reduce((a, q) => a + q.v, 0), tb: s.reduce((a, q) => a + q.tb, 0), ct: s[k - 1].ct, x: true });
  }
  return out;
}
const pct = x => x == null ? "—" : (x * 100).toFixed(1) + "%";

async function run(label, mode, mu, n, seed) {
  const m1 = genMinutes(n, seed, mode, mu);
  const htf = { "15m": agg(m1, 15), "1h": agg(m1, 60), "4h": agg(m1, 240) };
  const t0 = Date.now();
  const res = await E.backtestCore(m1, htf, "1m", { need: 500 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== ${label}  (mode=${mode} mu=${mu} n=${n} seed=${seed}) ${dt}s`);
  console.log(`candles ${res.candles} | directional ${res.dirN} hit ${pct(res.dirRate)} | gated ${res.gatedN} hit ${pct(res.gatedRate)} CI95 [${pct(res.gatedCI[0])},${pct(res.gatedCI[1])}]`);
  console.log(`t80 forward: n=${res.fw.n} hit=${pct(res.fw.rate)} CI95 [${pct(res.fw.ci[0])},${pct(res.fw.ci[1])}] gate-open share=${pct(res.openShare)}`);
  console.log("quantiles (top% of Q): " + res.rows.map(r => `${(r.f * 100) | 0}%: n=${r.n} ${pct(r.rate)}`).join(" | "));
  console.log(`calibrated signals (lower bound >=55%): n=${res.go.n} hit=${pct(res.go.rate)} shown-conf=${pct(res.go.conf)}`);
  console.log("analysts: " + res.ana.map(a => `${a.id} ${a.N ? pct(a.H / a.N) : "—"}(${a.N})`).join(" "));
  return res;
}
(async () => {
  const n = +process.argv[2] || 6000;
  if (process.argv[3] === "noise") {
    let N = 0, H = 0, opened = 0, G = 0, GH = 0;
    const log = console.log; console.log = () => {};
    const rs = [];
    for (let sd = 100; sd < 112; sd++) rs.push(await run("n", "rw", 0, n, sd));
    console.log = log;
    rs.forEach(r => { N += r.fw.n; H += r.fw.h; if (r.fw.n) opened++; G += r.gatedN; GH += Math.round(r.gatedRate * r.gatedN); });
    console.log(`12 noise runs: gate ever fired in ${opened}/12 runs; total t80 signals ${N}, hit ${N ? (H / N * 100).toFixed(1) + "%" : "—"}; gated overall ${(GH / G * 100).toFixed(1)}% (n=${G})`);
    return;
  }
  await run("PURE NOISE seed1", "rw", 0, n, 1);
  await run("PURE NOISE seed2", "rw", 0, n, 2);
  await run("PURE NOISE seed3", "rw", 0, n, 3);
  await run("PLANTED EDGE mu=0.3", "edge", 0.3, n, 11);
  await run("PLANTED EDGE mu=1.0", "edge", 1.0, n, 12);
})();
