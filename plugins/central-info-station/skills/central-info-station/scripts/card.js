"use strict";
/**
 * CIS — the **session card** (≤4KB, generated — never written by hand, so it never goes stale).
 * Injected at every session start / resume / clear / compact by hooks/session-start.js; on demand: `cis card`.
 *   topic · branch @ HEAD · the index state · main (and extra refs) vs this branch · pinned lines (e.g. the last deploy) ·
 *   what's open in this topic and in the plan · the latest **open** resume point (closed ones are skipped) · red lines from the
 *   agent rules · files over their size cap · how to retrieve.
 * Read-only; git calls are read-only.
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const { t: T } = require("./i18n");

const shortSha = (s) => String(s || "").slice(0, 8) || "—";
const tryGit = (git, args, cwd) => { try { return git(args, cwd); } catch { return ""; } };

function topicOf(top, branch, cfg) {
  const r = require("./topic").topicFor(top, branch, cfg);
  if (!r) return { name: null, file: null };
  if (r.status === "ambiguous") return { name: null, file: null, ambiguous: r.candidates };
  return { name: r.name, file: r.status === "missing-doc" ? null : r.file, via: r.via };
}

function mainBranchOf(cfg, git, top) {
  if (cfg.mainBranch && cfg.mainBranch !== "auto") return cfg.mainBranch;
  return tryGit(git, ["rev-parse", "--verify", "--quiet", "refs/heads/main"], top) ? "main" : tryGit(git, ["rev-parse", "--verify", "--quiet", "refs/heads/master"], top) ? "master" : "main";
}

/** bullets of the topic's "what's left" section */
function remaining(top, file, re) {
  if (!file) return [];
  try {
    const lines = fs.readFileSync(path.join(top, file), "utf8").split(/\r?\n/);
    const k = lines.findIndex((l) => re.remaining.test(l));
    if (k < 0) return [];
    const out = [];
    for (let i = k + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (/^\s*[-*] /.test(lines[i])) out.push(lib.clean(lines[i].replace(/^\s*[-*] /, "")));
    return out;
  } catch { return []; }
}

/** pinned lines: config card.pins [{label, file, pattern}] ⇒ the first matching line of each */
function pins(top, cfg) {
  const out = [];
  for (const p of (cfg.card && cfg.card.pins) || []) {
    try {
      const lines = fs.readFileSync(path.join(top, p.file), "utf8").split(/\r?\n/);
      const re = new RegExp(p.pattern, "i");
      const k = lines.findIndex((l) => re.test(l));
      if (k >= 0) out.push(`📍 ${p.label}: ${lib.short(lib.clean(lines[k]), 120)} (${p.file}:L${k + 1})`);
    } catch { /* missing file / bad pattern */ }
  }
  return out;
}

// ── closed resume points ───────────────────────────────────────────────────
const BRANCH_REF = /\b(?:wip|agents|feature|feat|fix|bugfix|hotfix|release|claude|chore|topic)\/[\w.\-/]*\w/g;
const READY = /(?<!not |לא )(?:ready (?:for|to) merge|ready for review|\bmerged\b|מוכן למיזוג)/i;
const uniq = (a) => [...new Set(a)];

/** what a resume point names **in its title** (the body mentions other people's context, so it is not counted) */
function handoffRefs(h, cx) {
  const t = String(h.title || "");
  const extra = [];
  for (const x of cx.re.extra) for (const m of t.matchAll(x)) extra.push(m[0].toUpperCase());
  return { ids: uniq(extra), branches: uniq(t.match(BRANCH_REF) || []), items: lib.idsIn(t, cx.re, cx.itemIds).filter((id) => cx.itemIds.has(id)) };
}

/**
 * Closed? (a) later in the same file (a later date, or the same date and below it) a "ready to merge / merged" line names the same branch
 * or the same id from its title; or (b) every plan item in its title is done. Returns the reason, or "" (open). When in doubt — open:
 * showing an old note costs less than hiding a live one.
 */
function closedBy(h, cx) {
  const t = T(cx.lang);
  const refs = handoffRefs(h, cx);
  const lines = cx.fileLines(h.file);
  if (refs.ids.length || refs.branches.length) {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!READY.test(ln) || i + 1 === h.start) continue;
      const near = [ln];
      for (let j = i + 1; j < Math.min(lines.length, i + 3) && !/^#{1,6}\s/.test(lines[j]); j++) near.push(lines[j]);
      const txt = near.join(" ");
      if (!refs.ids.some((x) => txt.toUpperCase().includes(x)) && !refs.branches.some((b) => txt.includes(b))) continue;
      const d = lib.parseDate(ln);
      if (d && h.date ? d > h.date || (d === h.date && i + 1 > h.start) : i + 1 > h.start) return t.closedReady(i + 1);
    }
  }
  if (refs.items.length && refs.items.every((id) => cx.itemStatus.get(id) === "done")) return t.closedDone(refs.items.join(", "));
  return "";
}
function openHandoff(list, cx) {
  const sorted = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.start - b.start);
  const skipped = [];
  for (const h of sorted) {
    const why = closedBy(h, cx);
    if (!why) return { open: h, skipped };
    skipped.push({ h, why });
  }
  return { open: null, skipped };
}

