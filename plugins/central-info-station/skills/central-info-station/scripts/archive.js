"use strict";
/**
 * CIS — **archive old sections of growing docs**, word for word, by month: `cis archive [--file <f>…] [--all] [--days 14] [--apply] [--json]`.
 * Default: a **dry run** on the files over their cap (`archive.caps`). Nothing is deleted — sections move to `<dir>/archive/<name>-<yyyy-mm>.md`,
 * the source gets one pointer line per month, and the index keeps searching the archive (ctx still finds everything).
 *
 * A unit = a level-2 section; inside a "container" section (≥2 dated entries — level-3/4 headings with a date, or bold lines with an id/date)
 * every entry is its own unit. A unit moves only when ALL hold:
 *   · it is not inside a protected section (`archive.protected` — requests, open decisions, what's left, ownership, 🔒 …);
 *   · it has a date (from its first line, else the latest past date in its body) and is at least `--days` old;
 *   · 🔒 every commit SHA it mentions (in backticks) that exists in the repo is already on the main branch (unmerged work stays visible).
 * Before writing: verified — every moved unit is in the archive verbatim, and kept + moved lines = the source.
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const C = require("./config");
const { t: T } = require("./i18n");

const HEADING = /^(#{2,4})\s+(.*)$/;
const DATE_ANY = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b20\d{2}-\d{2}-\d{2}\b/;
const isoDay = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

function units(lines, re) {
  const secs = [];
  let fence = false;
  const idRe = re && re.extra.length ? new RegExp(re.extra.map((x) => x.source).join("|")) : null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const h = lines[i].match(HEADING);
    if (h && h[1].length === 2) secs.push({ start: i, title: lines[i], level2: h[2], entries: [] });
    else if (secs.length) {
      const head = lines[i].slice(0, 160);
      const isEntry = (h && DATE_ANY.test(h[2])) || (/^\*\*/.test(lines[i]) && ((idRe && idRe.test(head)) || DATE_ANY.test(head)));
      if (isEntry) secs[secs.length - 1].entries.push(i);
    }
  }
  const out = [];
  if (!secs.length || secs[0].start > 0) out.push({ start: 0, end: (secs[0] ? secs[0].start : lines.length) - 1, title: "", kind: "head", level2: "", sec: -1 });
  secs.forEach((s, k) => {
    const end = (secs[k + 1] ? secs[k + 1].start : lines.length) - 1;
    if (s.entries.length >= 2) {
      out.push({ start: s.start, end: s.entries[0] - 1, title: s.title, kind: "preface", level2: s.level2, sec: k });
      s.entries.forEach((e, j) => out.push({ start: e, end: (s.entries[j + 1] ? s.entries[j + 1] : end + 1) - 1, title: lines[e], kind: "entry", level2: s.level2, sec: k }));
    } else out.push({ start: s.start, end, title: s.title, kind: "section", level2: s.level2, sec: k });
  });
  return out.filter((u) => u.end >= u.start);
}

