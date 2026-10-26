#!/usr/bin/env node
"use strict";
/**
 * CIS — **the refresh routine**: builds the index only when it is stale (the same key as ctx).
 * `node build.js [--background] [--reason <who>] [--force] [--cwd <dir>] [--quiet]`
 *   --background ⇒ re-launches itself detached and returns at once (git hooks and session start never wait).
 *   A lock (`<cache>.lock`) makes a second concurrent build skip; a lock older than 2 min is taken over.
 *   A short log: <tmp>/central-info-station/build.log (who · HEAD · rows · ms · cached/built).
 * Callers: git hooks post-commit / post-merge / post-checkout, and the session card when the cache is stale.
 * 🔒 read-only towards git; never writes to the repo; any error ⇒ silent exit 0 — a background routine must never break git.
 * Windows note: only `detached: true` survives the parent's exit; Windows may throttle a background process, so it can be slow.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const lib = require("./lib");
const { t: T } = require("./i18n");

const LOCK_STALE_MS = 120_000;
const LOG_MAX = 256 * 1024;
const LOG_FILE = path.join(lib.CACHE_DIR, "build.log");

function parseArgs(argv) {
  const a = { background: false, force: false, quiet: false, reason: "manual", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--background") a.background = true;
    else if (argv[i] === "--force") a.force = true;
    else if (argv[i] === "--quiet") a.quiet = true;
    else if (argv[i] === "--reason") a.reason = String(argv[++i] || "manual").replace(/[^\w.-]/g, "").slice(0, 32) || "manual";
    else if (argv[i] === "--cwd") a.cwd = argv[++i] || a.cwd;
  }
  return a;
}

function acquireLock(lockFile, now = Date.now()) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, at: now });
  try {
    fs.writeFileSync(lockFile, mine, { flag: "wx" });
  } catch {
    let at = 0;
    try { at = JSON.parse(fs.readFileSync(lockFile, "utf8")).at || 0; } catch { /* corrupt ⇒ stale */ }
    if (now - at < LOCK_STALE_MS) return null;
    fs.writeFileSync(lockFile, mine);
  }
  return () => { try { if (JSON.parse(fs.readFileSync(lockFile, "utf8")).pid === process.pid) fs.unlinkSync(lockFile); } catch { /* released */ } };
}

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) { const t = fs.readFileSync(LOG_FILE, "utf8"); fs.writeFileSync(LOG_FILE, t.slice(t.length / 2).replace(/^[^\n]*\n/, "")); }
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* optional */ }
}

function spawnBackground(opts = {}) {
  const args = [__filename, "--quiet", "--reason", opts.reason || "background"];
  if (opts.force) args.push("--force");
  if (opts.cwd) args.push("--cwd", opts.cwd);
  const child = spawn(process.execPath, args, { cwd: opts.cwd || process.cwd(), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return child.pid;
}

/** build if needed, under the lock ⇒ {status: built|fresh|locked|error, …} */
function build(opts = {}) {
  let loc;
  try { loc = lib.locate(opts.cwd || process.cwd(), opts.git); } catch (e) { return { status: "error", error: String((e && e.message) || e) }; }
  const cacheFile = opts.cacheFile || lib.cachePath(loc.top);
  const release = acquireLock(`${cacheFile}.lock`);
  if (!release) { log(`${opts.reason || "manual"} ${loc.top} skip=locked`); return { status: "locked", loc }; }
  try {
    const r = lib.loadIndex({ ...opts, loc, cacheFile });
    const res = { status: r.fromCache ? "fresh" : "built", loc, ms: r.ms, rows: r.index.rows.length, head: String(r.index.head).slice(0, 8), lang: r.index.language };
    log(`${opts.reason || "manual"} ${loc.top} head=${res.head} rows=${res.rows} ${res.status} ${res.ms}ms`);
    return res;
  } catch (e) {
    log(`${opts.reason || "manual"} ${loc.top} error=${String((e && e.message) || e).slice(0, 200)}`);
    return { status: "error", loc, error: String((e && e.message) || e) };
  } finally {
    release();
  }
}

function describe(r) {
  const t = T(r.lang);
  const where = r.loc ? path.basename(r.loc.top) : "?";
  return r.status === "built" ? t.built(where, r.rows, r.head, r.ms) : r.status === "fresh" ? t.fresh(where, r.rows, r.head) : r.status === "locked" ? t.locked(where) : t.buildFailed(r.error);
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  try {
    if (a.background) spawnBackground(a);
    else { const r = build(a); if (!a.quiet) process.stdout.write(`${describe(r)}\n`); }
  } catch { /* never breaks */ }
  process.exitCode = 0;
}

module.exports = { build, spawnBackground, acquireLock, parseArgs, describe, LOG_FILE };