/** red lines: rule bullets marked 🔴/🚫/⛔, then bullets in CAPS (NEVER / MUST NOT / ALWAYS / DO NOT) or Hebrew אסור / לעולם; plus card.redLines */
function redLines(rows, top, cfg) {
  const bullets = rows.filter((r) => r.type === "rule" && !r.parent && r.end === r.start && /#L\d+$/.test(r.id));
  const strong = (r) => /\b(NEVER|MUST NOT|DO NOT|ALWAYS|MUST)\b/.test(r.body) || /אסור|לעולם|חובה/.test(r.body);
  const picked = [...bullets.filter((r) => r.red), ...bullets.filter((r) => !r.red && strong(r))];
  const out = picked.slice(0, (cfg.card && cfg.card.maxRedLines) || 8).map((r) => `  - ${lib.short(r.body, 150)} (${r.file}:L${r.start})`);
  for (const x of (cfg.card && cfg.card.redLines) || []) {
    try {
      const lines = fs.readFileSync(path.join(top, x.file), "utf8").split(/\r?\n/);
      const k = lines.findIndex((l) => new RegExp(x.pattern, "i").test(l));
      if (k >= 0) out.push(`  - ${lib.short(lib.clean(lines[k].replace(/^\s*(?:[-*]|\d+\.)\s*/, "")), 300)} (${x.file}:L${k + 1})`);
    } catch { /* skip */ }
  }
  return uniq(out);
}

/**
 * Session mode (`--session`, from the SessionStart hook): **never slow**. A cache exists (even stale) ⇒ the card from it now, and a
 * background rebuild if stale. No cache at all ⇒ one synchronous build (~1–2 s, first time in a worktree).
 */
function sessionIndex(opts = {}) {
  const git = opts.git || lib.realGit;
  const t = (lang) => T(lang);
  const f = lib.freshness({ git, cwd: opts.cwd, cacheFile: opts.cacheFile });
  const cached = f.meta ? lib.readCachedIndex(f.loc.top, opts.cacheFile) : null;
  if (cached && f.fresh) return { index: cached, loc: f.loc, env: f.env, state: t(cached.language).stateFresh };
  if (cached) {
    let bg = false;
    if (!process.env.CIS_NO_BG) { try { require("./build").spawnBackground({ reason: "session-start", cwd: f.loc.top }); bg = true; } catch { /* no warm-up */ } }
    return { index: cached, loc: f.loc, env: f.env, state: t(cached.language).stateStale(bg) };
  }
  const r = lib.loadIndex({ git, loc: f.loc, env: f.env, cacheFile: opts.cacheFile });
  return { index: r.index, loc: r.loc, env: r.env, state: t(r.index.language).stateBuilt(r.ms) };
}

function buildCard(opts = {}) {
  const git = opts.git || lib.realGit;
  const s = opts.session ? sessionIndex({ ...opts, git }) : { ...lib.loadIndex({ git, cwd: opts.cwd, cacheFile: opts.cacheFile }), state: "" };
  const { index, loc, env, state } = s;
  const cfg = env.cfg;
  const t = T(cfg.language);
  const maxBytes = (cfg.card && cfg.card.maxBytes) || 4096;
  const rows = index.rows.filter((r) => !r.parent);
  const topic = topicOf(loc.top, loc.branch, cfg);
  const L = [];
  const note = topic.ambiguous ? t.topicAmbiguous(topic.ambiguous.join(", ")) : topic.via === "worktree" ? t.topicDeclaredWorktree : topic.via === "branch" ? t.topicDeclaredBranch : "";
  L.push(t.cardTitle(topic.name || (topic.ambiguous ? "—" : ""), note, loc.branch, shortSha(loc.head)));
  L.push(t.cardIndex(shortSha(index.head), index.builtAt.slice(0, 16).replace("T", " "), index.graphBuiltAt, index.rows.length, state));
  const main = mainBranchOf(cfg, git, loc.top);
  const mainSha = tryGit(git, ["rev-parse", "--short=8", main], loc.top) || "—";
  let vs = "";
  if (loc.branch !== main) {
    const c = tryGit(git, ["rev-list", "--left-right", "--count", `${main}...HEAD`], loc.top).split(/\s+/);
    if (c.length === 2) vs = t.cardVsMain(main, c[0], c[1]);
  }
  const refs = ((cfg.card && cfg.card.refs) || []).map((r) => ` · ${r} ${tryGit(git, ["rev-parse", "--short=8", r], loc.top) || "—"}`).join("");
  L.push(t.cardGit(main, mainSha, vs, refs));
  L.push(...pins(loc.top, cfg));

  const rem = remaining(loc.top, topic.file, env.re);
  const open = rows.filter((r) => r.type === "item" && (r.status === "open" || r.status === "in_progress" || r.status === "blocked"));
  if (topic.file || open.length) {
    L.push(t.cardOpen(topic.file));
    if (topic.file) { if (rem.length) for (const x of rem.slice(0, 5)) L.push(`  - ${lib.short(x, 150)}`); else L.push(t.cardNoRemaining); }
    if (open.length || rows.some((r) => r.type === "item")) {
      const blocked = open.filter((r) => r.status === "blocked").map((r) => r.id).filter((x) => !x.includes("#"));
      L.push(t.cardPlan(open.length, blocked.slice(0, 6).join(", ")));
    }
  }

  const items = index.rows.filter((r) => r.type === "item");
  const cache = new Map();
  const cx = {
    re: env.re, lang: cfg.language,
    itemIds: new Set(items.map((r) => r.id).filter((x) => !x.includes("#"))),
    itemStatus: new Map(items.map((r) => [r.id, r.status])),
    fileLines: (f) => { if (!cache.has(f)) { try { cache.set(f, fs.readFileSync(path.join(loc.top, f), "utf8").split(/\r?\n/)); } catch { cache.set(f, []); } } return cache.get(f); },
  };
  const topicDir = cfg.topics && cfg.topics.dir;
  const handoffs = rows.filter((r) => r.type === "handoff");
  const fmt = (r) => {
    const skip = r.skipped.length ? t.handoffSkipped(r.skipped.length, r.open ? "" : `${lib.ref(r.skipped[0].h)} — ${r.skipped[0].why}`) : "";
    return r.open ? `${lib.short(r.open.title, 120)} — ${lib.ref(r.open)}${skip}` : `${t.handoffNone}${skip}`;
  };
  if (topic.file) {
    const mine = openHandoff(handoffs.filter((r) => r.file === topic.file), cx);
    if (mine.open || mine.skipped.length) L.push(`${t.handoffMine}: ${fmt(mine)}`);
  }
  const general = openHandoff(handoffs.filter((r) => !(topicDir && r.file.startsWith(`${topicDir}/`)) && !/\/archive\//.test(r.file)), cx);
  if (general.open || general.skipped.length) L.push(`${t.handoffGeneral}: ${fmt(general)}`);

  const red = redLines(rows, loc.top, cfg);
  if (red.length) { L.push(t.cardRules); L.push(...red); }
  try {
    const over = require("./check").check({ loc, env }).items.filter((i) => i.over);
    if (over.length) L.push(t.cardOver(over.length, over.map((i) => path.posix.basename(i.label)).slice(0, 4).join(" · ")));
  } catch { /* no caps line */ }
  L.push(t.cardHow);
  L.push(t.cardMiss);

  let out = L.join("\n");
  while (Buffer.byteLength(out, "utf8") > maxBytes && L.length > 6) {
    const k = L.findIndex((l, i) => i > 3 && /^ {2}- /.test(l));
    if (k < 0) break;
    L.splice(k, 1);
    out = L.join("\n");
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) out = Buffer.from(out, "utf8").subarray(0, maxBytes - 3).toString("utf8").replace(/�$/, "") + "…";
  return out;
}

module.exports = { buildCard, sessionIndex, topicOf, remaining, pins, handoffRefs, closedBy, openHandoff, redLines, mainBranchOf };
