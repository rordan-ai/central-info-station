"use strict";
/**
 * CIS — configuration: defaults, loading `.cis/config.json`, and **detection** (`cis init`).
 *
 * Nothing about a specific project is hard-coded anywhere else: which files are decision logs / plans / docs / agent rules,
 * the id formats, the size limits and what the hooks enforce — all of it lives in the config, and `detect()` proposes it
 * by looking at the repo (the agent then reviews it with the user before installing).
 */
const fs = require("fs");
const path = require("path");

const CONFIG_DIR = ".cis";
const CONFIG_FILE = "config.json";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "vendor", "coverage", "target", "venv", ".venv", "__pycache__", ".turbo", ".cache", ".cis"]);
const CODE_EXT = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "cs", "fs", "swift", "m", "mm", "c", "cc", "cpp", "h", "hpp", "scala", "clj", "ex", "exs", "erl", "dart", "lua", "sh", "ps1", "sql", "css", "scss", "sass", "less", "vue", "svelte", "astro"];
const RULE_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "CONVENTIONS.md", ".cursorrules", ".windsurfrules", ".clinerules", ".github/copilot-instructions.md"];
const RULE_GLOBS = ["rules/*.md", ".claude/rules/*.md", ".cursor/rules/*.mdc", ".cursor/rules/*.md"];

const DEFAULTS = {
  version: 1,
  language: "en",
  mainBranch: "auto",
  sources: [],
  ids: { decision: "D\\d{1,4}", item: "\\d{1,2}\\.\\d{1,3}[a-z]?", extra: [] },
  memory: "auto",
  graph: "auto",
  handoff: "resume (?:here|point)|next session|where we left off|hand-?off (?:to|for|note)|נקודת (?:ה)?המשך|העברה לחיבור",
  card: { maxBytes: 4096, refs: [], pins: [], remaining: "what'?s left|remaining|to ?do|next steps|open items|מה נותר", redLines: [], maxRedLines: 8 },
  topics: { dir: null, branchPrefix: "agents/" },
  gate: { enabled: true, mode: "deny", maxKB: 30, dirs: [], ext: ["md", "markdown", "mdx", "txt", "rst", "adoc", "json", "jsonl", "csv", "log", "yml", "yaml", "html", "htm"] },
  edit: { enabled: true, maxLines: 3, codeExt: CODE_EXT },
  archive: {
    caps: {},
    minAgeDays: 14,
    protected: "requested|open decisions|what'?s left|remaining|ownership|working rules|role|archived|🔒|מבוקש|הכרעות פתוחות|מה נותר|גבולות בעלות|כללי עבודה|התפקיד|בארכיון",
  },
};

// ── small helpers ─────────────────────────────────────────────────────────
const posix = (p) => String(p).replace(/\\/g, "/");
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

