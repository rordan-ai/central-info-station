---
name: central-info-station
description: "Central Info Station (CIS) keeps AI coding agents oriented in large projects: retrieve, don't read. It builds a self-updating index of references (decisions, ADRs, plans/tasks, handoff notes, agent rules, memory, git history, optional code graph) and enforces the habit with Claude Code hooks — a ≤4KB session card injected at every start/resume/compact, a read gate that blocks whole-file reads of big docs (line ranges allowed), edit-time context for the file being changed, and git hooks that keep the index fresh. Use this skill whenever the repo has a `.cis/` folder (then: read the card, run `cis ctx` before opening any doc, read only the lines it points to), and whenever the user wants to set up, install, tune or remove it, or complains that agents waste context reading huge CLAUDE.md / SESSION-CONTEXT / handoff / decision-log / plan files, lose the resume point between sessions, re-open settled decisions, or that parallel agents in git worktrees lose track of their topic. Also for: 'where did we decide X', 'find task 3.4 / D12 / ADR-0007', 'archive our growing handoff doc', 'enforce reading discipline', 'session card', 'read gate'. Also: CIS · Central Info Station · Hebrew: תחנת מידע מרכזית · לשלוף לא לקרוא · כרטיס פתיחה · שער קריאה."
license: MIT
compatibility: "Node.js 18+ and git. Enforcement uses Claude Code hooks (CLI, Desktop, IDE); the CLI works with any agent. Windows, macOS, Linux. Zero dependencies."
---

# Central Info Station (CIS) — retrieve, don't read

Large projects grow documents faster than any agent can read them: a 200KB plan, a 300KB handoff log, a decision table with 80
rows, rules spread across CLAUDE.md files. An agent that reads them whole burns its context, still misses the one line that
matters, re-opens decisions that were settled weeks ago, and loses the resume point at every compact.

CIS fixes the *habit*, not just the tooling:

- **An index of references, never content** — every decision, task, rule, memory, handoff and doc section becomes one row:
  id · title · status · `file:lines` · the code files it links to. Answers point at the source; you read only those lines.
- **Retrieval** — `cis ctx "<query>"` returns ≤5 references + the exact excerpt, ≤3KB. Exact ids win (`D12`, `3.4`,
  `ADR-0007`, a commit SHA); a file name returns what governs that file; free text is ranked (BM25, English + Hebrew).
  A superseded decision is never first — the one that replaced it comes right after.
- **Enforcement (hooks)** — the card is injected at every session start; whole-file reads of big docs are blocked with a
  pointer to `ctx`; editing a file shows the ≤3 decisions/rules that name it; git hooks rebuild the index in the background.
- **An improvement loop** — when `ctx` misses, one line in a miss log; the misses are what you tune the config from.

The scripts live in `scripts/` next to this file. In a repo after install, the same runtime is vendored at
`.cis/bin/` — use `node .cis/bin/cis.js <command>` (the card calls it `cis`).

## 1. Working in a repo that has `.cis/` (the everyday mode)

The hooks already injected a **session card** at the top of the session (if not, run `node .cis/bin/cis.js card`).
It tells you the branch vs main, what is open in your topic and in the plan, the latest **open** resume point (closed
ones are skipped), and the red lines from the agent rules. Start from it — do not open SESSION-CONTEXT / handoff / plan
files to "get oriented"; that is exactly the cost CIS removes.

Then, for anything you need to know:

1. `node .cis/bin/cis.js ctx "<id | file | symbol | words>"` — e.g. `ctx D12`, `ctx src/billing.ts`, `ctx "invoice cache"`.
2. Read **only** the `file:Lstart-Lend` it gives (Read with offset/limit, or `sed -n 'A,Bp'`). Need more? Widen the range,
   or run another `ctx` — never the whole file.
3. If `ctx` did not find it and you found it another way, log it so the index improves:
   `node .cis/bin/cis.js miss "<what you searched>" --expected "<file:line | id>"`.

Why this order: the card + one `ctx` cost ~4–7KB; reading the documents they summarize costs 50–300KB per file, and
the answer is usually one paragraph. Ranges also keep you honest — you cite exact lines instead of a vague memory of a file.

**When the read gate blocks you** ("🚫 Read gate … is large — NNKB · N lines"): that is the design working. Do what the
message says — `ctx`, then a range. Ranges are always allowed (QA and reviews included), code files are never gated, and
`grep -n` to locate a word is fine. Do not try to defeat the gate with tricks (offset 2, `cat` through another program);
if CIS truly cannot serve a need, tell the user and suggest tuning the config (`gate.maxKB`, `gate.mode: "warn"`).

