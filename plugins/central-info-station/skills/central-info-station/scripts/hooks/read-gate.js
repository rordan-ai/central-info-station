#!/usr/bin/env node
"use strict";
/**
 * CIS — **the read gate** (PreToolUse on Read · Bash · PowerShell).
 *
 * Denies a **whole-file read** of a large document (over `gate.maxKB`, default 30KB) that CIS indexes (a configured source,
 * or a file under `gate.dirs`) — so the agent retrieves (`cis ctx`) and reads the line range it points to, instead of pouring
 * 50–300KB into its context.
 *   · Read without offset/limit, or with a range that covers the whole file
 *   · Bash: cat / more / less / nl / tac · head / tail covering everything · sed printing everything · git show <rev>:<file>
 *   · PowerShell: Get-Content / gc / cat / type without -TotalCount / -Head / -Tail (or covering everything)
 * Always allowed: line ranges · output piped onward (`|` filters) or redirected to a file · `sed -i` · code files · small files ·
 * anything outside a station repo. `cd` inside the command is followed.
 * `gate.mode: "warn"` ⇒ never blocks, adds a nudge instead. Any failure ⇒ allow (the gate must never break a tool).
 * Every block is one line in <repo>/.cis/local/read-gate.jsonl (to measure the effect).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stationRoot } = require("./session-start");

const READ_DEFAULT_LIMIT = 2000;
const DEFAULT = { maxKB: 30, dirs: [], ext: ["md", "markdown", "mdx", "txt", "rst", "adoc", "json", "jsonl", "csv", "log", "yml", "yaml", "html", "htm"], mode: "deny", enabled: true };
const configs = new Map();

/** CIS config of a repo root (cached per process) ⇒ {gate, language, matchers} */
function rootConfig(root) {
  if (configs.has(root)) return configs.get(root);
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(root, ".cis", "config.json"), "utf8")) || {}; } catch { c = {}; }
  const gate = { ...DEFAULT, ...(c.gate || {}) };
  const C = require("../config");
  const matchers = (c.sources || []).map((s) => (s.path ? (rel) => rel.toLowerCase() === C.posix(s.path).toLowerCase() : s.glob ? ((re) => (rel) => re.test(rel))(C.globToRe(s.glob)) : () => false));
  const v = { gate, language: c.language || "en", matchers, ext: new RegExp(`\\.(?:${gate.ext.join("|")})$`, "i") };
  configs.set(root, v);
  return v;
}

/** {abs, rel, root, bytes, lines, cfg} — or null when the file is not gated (small · code · not indexed · outside a station repo · missing) */
function gatedFile(abs) {
  if (!abs) return null;
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const root = stationRoot(path.dirname(abs));
  if (!root) return null;
  const cfg = rootConfig(root);
  if (cfg.gate.enabled === false || !cfg.ext.test(abs) || st.size <= cfg.gate.maxKB * 1024) return null;
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || rel.startsWith(".cis/")) return null;
  const inScope = cfg.matchers.some((m) => m(rel)) || (cfg.gate.dirs || []).some((d) => rel.startsWith(`${String(d).replace(/\/+$/, "")}/`));
  if (!inScope) return null;
  let lines = 0;
  try { const t = fs.readFileSync(abs, "utf8"); lines = (t.match(/\n/g) || []).length + (t.endsWith("\n") ? 0 : 1); } catch { return null; }
  return { abs, rel, root, bytes: st.size, lines, cfg };
}

/** does the range cover the whole file? range: {full} · {start,end} · {tail} · {bytes} · {tailBytes} */
function coversAll(range, g) {
  if (!range) return false;
  if (range.full) return true;
  if (range.bytes != null) return range.bytes >= g.bytes;
  if (range.tailBytes != null) return range.tailBytes >= g.bytes;
  if (range.tail != null) return range.tail >= g.lines;
  return range.start <= 1 && range.end >= g.lines;
}

