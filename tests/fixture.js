"use strict";
/**
 * A realistic sample repository for tests and demos: a decision log (table) with a superseded decision, ADRs, a task plan with ids,
 * a large handoff doc (over the 30KB gate) with an open and a closed resume point, agent rules, topic files for parallel worktrees,
 * code files, and commits that carry decision / task ids.
 *   node tests/fixture.js <dir>   ⇒ creates the repo there
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const w = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

function makeFixture(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  w(dir, "CLAUDE.md", [
    "# Project rules",
    "",
    "## Rules",
    "- 🔴 **Never edit migrations after they ran** — add a new migration instead (`db/migrations/`).",
    "- **Money is integer cents** — `src/billing.ts` must never use floats.",
    "- ALWAYS run `npm test` before you push.",
    "- Prefer small commits.",
    "",
  ].join("\n"));
  w(dir, "docs/DECISIONS.md", [
    "# Decisions",
    "",
    "| ID | Decision | Why | Date |",
    "|---|---|---|---|",
    "| D1 | Use PostgreSQL | relational data | 2026-01-10 |",
    "| D2 | Cache invoices for 1 hour | speed | 2026-02-01 |",
    "| D3 | Round money half-even in `src/billing.ts` | accounting standard | 2026-03-05 |",
    "| ~~D4~~ | ~~GraphQL API~~ | dropped | 2026-03-20 |",
    "| D5 | No invoice cache — compute at runtime; supersedes D2 | the cache served stale totals | 2026-04-02 |",
    "",
  ].join("\n"));
  w(dir, "docs/adr/0001-record-architecture-decisions.md", "# 1. Record architecture decisions\n\nDate: 2026-01-02\n\n## Status\n\nAccepted\n\n## Context\n\nWe need a log.\n");
  w(dir, "docs/adr/0002-use-rest.md", "# 2. Use REST for the public API\n\nDate: 2026-03-21\n\n## Status\n\nAccepted\n\n## Decision\n\nREST over HTTP, see `src/api.ts`.\n");
  w(dir, "docs/PLAN.md", [
    "# Plan",
    "",
    "- [x] **1.1** Set up the repo",
    "- [x] **1.2** Billing core in `src/billing.ts` (D3)",
    "- [ ] **2.1** Invoice export to CSV",
    "  continuation line about the CSV columns",
    "- [~] **2.2** Retry failed payments",
    "- [!] **2.3** Bank webhook — blocked on the bank's sandbox",
    "- [-] **2.4** GraphQL gateway (D4 dropped)",
    "",
    "| Date | Commit | Kind | What |",
    "|---|---|---|---|",
    "| 2026-03-05 | `abc1234` | feat | billing rounding |",
    "",
  ].join("\n"));
  const filler = (n) => Array.from({ length: n }, (_, i) => `- note ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(4)}`).join("\n");
  w(dir, "docs/HANDOFF.md", [
    "# Handoff log",
    "",
    "## Resume point 2026-04-01 — `wip/csv-export` (2.1)",
    "Started the CSV export; the column order is still open.",
    "",
    "## Ready to merge: `wip/csv-export` — 2026-04-03",
    "Done; tests green.",
    "",
    "## Resume point 2026-04-10 — `wip/retry-payments` (2.2)",
    "Retry with exponential backoff; the max attempts constant lives in `src/billing.ts`.",
    "The webhook signature check is the next step. The magic word for the search test is quasar.",
    "",
    "## Notes",
    filler(260),
    "",
  ].join("\n"));
  w(dir, "docs/sessions/alpha.md", "# alpha — branch `agents/alpha`\n\n> branch: `agents/alpha` · worktree: `../alpha-wt`\n\n## What's left\n- Finish 2.2 retries\n- Ask about the bank sandbox\n");
  w(dir, "docs/sessions/cloud.md", "# cloud — branch `claude/cloud-setup`\n\n## Notes\n- conflicts with agents/alpha on `src/api.ts`\n");
  w(dir, "src/billing.ts", "export function roundHalfEven(cents: number): number {\n  return Math.round(cents);\n}\n");
  w(dir, "src/api.ts", "import { roundHalfEven } from './billing';\nexport const total = (x: number) => roundHalfEven(x);\n");
  w(dir, "db/migrations/001_init.sql", "create table invoices (id int);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init: repo + rules");
  w(dir, "src/billing.ts", "export function roundHalfEven(cents: number): number {\n  return Math.round(cents); // D3\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "D3: half-even rounding in billing (1.2)");
  w(dir, "src/api.ts", "import { roundHalfEven } from './billing';\nexport const total = (x: number) => roundHalfEven(x) | 0;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "2.1 start invoice export");
  if (opts.branch) git(dir, "checkout", "-q", "-b", opts.branch);
  return dir;
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || "fixture-repo");
  makeFixture(dir, { branch: process.argv[3] });
  process.stdout.write(`${dir}\n`);
}
module.exports = { makeFixture };
