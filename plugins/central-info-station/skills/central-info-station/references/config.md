# `.cis/config.json` — field reference

`cis init` proposes this file from what it finds in the repo; every field has a default, so a config can be as small as
`{"sources": [...]}`. Unknown fields are ignored. After editing: `cis build --force` (or just run `ctx`, which rebuilds
when the config changed) and `cis doctor`.

```json
{
  "version": 1,
  "language": "en",
  "mainBranch": "main",
  "sources": [
    { "path": "CLAUDE.md", "kind": "rules" },
    { "glob": "docs/adr/*.md", "kind": "adr" },
    { "path": "docs/DECISIONS.md", "kind": "decisions" },
    { "path": "docs/PLAN.md", "kind": "plan" },
    { "glob": "docs/**/*.md", "kind": "docs" }
  ],
  "exclude": ["docs/generated/**"],
  "ids": { "decision": "D\\d{1,4}|ADR-?\\d{1,5}", "item": "\\d{1,2}\\.\\d{1,3}[a-z]?", "extra": ["PROJ-\\d+"] },
  "memory": "auto",
  "graph": "auto",
  "handoff": "resume (?:here|point)|next session|where we left off|hand-?off (?:to|for|note)|נקודת (?:ה)?המשך",
  "card": { "maxBytes": 4096, "refs": ["production"], "pins": [{ "label": "last deploy", "file": "docs/DEPLOYS.md", "pattern": "dpl_" }], "redLines": [], "maxRedLines": 8, "remaining": "what'?s left|remaining|to ?do|next steps" },
  "topics": { "dir": "docs/sessions", "branchPrefix": "agents/" },
  "gate": { "enabled": true, "mode": "deny", "maxKB": 30, "dirs": ["docs"], "ext": ["md", "txt", "json", "..."] },
  "edit": { "enabled": true, "maxLines": 3, "codeExt": ["ts", "py", "..."] },
  "archive": { "caps": { "docs/sessions/*.md": 60, "docs/HANDOFF.md": 40 }, "minAgeDays": 14, "protected": "what'?s left|open decisions|🔒" }
}
```

## Top level

| field | default | meaning |
|---|---|---|
| `language` | `"en"` | `"en"` or `"he"` — the language of the card, ctx, gate and archive messages. `init` picks `he` when the docs are mostly Hebrew. |
| `mainBranch` | `"auto"` | the integration branch (`main` / `master` when auto). Used for "behind/ahead", topics, and the archive's unmerged-commit guard. |
| `sources` | `[]` | what gets indexed, in order; a file matched by an earlier entry is not matched again. Each entry: `path` (one file) or `glob` (`*`, `**`, `?`), and `kind`. A source's monthly archives (`<dir>/archive/<name>-*.md`) are indexed automatically. |
| `exclude` | `[]` | globs never indexed. |
| `memory` | `"auto"` | Claude Code's auto-memory folder for this project (`~/.claude/projects/<slug>/memory`, shared by all worktrees). A path, or `false` to skip. |
| `graph` | `"auto"` | a code graph (`graphify-out/graph.json`) — adds "imported by / tests / depends on" to file queries and lets backticked symbols link to their files. A path, or `false`. |
| `handoff` | see above | regex (case-insensitive) — a level-2+ heading matching it is a **resume point**. |

## `kind` of a source

| kind | what is parsed | rows |
|---|---|---|
| `rules` | agent rules files — CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules, copilot-instructions… | one **rule** per bullet + sections |
| `decisions` | a decision log: table rows `\| D12 \| … \|` and/or headings `## D12 — …` | one **decision** per entry |
| `adr` | ADR files `0007-title.md` (Nygard / MADR) | one **decision** per file, id `ADR-0007` |
| `plan` | task lists `- [ ] **3.4** …` (markers ` ` x ~ ! -) + a changelog table `\| date \| sha \| kind \| what \|` | one **task** per item, one **log** per row |
| `docs` | any markdown | one **section** per heading (≤ level 4), **handoff** when the heading matches `handoff` |

Details and examples: `formats.md`.

## `ids`

Regex *sources* (strings, JSON-escaped). They decide what counts as an exact id in `ctx` and what links rows to commits.

- `decision` — decision ids. `init` derives it (`D\d{1,4}`, `DEC-\d{1,4}`, plus `ADR-?\d{1,5}` when ADRs exist).
- `item` — plan task ids. An id below 10 (`2.8`) only counts after `§`, "item", "task" or the plan's file name, so "1.5 min" is not a task.
- `extra` — anything else worth linking to commits: ticket keys (`PROJ-\d+`), session report ids. A commit whose subject carries
  one links the row to the files it changed.

## `card`

| field | meaning |
|---|---|
| `maxBytes` | hard cap (lists are trimmed from the middle; the first lines and the how-to lines stay). |
| `refs` | extra refs to show next to main, e.g. `["production", "origin/main"]`. |
| `pins` | `[{label, file, pattern}]` — the first line of `file` matching `pattern` (regex), e.g. the latest deploy id. |
| `redLines` | `[{file, pattern}]` — lines that must always appear under 🔴 (besides rule bullets marked 🔴/🚫/⛔ or written in CAPS NEVER / MUST NOT / ALWAYS). |
| `remaining` | regex for the topic file's "what's left" heading. |

## `topics` (parallel agents, one git worktree each)

| field | meaning |
|---|---|
| `dir` | folder with one markdown file per topic (`null` = no topics; single-agent repos leave it off). |
| `branchPrefix` | `agents/` — branch `agents/billing` ⇒ topic `billing` ⇒ file `<dir>/billing.md`. |

Other branches (`wip/…`, a cloud agent's `claude/…`) are matched only by declarations in a topic file's header — see `formats.md`.

## `gate`

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the read gate off (the hook stays registered but allows everything). |
| `mode` | `"deny"` | `"warn"` never blocks — it adds a nudge to the context instead. Good for a first week. |
| `maxKB` | `30` | files above this size are served by range only. |
| `dirs` | `[]` | folders gated in addition to the sources (e.g. generated reports). Only files CIS can serve should be gated, so the block message is never a dead end. |
| `ext` | docs + data | extensions considered documents; code is never gated. |

## `edit`

`enabled`, `maxLines` (≤3 recommended), `codeExt` — files with these extensions may also get decisions linked through a
focused commit (≤8 files) that carries the decision's id.

## `archive`

| field | meaning |
|---|---|
| `caps` | `{glob: KB}` — `cis check` reports files over their cap; `cis archive` works on those by default. |
| `minAgeDays` | a unit must be at least this old to move. |
| `protected` | regex — level-2 sections whose title matches never move (what's left, open decisions, requests, ownership, 🔒 …). |

## Environment variables

`CIS_DISABLE=1` (all hooks silent) · `CIS_NO_BG=1` (no background builds) · `CIS_CACHE_DIR` · `CIS_MEMORY_DIR` ·
`CIS_MISSES_FILE` · `CIS_GATE_LOG`.
