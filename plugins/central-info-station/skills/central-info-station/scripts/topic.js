"use strict";
/**
 * CIS — **which topic is this session working on** (for teams of parallel agents, one git worktree each).
 *
 * Optional: only when `topics.dir` is set (e.g. docs/sessions — one markdown file per topic/agent).
 * Decided by **explicit declarations, never by guessing** (a guess once matched a branch name mentioned in another topic's body):
 *   1. the main branch ⇒ "integrator" (whoever merges)
 *   2. `<branchPrefix><x>` (default agents/<x>) ⇒ topic x (status "missing-doc" when the file is absent)
 *   3. a **branch declaration** in a topic file's header: "# <x> — branch `<branch>`" · "> branch: `<branch>`" (Hebrew: ענף)
 *   4. a **worktree declaration** in the header: "worktree: `<folder>`" — keeps short-lived branches (wip/…) with their topic
 *   5. otherwise ⇒ null
 * "Header" = everything before the first `## `, plus "- branch: `…` · worktree: `…`" lines anywhere (a re-opened topic appends one).
 * Several files declaring the same branch/folder ⇒ "ambiguous" with the candidates (never picks one).
 */
const fs = require("fs");
const path = require("path");

const NON_TOPIC = new Set(["README.md", "_TEMPLATE.md", "TEMPLATE.md", "BOARD.md", "INDEX.md"]);
const BRANCH_DECL = /(?:ענף|branch)\s*:?\s*`([^`\s<>]+)`/gi;
const WORKTREE_DECL = /worktree\s*:?\s*`([^`<>]+)`/gi;
const SESSION_LINE = /^- (?:ענף|branch): `([^`\s<>]+)` · worktree: `([^`<>]+)`/gim;
const HEADER_MAX_LINES = 30;

function header(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length && i < HEADER_MAX_LINES; i++) {
    if (i > 0 && /^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}
const all = (re, s) => [...String(s).matchAll(re)].map((m) => m[1].trim());
function normDir(p) {
  const s = path.resolve(String(p || "")).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function declarations(top, dir) {
  let files = [];
  try { files = fs.readdirSync(path.join(top, dir)).filter((f) => f.endsWith(".md") && !NON_TOPIC.has(f)).sort(); } catch { return []; }
  return files.map((f) => {
    let text = "";
    try { text = fs.readFileSync(path.join(top, dir, f), "utf8"); } catch { /* unreadable */ }
    const h = header(text);
    const extra = [...text.matchAll(SESSION_LINE)];
    return {
      name: f.replace(/\.md$/, ""), file: `${dir}/${f}`,
      branches: [...all(BRANCH_DECL, h), ...extra.map((m) => m[1])],
      worktrees: [...all(WORKTREE_DECL, h), ...extra.map((m) => m[2].trim())],
    };
  });
}
function pick(list, via) {
  if (list.length === 1) return { name: list[0].name, file: list[0].file, status: "declared", via };
  if (list.length > 1) return { name: null, file: null, status: "ambiguous", via, candidates: list.map((d) => d.name) };
  return null;
}

/** {name, file, status: integrator|ok|missing-doc|declared|ambiguous, via[, candidates]} or null */
function topicFor(top, branch, cfg = {}) {
  const t = cfg.topics || {};
  const b = String(branch || "");
  if (!t.dir) return null; // no topics configured ⇒ a single-agent repo: no topic concept at all
  const mainBranch = cfg.mainBranch && cfg.mainBranch !== "auto" ? cfg.mainBranch : "main";
  if (b === mainBranch || ((!cfg.mainBranch || cfg.mainBranch === "auto") && (b === "main" || b === "master"))) return { name: "integrator", file: null, status: "integrator", via: "main" };
  const prefix = t.branchPrefix || "agents/";
  if (b.startsWith(prefix) && b.length > prefix.length) {
    const name = b.slice(prefix.length);
    const file = `${t.dir}/${name}.md`;
    return { name, file, status: fs.existsSync(path.join(top, file)) ? "ok" : "missing-doc", via: "prefix" };
  }
  const decl = declarations(top, t.dir);
  if (b) { const r = pick(decl.filter((d) => d.branches.includes(b)), "branch"); if (r) return r; }
  const here = normDir(top);
  return pick(decl.filter((d) => d.worktrees.some((w) => normDir(w) === here)), "worktree");
}

module.exports = { topicFor, declarations, header, normDir, NON_TOPIC };