// ── Read ─────────────────────────────────────────────────────────────────────
function decideRead(ti, cwd) {
  const fp = ti && ti.file_path;
  if (!fp) return null;
  const g = gatedFile(path.resolve(cwd || process.cwd(), String(fp)));
  if (!g) return null;
  const offset = Number(ti.offset) || 0;
  const limit = Number(ti.limit) || 0;
  const start = offset > 1 ? offset : 1;
  const end = start + (limit > 0 ? limit : READ_DEFAULT_LIMIT) - 1;
  // no offset and no limit = "everything", even when the tool would stop at 2000 lines
  if ((!offset && !limit) || coversAll({ start, end }, g)) return { g, tool: "Read" };
  return null;
}

// ── commands: tokenize (quotes · redirects · pipes · separators) ──────────────
/** tokens: {w} word · {op:";"} separator · {op:"|"} · {op:"redir", fd} (its target is the next word) · {op:"dup"} (2>&1) · {op:"in"} */
function tokenize(cmd, ps) {
  const s = String(cmd || "");
  const toks = [];
  let buf = "";
  let has = false;
  const push = () => { if (has) toks.push({ w: buf }); buf = ""; has = false; };
  const op = (v, extra) => { push(); toks.push({ op: v, ...extra }); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      buf += j < 0 ? s.slice(i + 1) : s.slice(i + 1, j);
      has = true;
      i = j < 0 ? s.length : j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (!ps && s[j] === "\\" && /["\\$`]/.test(s[j + 1] || "")) { buf += s[j + 1]; j += 2; continue; }
        if (ps && s[j] === "`" && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        buf += s[j++];
      }
      has = true;
      i = j;
      continue;
    }
    if ((!ps && c === "\\") || (ps && c === "`")) {
      if (n === "\n") { i++; continue; }
      if (n !== undefined) { buf += n; has = true; i++; continue; }
    }
    if (c === " " || c === "\t" || c === "\r") { push(); continue; }
    if (c === "\n" || c === ";") { op(";"); continue; }
    if ((c === "&" && n === "&") || (c === "|" && n === "|")) { op(";"); i++; continue; }
    if (c === "|") { op("|"); continue; }
    if (c === ">" || (c === "&" && n === ">" && !ps)) {
      let fd = "1";
      if (c === "&") { fd = "&"; i++; push(); }
      else if (has && /^\d$/.test(buf)) { fd = buf; buf = ""; has = false; }
      else push();
      if (s[i + 1] === ">") i++;
      if (s[i + 1] === "&") { let j = i + 2; while (j < s.length && /\d/.test(s[j])) j++; i = j - 1; toks.push({ op: "dup" }); continue; }
      toks.push({ op: "redir", fd });
      continue;
    }
    if (c === "<" && !ps) { op("in"); continue; }
    if (c === "&" && !ps) { op(";"); continue; }
    if ((c === "(" || c === ")" || c === "{" || c === "}") && !has) { op(";"); continue; }
    buf += c;
    has = true;
  }
  push();
  return toks;
}

/** pipelines: [[{argv, out, stdin}]] — out=true when stdout goes to a file (it never reaches the model's context) */
function pipelines(toks) {
  const all = [];
  let pipe = [];
  let cmd = { argv: [], out: false, stdin: null };
  const endCmd = () => { if (cmd.argv.length || cmd.stdin) pipe.push(cmd); cmd = { argv: [], out: false, stdin: null }; };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.w !== undefined) { cmd.argv.push(t.w); continue; }
    if (t.op === "redir") { if (toks[k + 1] && toks[k + 1].w !== undefined) k++; if (t.fd === "1" || t.fd === "&") cmd.out = true; continue; }
    if (t.op === "in") { if (toks[k + 1] && toks[k + 1].w !== undefined) cmd.stdin = toks[++k].w; continue; }
    if (t.op === "dup") continue;
    if (t.op === "|") { endCmd(); continue; }
    if (t.op === ";") { endCmd(); if (pipe.length) all.push(pipe); pipe = []; }
  }
  endCmd();
  if (pipe.length) all.push(pipe);
  return all;
}

