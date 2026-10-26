"use strict";
// CIS — tests. Run: node --test tests/   (Node 18+, git on PATH; no network, no dependencies)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cis-test-"));
process.env.CIS_CACHE_DIR = path.join(TMP, "cache");
process.env.CIS_MEMORY_DIR = path.join(TMP, "no-memory");
process.env.CIS_NO_BG = "1";

const S = path.join(__dirname, "..", "plugins", "central-info-station", "skills", "central-info-station", "scripts");
const lib = require(path.join(S, "lib"));
const C = require(path.join(S, "config"));
const { makeFixture } = require("./fixture");
const NOW = new Date("2026-10-25T12:00:00Z");
const cx = (cfg = C.merge(C.DEFAULTS, {})) => ({ cfg, re: C.compile(cfg), now: NOW, itemIds: new Set(), isDoc: (f) => /\.md$/.test(f) });
let n = 0;
const fixture = (opts) => makeFixture(path.join(TMP, `repo-${++n}`), opts);
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...(opts.env || {}) }, cwd: opts.cwd, input: opts.input });

// ── text ───────────────────────────────────────────────────────────────────
test("tokens: English stems, Hebrew prefixes / finals / plurals, stop words", () => {
  const t = lib.tokens("The invoices והחלונות קודמים");
  assert.ok(t.includes("invoices") && t.includes("invoic"));
  assert.ok(t.includes("החלונות") && t.includes("חלונות") && t.includes("חלונ"));
  assert.ok(!t.includes("the"));
});
test("parseDate: ISO · dd/mm/yyyy · dd/mm/yy · dd/mm (year inferred) · nonsense", () => {
  assert.equal(lib.parseDate("on 2026-03-05", NOW), "2026-03-05");
  assert.equal(lib.parseDate("5/3/2026", NOW), "2026-03-05");
  assert.equal(lib.parseDate("5/3/26", NOW), "2026-03-05");
  assert.equal(lib.parseDate("20/10", NOW), "2026-10-20");
  assert.equal(lib.parseDate("31/12", NOW), "2025-12-31", "more than 60 days ahead ⇒ last year");
  assert.equal(lib.parseDate("40/2", NOW), "");
});

// ── parsers ────────────────────────────────────────────────────────────────
test("decisions: table rows · struck = cancelled · 'supersedes' (EN) and 'מחליפה את' (HE) · heading entries with Status", () => {
  const md = [
    "| D1 | Use X | why | 2026-01-01 |",
    "| D2 | Cache 1h | speed | 2026-02-01 |",
    "| ~~D3~~ | ~~GraphQL~~ | dropped | 2026-02-02 |",
    "| D4 | No cache; supersedes D2 | stale | 2026-03-01 |",
    "| D5 | שכבה חדשה — מחליפה את D1 | סיבה | 2026-03-02 |",
    "",
    "## D6 — Keep REST",
    "Status: Deprecated",
    "",
    "## D7: Event log",
    "body",
  ].join("\n");
  const rows = lib.parseDecisions(md, "docs/DECISIONS.md", cx());
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by), ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
  assert.equal(by.D2.supersededBy, "D4");
  assert.equal(by.D1.supersededBy, "D5");
  assert.equal(by.D3.status, "cancelled");
  assert.equal(by.D6.status, "cancelled");
  assert.equal(by.D7.status, "active");
  assert.equal(by.D7.title, "Event log");
});
test("ADR: id from the file name · title from H1 · Status section · superseded by", () => {
  const cfg = C.merge(C.DEFAULTS, { ids: { decision: "D\\d{1,4}|ADR-?\\d{1,5}" } });
  const [a] = lib.parseAdr("# 7. Use Kafka\n\nDate: 2026-02-01\n\n## Status\n\nSuperseded by ADR-0009\n", "docs/adr/0007-use-kafka.md", cx(cfg));
  assert.equal(a.id, "ADR-0007");
  assert.equal(a.title, "Use Kafka");
  assert.equal(a.status, "superseded");
  assert.equal(a.date, "2026-02-01");
});
test("plan: ids bold or plain · five markers · continuation lines · items without an id · changelog table", () => {
  const md = ["- [ ] **2.1** Export", "  more about export", "- [x] 2.2 Done thing", "- [~] **2.3** Doing", "- [!] **2.4** Blocked", "- [-] **2.5** Dropped", "- [ ] no id here", "| 2026-03-05 | `abc1234` | feat | thing |"].join("\n");
  const { items, logs } = lib.parsePlan(md, "PLAN.md", cx());
  assert.deepEqual(items.map((r) => [r.id, r.status]), [["2.1", "open"], ["2.2", "done"], ["2.3", "in_progress"], ["2.4", "blocked"], ["2.5", "dropped"], ["PLAN.md#L7", "open"]]);
  assert.equal(items[0].end, 2);
  assert.equal(logs[0].id, "abc1234");
});
test("sections: H1 is never a resume point; resume / handoff headings (EN + HE) are", () => {
  const md = "# Handoff log\n## Resume point 2026-04-10\nx\n## נקודת המשך 20/10\ny\n## Notes\nz\n";
  const rows = lib.parseSections(md, "docs/H.md", "docs", cx());
  assert.deepEqual(rows.map((r) => r.type), ["section", "handoff", "handoff", "section"]);
});

