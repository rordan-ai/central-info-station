# What CIS understands

The parsers are deliberately forgiving: they read the shapes teams already write. Nothing has to be reformatted — if a shape
is missing, add a source/regex in the config rather than changing the docs.

## Decision logs (`kind: decisions`)

Table rows — the id in the first cell, the title in the second, the date in the last:

```markdown
| ID | Decision | Why | Date |
|---|---|---|---|
| D2 | Cache invoices for 1 hour | speed | 2026-02-01 |
| ~~D4~~ | ~~GraphQL API~~ | dropped | 2026-03-20 |
| D5 | No invoice cache — compute at runtime; supersedes D2 | stale totals | 2026-04-02 |
```

Headings — `## D7 — Event log` / `### DEC-7: Event log`, with an optional `Status: Accepted | Deprecated | Superseded by D9` line.

- `~~D4~~` (struck) or a status word *deprecated / rejected / cancelled* ⇒ **cancelled**.
- "supersedes / replaces / instead of / overrides D2" (Hebrew: "מחליפה את D2", "במקום D2") in a later entry, or
  "Superseded by D5" in the old one ⇒ D2 is **superseded by D5**. `ctx D2` then shows D2 *and* D5 right after it, and a text
  search never ranks D2 first.

## ADRs (`kind: adr`)

Files named `0007-use-kafka.md` in `adr/`, `adrs/`, `decisions/`, `decision-records/` or `architecture/decisions/`.
Id `ADR-0007`; title from the H1 (`# 7. Use Kafka`); status from frontmatter `status:`, a `Status:` line, or a `## Status`
section; date from `Date:` / frontmatter. "Superseded by ADR-0009" is honoured.

## Plans / task lists (`kind: plan`)

```markdown
- [ ] **2.1** Invoice export to CSV
  continuation lines are part of the task
- [~] 2.2 Retry failed payments          (in progress)
- [!] **2.3** Bank webhook                (blocked — listed on the card)
- [x] **1.2** Billing core (D3)           (done)
- [-] **2.4** GraphQL gateway             (dropped)
- [ ] a task without an id                (id = PLAN.md#L12)
```

A changelog table `| 2026-03-05 | \`abc1234\` | feat | what |` gives one **log** row per line, linked to the files of that commit.

## Docs, sections and resume points (`kind: docs`)

Every heading (levels 1–4, outside code fences) is a **section** that runs until the next heading of the same or a higher
level. Long sections are also chunked (~600 chars) so a fact deep inside is still found — each chunk points at its own lines.

A level-2+ heading matching `handoff` is a **resume point**: "Resume point 2026-04-10 — `wip/retry`", "Next session",
"Where we left off", "Handoff to …", Hebrew "נקודת המשך". The card shows the newest **open** one per topic file and one for
the project. A resume point is **closed** — and skipped — when:

- later in the same file, a line says *ready to merge / ready for review / merged* (Hebrew "מוכן למיזוג") and names the same
  branch or the same `ids.extra` id that the resume point's **title** names; or
- every plan task named in its title is done.

Only the title counts — bodies mention other people's branches. When in doubt the point stays open.

## Agent rules (`kind: rules`)

Every bullet is a **rule** (title = its bold part). Bullets marked 🔴 / 🚫 / ⛔ — or written with NEVER / MUST NOT / ALWAYS
in capitals (Hebrew אסור / לעולם / חובה) — are the card's red lines. A rule that names a file (`src/billing.ts`) or a folder
in backticks (`` `db/migrations/` ``) is shown when that file — or any file in that folder — is edited.

## Links to code

A row links to a code file when its text names it — a tracked path (`src/billing.ts`), a file name in backticks
(`` `billing.ts` `` when unique), or a backticked symbol known to the code graph (`` `roundHalfEven()` ``) — or when a commit
whose subject carries the row's id touched it (specificity = how many files that id touched; broad commits rank low).

## Topic files (parallel agents)

One file per topic in `topics.dir`. The header (everything before the first `##`) declares what belongs to it:

```markdown
# billing — branch `agents/billing`

> branch: `agents/billing` · worktree: `/work/repo-billing` · opened 2026-09-16

## What's left
- …
```

A later session of the same topic in a new worktree may append `- branch: \`agents/billing\` · worktree: \`/work/repo-billing-2\``
anywhere. Short-lived branches (`wip/…`) in a declared worktree belong to that topic; a cloud agent's branch is matched by
the branch declared in its file's title. Two files declaring the same branch or folder ⇒ "ambiguous" (nothing is picked).

## Agent memory (Claude Code)

`~/.claude/projects/<project-slug>/memory/*.md` with frontmatter (`name`, `description`) and the `MEMORY.md` index; a 🔴 in
the index link marks it red. `_archive/` is indexed as archived.
