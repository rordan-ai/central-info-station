#!/usr/bin/env node
"use strict";
/**
 * CIS — **edit-time context** (PreToolUse on Edit / Write / MultiEdit / NotebookEdit).
 * Before a file is changed, adds ≤3 short lines (≤300 chars) to the model's context: an active decision · a rule · a 🔴 memory that
 * names this file (explicitly, or — for a decision — through a focused commit that carries its id). Goal: don't silently undo or
 * re-open something already decided.
 * ⚡ Reads only the small edit map written next to the cache (`<cache>.edit.json`) — no build, no git, no subprocess. No map ⇒ silent.
 * Never blocks: the output is additionalContext only. Any error ⇒ silent exit 0.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { stationRoot, readInput } = require("./session-start");

const MAX_CHARS = 300;
const cacheDir = () => process.env.CIS_CACHE_DIR || path.join(os.tmpdir(), "central-info-station");
const editFileFor = (root) => path.join(cacheDir(), `${crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 12)}.json.edit.json`);

/** the file's own lines first, then lines of the folders that contain it (deepest folder first) — no duplicates, ≤ max lines, ≤300 chars */
function linesFor(rel, root, max = 3) {
  try {
    const e = JSON.parse(fs.readFileSync(editFileFor(root), "utf8"));
    const r = String(rel).split(path.sep).join("/");
    const list = [...((e && e.files && e.files[r]) || [])];
    const parts = r.split("/");
    for (let i = parts.length - 1; i >= 1; i--) list.push(...((e && e.dirs && e.dirs[`${parts.slice(0, i).join("/")}/`]) || []));
    const out = [];
    const seen = new Set();
    let used = 0;
    for (const l of list) {
      if (!l || !l.text || seen.has(l.id)) continue;
      if (out.length >= max || used + l.text.length > MAX_CHARS) break;
      seen.add(l.id);
      out.push(String(l.text));
      used += l.text.length;
    }
    return out;
  } catch { return []; }
}

function main() {
  if (process.env.CIS_DISABLE === "1") return;
  const input = readInput();
  const ti = input.tool_input || {};
  const fp = ti.file_path || ti.notebook_path;
  if (!fp) return;
  const abs = path.resolve(input.cwd || process.cwd(), String(fp));
  const root = stationRoot(path.dirname(abs));
  if (!root) return;
  let max = 3;
  try { const c = JSON.parse(fs.readFileSync(path.join(root, ".cis", "config.json"), "utf8")); if (c.edit && c.edit.enabled === false) return; if (c.edit && c.edit.maxLines) max = c.edit.maxLines; } catch { /* defaults */ }
  const lines = linesFor(path.relative(root, abs), root, max);
  if (!lines.length) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: lines.join("\n") } }));
}

if (require.main === module) {
  try { main(); } catch { /* never blocks an edit */ }
  process.exit(0);
}
module.exports = { linesFor, editFileFor };