// ── config & detection ─────────────────────────────────────────────────────
test("config: globs (* ** ?) · detect finds rules, ADRs, decisions, plan, topics, docs, the big file", () => {
  assert.ok(C.globToRe("docs/**/*.md").test("docs/a/b/c.md"));
  assert.ok(C.globToRe("docs/**/*.md").test("docs/c.md"));
  assert.ok(!C.globToRe("docs/*.md").test("docs/a/c.md"));
  const dir = fixture();
  const { config, report } = C.detect(dir, { git: lib.realGit });
  const kinds = config.sources.map((s) => `${s.kind}:${s.path || s.glob}`);
  for (const k of ["rules:CLAUDE.md", "adr:docs/adr/*.md", "decisions:docs/DECISIONS.md", "plan:docs/PLAN.md", "docs:docs/**/*.md"]) assert.ok(kinds.includes(k), k);
  assert.equal(config.topics.dir, "docs/sessions");
  assert.match(config.ids.decision, /ADR/);
  assert.ok(report.some((r) => /HANDOFF\.md/.test(r)), "the file over 30KB is reported");
});

// ── the index & ctx ────────────────────────────────────────────────────────
test("index + query: exact id ⇒ the superseding decision right after · text · a file ⇒ explicit mentions first · ≤3KB", () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, ".cis"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".cis", "config.json"), JSON.stringify(C.detect(dir, { git: lib.realGit }).config));
  const { index, env } = lib.loadIndex({ cwd: dir });
  const q = (s) => lib.query(index, s, { re: env.re }).hits.map((h) => h.row.id);
  assert.deepEqual(q("D2").slice(0, 2), ["D2", "D5"]);
  assert.equal(q("invoice cache")[0], "D5", "the live decision outranks the superseded one");
  assert.equal(q("ADR-0002")[0], "ADR-0002");
  assert.equal(q("2.3")[0], "2.3");
  assert.equal(q("src/billing.ts")[0], "D3");
  assert.match(q("quasar")[0], /HANDOFF\.md#L9/);
  const out = lib.formatQuery(index, "src/billing.ts", lib.query(index, "src/billing.ts", { re: env.re }));
  assert.ok(Buffer.byteLength(out) <= 3000);
  const again = lib.loadIndex({ cwd: dir });
  assert.equal(again.fromCache, true, "second load is from the cache");
  fs.appendFileSync(path.join(dir, "docs", "PLAN.md"), "- [ ] **3.1** New task\n");
  assert.equal(lib.loadIndex({ cwd: dir }).fromCache, false, "a changed source rebuilds");
});

// ── card ───────────────────────────────────────────────────────────────────
test("card: ≤4KB · red lines · plan · the open resume point (the closed one is skipped) · Hebrew when configured", () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, ".cis"), { recursive: true });
  const config = C.detect(dir, { git: lib.realGit }).config;
  fs.writeFileSync(path.join(dir, ".cis", "config.json"), JSON.stringify(config));
  const card = require(path.join(S, "card")).buildCard({ cwd: dir });
  assert.ok(Buffer.byteLength(card) <= 4096);
  assert.match(card, /Resume point \(project\): Resume point 2026-04-10/);
  assert.match(card, /🔴 Never edit migrations/);
  assert.match(card, /plan: 3 open · ⛔ blocked: 2\.3/);
  fs.writeFileSync(path.join(dir, ".cis", "config.json"), JSON.stringify({ ...config, language: "he" }));
  assert.match(require(path.join(S, "card")).buildCard({ cwd: dir }), /כרטיס פתיחה[\s\S]*נקודת המשך \(כללית\)/);
});
test("card: a resume point closed by a later 'ready to merge' with the same branch is skipped; by done plan items too", () => {
  const { openHandoff, closedBy } = require(path.join(S, "card"));
  const lines = ["# x", "## Resume point 13/10 — `wip/a-daily` (14.53) · WIP, not ready", "w", "## Resume point 12/10 — 14.40 · `wip/a-old`", "o", "## Ready to merge: `wip/a-daily` 14/10", "p", "## Resume point 11/10 — `wip/a-open`", "q"];
  const cfg = C.merge(C.DEFAULTS, {});
  const rows = lib.parseSections(lines.join("\n"), "x.md", "docs", cx(cfg)).filter((r) => r.type === "handoff");
  const c = { re: C.compile(cfg), lang: "en", itemIds: new Set(["14.53", "14.40"]), itemStatus: new Map([["14.53", "open"], ["14.40", "done"]]), fileLines: () => lines };
  assert.match(closedBy(rows[0], c), /"ready" at L6/);
  assert.match(closedBy(rows[1], c), /14\.40 done/);
  assert.equal(closedBy(rows[2], c), "");
  assert.equal(openHandoff(rows, c).open.start, 8);
});

