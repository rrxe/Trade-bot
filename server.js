"use strict";
/*
 * Council background runner.
 * Durable state lives in DATA_DIR/state.json (Docker Compose mounts /data).
 * Writes are atomic and debounced on every localStorage mutation, with a last-known-good backup.
 */
const fs = require("fs");
const vm = require("vm");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const DIR = __dirname;
const DATA = process.env.DATA_DIR || path.join(DIR, "data");
const PORT = Number(process.env.PORT) || 8080;
const AUTH = process.env.AUTH || "";
const TFLIST = ["1m", "3m", "5m", "15m", "1h", "4h"];
const SENSES = ["loose", "balanced", "strict", "t80"];
/* Supabase (اختياري): نسخة سحابية دائمة من الحالة، تنجو من حذف الـ Volume أو نقل الخادم. */
const SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "").trim();
const SB_TABLE = (process.env.SUPABASE_TABLE || "council_state").trim();
const SB_PUSH_MS = Math.max(15, Number(process.env.SUPABASE_PUSH_SECONDS) || 60) * 1000;
const SB_ON = !!(SB_URL && SB_KEY);
const sb = { enabled: SB_ON, ok: null, restored: false, lastLoadAt: null, lastPushAt: null, lastDailyAt: null, lastError: null };
const STATE_FILE = path.join(DATA, "state.json");
const BACKUP_FILE = path.join(DATA, "state.json.bak");
const TEMP_FILE = path.join(DATA, "state.json.tmp");

const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const scriptStart = html.indexOf("<script>") + 8;
if (scriptStart < 8) throw new Error("The application script was not found in index.html");
const scriptEnd = html.indexOf("</script>", scriptStart);
if (scriptEnd < 0) throw new Error("The closing script tag was not found in index.html");
const engineCode = html.slice(scriptStart, scriptEnd);
let CSP = "default-src 'self'";
try {
  const match = /Content-Security-Policy "([^"]+)"/.exec(fs.readFileSync(path.join(DIR, "nginx.conf"), "utf8"));
  if (match) CSP = match[1];
} catch (error) {
  // The application remains usable with the conservative fallback policy.
}

fs.mkdirSync(DATA, { recursive: true });

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizeState(raw) {
  const value = isObject(raw) ? raw : {};
  const tf = isObject(value.tf) ? value.tf : {};
  const pend = isObject(value.pend) ? value.pend : {};
  return {
    version: 2,
    sens: SENSES.includes(value.sens) ? value.sens : "balanced",
    tf: Object.fromEntries(Object.entries(tf).filter(([key, item]) => TFLIST.includes(key) && isObject(item))),
    pend: Object.fromEntries(TFLIST.map(key => [key, isObject(pend[key]) ? pend[key] : null])),
    savedAt: Number(value.savedAt) || null
  };
}
function readStateFile(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    return null;
  }
}
let saved = readStateFile(STATE_FILE);
if (!saved) {
  const backup = readStateFile(BACKUP_FILE);
  saved = backup || normalizeState(null);
  if (backup) console.warn("Primary state file was invalid; restored the last-known-good backup.");
}


