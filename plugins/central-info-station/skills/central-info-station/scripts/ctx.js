"use strict";
/**
 * CIS — **retrieve instead of read**: `cis ctx "<topic | id | file | symbol>" [--n 8] [--json] [--rebuild]`
 *   ⇒ up to 5 references (type · id · title · status · file:lines · why) + the exact excerpt of the first, ≤3KB.
 * The improvement loop: `cis miss "<what you searched>" --expected "<the right source>"` appends to a per-project log
 * (<main checkout>/.cis/local/misses.jsonl — shared by all worktrees, git-ignored) with the rank ctx gave the right source.
 * `cis misses` lists them — that is what the index is tuned from.
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const { t: T } = require("./i18n");

const missesFile = (mainRoot) => process.env.CIS_MISSES_FILE || path.join(lib.localDir(mainRoot), "misses.jsonl");

/** 1-based rank of the right source in the full result list (by id, file:line inside the range, or file); 0 = not found */
function rankOf(index, q, expected, re) {
  const res = lib.query(index, q, { n: 50, re });
  const e = String(expected || "").trim();
  const m = e.match(/^(.+?):L?(\d+)$/);
  const k = res.hits.findIndex((h) => {
    const r = h.row;
    if (r.id === e || r.id.toLowerCase() === e.toLowerCase()) return true;
    if (m) return r.file === m[1] && r.start <= +m[2] && (r.end || r.start) >= +m[2];
    return r.file === e;
  });
  return { rank: k + 1, got: res.hits.slice(0, 5).map((h) => `${h.row.id} (${lib.ref(h.row)})`) };
}

function recordMiss(q, expected, opts = {}) {
  const { index, loc, env } = opts.index ? opts : lib.loadIndex({ cwd: opts.cwd });
  const { rank, got } = rankOf(index, q, expected, env && env.re);
  const entry = { at: new Date().toISOString(), top: path.basename(loc.top), branch: loc.branch, head: String(index.head).slice(0, 8), q, expected, rank, got };
  const file = opts.file || missesFile(loc.mainRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return { entry, file };
}

function readMisses(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

/** `ctx` — returns the text to print */
function run(argv, opts = {}) {
  const args = [];
  let n = 5;
  let json = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--n") n = Math.max(1, Math.min(20, parseInt(argv[++i], 10) || 5));
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--rebuild") force = true;
    else args.push(argv[i]);
  }
  const { index, env, fromCache, ms } = lib.loadIndex({ force, cwd: opts.cwd });
  const t = T(index.language);
  const q = args.join(" ").trim();
  if (!q) return { code: 2, out: t.ctxUsage };
  const res = lib.query(index, q, { n, re: env.re });
  if (!json) return { code: 0, out: lib.formatQuery(index, q, res) };
  const hits = res.hits.map((h) => ({ id: h.row.id, type: h.row.type, title: h.row.title, status: h.row.status, ref: lib.ref(h.row), red: h.row.red, why: h.why, supersededBy: h.row.supersededBy || null, links: h.row.links.slice(0, 5) }));
  return { code: 0, out: JSON.stringify({ q, mode: res.mode, total: res.total, files: res.files, head: index.head, fromCache, ms, hits }, null, 1) };
}

function runMiss(argv, opts = {}) {
  let q = "";
  let expected = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expected") expected = String(argv[++i] || "");
    else q = q ? `${q} ${argv[i]}` : argv[i];
  }
  const loaded = lib.loadIndex({ cwd: opts.cwd });
  const t = T(loaded.index.language);
  if (!q.trim() || !expected.trim()) return { code: 2, out: t.missUsage };
  const { entry, file } = recordMiss(q.trim(), expected.trim(), { ...loaded });
  return { code: 0, out: t.missDone(file, entry.rank) };
}

function runMisses(opts = {}) {
  const loc = lib.locate(opts.cwd || process.cwd());
  const env = lib.envFor(loc);
  const t = T(env.cfg.language);
  const all = readMisses(missesFile(loc.mainRoot));
  return { code: 0, out: all.length ? all.map(t.missLine).join("\n") : t.missesNone };
}

module.exports = { run, runMiss, runMisses, rankOf, recordMiss, readMisses, missesFile };