function expandPath(w, cwd, ps) {
  let p = String(w || "");
  if (!p || /[*?]/.test(p)) return null;
  p = p.replace(/^~(?=$|[\\/])/, os.homedir());
  p = ps
    ? p.replace(/^\$env:(\w+)/i, (m, v) => process.env[v] || m).replace(/^\$(HOME)\b/i, os.homedir()).replace(/^\$(PWD)\b/i, cwd)
    : p.replace(/^\$\{?HOME\}?/, os.homedir()).replace(/^\$\{?PWD\}?/, cwd);
  if (p.includes("$")) return null;
  if (process.platform === "win32") { const m = p.match(/^\/([a-zA-Z])(\/.*)?$/); if (m) p = `${m[1].toUpperCase()}:${m[2] || "/"}`; }
  return path.resolve(cwd, p);
}

// ── what a command reads: [{file, range}] ───────────────────────────────────
const num = (v) => { const x = parseInt(String(v), 10); return Number.isFinite(x) ? x : null; };

function headRange(args) {
  let n = 10;
  let bytes = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    let m;
    if (a === "--") { files.push(...args.slice(i + 1)); break; }
    if (a === "-n" || a === "--lines") v = args[++i];
    else if ((m = a.match(/^-n(.+)$/) || a.match(/^--lines=(.+)$/))) v = m[1];
    else if (a === "-c" || a === "--bytes") { bytes = args[++i]; continue; }
    else if ((m = a.match(/^-c(.+)$/) || a.match(/^--bytes=(.+)$/))) { bytes = m[1]; continue; }
    else if ((m = a.match(/^-(\d+)$/))) v = m[1];
    else if (a.startsWith("-") && a !== "-") continue;
    else { files.push(a); continue; }
    n = String(v).startsWith("-") ? Infinity : num(v) ?? 10; // "-n -K" = all but the last K
  }
  if (bytes != null) return { files, range: String(bytes).startsWith("-") ? { full: true } : { bytes: num(bytes) ?? 0 } };
  return { files, range: { start: 1, end: n } };
}

function tailRange(args) {
  let range = { tail: 10 };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    let m;
    let isBytes = false;
    if (a === "--") { files.push(...args.slice(i + 1)); break; }
    if (a === "-n" || a === "--lines") v = args[++i];
    else if ((m = a.match(/^-n(.+)$/) || a.match(/^--lines=(.+)$/))) v = m[1];
    else if (a === "-c" || a === "--bytes") { v = args[++i]; isBytes = true; }
    else if ((m = a.match(/^-c(.+)$/) || a.match(/^--bytes=(.+)$/))) { v = m[1]; isBytes = true; }
    else if ((m = a.match(/^-(\d+)$/))) v = m[1];
    else if (a.startsWith("-") && a !== "-") continue;
    else { files.push(a); continue; }
    const s = String(v);
    if (s.startsWith("+")) range = isBytes ? (num(s.slice(1)) <= 1 ? { full: true } : { tailBytes: 0 }) : { start: num(s.slice(1)) ?? 1, end: Infinity };
    else range = isBytes ? { tailBytes: num(s) ?? 0 } : { tail: num(s) ?? 10 };
  }
  return { files, range };
}

/** sed: -i (edit) ⇒ not a read · -n with p ⇒ its ranges · without -n ⇒ everything (except "Nq") · -f ⇒ unknown (allowed) */
function sedRange(args, lines) {
  let quiet = false;
  const scripts = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m;
    if (/^-i|^--in-place/.test(a)) return null;
    if (a === "-f" || /^--file/.test(a)) return null;
    if (a === "-n" || a === "--quiet" || a === "--silent") { quiet = true; continue; }
    if (a === "-e" || a === "--expression") { scripts.push(args[++i] || ""); continue; }
    if ((m = a.match(/^--expression=(.*)$/) || a.match(/^-e(.+)$/))) { scripts.push(m[1]); continue; }
    if (/^-[nErsuz]+$/.test(a)) { if (a.includes("n")) quiet = true; continue; }
    if (a.startsWith("--")) continue;
    rest.push(a);
  }
  if (!scripts.length) { if (!rest.length) return null; scripts.push(rest.shift()); }
  const parts = scripts.join(";").split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  if (!quiet) {
    const q = parts.length === 1 && parts[0].match(/^(\d+)\s*q$/);
    return { files: rest, range: q ? { start: 1, end: +q[1] } : { full: true } };
  }
  const full = parts.some((p) => {
    if (/^p$/.test(p)) return true;
    const m = p.match(/^(\d+)\s*(?:,\s*(\d+|\$))?\s*p$/);
    if (!m) return false;
    const a = +m[1];
    const b = m[2] === "$" ? Infinity : m[2] ? +m[2] : a;
    return a <= 1 && b >= lines;
  });
  return { files: rest, range: full ? { full: true } : { start: 2, end: 2 } };
}