/* ---------- Supabase REST (بدون أي مكتبة خارجية) ---------- */
let sbPending = null, sbTimer = null, sbPushing = false, sbLastHash = "", sbLastDaily = "";
async function sbRequest(pathAndQuery, { method = "GET", body, headers = {}, timeout = 15000 } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    method,
    body,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...headers },
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  return res;
}
async function sbUpsert(id, state, timeout) {
  const body = JSON.stringify([{ id, data: state, saved_at: new Date(state.savedAt || Date.now()).toISOString() }]);
  await sbRequest(`${SB_TABLE}?on_conflict=id`, {
    method: "POST", body, timeout,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" }
  });
}
async function sbPrune() {
  try {
    const res = await sbRequest(`${SB_TABLE}?id=like.daily-*&select=id&order=id.desc&offset=14&limit=50`);
    const rows = await res.json();
    if (rows.length) await sbRequest(`${SB_TABLE}?id=in.(${rows.map(r => r.id).join(",")})`, { method: "DELETE" });
  } catch (error) {
    log("supabase prune warning:", error.message);
  }
}
async function sbPushNow(force) {
  if (!SB_ON || sbPushing || !sbPending) return;
  const state = sbPending;
  const hash = crypto.createHash("sha1").update(JSON.stringify({ ...state, savedAt: 0 })).digest("hex");
  if (!force && hash === sbLastHash) { sbPending = null; return; }
  sbPushing = true;
  try {
    await sbUpsert("main", state, force ? 4000 : 20000);
    sbLastHash = hash;
    if (sbPending === state) sbPending = null;
    sb.ok = true; sb.lastPushAt = Date.now(); sb.lastError = null;
  } catch (error) {
    sb.ok = false; sb.lastError = error.message;
    log("supabase push failed:", error.message);
    sbPushing = false;
    return;
  }
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (sbLastDaily !== day) {
      await sbUpsert(`daily-${day}`, state, force ? 4000 : 20000);
      sbLastDaily = day; sb.lastDailyAt = Date.now();
      await sbPrune();
    }
  } catch (error) {
    log("supabase daily snapshot warning:", error.message);
  } finally {
    sbPushing = false;
  }
}
function queuePush(state) {
  if (!SB_ON) return;
  sbPending = state;
  if (sbTimer) return;
  sbTimer = setTimeout(() => { sbTimer = null; sbPushNow(false); }, SB_PUSH_MS);
  if (sbTimer.unref) sbTimer.unref();
}
/* عند الإقلاع: إن كانت النسخة السحابية أحدث (أو الملف المحلي فارغ) نستعيدها قبل تشغيل المحرك. */
async function restoreFromSupabase() {
  if (!SB_ON) { log("supabase: disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY not set)"); return; }
  try {
    const res = await sbRequest(`${SB_TABLE}?id=eq.main&select=data`);
    const rows = await res.json();
    sb.lastLoadAt = Date.now(); sb.ok = true;
    if (rows[0] && rows[0].data) {
      const remote = normalizeState(rows[0].data);
      const localEmpty = !Object.keys(saved.tf).length;
      const remoteHas = Object.keys(remote.tf).length > 0;
      if (remoteHas && (localEmpty || (remote.savedAt || 0) > (saved.savedAt || 0))) {
        saved = remote; sb.restored = true;
        log("supabase: restored state from the cloud copy (" + Object.keys(remote.tf).join(",") + ")");
        flush();
      } else log("supabase: local state is current; keeping it");
    } else log("supabase: connected; no cloud copy yet, it will be created on the first save");
  } catch (error) {
    sb.ok = false; sb.lastError = error.message;
    log("supabase: could not read the cloud copy:", error.message);
  }
}

const contexts = Object.create(null);
let flushTimer = null;
let shuttingDown = false;
let flushInProgress = false;
const log = (...args) => console.log(new Date().toISOString(), ...args);

const dummy = () => new Proxy(function () {}, {
  get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : dummy(),
  set: () => true,
  apply: () => dummy()
});
function runInFrame(tf, source) {
  return vm.runInContext(source, contexts[tf], { timeout: 5000 });
}

function snapshot() {
  const out = {
    version: 2,
    savedAt: Date.now(),
    sens: saved.sens,
    tf: { ...saved.tf },
    pend: { ...saved.pend }
  };
  for (const tf of TFLIST) {
    if (!contexts[tf]) continue;
    try {
      const current = runInFrame(tf,
        "({sens:S.store.sens,tf:S.store.tf[S.tf]||null,pending:S.pending||null})");
      if (SENSES.includes(current.sens)) out.sens = current.sens;
      if (isObject(current.tf)) out.tf[tf] = current.tf;
      else delete out.tf[tf];
      out.pend[tf] = isObject(current.pending) ? current.pending : null;
    } catch (error) {
      log("snapshot failed for", tf, error.message);
    }
  }
  return normalizeState(out);
}
function flush() {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const next = snapshot();
    const data = JSON.stringify(next);
    const fd = fs.openSync(TEMP_FILE, "w", 0o600);
    try {
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, BACKUP_FILE);
    } catch (backupError) {
      log("backup update warning:", backupError.message);
    }
    fs.renameSync(TEMP_FILE, STATE_FILE);
    try {
      const dirFd = fs.openSync(DATA, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (syncError) {
      // Directory fsync is not available on every filesystem; atomic rename still applies.
    }
    saved = next;
    queuePush(next);
  } catch (error) {
    log("state save failed:", error.message);
    try { if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE); } catch (_) {}
  } finally {
    flushInProgress = false;
  }
}
function scheduleFlush() {
  if (shuttingDown) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 300);
  if (flushTimer.unref) flushTimer.unref();
}

function boot(tf) {
  const mem = {
    btc_council_v3: JSON.stringify({
      sens: saved.sens,
      tf: saved.tf[tf] ? { [tf]: saved.tf[tf] } : {}
    }),
    tf_sel: tf
  };
  if (saved.pend[tf]) mem[`pend_${tf}`] = JSON.stringify(saved.pend[tf]);

  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; },
    setItem(key, value) {
      mem[key] = String(value);
      scheduleFlush();
    },
    removeItem(key) {
      delete mem[key];
      scheduleFlush();
    }
  };

  const context = vm.createContext({
    window: { __SERVER: true, __TF: tf, devicePixelRatio: 1 },
    document: dummy(),
    localStorage,
    navigator: { vibrate() {} },
    performance,
    confirm: () => false,
    requestAnimationFrame: () => 0,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    fetch,
    WebSocket,
    console: { log() {}, warn() {}, error() {} }
  });
  contexts[tf] = context;
  try {
    vm.runInContext(engineCode, context, { filename: `council-${tf}.js`, timeout: 10000 });
    log("started", tf);
    scheduleFlush();
  } catch (error) {
    log("FAILED", tf, error && error.stack ? error.stack : error);
  }
}