// ── topics ─────────────────────────────────────────────────────────────────
test("topic: no topics dir ⇒ none · prefix · declared branch (not a body mention) · declared worktree · ambiguous", () => {
  const { topicFor } = require(path.join(S, "topic"));
  const dir = path.join(TMP, "topics");
  const s = path.join(dir, "docs", "sessions");
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(path.join(s, "a.md"), "# a — branch `agents/a`\n\n## Files\n- conflicts with claude/cloud-1 on api.ts\n");
  fs.writeFileSync(path.join(s, "cloud.md"), "# cloud — branch `claude/cloud-1`\n");
  fs.writeFileSync(path.join(s, "dep.md"), `# dep\n\n> branch: \`agents/dep\` · worktree: \`${dir.replace(/\\/g, "/")}\`\n`);
  const cfg = { topics: { dir: "docs/sessions", branchPrefix: "agents/" }, mainBranch: "main" };
  assert.equal(topicFor(dir, "agents/a", { topics: {} }), null);
  assert.equal(topicFor(dir, "main", cfg).status, "integrator");
  assert.equal(topicFor(dir, "agents/a", cfg).status, "ok");
  assert.equal(topicFor(dir, "agents/zz", cfg).status, "missing-doc");
  assert.deepEqual(topicFor(dir, "claude/cloud-1", cfg), { name: "cloud", file: "docs/sessions/cloud.md", status: "declared", via: "branch" });
  assert.equal(topicFor(dir, "wip/x", cfg).name, "dep");
  fs.writeFileSync(path.join(s, "cloud2.md"), "# cloud2 — branch `claude/cloud-1`\n");
  assert.equal(topicFor(dir, "claude/cloud-1", cfg).status, "ambiguous");
});

