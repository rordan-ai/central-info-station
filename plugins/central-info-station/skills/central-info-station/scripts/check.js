"use strict";
/**
 * CIS — **size caps** (report only): `cis check [--json]`.
 * Caps come from `archive.caps` in the config ({"<glob>": KB}); the agent memory index (Claude Code's MEMORY.md) is capped at 200 lines
 * (only the first 200 are loaded); the largest sources over the read-gate limit are listed for information.
 * Why: a hand trim of a growing handoff file undoes itself within weeks — a constant measurement keeps it honest.
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const C = require("./config");
const { t: T } = require("./i18n");

const KB = 1024;
const MEMORY_LINES = 200;
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };

function check(opts = {}) {
  const git = opts.git || lib.realGit;
  const loc = opts.loc || lib.locate(opts.cwd || process.cwd(), git);
  const env = opts.env || lib.envFor(loc, { git });
  const cfg = env.cfg;
  const items = [];
  const capped = new Set();
  for (const [glob, kb] of Object.entries((cfg.archive && cfg.archive.caps) || {})) {
    for (const rel of C.expand(loc.top, glob)) {
      if (/\/archive\//.test(rel) || capped.has(rel)) continue;
      const size = sizeOf(path.join(loc.top, rel));
      if (size < 0) continue;
      capped.add(rel);
      const cap = kb * KB;
      items.push({ label: rel, kind: "capped", size, cap, over: size > cap, factor: +(size / cap).toFixed(1) });
    }
  }
  const limit = ((cfg.gate && cfg.gate.maxKB) || 30) * KB;
  const big = env.sources.filter((s) => !capped.has(s.rel)).map((s) => ({ rel: s.rel, size: sizeOf(path.join(loc.top, s.rel)) })).filter((x) => x.size > limit).sort((a, b) => b.size - a.size);
  for (const b of big.slice(0, 5)) items.push({ label: b.rel, kind: "info", size: b.size, cap: null, over: false, factor: null });
  let red = 0;
  let lines = 0;
  if (env.memDir) {
    try {
      const txt = fs.readFileSync(path.join(env.memDir, "MEMORY.md"), "utf8");
      lines = txt.split(/\r?\n/).length;
      red = Object.values(lib.parseMemoryIndex(txt)).filter((m) => m.red).length;
      items.push({ label: "MEMORY.md", kind: "memory", size: lines, cap: MEMORY_LINES, over: lines > MEMORY_LINES, factor: +(lines / MEMORY_LINES).toFixed(1), unit: "lines" });
    } catch { /* no memory index */ }
  }
  return { items, memory: { redPointers: red, lines, dir: env.memDir }, language: cfg.language };
}

function format(res) {
  const t = T(res.language);
  const L = [t.checkTitle];
  for (const it of res.items) {
    const v = it.unit === "lines" ? `${it.size} lines` : `${(it.size / KB).toFixed(1)}KB`;
    if (!it.cap) L.push(t.checkInfo(it.label, v));
    else L.push(t.checkLine(!it.over, it.label, v, it.unit === "lines" ? `${it.cap} lines` : `${(it.cap / KB).toFixed(0)}KB`, it.factor));
  }
  if (res.memory.lines) L.push(t.checkMemory(res.memory.redPointers, res.memory.lines));
  const over = res.items.filter((i) => i.over).length;
  L.push(over ? t.checkOver(over) : t.checkOk);
  return L.join("\n");
}

/** one line: when the index was built · from which HEAD · rows · fresh or not. `warm` ⇒ rebuild in the background when stale. */
function brief(opts = {}) {
  const f = lib.freshness(opts);
  const t = T(f.env.cfg.language);
  let bg = false;
  if (opts.warm && !f.fresh) { try { require("./build").spawnBackground({ reason: opts.reason || "brief", cwd: f.loc.top }); bg = true; } catch { /* none */ } }
  if (!f.meta) return t.briefNone(bg);
  return t.brief(f.meta.builtAt.slice(0, 16).replace("T", " "), String(f.meta.head).slice(0, 8), f.meta.rows, f.fresh ? t.stateFresh : t.stateStale(bg));
}

module.exports = { check, format, brief, MEMORY_LINES };