/** Get-Content: -Path/-LiteralPath or position 0 · -TotalCount/-Head/-First ⇒ the first N · -Tail/-Last ⇒ the last N */
function psGetContent(args) {
  const files = [];
  let range = { full: true };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let v;
    const colon = a.match(/^(-[\w]+):(.+)$/);
    if (colon) { a = colon[1]; v = colon[2]; }
    if (/^-/.test(a)) {
      const name = a.slice(1).toLowerCase();
      const val = () => (v !== undefined ? v : args[++i]);
      if (/^(path|literalpath|lp|pspath|p)$/.test(name)) files.push(...String(val() || "").split(","));
      else if (/^(totalcount|tot\w*|head|first|h)$/.test(name)) range = { start: 1, end: num(val()) ?? 0 };
      else if (/^(tail|last|ta\w*)$/.test(name)) range = { tail: num(val()) ?? 0 };
      else if (/^(encoding|delimiter|readcount|stream|filter|include|exclude|credential)$/.test(name)) val();
      continue;
    }
    files.push(a);
  }
  return { files: files.filter(Boolean), range };
}

const BASH_CAT = new Set(["cat", "more", "less", "nl", "tac", "bat"]);
const PS_GC = new Set(["get-content", "gc", "cat", "type"]);
const CD = /^(cd|pushd|chdir|set-location|sl|push-location)$/i;
const QUICK = /\.(md|markdown|mdx|txt|rst|adoc|json|jsonl|csv|log|ya?ml|html?)\b|show\s|cat-file/i;