function safeSummary() {
  const tfs = {};
  for (const tf of TFLIST) {
    if (!contexts[tf]) continue;
    try {
      tfs[tf] = runInFrame(tf, `(() => {
        const p=S.pending;
        const calibrated=!!(p&&p.go&&Number.isFinite(p.conf)&&p.conf>=.55&&p.calN>=100);
        const go=T().c.go;
        return {
          p:p&&{d:p.d,go:calibrated,conf:calibrated?p.conf:null,calN:p.calN||0,id:p.id},
          ct:S.candles.length?S.candles[S.candles.length-1].ct:null,
          go:go,
          age:S.lastMsg?NOW()-S.lastMsg:null
        };
      })()`);
    } catch (error) {
      tfs[tf] = { error: "frame_unavailable" };
    }
  }
  return { now: Date.now(), tfs };
}

/* Restart an individual market-data connection if its feed has gone silent. */
function watchdog() {
  for (const tf of TFLIST) {
    if (!contexts[tf]) continue;
    try {
      const age = runInFrame(tf, "S.lastMsg?NOW()-S.lastMsg:NOW()-BOOT_T");
      if (age > 60000) {
        log("feed stalled; reconnecting", tf);
        runInFrame(tf, "start(S.tf)");
      }
    } catch (error) {
      log("watchdog failed for", tf, error.message);
    }
  }
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end("ok");
  }
  if (AUTH && (req.headers.authorization || "") !== `Basic ${Buffer.from(AUTH).toString("base64")}`) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="council"', "Cache-Control": "no-store" });
    return res.end("authentication required");
  }

  const json = (value, code = 200, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(value));
  };
  const readBody = () => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) reject(new Error("request_too_large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (error) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });

  try {
    if (url.pathname === "/api/summary" && req.method === "GET") return json(safeSummary());
    if (url.pathname === "/api/state" && req.method === "GET") {
      const tf = url.searchParams.get("tf");
      if (!TFLIST.includes(tf) || !contexts[tf]) return json({ error: "unknown_timeframe" }, 404);
      const state = runInFrame(tf, "({tf:S.store.tf[S.tf]||null,sens:S.store.sens,pending:S.pending})");
      return json(state);
    }
    if (url.pathname === "/api/storage" && req.method === "GET") {
      return json({
        ok: fs.existsSync(STATE_FILE),
        backup: fs.existsSync(BACKUP_FILE),
        volume: "mounted_data_directory",
        savedAt: saved.savedAt,
        timeframes: Object.keys(saved.tf),
        supabase: { ...sb, pending: !!sbPending }
      });
    }
    if (url.pathname === "/api/backup" && req.method === "GET") {
      flush();
      const body = fs.readFileSync(STATE_FILE);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="council-backup.json"',
        "Cache-Control": "no-store"
      });
      return res.end(body);
    }
    if (url.pathname === "/api/sens" && req.method === "POST") {
      const input = await readBody();
      if (!SENSES.includes(input.s)) return json({ error: "invalid_sensitivity" }, 400);
      saved.sens = input.s;
      for (const tf of TFLIST) if (contexts[tf]) {
        runInFrame(tf, `S.store.sens=${JSON.stringify(input.s)};GATE.v=null;save();`);
      }
      flush();
      return json({ ok: true, sens: saved.sens });
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      for (const tf of TFLIST) if (contexts[tf]) {
        runInFrame(tf, "S.store={sens:S.store.sens,tf:{}};S.pending=null;GATE.v=null;save();localStorage.removeItem('pend_'+S.tf);");
      }
      flush();
      return json({ ok: true });
    }

    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (["index.html", "manifest.webmanifest", "icon.svg"].includes(file)) {
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-cache"
      });
      return res.end(fs.readFileSync(path.join(DIR, file)));
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("not found");
  } catch (error) {
    log("request failed:", error.message);
    return json({ error: "request_failed" }, 500);
  }
});

async function main() {
  process.on("unhandledRejection", error => log("unhandled rejection:", error && error.message ? error.message : error));
  process.on("uncaughtException", error => log("uncaught exception:", error && error.stack ? error.stack : error));
  await restoreFromSupabase();
  TFLIST.forEach((tf, index) => setTimeout(() => boot(tf), index * 1500));
  setInterval(flush, 10000).unref?.();
  setInterval(watchdog, 30000).unref?.();
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(signal, "received; saving state before shutdown");
    if (flushTimer) clearTimeout(flushTimer);
    flush();
    try { await sbPushNow(true); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 6000).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  server.listen(PORT, "0.0.0.0", () => log("listening on", PORT, "data directory", DATA));
}

if (require.main === module) main();
else module.exports = { boot, contexts, runInFrame, flush, safeSummary, server, STATE_FILE, restoreFromSupabase, sb };