/** glob ⇒ RegExp on posix relative paths. Supports `*`, `**`, `?`. */
function globToRe(glob) {
  let re = "";
  const g = posix(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}
/** the directory part of a glob before its first wildcard ("docs/**\/*.md" ⇒ "docs") */
function staticPrefix(glob) {
  const parts = posix(glob).split("/");
  const out = [];
  for (const p of parts) { if (/[*?[]/.test(p)) break; out.push(p); }
  if (out.length === parts.length) out.pop(); // a plain file path ⇒ its directory
  return out.join("/");
}
function walk(top, rel, out, depth = 0) {
  if (depth > 12) return;
  let entries = [];
  try { entries = fs.readdirSync(path.join(top, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(top, r, out, depth + 1); }
    else if (e.isFile()) out.push(r);
  }
}
function expand(top, glob) {
  const re = globToRe(glob);
  const files = [];
  walk(top, staticPrefix(glob), files);
  return files.filter((f) => re.test(f)).sort();
}

/**
 * The source files of the index: [{rel, kind}] in config order; a file matched by an earlier entry is not matched again.
 * Each file's archive siblings (`<dir>/archive/<name>-*.md`, written by `cis archive`) are included as "docs", so ctx still finds them.
 */
function listSources(top, cfg) {
  const seen = new Set();
  const out = [];
  const push = (rel, kind) => {
    const k = process.platform === "win32" ? rel.toLowerCase() : rel;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ rel, kind });
  };
  const excludes = (cfg.exclude || []).map(globToRe);
  const ok = (rel) => !excludes.some((re) => re.test(rel));
  for (const s of cfg.sources || []) {
    const files = s.path ? (fs.existsSync(path.join(top, s.path)) ? [posix(s.path)] : []) : s.glob ? expand(top, s.glob) : [];
    for (const f of files) if (ok(f)) push(f, s.kind || "docs");
  }
  for (const s of [...out]) {
    if (s.kind === "adr") continue;
    const dir = path.posix.dirname(s.rel);
    const base = path.posix.basename(s.rel).replace(/\.[^.]+$/, "");
    for (const f of expand(top, `${dir === "." ? "" : `${dir}/`}archive/${base}-*.md`)) push(f, "docs");
  }
  return out;
}

/** compiled patterns used everywhere (built once per config) */
function compile(cfg) {
  const re = (s, flags = "") => new RegExp(s, flags);
  const decision = cfg.ids.decision || "D\\d{1,4}";
  const item = cfg.ids.item || "\\d{1,2}\\.\\d{1,3}[a-z]?";
  const extra = (cfg.ids.extra || []).filter(Boolean);
  const codeExt = (cfg.edit.codeExt || CODE_EXT).join("|");
  return {
    decision: re(`(?<![\\w-])(?:${decision})(?![\\w-])`, "g"),
    decisionExact: re(`^~?(?:${decision})$`, "i"),
    item: re(`(?<![\\d.\\/])(${item})(?![\\d\\/])`, "g"),
    itemExact: re(`^(?:${item})$`, "i"),
    extra: extra.map((x) => re(`(?<![\\w-])(?:${x})(?![\\w-])`, "g")),
    extraExact: extra.map((x) => re(`^(?:${x})$`, "i")),
    handoff: re(cfg.handoff || DEFAULTS.handoff, "i"),
    remaining: re(`^##\\s+(?:${cfg.card.remaining || DEFAULTS.card.remaining})`, "i"),
    protectedRe: re(cfg.archive.protected || DEFAULTS.archive.protected, "i"),
    code: re(`\\.(?:${codeExt})$`, "i"),
    docExt: re(`\\.(?:${(cfg.gate.ext || DEFAULTS.gate.ext).join("|")})$`, "i"),
  };
}

/** `.cis/config.json` merged over the defaults; no file ⇒ the detected config (not written) */
function loadConfig(top, opts = {}) {
  const file = path.join(top, CONFIG_DIR, CONFIG_FILE);
  let user = null;
  try { user = JSON.parse(fs.readFileSync(file, "utf8")); } catch { user = null; }
  const config = merge(DEFAULTS, user || (opts.detect === false ? {} : detect(top, opts).config));
  return { config, file, exists: !!user, re: compile(config) };
}

// ── detection (`cis init`) ─────────────────────────────────────────────
const readHead = (abs, n = 200_000) => { try { return fs.readFileSync(abs, "utf8").slice(0, n); } catch { return ""; } };
const count = (text, re) => (text.match(re) || []).length;

/**
 * Looks at the repo and proposes a config: agent rules files, ADR folders, decision logs (tables / headings with ids),
 * task-list plans, docs folders, topic files of parallel sessions, the main branch, the language, a code graph.
 * Returns {config, report} — the report says what was found and why, for the agent to review with the user.
 */
function detect(top, opts = {}) {
  const git = opts.git;
  const report = [];
  const all = [];
  walk(top, "", all);
  const md = all.filter((f) => /\.(md|mdx|mdc)$/i.test(f) || /(^|\/)\.(cursorrules|windsurfrules|clinerules)$/.test(f));
  const sources = [];
  const used = new Set();
  const take = (rel) => used.add(rel.toLowerCase());

  // 1. agent rules
  for (const f of RULE_FILES) if (fs.existsSync(path.join(top, f))) { sources.push({ path: f, kind: "rules" }); take(f); }
  for (const g of RULE_GLOBS) if (expand(top, g).length) { sources.push({ glob: g, kind: "rules" }); expand(top, g).forEach(take); }
  const rules = sources.filter((s) => s.kind === "rules").map((s) => s.path || s.glob);
  if (rules.length) report.push(`rules: ${rules.join(", ")}`);

  // 2. ADR folders (0001-title.md)
  const adrDirs = new Set(md.filter((f) => /(^|\/)(adr|adrs|decisions|decision-records|architecture\/decisions)\/\d{3,5}-[^/]+\.md$/i.test(f)).map((f) => path.posix.dirname(f)));
  for (const d of adrDirs) { sources.push({ glob: `${d}/*.md`, kind: "adr" }); expand(top, `${d}/*.md`).forEach(take); report.push(`ADRs: ${d}/ (${expand(top, `${d}/*.md`).length} files)`); }

  // 3. decision logs & plans — by content
  let decPrefix = null;
  let itemBold = false;
  const scored = [];
  for (const f of md) {
    if (used.has(f.toLowerCase())) continue;
    const t = readHead(path.join(top, f));
    const decTable = t.match(/^\|\s*(?:~~)?((?:D|DEC|DR|AD)-?)\d{1,4}(?:~~)?\s*\|/gm) || [];
    const decHead = t.match(/^#{2,4}\s+(?:~~)?((?:D|DEC|DR)-?)\d{1,4}\b/gm) || [];
    const boxes = count(t, /^\s*[-*] \[[ xX~!-]\]\s/gm);
    scored.push({ f, dec: decTable.length + decHead.length, boxes, bold: count(t, /^\s*[-*] \[[ xX~!-]\]\s+\*\*\d{1,2}\.\d{1,3}[a-z]?\*\*/gm), sample: (decTable[0] || decHead[0] || "") });
  }
  for (const s of scored.filter((x) => x.dec >= 3).sort((a, b) => b.dec - a.dec).slice(0, 3)) {
    sources.push({ path: s.f, kind: "decisions" });
    take(s.f);
    const m = s.sample.match(/((?:D|DEC|DR|AD)-?)\d/);
    if (m && !decPrefix) decPrefix = m[1];
    report.push(`decision log: ${s.f} (${s.dec} entries)`);
  }
  for (const s of scored.filter((x) => x.boxes >= 5 && !used.has(x.f.toLowerCase())).sort((a, b) => b.boxes - a.boxes).slice(0, 3)) {
    sources.push({ path: s.f, kind: "plan" });
    take(s.f);
    if (s.bold >= 3) itemBold = true;
    report.push(`plan: ${s.f} (${s.boxes} tasks${s.bold ? `, ${s.bold} with numeric ids` : ""})`);
  }

  // 4. topic files of parallel sessions (worktrees)
  let topicsDir = null;
  for (const d of ["docs/sessions", "docs/topics", ".agents/sessions", "sessions", "docs/agents"]) {
    const files = expand(top, `${d}/*.md`);
    if (files.length >= 1 && files.some((f) => /(?:ענף|branch)\s*:?\s*`/i.test(readHead(path.join(top, f), 4000)))) { topicsDir = d; break; }
  }
  if (topicsDir) report.push(`topic files of parallel sessions: ${topicsDir}/`);

  // 5. everything else that is documentation
  const docDirs = new Set();
  for (const f of md) {
    if (used.has(f.toLowerCase()) || /^\.github\//.test(f) || /(^|\/)(node_modules|vendor)\//.test(f)) continue;
    const first = f.split("/")[0];
    docDirs.add(f.includes("/") ? first : ".");
  }
  for (const d of [...docDirs].sort()) {
    if (d === ".") sources.push({ glob: "*.md", kind: "docs" });
    else if (/^(docs?|documentation|wiki|notes|handbook|specs?|rfcs?|design|\.claude)$/i.test(d) || d === topicsDir) sources.push({ glob: `${d}/**/*.md`, kind: "docs" });
  }
  const docs = sources.filter((s) => s.kind === "docs").map((s) => s.glob);
  if (docs.length) report.push(`docs: ${docs.join(", ")}`);

  // ids, language, branch, graph, gate dirs
  const ids = { ...DEFAULTS.ids };
  const decParts = [];
  if (decPrefix) decParts.push(`${decPrefix.replace("-", "\\-")}\\d{1,4}`);
  if (adrDirs.size) decParts.push("ADR-?\\d{1,5}");
  ids.decision = decParts.length ? decParts.join("|") : DEFAULTS.ids.decision;
  if (!itemBold) ids.item = DEFAULTS.ids.item;
  let heb = 0;
  let lat = 0;
  for (const s of sources.slice(0, 12)) {
    const files = s.path ? [s.path] : expand(top, s.glob).slice(0, 5);
    for (const f of files) { const t = readHead(path.join(top, f), 20_000); heb += count(t, /[א-ת]/g); lat += count(t, /[A-Za-z]/g); }
  }
  const language = heb > 0.35 * (heb + lat) ? "he" : "en";
  let mainBranch = "main";
  if (git) {
    const has = (b) => { try { git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], top); return true; } catch { return false; } };
    mainBranch = has("main") ? "main" : has("master") ? "master" : "main";
  }
  const gateDirs = [...new Set(docs.filter((g) => g !== "*.md").map((g) => g.split("/")[0]))];
  const big = [];
  for (const s of listSources(top, { sources })) {
    try { const kb = fs.statSync(path.join(top, s.rel)).size / 1024; if (kb > DEFAULTS.gate.maxKB) big.push(`${s.rel} ${kb.toFixed(0)}KB`); } catch { /* gone */ }
  }
  if (big.length) report.push(`over ${DEFAULTS.gate.maxKB}KB (the read gate will serve these by range): ${big.slice(0, 8).join(" · ")}${big.length > 8 ? " · …" : ""}`);
  report.push(`language: ${language} · main branch: ${mainBranch}${fs.existsSync(path.join(top, "graphify-out", "graph.json")) ? " · code graph: graphify-out/graph.json" : ""}`);

  const config = {
    version: 1,
    language,
    mainBranch,
    sources,
    ids,
    topics: { dir: topicsDir, branchPrefix: "agents/" },
    gate: { enabled: true, mode: "deny", maxKB: DEFAULTS.gate.maxKB, dirs: gateDirs },
    archive: { caps: topicsDir ? { [`${topicsDir}/*.md`]: 60 } : {} },
  };
  return { config, report };
}

module.exports = { DEFAULTS, CONFIG_DIR, CONFIG_FILE, CODE_EXT, SKIP_DIRS, merge, globToRe, staticPrefix, expand, listSources, compile, loadConfig, detect, posix };