/** a date counts when it is not in the future; a short dd/mm (no year — "1/1", "2/3" are often not dates) must also be ≥ the first commit */
function dateOk(raw, d, today, since) {
  if (!d || d > today) return false;
  return /\d{4}/.test(raw) || !since || d >= since;
}
function unitDate(lines, u, now, since) {
  const today = isoDay(now);
  const DATES = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b20\d{2}-\d{2}-\d{2}\b/g;
  const m0 = u.title.replace(/`/g, "").match(DATES);
  if (m0) { const d = lib.parseDate(m0[0], now); if (dateOk(m0[0], d, today, since)) return d; }
  let best = "";
  for (const m of lines.slice(u.start, u.end + 1).join("\n").matchAll(DATES)) {
    const d = lib.parseDate(m[0], now);
    if (dateOk(m[0], d, today, since) && d > best) best = d;
  }
  return best;
}

/** SHA ⇒ "main" (on the main branch) · "branch" (exists, not merged) · "unknown" (not in this repo) */
function shaChecker(git, top, mainBranch) {
  const list = (args) => { try { return git(args, top).split("\n").map((s) => s.trim()).filter(Boolean); } catch { return []; } };
  const main = new Set(list(["rev-list", mainBranch]));
  const byPrefix = new Map();
  for (const s of list(["rev-list", "--all"])) { const k = s.slice(0, 7); if (!byPrefix.has(k)) byPrefix.set(k, []); byPrefix.get(k).push(s); }
  return (sha) => {
    const c = (byPrefix.get(sha.slice(0, 7)) || []).filter((s) => s.startsWith(sha));
    if (!c.length) return "unknown";
    return c.some((s) => main.has(s)) ? "main" : "branch";
  };
}

function plan(text, opts) {
  const now = opts.now || new Date();
  const t = T(opts.lang);
  const lines = text.split("\n");
  const planned = units(lines, opts.re).map((u) => {
    const r = { ...u, date: "", action: "keep", reason: "" };
    if (u.kind === "head") return { ...r, reason: t.reason.head };
    if (opts.protectedRe.test(u.level2) || opts.protectedRe.test(u.title)) return { ...r, reason: t.reason.protected };
    if (u.kind === "preface") return { ...r, reason: t.reason.preface };
    r.date = unitDate(lines, u, now, opts.since);
    if (!r.date) return { ...r, reason: t.reason.undated };
    if (daysBetween(r.date, isoDay(now)) < opts.days) return { ...r, reason: t.reason.young };
    for (const m of lines.slice(u.start, u.end + 1).join("\n").matchAll(/`([0-9a-f]{7,40})`/g)) if (opts.sha(m[1]) === "branch") return { ...r, reason: t.reason.sha(m[1].slice(0, 8)) };
    return { ...r, action: "archive", reason: "" };
  });
  // the newest resume point of the file stays where the next session looks for it, however old it is
  const resumes = planned.filter((u) => u.kind !== "head" && opts.re && opts.re.handoff.test(u.title)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.start - a.start);
  if (resumes[0] && resumes[0].action === "archive") { resumes[0].action = "keep"; resumes[0].reason = t.reason.resume; }
  for (const p of planned.filter((u) => u.kind === "preface" && u.reason === t.reason.preface)) {
    const kids = planned.filter((u) => u.kind === "entry" && u.sec === p.sec);
    if (kids.length && kids.every((u) => u.action === "archive")) { p.action = "archive"; p.reason = ""; p.date = kids.map((u) => u.date).sort().pop(); }
  }
  return planned;
}

const archiveFileFor = (rel, ym) => { const dir = path.posix.dirname(rel); return `${dir === "." ? "" : `${dir}/`}archive/${path.posix.basename(rel).replace(/\.[^.]+$/, "")}-${ym}.md`; };

function compute(rel, text, p, now, lang) {
  const t = T(lang);
  const lines = text.split("\n");
  const moved = p.filter((u) => u.action === "archive");
  if (!moved.length) return { source: text, archives: {}, moved, kept: p.length };
  const byMonth = new Map();
  for (const u of moved) { const ym = u.date.slice(0, 7); if (!byMonth.has(ym)) byMonth.set(ym, []); byMonth.get(ym).push(u); }
  const archives = {};
  const pointers = [];
  for (const [ym, list] of [...byMonth].sort()) {
    const arel = archiveFileFor(rel, ym);
    archives[arel] = {
      header: t.archiveHeader(rel, ym, isoDay(now)),
      body: list.map((u) => `${t.archiveFrom(u.level2 ? `## ${u.level2}` : "(top)", u.start + 1, u.date)}\n${lines.slice(u.start, u.end + 1).join("\n")}`).join("\n\n"),
    };
    pointers.push(t.archivePointer(ym, list.length, path.posix.basename(arel), path.posix.relative(path.posix.dirname(rel), arel), isoDay(now)));
  }
  const removed = new Set();
  for (const u of moved) for (let i = u.start; i <= u.end; i++) removed.add(i);
  const kept = lines.filter((_, i) => !removed.has(i));
  const k = kept.findIndex((l) => l.startsWith(t.archiveSection));
  if (k >= 0) {
    let end = k + 1;
    while (end < kept.length && !/^#{1,2}\s/.test(kept[end])) end++;
    kept.splice(end, 0, ...pointers);
  } else {
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    kept.push("", t.archiveSection, t.archiveNote, ...pointers, "");
  }
  if (kept.length - (lines.length - removed.size) < pointers.length) throw new Error(`verification failed: ${rel} — line counts do not add up`);
  for (const u of moved) {
    if (!archives[archiveFileFor(rel, u.date.slice(0, 7))].body.includes(lines.slice(u.start, u.end + 1).join("\n"))) throw new Error(`verification failed: ${rel}:${u.start + 1} is not in the archive verbatim`);
  }
  return { source: kept.join("\n"), archives, moved, kept: p.length - moved.length };
}

function firstCommitDate(git, top) {
  try {
    const root = git(["rev-list", "--max-parents=0", "HEAD"], top).split("\n")[0].trim();
    return root ? git(["log", "-1", "--format=%ad", "--date=short", root], top).trim() : "";
  } catch { return ""; }
}

function run(opts = {}) {
  const git = opts.git || lib.realGit;
  const loc = opts.loc || lib.locate(opts.cwd || process.cwd(), git);
  const env = opts.env || lib.envFor(loc, { git });
  const cfg = env.cfg;
  const now = opts.now || new Date();
  const mainBranch = require("./card").mainBranchOf(cfg, git, loc.top);
  const sha = opts.sha || shaChecker(git, loc.top, mainBranch);
  const caps = (cfg.archive && cfg.archive.caps) || {};
  const capped = [];
  for (const [glob, kb] of Object.entries(caps)) for (const rel of C.expand(loc.top, glob)) if (!/\/archive\//.test(rel)) capped.push({ rel, cap: kb * 1024 });
  const over = (x) => { try { return fs.statSync(path.join(loc.top, x.rel)).size > x.cap; } catch { return false; } };
  const files = opts.files && opts.files.length ? opts.files : capped.filter((x) => opts.all || over(x)).map((x) => x.rel);
  const since = opts.since !== undefined ? opts.since : firstCommitDate(git, loc.top);
  const report = [];
  for (const rel of files) {
    const abs = path.join(loc.top, rel);
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const p = plan(text, { now, days: opts.days || (cfg.archive && cfg.archive.minAgeDays) || 14, sha, re: env.re, protectedRe: env.re.protectedRe, lang: cfg.language, since });
    const res = compute(rel, text, p, now, cfg.language);
    const reasons = {};
    for (const u of p) if (u.action === "keep" && u.kind !== "head") { const k = u.reason.replace(/:.*/, ""); reasons[k] = (reasons[k] || 0) + 1; }
    report.push({ file: rel, before: Buffer.byteLength(text), after: Buffer.byteLength(res.source), moved: res.moved.length, units: p.filter((u) => u.kind !== "head").length, reasons, archives: Object.keys(res.archives) });
    if (opts.apply && res.moved.length) {
      for (const [r, a] of Object.entries(res.archives)) {
        const ap = path.join(loc.top, r);
        fs.mkdirSync(path.dirname(ap), { recursive: true });
        const prev = fs.existsSync(ap) ? fs.readFileSync(ap, "utf8").replace(/\n*$/, "\n\n") : `${a.header}\n`;
        fs.writeFileSync(ap, `${prev}${a.body}\n`);
      }
      fs.writeFileSync(abs, res.source);
    }
  }
  return { report, language: cfg.language };
}

function format(res, applied) {
  const t = T(res.language);
  const kb = (b) => `${(b / 1024).toFixed(1)}KB`;
  return [t.archiveTitle(applied), ...res.report.map((e) => t.archiveLine(e.moved, e.file, kb(e.before), kb(e.after), e.moved, e.units, Object.entries(e.reasons).map(([k, v]) => `${k} ${v}`).join(" · ")))].join("\n");
}

module.exports = { units, unitDate, plan, compute, run, format, shaChecker, archiveFileFor };