**When you edit a file** a hook may add lines like `🧭 CIS · decision D3 · …`. Those are settled decisions / rules
about that file. Respect them; if your change contradicts one, stop and ask the user instead of silently undoing it.

**Superseded / cancelled** rows are shown with their status — never act on a superseded decision; follow the one that replaced it.

## 2. Setting it up in a repo (install)

Do this when the user asks to set up / install / enforce CIS, or agrees to your suggestion. It is a per-repo,
explicit opt-in: the hooks change how every agent session in this repo behaves, so explain it before installing.

1. **Detect.** `node <skill-dir>/scripts/cis.js init` — prints what it found (agent rules, ADR folders, decision logs,
   task plans, topic files of parallel agents, docs folders, files over the gate limit, language, main branch) and the
   proposed `.cis/config.json`. Nothing is written yet.
2. **Review it with the user** in plain words: which files become sources, which big files the gate will serve by range,
   whether the language should be `en` or `he` (it drives the messages), and the gate mode — `deny` (enforce, the default)
   or `warn` (nudge only — a gentle first week). Adjust the config if needed; field reference: `references/config.md`.
   Formats it understands (decision tables/headings, ADRs, task lists, handoffs, topic declarations): `references/formats.md`.
3. **Install.** `node <skill-dir>/scripts/cis.js install` (add `--local` to register the hooks only for this user in
   `.claude/settings.local.json`; `--no-gate` / `--no-edit` / `--no-git-hooks` to leave a part out; `--dry-run` to preview).
   It writes `.cis/config.json` if missing, vendors the runtime to `.cis/bin/`, merges three hooks into
   `.claude/settings.json` next to any existing hooks, adds a marked block to the git hooks, and builds the index.
4. **Verify.** `node .cis/bin/cis.js doctor` — every line should be ✅ (it also proves the gate blocks a full read
   of the biggest source and allows a range). Show the user `cis card` and one `cis ctx` on a real question.
5. **Commit** `.cis/` (config + bin; `local/` is git-ignored) and `.claude/settings.json`, so every clone, worktree,
   teammate and CI run gets the same behaviour. Hooks take effect from the next session.

What each hook does, Windows notes, failure behaviour (every hook fails open), and how this works with Codex / Cursor /
Gemini CLI / Claude.ai (no hooks — the CLI and an AGENTS.md snippet still work: `cis snippet`): `references/enforcement.md`.

## 3. Keeping it healthy

- **Misses:** `cis misses` lists what `ctx` failed to find. Typical fixes: a file that should be a source, an id format
  missing from `ids` (e.g. ticket keys `PROJ-\d+` in `ids.extra`), a handoff heading pattern. Change the config, then
  `cis build --force` and re-run the missed query.
- **Growing docs:** `cis check` reports files over their cap (`archive.caps`). `cis archive` is a dry run showing
  what would move; `--apply` moves old dated sections word for word into `<dir>/archive/<name>-<yyyy-mm>.md`, leaves one
  pointer line per month, and never moves protected sections (what's left, open decisions, requests, 🔒), undated or
  recent ones, the latest resume point, or anything citing a commit that is not merged yet. `ctx` still finds archived text.
  Archive only files you own — in multi-agent repos each agent archives its own topic file on its own branch.
- **Parallel agents (worktrees):** set `topics.dir` (one markdown file per topic). A session's topic is decided only by
  explicit declarations — the branch prefix (`agents/<topic>`), a `branch: \`…\`` / `worktree: \`…\`` line in the topic
  file's header — never by guessing from text. The card then shows that topic's "what's left" and resume point.
- **Remove:** `node .cis/bin/cis.js uninstall` removes exactly what install added (`--purge` also removes `.cis/bin`).

## 4. Principles (why it is built this way)

- **References, not copies** — the index never duplicates content, so it cannot drift from the source; every answer is a
  `file:line` the user can open.
- **Never stale** — the cache key covers HEAD, every source's size/mtime, memory, the code graph, the config and the code;
  `ctx` rebuilds when anything changed. The card may show a cached index for speed, and says so.
- **Fail open** — a hook that errors or times out lets the tool call through. Enforcement must never break a session.
- **Explicit over clever** — topics, ids and sources are declared; when two files declare the same branch the card says
  "ambiguous" instead of picking one.
- **Small outputs, hard limits** — card ≤4KB, ctx ≤3KB, edit context ≤3 lines / 300 chars.