// ── the read gate ──────────────────────────────────────────────────────────
function gateRepo() {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, ".cis"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".cis", "config.json"), JSON.stringify(C.detect(dir, { git: lib.realGit }).config));
  return dir;
}
const gate = require(path.join(S, "hooks", "read-gate"));
test("read gate — Read: 🔴 a full read is DENIED, a line range is ALLOWED · a range covering everything is denied · code / small allowed", () => {
  const dir = gateRepo();
  const H = path.join(dir, "docs", "HANDOFF.md");
  const R = (extra) => gate.decide({ tool_name: "Read", tool_input: { file_path: H, ...extra }, cwd: dir });
  const full = R({});
  assert.ok(full, "full read ⇒ denied");
  assert.match(full.reason, /docs\/HANDOFF\.md is large — \d+KB · \d+ lines/);
  assert.match(full.reason, /\.cis\/bin\/cis\.js ctx/);
  assert.equal(R({ offset: 3, limit: 20 }), null, "range ⇒ allowed");
  assert.ok(R({ offset: 1, limit: 99999 }), "a range covering the whole file ⇒ denied");
  assert.equal(gate.decide({ tool_name: "Read", tool_input: { file_path: path.join(dir, "src", "billing.ts") }, cwd: dir }), null);
  assert.equal(gate.decide({ tool_name: "Read", tool_input: { file_path: path.join(dir, "docs", "PLAN.md") }, cwd: dir }), null);
});
test("read gate — Bash & PowerShell: whole-file readers denied; ranges, pipes, redirects, sed -i allowed; cd followed", () => {
  const dir = gateRepo();
  const B = (command) => !!gate.decide({ tool_name: "Bash", tool_input: { command }, cwd: dir });
  const P = (command) => !!gate.decide({ tool_name: "PowerShell", tool_input: { command }, cwd: dir });
  const G = ["gi", "t"].join("");
  for (const c of ["cat docs/HANDOFF.md", 'echo a; cat "docs/HANDOFF.md" 2>/dev/null', "cat < docs/HANDOFF.md", "head -n 99999 docs/HANDOFF.md", "tail -n +1 docs/HANDOFF.md", "sed -n '1,$p' docs/HANDOFF.md", "sed 's/a/b/' docs/HANDOFF.md", "cd docs && cat HANDOFF.md", `${G} show HEAD:docs/HANDOFF.md`]) assert.ok(B(c), `denied: ${c}`);
  for (const c of ["cat docs/HANDOFF.md | grep quasar", "cat docs/HANDOFF.md > out.md", "head -n 40 docs/HANDOFF.md", "tail -20 docs/HANDOFF.md", "sed -n '10,60p' docs/HANDOFF.md", "sed -i 's/a/b/' docs/HANDOFF.md", "cat src/billing.ts", "grep -n quasar docs/HANDOFF.md", `${G} show HEAD:docs/HANDOFF.md | head`]) assert.ok(!B(c), `allowed: ${c}`);
  for (const c of ["Get-Content docs/HANDOFF.md", "gc docs/HANDOFF.md", "type docs/HANDOFF.md"]) assert.ok(P(c), `denied: ${c}`);
  for (const c of ["Get-Content docs/HANDOFF.md -TotalCount 40", "Get-Content docs/HANDOFF.md -Tail 30", "gc docs/HANDOFF.md | Select-String quasar"]) assert.ok(!P(c), `allowed: ${c}`);
});
test("read gate — as a process: deny JSON + a log line · allowed ⇒ no output · bad input ⇒ exit 0 · warn mode ⇒ additionalContext only", () => {
  const dir = gateRepo();
  const H = path.join(dir, "docs", "HANDOFF.md");
  const run = (input) => node([path.join(S, "hooks", "read-gate.js")], { input });
  let r = run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: H }, cwd: dir, session_id: "abc" }));
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.deepEqual([o.hookEventName, o.permissionDecision], ["PreToolUse", "deny"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".cis", "local", "read-gate.jsonl"), "utf8").trim()).file, "docs/HANDOFF.md");
  r = run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: H, offset: 5, limit: 10 }, cwd: dir }));
  assert.equal(r.stdout, "");
  assert.equal(run("{bad").status, 0);
  const cf = path.join(dir, ".cis", "config.json");
  fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(fs.readFileSync(cf, "utf8")), gate: { mode: "warn", maxKB: 30, dirs: ["docs"] } }));
  const w = JSON.parse(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: H }, cwd: dir })).stdout).hookSpecificOutput;
  assert.equal(w.permissionDecision, undefined);
  assert.match(w.additionalContext, /HANDOFF\.md is \d+KB/);
});
test("read gate — outside a CIS repo nothing is gated", () => {
  const dir = fixture();
  assert.equal(gate.decide({ tool_name: "Read", tool_input: { file_path: path.join(dir, "docs", "HANDOFF.md") }, cwd: dir }), null);
});

// ── edit context ───────────────────────────────────────────────────────────
test("edit context: decision + rule for a named file · a rule naming a folder covers files in it · nothing for unrelated files", () => {
  const dir = gateRepo();
  lib.loadIndex({ cwd: dir, force: true });
  const run = (rel) => {
    const r = node([path.join(S, "hooks", "edit-context.js")], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(dir, rel) }, cwd: dir }) });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
  };
  assert.match(run("src/billing.ts"), /decision D3 ·[\s\S]*rule Money is integer cents/);
  assert.match(run("db/migrations/001_init.sql"), /Never edit migrations/);
  assert.equal(run("README.md"), "");
});