/** git show <rev>:<file> / git cat-file -p <rev>:<file> — sized by the working-tree copy (close enough) */
function gitShowFiles(argv, cwd, ps) {
  let i = 1;
  let gcwd = cwd;
  while (i < argv.length && argv[i].startsWith("-")) {
    if (argv[i] === "-C") { gcwd = expandPath(argv[i + 1], cwd, ps) || cwd; i += 2; continue; }
    if (argv[i] === "-c") { i += 2; continue; }
    i++;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (!(sub === "show" || (sub === "cat-file" && rest.includes("-p")))) return [];
  const root = stationRoot(gcwd);
  const out = [];
  for (const a of rest) {
    const m = a.match(/^([^-:][^:]*):(.+)$/);
    if (!m || (/^[a-zA-Z]$/.test(m[1]) && /^[\\/]/.test(m[2]))) continue; // C:/… is a path, not rev:path
    const p = m[2];
    out.push({ abs: /^\.\.?[\\/]/.test(p) || !root ? path.resolve(gcwd, p) : path.resolve(root, p), range: { full: true } });
  }
  return out;
}

/** a Bash / PowerShell command ⇒ the first whole-file read that is gated, or null */
function decideCommand(command, cwd, ps, tool) {
  const text = String(command || "");
  let here = cwd || process.cwd();
  if (!QUICK.test(text)) return null; // fast path: nothing that could be a document read
  for (const pipe of pipelines(tokenize(text, ps))) {
    const last = pipe[pipe.length - 1];
    const argv = last.argv.slice();
    while (argv.length && (/^\w+=/.test(argv[0]) || /^(command|builtin|time|env|exec|&|\.)$/i.test(argv[0]))) argv.shift();
    const head = (argv[0] || "").toLowerCase();
    if (pipe.length === 1 && CD.test(head)) {
      const target = argv.slice(1).find((x) => !x.startsWith("-"));
      const d = target ? expandPath(target, here, ps) : os.homedir();
      if (d) here = d;
      continue;
    }
    if (last.out) continue; // redirected to a file — never reaches the context
    let reads = [];
    if (head === "git") reads = gitShowFiles(argv, here, ps);
    else {
      let r = null;
      if (ps && PS_GC.has(head)) r = psGetContent(argv.slice(1));
      else if (ps && head === "more") r = { files: argv.slice(1), range: { full: true } };
      else if (!ps && BASH_CAT.has(head)) r = { files: argv.slice(1).filter((x) => !x.startsWith("-") || x === "-"), range: { full: true } };
      else if (head === "head") r = headRange(argv.slice(1));
      else if (head === "tail") r = tailRange(argv.slice(1));
      else if (head === "sed") r = { lazy: true, files: argv.slice(1).filter((x) => !x.startsWith("-")) };
      if (!r) continue;
      let files = r.files.filter((x) => x !== "-");
      if (!files.length && last.stdin) files = [last.stdin];
      for (const f of files) {
        const abs = expandPath(f, here, ps);
        if (!abs) continue;
        if (r.lazy) {
          const g = gatedFile(abs);
          if (!g) continue;
          const s = sedRange(argv.slice(1), g.lines);
          if (s && s.files.some((x) => expandPath(x, here, ps) === abs) && coversAll(s.range, g)) return { g, tool };
          continue;
        }
        reads.push({ abs, range: r.range });
      }
    }
    for (const rd of reads) { const g = gatedFile(rd.abs); if (g && coversAll(rd.range, g)) return { g, tool }; }
  }
  return null;
}

// ── message + log ────────────────────────────────────────────────────────────
function reason(hit) {
  const { g, tool } = hit;
  const t = require("../i18n").t(g.cfg.language);
  const how = tool === "Read" ? t.gateHowRead : tool === "PowerShell" ? t.gateHowPs : t.gateHowBash;
  return t.gate(g.rel, Math.round(g.bytes / 1024), g.lines, how);
}
function logHit(hit, input) {
  try {
    const file = process.env.CIS_GATE_LOG || path.join(hit.g.root, ".cis", "local", "read-gate.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), tool: hit.tool, file: hit.g.rel, kb: Math.round(hit.g.bytes / 1024), lines: hit.g.lines, mode: hit.g.cfg.gate.mode, session: String(input.session_id || "").slice(0, 8) })}\n`);
  } catch { /* measurement only */ }
}

/** hook input ⇒ {g, tool, reason, mode} or null */
function decide(input) {
  const tool = input && input.tool_name;
  const ti = (input && input.tool_input) || {};
  const cwd = (input && input.cwd) || process.cwd();
  let hit = null;
  if (tool === "Read") hit = decideRead(ti, cwd);
  else if (tool === "Bash" || tool === "PowerShell") hit = decideCommand(ti.command, cwd, tool === "PowerShell", tool);
  return hit ? { ...hit, reason: reason(hit), mode: hit.g.cfg.gate.mode === "warn" ? "warn" : "deny" } : null;
}

function main() {
  if (process.env.CIS_DISABLE === "1") return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  let r = null;
  try { r = decide(input); } catch { r = null; }
  if (!r) return;
  logHit(r, input);
  if (r.mode === "warn") {
    const t = require("../i18n").t(r.g.cfg.language);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: t.gateWarn(r.g.rel, Math.round(r.g.bytes / 1024)) } }));
    return;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.reason } }));
}

if (require.main === module) {
  try { main(); } catch { /* never breaks a tool */ }
  process.exit(0);
}

module.exports = { decide, decideRead, decideCommand, gatedFile, coversAll, tokenize, pipelines, headRange, tailRange, sedRange, psGetContent, expandPath, rootConfig };
