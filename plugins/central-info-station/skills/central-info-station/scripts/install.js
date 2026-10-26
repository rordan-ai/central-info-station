"use strict";
/**
 * CIS — **install / uninstall / doctor**: turns CIS on for one repository (an explicit, per-repo opt-in).
 *
 * install:
 *   1. `.cis/config.json` — detected (`init`) when missing; never overwritten.
 *   2. the runtime is vendored into `.cis/bin/` (plain Node, zero dependencies) — commit it: every clone, worktree, teammate
 *      and CI run gets the same version, and hooks never point at someone's home folder.
 *   3. Claude Code hooks are merged into `.claude/settings.json` (team) or `.claude/settings.local.json` (`--local`, just you),
 *      in the documented exec form — `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.cis/bin/…"]` — which works on
 *      Windows, macOS and Linux without a shell. Existing hooks are kept; ours are recognised by ".cis/bin/" and replaced.
 *        SessionStart (no matcher ⇒ startup · resume · clear · compact · fork) ⇒ the session card
 *        PreToolUse Read|Bash|PowerShell ⇒ the read gate · PreToolUse Edit|Write|MultiEdit|NotebookEdit ⇒ edit-time context
 *   4. git hooks post-commit / post-merge / post-checkout get one marked block that rebuilds the index in the background.
 *      With `core.hooksPath` set (husky, lefthook …) nothing is written — the line to add is printed instead.
 * uninstall: removes exactly what install added (hooks, git-hook blocks); `--purge` also removes `.cis/bin/`. The config stays.
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const C = require("./config");

const VERSION = "1.0.0";
const MARK = ".cis/bin/";
const GIT_HOOKS = ["post-commit", "post-merge", "post-checkout"];
const START = "# central-info-station-start";
const END = "# central-info-station-end";
const RUNTIME = ["cis.js", "lib.js", "config.js", "i18n.js", "card.js", "ctx.js", "build.js", "check.js", "archive.js", "topic.js", "install.js", "hooks/session-start.js", "hooks/read-gate.js", "hooks/edit-context.js"];

const hookCmd = (rel, timeout) => ({ type: "command", command: "node", args: [`\${CLAUDE_PROJECT_DIR}/${MARK}${rel}`], timeout });
const OUR_HOOKS = {
  SessionStart: [{ hooks: [hookCmd("hooks/session-start.js", 30)] }],
  PreToolUse: [
    { matcher: "Read|Bash|PowerShell", hooks: [hookCmd("hooks/read-gate.js", 10)] },
    { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [hookCmd("hooks/edit-context.js", 10)] },
  ],
};
const isOurs = (h) => JSON.stringify([h && h.command, h && h.args]).includes(MARK);

/** settings object ⇒ the same object without our hooks (other hooks untouched; empty groups/events dropped) */
function stripHooks(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  if (!s.hooks) return s;
  for (const ev of Object.keys(s.hooks)) {
    const groups = (s.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (groups.length) s.hooks[ev] = groups; else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}
function withHooks(settings, opts = {}) {
  const s = stripHooks(settings);
  s.hooks = s.hooks || {};
  for (const [ev, groups] of Object.entries(OUR_HOOKS)) {
    const want = groups.filter((g) => !(opts.noEdit && JSON.stringify(g).includes("edit-context")) && !(opts.noGate && JSON.stringify(g).includes("read-gate")));
    if (want.length) s.hooks[ev] = [...(s.hooks[ev] || []), ...JSON.parse(JSON.stringify(want))];
  }
  return s;
}

// ── git hooks ───────────────────────────────────────────────────────────────
function gitBlock(hook) {
  return [
    `${START} — rebuild the CIS index in the background (installed by: node .cis/bin/cis.js install)`,
    `( [ "\${3:-1}" = "1" ] && [ ! -d "\${GIT_DIR:-.git}/rebase-merge" ] && [ ! -d "\${GIT_DIR:-.git}/rebase-apply" ] && [ -f "$PWD/${MARK}build.js" ] && command -v node >/dev/null 2>&1 && node "$PWD/${MARK}build.js" --background --reason ${hook} >/dev/null 2>&1 ) || true`,
    END,
  ].join("\n");
}
function stripBlock(text) {
  const out = [];
  let inside = false;
  for (const ln of String(text || "").split("\n")) {
    if (!inside && ln.startsWith(START)) { inside = true; continue; }
    if (inside) { if (ln.startsWith(END)) inside = false; continue; }
    out.push(ln);
  }
  return out.join("\n");
}
/** our block right after the shebang — before any early `exit` another tool's hook may have */
function withBlock(text, hook) {
  const clean = stripBlock(text);
  if (!clean.trim()) return `#!/bin/sh\n${gitBlock(hook)}\n`;
  const lines = clean.split("\n");
  if (lines[0].startsWith("#!")) return [lines[0], gitBlock(hook), ...lines.slice(1)].join("\n");
  return ["#!/bin/sh", gitBlock(hook), ...lines].join("\n");
}
function gitHooksDir(top, git) {
  let custom = "";
  try { custom = git(["config", "--get", "core.hooksPath"], top).trim(); } catch { custom = ""; }
  if (custom) return { dir: path.resolve(top, custom), custom: true };
  const common = git(["rev-parse", "--git-common-dir"], top).trim();
  return { dir: path.join(path.resolve(top, common), "hooks"), custom: false };
}
function installGitHooks(top, git, opts = {}) {
  const { dir, custom } = opts.hooksDir ? { dir: opts.hooksDir, custom: false } : gitHooksDir(top, git);
  if (custom && !opts.uninstall) return { custom: true, dir, line: gitBlock("post-commit").split("\n")[1] };
  const res = [];
  for (const hook of GIT_HOOKS) {
    const file = path.join(dir, hook);
    let before = "";
    try { before = fs.readFileSync(file, "utf8"); } catch { /* new */ }
    let after = opts.uninstall ? stripBlock(before) : withBlock(before, hook);
    if (opts.uninstall && !before) after = "";
    const changed = after !== before;
    if (changed && !opts.dryRun) {
      if (opts.uninstall && !after.replace(/^#!.*\n?/, "").trim()) { try { fs.unlinkSync(file); } catch { /* none */ } }
      else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, after); try { fs.chmodSync(file, 0o755); } catch { /* windows */ } }
    }
    res.push({ hook, file, changed });
  }
  return { custom: false, dir, files: res };
}

// ── runtime & settings ──────────────────────────────────────────────────────
function vendor(top, opts = {}) {
  const from = __dirname;
  const to = path.join(top, C.CONFIG_DIR, "bin");
  if (path.resolve(from) === path.resolve(to)) return { to, copied: 0, self: true };
  let copied = 0;
  for (const rel of RUNTIME) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (!opts.dryRun) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    copied++;
  }
  if (!opts.dryRun) {
    fs.writeFileSync(path.join(to, "VERSION"), `${VERSION}\n`);
    fs.writeFileSync(path.join(to, "package.json"), '{ "type": "commonjs", "private": true }\n');
    const gi = path.join(top, C.CONFIG_DIR, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "local/\n");
  }
  return { to, copied };
}
function settingsFile(top, local) { return path.join(top, ".claude", local ? "settings.local.json" : "settings.json"); }
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const txt = fs.readFileSync(file, "utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt); // invalid JSON ⇒ throw: never overwrite a settings file we cannot read
}
function writeSettings(file, obj, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function install(opts = {}) {
  const git = opts.git || lib.realGit;
  const loc = lib.locate(opts.cwd || process.cwd(), git);
  const top = loc.top;
  const out = { top, steps: [] };
  const cfgFile = path.join(top, C.CONFIG_DIR, C.CONFIG_FILE);
  if (!fs.existsSync(cfgFile)) {
    const { config, report } = C.detect(top, { git });
    if (!opts.dryRun) { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, `${JSON.stringify(config, null, 2)}\n`); }
    out.steps.push(`config: created ${C.CONFIG_DIR}/${C.CONFIG_FILE} (detected — review it): ${report.join(" | ")}`);
  } else out.steps.push(`config: kept ${C.CONFIG_DIR}/${C.CONFIG_FILE}`);
  const v = vendor(top, opts);
  out.steps.push(v.self ? `runtime: already running from ${C.CONFIG_DIR}/bin` : `runtime: ${v.copied} files ⇒ ${C.CONFIG_DIR}/bin (commit it)`);
  if (!opts.noClaudeHooks) {
    const sf = settingsFile(top, opts.local);
    const next = withHooks(readJson(sf), opts);
    writeSettings(sf, next, opts.dryRun);
    out.steps.push(`claude hooks: ${path.relative(top, sf).replace(/\\/g, "/")} — SessionStart (card)${opts.noGate ? "" : " · PreToolUse Read|Bash|PowerShell (read gate)"}${opts.noEdit ? "" : " · PreToolUse Edit|Write (edit context)"}`);
    // the other settings file must not register us twice
    const other = settingsFile(top, !opts.local);
    if (fs.existsSync(other)) { const o = readJson(other); const s = stripHooks(o); if (JSON.stringify(s) !== JSON.stringify(o)) { writeSettings(other, s, opts.dryRun); out.steps.push(`claude hooks: removed a duplicate registration from ${path.relative(top, other).replace(/\\/g, "/")}`); } }
  }
  if (!opts.noGitHooks) {
    const g = installGitHooks(top, git, opts);
    out.steps.push(g.custom ? `git hooks: core.hooksPath is set (${g.dir}) — add this line to your post-commit / post-merge / post-checkout hooks:\n    ${g.line}` : `git hooks: ${g.files.filter((f) => f.changed).length ? "installed" : "already installed"} in ${g.dir}`);
  }
  if (!opts.dryRun && !opts.noBuild) {
    try { const r = require("./build").build({ cwd: top, reason: "install" }); out.steps.push(`index: ${r.status}${r.rows ? ` · ${r.rows} rows · ${r.ms}ms` : ""}${r.error ? ` — ${r.error}` : ""}`); } catch (e) { out.steps.push(`index: not built (${e.message})`); }
  }
  return out;
}

function uninstall(opts = {}) {
  const git = opts.git || lib.realGit;
  const loc = lib.locate(opts.cwd || process.cwd(), git);
  const out = { top: loc.top, steps: [] };
  for (const local of [false, true]) {
    const sf = settingsFile(loc.top, local);
    if (!fs.existsSync(sf)) continue;
    const before = readJson(sf);
    const after = stripHooks(before);
    if (JSON.stringify(before) !== JSON.stringify(after)) { writeSettings(sf, after, opts.dryRun); out.steps.push(`claude hooks: removed from ${path.relative(loc.top, sf).replace(/\\/g, "/")}`); }
  }
  const g = installGitHooks(loc.top, git, { ...opts, uninstall: true });
  out.steps.push(`git hooks: ${g.files ? g.files.filter((f) => f.changed).length : 0} cleaned in ${g.dir}`);
  if (opts.purge && !opts.dryRun) { fs.rmSync(path.join(loc.top, C.CONFIG_DIR, "bin"), { recursive: true, force: true }); out.steps.push(`runtime: removed ${C.CONFIG_DIR}/bin (config kept)`); }
  return out;
}

/** health check — every line ✅ / ⚠️ with what to do */
function doctor(opts = {}) {
  const git = opts.git || lib.realGit;
  const L = [];
  const ok = (b, msg, fix) => L.push(`${b ? "✅" : "⚠️"} ${msg}${!b && fix ? ` — ${fix}` : ""}`);
  const major = +process.versions.node.split(".")[0];
  ok(major >= 18, `node ${process.versions.node}`, "Node 18+ is required");
  let loc;
  try { loc = lib.locate(opts.cwd || process.cwd(), git); } catch { ok(false, "git repository", "run inside a git repository"); return L.join("\n"); }
  const conf = C.loadConfig(loc.top, { git });
  ok(conf.exists, `${C.CONFIG_DIR}/${C.CONFIG_FILE}`, "run: cis init --write (or cis install)");
  const sources = C.listSources(loc.top, conf.config);
  ok(sources.length > 0, `${sources.length} source files (${[...new Set(sources.map((s) => s.kind))].join(", ") || "none"})`, "add sources to the config");
  for (const s of conf.config.sources || []) if (s.path && !fs.existsSync(path.join(loc.top, s.path))) ok(false, `source missing: ${s.path}`, "fix or remove it in the config");
  const settingsHas = (local) => { try { return JSON.stringify(readJson(settingsFile(loc.top, local))).includes(MARK); } catch { return false; } };
  const reg = settingsHas(false) ? ".claude/settings.json" : settingsHas(true) ? ".claude/settings.local.json" : "";
  ok(!!reg, `Claude Code hooks${reg ? ` in ${reg}` : ""}`, "run: cis install");
  ok(fs.existsSync(path.join(loc.top, C.CONFIG_DIR, "bin", "hooks", "session-start.js")), `runtime in ${C.CONFIG_DIR}/bin`, "run: cis install (and commit .cis/)");
  try {
    const { dir, custom } = gitHooksDir(loc.top, git);
    const has = GIT_HOOKS.every((h) => { try { return fs.readFileSync(path.join(dir, h), "utf8").includes(START); } catch { return false; } });
    ok(has, `git hooks${custom ? ` (core.hooksPath ${dir})` : ""}`, custom ? "add CIS line to your hook manager" : "run: cis install");
  } catch { ok(false, "git hooks", "could not read the hooks folder"); }
  try {
    const t0 = Date.now();
    const r = lib.loadIndex({ git, cwd: loc.top });
    ok(r.index.rows.length > 0, `index: ${r.index.rows.length} rows · ${r.fromCache ? "cached" : "built"} in ${Date.now() - t0}ms`, "check the sources");
    const card = require("./card").buildCard({ git, cwd: loc.top });
    ok(Buffer.byteLength(card) <= ((conf.config.card && conf.config.card.maxBytes) || 4096), `card: ${Buffer.byteLength(card)} bytes`);
  } catch (e) { ok(false, `index: ${e.message}`); }
  try {
    const gate = require("./hooks/read-gate");
    const big = sources.map((s) => ({ abs: path.join(loc.top, s.rel), size: (() => { try { return fs.statSync(path.join(loc.top, s.rel)).size; } catch { return 0; } })() })).sort((a, b) => b.size - a.size)[0];
    if (big && gate.gatedFile(big.abs)) {
      const denied = !!gate.decide({ tool_name: "Read", tool_input: { file_path: big.abs }, cwd: loc.top });
      const range = !gate.decide({ tool_name: "Read", tool_input: { file_path: big.abs, offset: 1, limit: 40 }, cwd: loc.top });
      ok(denied && range, `read gate: a full read of ${path.relative(loc.top, big.abs).replace(/\\/g, "/")} is blocked, a 40-line range is allowed`);
    } else ok(true, `read gate: no source is over ${(conf.config.gate && conf.config.gate.maxKB) || 30}KB yet — nothing to block`);
  } catch (e) { ok(false, `read gate: ${e.message}`); }
  return L.join("\n");
}

/** for agents without hooks (Codex, Cursor, Gemini CLI, Claude.ai …): the rule as text, to paste into AGENTS.md / the rules file */
function snippet() {
  return [
    "## CIS — retrieve, don't read",
    "- Before reading project docs, run `node .cis/bin/cis.js card` (state, open work, resume point, red lines).",
    "- To find anything (a decision, a task id, a file, a topic): `node .cis/bin/cis.js ctx \"<query>\"` ⇒ exact file:lines; read only those lines.",
    "- Never read a document over 30KB in full — read the line range ctx points to.",
    "- When ctx missed and you found it another way: `node .cis/bin/cis.js miss \"<query>\" --expected \"<file:line | id>\"`.",
  ].join("\n");
}

module.exports = { VERSION, install, uninstall, doctor, snippet, withHooks, stripHooks, withBlock, stripBlock, installGitHooks, gitBlock, vendor, OUR_HOOKS, RUNTIME, START, END };