// ── install / uninstall ────────────────────────────────────────────────────
test("install: config + runtime + hooks merged next to foreign hooks (idempotent) + git hooks; uninstall restores; doctor all ✅", () => {
  const dir = fixture();
  const sf = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  const foreign = { permissions: { deny: ["Read(./secret.txt)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["guard.js"] }] }] } };
  fs.writeFileSync(sf, JSON.stringify(foreign));
  const ins = require(path.join(S, "install"));
  ins.install({ cwd: dir, noBuild: true });
  ins.install({ cwd: dir, noBuild: true });
  const s = JSON.parse(fs.readFileSync(sf, "utf8"));
  assert.deepEqual(s.permissions, foreign.permissions);
  assert.equal(s.hooks.SessionStart.length, 1, "idempotent");
  assert.equal(s.hooks.PreToolUse.length, 3, "foreign + gate + edit");
  assert.deepEqual(s.hooks.SessionStart[0].hooks[0], { type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.cis/bin/hooks/session-start.js"], timeout: 30 });
  assert.ok(fs.existsSync(path.join(dir, ".cis", "bin", "hooks", "read-gate.js")));
  assert.ok(fs.existsSync(path.join(dir, ".cis", "config.json")));
  const hook = fs.readFileSync(path.join(dir, ".git", "hooks", "post-commit"), "utf8");
  assert.match(hook, /^#!\/bin\/sh\n# central-info-station-start/);
  const doc = ins.doctor({ cwd: dir });
  assert.doesNotMatch(doc, /⚠️/, doc);
  ins.uninstall({ cwd: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, "utf8")), foreign, "uninstall leaves exactly the foreign settings");
  assert.ok(!fs.existsSync(path.join(dir, ".git", "hooks", "post-commit")), "a hook file that was only ours is removed");
});
test("install: git hook block goes right after an existing shebang, keeps the rest; core.hooksPath set ⇒ nothing written", () => {
  const ins = require(path.join(S, "install"));
  const out = ins.withBlock("#!/bin/sh\necho other\nexit 0\n", "post-merge");
  assert.match(out, /^#!\/bin\/sh\n# central-info-station-start[\s\S]*# central-info-station-end\necho other\nexit 0/);
  assert.equal(ins.stripBlock(out), "#!/bin/sh\necho other\nexit 0\n");
  const dir = fixture();
  execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: dir });
  const r = ins.installGitHooks(dir, lib.realGit, {});
  assert.equal(r.custom, true);
  assert.ok(!fs.existsSync(path.join(dir, ".husky", "post-commit")));
});

// ── archive ────────────────────────────────────────────────────────────────
test("archive: dated old units move word for word by month; the latest resume point, protected and undated ones stay; unmerged SHA stays", () => {
  const A = require(path.join(S, "archive"));
  const cfg = C.merge(C.DEFAULTS, {});
  const re = C.compile(cfg);
  const text = ["# Log", "", "## Resume point 2026-03-01 — old", "a", "", "## Resume point 2026-04-01 — newest", "b", "", "## What's left", "- x", "", "## Notes 2026-02-01", "c `deadbee`", "", "## Undated", "d", ""].join("\n");
  const p = A.plan(text, { now: NOW, days: 14, sha: (s) => (s === "deadbee" ? "branch" : "unknown"), re, protectedRe: re.protectedRe, lang: "en" });
  const act = Object.fromEntries(p.filter((u) => u.kind !== "head").map((u) => [u.level2, `${u.action}:${u.reason}`]));
  assert.equal(act["Resume point 2026-03-01 — old"], "archive:");
  assert.equal(act["Resume point 2026-04-01 — newest"], "keep:latest resume point");
  assert.equal(act["What's left"], "keep:protected");
  assert.match(act["Notes 2026-02-01"], /keep:commit not on main/);
  assert.equal(act.Undated, "keep:undated");
  const res = A.compute("docs/LOG.md", text, p, NOW, "en");
  assert.ok(res.archives["docs/archive/LOG-2026-03.md"].body.includes("## Resume point 2026-03-01 — old\na"));
  assert.match(res.source, /## 🗄️ Archived\n[\s\S]*2026-03: 1 sections/);
  assert.ok(!res.source.includes("— old\na"));
});

// ── session start ──────────────────────────────────────────────────────────
test("session-start hook: the card of the tree in the input's cwd (not the script's folder); silent outside a CIS repo", () => {
  const dir = gateRepo();
  const run = (cwd) => node([path.join(S, "hooks", "session-start.js")], { cwd: TMP, input: JSON.stringify({ cwd, source: "compact", hook_event_name: "SessionStart" }) });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^🧭 Session card · topic: integrator · branch main @ [0-9a-f]{8}/);
  assert.ok(Buffer.byteLength(r.stdout) < 10000, "under the documented 10,000-char limit");
  const plain = run(fixture());
  assert.equal(plain.stdout, "");
});

// ── build lock ─────────────────────────────────────────────────────────────
test("build: a second concurrent build skips (lock); a stale lock is taken over", () => {
  const b = require(path.join(S, "build"));
  const lock = path.join(TMP, "x.lock");
  const release = b.acquireLock(lock);
  assert.ok(release);
  assert.equal(b.acquireLock(lock), null);
  release();
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 10 * 60_000 }));
  assert.ok(b.acquireLock(lock));
});

test("cleanup", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows may hold files */ } });
