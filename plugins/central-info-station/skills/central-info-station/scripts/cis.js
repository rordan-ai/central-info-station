#!/usr/bin/env node
"use strict";
/**
 * CIS — the CLI.  node cis.js <command> …   (in a repo after install: node .cis/bin/cis.js …)
 *
 *   init [--write] [--force] [--json]   detect the repo's sources and propose .cis/config.json (--write saves it)
 *   install [--local] [--no-git-hooks] [--no-gate] [--no-edit] [--dry-run]   enforce: runtime + Claude Code hooks + git hooks
 *   uninstall [--purge]                 remove exactly what install added (--purge: also .cis/bin)
 *   doctor                              health check, with what to fix
 *   ctx "<query>" [--n 8] [--json] [--rebuild]   retrieve: 5 references + the exact excerpt (≤3KB)
 *   card [--session]                    the session card (≤4KB)
 *   build [--force] [--background]      rebuild the index if stale
 *   check [--json]                      size caps
 *   archive [--file F]… [--all] [--days N] [--apply] [--json]   move old sections out of growing docs (dry run by default)
 *   miss "<query>" --expected "<file:line | id>"   log a ctx miss (the improvement loop) · misses — list them
 *   topic                               which topic this worktree/branch belongs to
 *   snippet                             the rule as text, for agents without hooks (AGENTS.md)
 *   version
 * Zero dependencies — Node 18+. Works in a git repository (any OS).
 */
const path = require("path");
const fs = require("fs");

function out(s) { process.stdout.write(`${s}\n`); }

function main(argv) {
  const [cmd, ...rest] = argv;
  const has = (f) => rest.includes(f);
  const val = (f) => { const k = rest.indexOf(f); return k >= 0 ? rest[k + 1] : undefined; };
  switch (cmd) {
    case "init": {
      const lib = require("./lib");
      const C = require("./config");
      const loc = lib.locate(process.cwd());
      const { config, report } = C.detect(loc.top, { git: lib.realGit });
      const file = path.join(loc.top, C.CONFIG_DIR, C.CONFIG_FILE);
      if (has("--json")) { out(JSON.stringify({ config, report }, null, 2)); return 0; }
      out("Detected:");
      for (const r of report) out(`  · ${r}`);
      out("");
      out(JSON.stringify(config, null, 2));
      if (has("--write")) {
        if (fs.existsSync(file) && !has("--force")) { out(`\n${C.CONFIG_DIR}/${C.CONFIG_FILE} exists — kept (use --force to overwrite).`); return 0; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
        out(`\nWritten: ${path.relative(process.cwd(), file) || file}`);
      } else out("\n(dry run — add --write to save it)");
      return 0;
    }
    case "install": {
      const r = require("./install").install({ local: has("--local"), noGitHooks: has("--no-git-hooks"), noGate: has("--no-gate"), noEdit: has("--no-edit"), dryRun: has("--dry-run") });
      out(`CIS ${require("./install").VERSION} — ${has("--dry-run") ? "dry run" : "installed"} in ${r.top}`);
      for (const s of r.steps) out(`  · ${s}`);
      if (!has("--dry-run")) out("\nNext: review .cis/config.json · commit .cis/ and .claude/settings.json · run: node .cis/bin/cis.js doctor");
      return 0;
    }
    case "uninstall": {
      const r = require("./install").uninstall({ purge: has("--purge"), dryRun: has("--dry-run") });
      for (const s of r.steps) out(`  · ${s}`);
      return 0;
    }
    case "doctor": out(require("./install").doctor()); return 0;
    case "ctx": { const r = require("./ctx").run(rest); out(r.out); return r.code; }
    case "miss": { const r = require("./ctx").runMiss(rest); out(r.out); return r.code; }
    case "misses": { const r = require("./ctx").runMisses(); out(r.out); return r.code; }
    case "card": {
      try { out(require("./card").buildCard({ session: has("--session") })); }
      catch (e) { if (has("--session")) out(require("./i18n").t("en").cardUnavailable(String(e.message).slice(0, 100))); else throw e; }
      return 0;
    }
    case "build": {
      const b = require("./build");
      if (has("--background")) { b.spawnBackground({ force: has("--force"), reason: "cli" }); return 0; }
      out(b.describe(b.build({ force: has("--force"), reason: "cli" })));
      return 0;
    }
    case "check": {
      const c = require("./check");
      const r = c.check();
      out(has("--json") ? JSON.stringify(r, null, 1) : c.format(r));
      return 0;
    }
    case "archive": {
      const a = require("./archive");
      const files = [];
      for (let i = 0; i < rest.length; i++) if (rest[i] === "--file") files.push(String(rest[++i] || "").split(path.sep).join("/"));
      const r = a.run({ files, days: parseInt(val("--days"), 10) || undefined, apply: has("--apply"), all: has("--all") });
      out(has("--json") ? JSON.stringify(r.report, null, 1) : a.format(r, has("--apply")));
      return 0;
    }
    case "topic": {
      const lib = require("./lib");
      const loc = lib.locate(process.cwd());
      const env = lib.envFor(loc);
      out(JSON.stringify(require("./topic").topicFor(loc.top, loc.branch, env.cfg)));
      return 0;
    }
    case "snippet": out(require("./install").snippet()); return 0;
    case "version": out(require("./install").VERSION); return 0;
    default:
      out(fs.readFileSync(__filename, "utf8").split("\n").slice(3, 20).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
      return cmd ? 2 : 0;
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`station: ${(e && e.message) || e}\n`); process.exitCode = 1; }
}
module.exports = { main };
