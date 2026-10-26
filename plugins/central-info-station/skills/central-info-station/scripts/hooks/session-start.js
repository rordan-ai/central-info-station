#!/usr/bin/env node
"use strict";
/**
 * CIS — **SessionStart hook**: injects the session card at every start / resume / clear / compact / fork.
 * Claude Code adds a SessionStart hook's stdout to the model's context. The card is ≤4KB (the documented limit is 10,000 chars).
 * The tree is taken from the hook input's `cwd` (the session's current folder — after entering a worktree it is the worktree), not
 * from where this script lives: a session that started in the main checkout and moved to a worktree gets the worktree's card.
 * Silent when the tree has no `.cis/config.json` or CIS_DISABLE=1. Never fails the session start (exit 0 always).
 */
const fs = require("fs");
const path = require("path");

function readInput() {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}") || {}; } catch { return {}; }
}
function stationRoot(start) {
  let d = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, ".cis", "config.json"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

function main() {
  if (process.env.CIS_DISABLE === "1") return;
  const input = readInput();
  let cwd = input.cwd;
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = process.cwd(); } catch { cwd = process.cwd(); }
  const root = stationRoot(cwd);
  if (!root) return;
  try {
    const card = require("../card").buildCard({ session: true, cwd: root });
    process.stdout.write(`${card}\n`);
  } catch (e) {
    let lang = "en";
    try { lang = JSON.parse(fs.readFileSync(path.join(root, ".cis", "config.json"), "utf8")).language || "en"; } catch { /* default */ }
    process.stdout.write(`${require("../i18n").t(lang).cardUnavailable(String((e && e.message) || e).slice(0, 100))}\n`);
  }
}

if (require.main === module) {
  try { main(); } catch { /* never breaks a session start */ }
  process.exit(0);
}
module.exports = { stationRoot, readInput };
