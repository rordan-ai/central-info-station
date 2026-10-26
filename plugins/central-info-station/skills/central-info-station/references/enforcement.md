# Enforcement — the hooks, what they do, and how they fail

Instructions alone ("please don't read big files") are forgotten after the first compact. CIS puts the habit in
hooks that the harness runs every time. All of them are per-repo (registered by `cis install`), all are plain Node with
no dependencies, and **all fail open**: an error or a timeout lets the tool call through — enforcement must never break a session.

## Claude Code hooks (`.claude/settings.json`)

Registered in the documented exec form — `"command": "node"` with `"args": ["${CLAUDE_PROJECT_DIR}/.cis/bin/…"]` — which
runs without a shell, so it behaves the same on Windows, macOS and Linux (`${CLAUDE_PROJECT_DIR}` is substituted inside `args`).

| event | matcher | script | effect |
|---|---|---|---|
| `SessionStart` | none (= startup, resume, clear, compact, fork) | `hooks/session-start.js` | prints the card; Claude Code adds a SessionStart hook's stdout to the context (limit 10,000 chars — the card is ≤4KB). |
| `PreToolUse` | `Read\|Bash\|PowerShell` | `hooks/read-gate.js` | `permissionDecision: "deny"` with a reason the model sees, for whole-file reads of gated docs. `gate.mode: "warn"` ⇒ only `additionalContext`. |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `hooks/edit-context.js` | `additionalContext` with ≤3 lines (decisions / rules / memories that name the file or its folder). Never blocks. |

Notes:

- **Which tree?** Hooks use the `cwd` from the hook input — the session's current folder, which after entering a worktree is
  the worktree — not `${CLAUDE_PROJECT_DIR}` (the folder the session started in). A session that moved into a worktree gets
  that worktree's card and topic.
- **Existing hooks are kept.** Install appends its matcher groups and recognises its own entries by `.cis/bin/`; running
  it twice changes nothing; uninstall removes only those entries. If the settings file is not valid JSON, install stops
  instead of overwriting it.
- **Team vs personal.** `.claude/settings.json` is committed — everyone in the repo gets the behaviour. `--local` writes
  `.claude/settings.local.json` instead (only you); install removes a duplicate registration from the other file.
- **Turning it off for a moment:** `CIS_DISABLE=1` in the environment of Claude Code silences all three hooks.
- Hook changes take effect in new sessions — start a new session after installing.

### What the read gate blocks — and allows

Blocked: a full read of a gated document (over `gate.maxKB`, and a source or under `gate.dirs`):

- Read without `offset`/`limit`, or with a range covering the whole file;
- Bash: `cat` `more` `less` `nl` `tac` `bat` · `head`/`tail` covering everything · `sed` printing everything · `git show <rev>:<file>`;
- PowerShell: `Get-Content` `gc` `cat` `type` without `-TotalCount`/`-Head`/`-Tail` (or covering everything).

Allowed: any line range; output piped onward (`cat f | grep x`) or redirected to a file; `sed -i`; `grep`; code files; small
files; anything outside a station repo. `cd` inside a command is followed. Each block is one JSON line in
`.cis/local/read-gate.jsonl` — `cis` users can measure how often agents hit it and on which files.

The gate is a guard rail, not a sandbox: an agent determined to read a whole file can (e.g. `offset: 2`). It exists to stop
the reflex, and its message says exactly what to do instead.

## Git hooks (refresh)

`post-commit`, `post-merge`, `post-checkout` (branch switches only) get one marked block, right after the shebang, before any
early `exit` in other tools' hook code:

```sh
# central-info-station-start — …
( [ "${3:-1}" = "1" ] && [ ! -d "${GIT_DIR:-.git}/rebase-merge" ] && … && node "$PWD/.cis/bin/build.js" --background … ) || true
# central-info-station-end
```

It skips rebases, needs `node` on PATH, launches a detached background build and returns immediately; `|| true` means it can
never fail a git command. The hooks folder is the common one, so every worktree is covered. With `core.hooksPath` set
(husky, lefthook, pre-commit), install writes nothing and prints the one line to add to your hook manager.

Windows: a detached background process may be throttled by the OS, so the background build can take a few seconds longer;
nothing waits for it, and `ctx` always rebuilds a stale index itself.

## Agents without hooks (Codex CLI, Cursor, Gemini CLI, Claude.ai, Cowork …)

The index and the CLI work anywhere Node runs. What is missing is enforcement, so the habit has to come from instructions:

1. `node .cis/bin/cis.js snippet` prints a short "retrieve, don't read" section — paste it into AGENTS.md /
   `.cursorrules` / GEMINI.md (whatever that agent reads at start).
2. The git hooks still keep the index fresh for everyone.
3. Claude.ai / Cowork projects without a shell can still use the *practice* in SKILL.md, but not the scripts.

Only claim what a given tool actually supports — if unsure whether an agent runs hooks, check its current documentation.

## Troubleshooting

| symptom | check |
|---|---|
| no card at session start | `cis doctor`; is `.cis/config.json` in the session's tree? `CIS_DISABLE` set? |
| card says "stale" | normal right after a change — it shows the cached card and rebuilds in the background; `ctx` is always fresh |
| `ctx` does not find something you know exists | is the file a source (`cis doctor` lists them)? an id format missing from `ids`? log it with `cis miss` |
| the gate blocks a file CIS cannot serve | narrow `gate.dirs`, add the file as a source, or raise `gate.maxKB` |
| index build slow on a huge repo | narrow `sources` globs; `exclude` generated docs; the build log is `<tmp>/central-info-station/build.log` |
