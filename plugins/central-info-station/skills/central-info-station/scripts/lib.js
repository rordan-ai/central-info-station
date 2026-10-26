"use strict";
/**
 * CIS — the index.
 *
 * An index of **references only**: one row per decision · task · log line · memory · rule · handoff · doc section.
 * Each row: id · title · date · status · file:lines · ids it mentions · code files it links to (explicitly, or through a commit).
 * Content is never copied — answers point at the file, and `ctx` reads just the excerpt.
 *
 * 🔒 Read-only: git is read-only (`--no-optional-locks`); nothing is written to the repo. The cache lives in os.tmpdir().
 * ⏱️ The cache rebuilds itself when anything it was built from changed (HEAD · every source's mtime/size · memory · code graph ·
 *    config · this file) ⇒ an answer can never come from a stale index.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const C = require("./config");
const { t: T } = require("./i18n");

const INDEX_VERSION = 1;
const CACHE_DIR = process.env.CIS_CACHE_DIR || path.join(os.tmpdir(), "central-info-station");
const TYPE_WEIGHT = { decision: 1.5, rule: 1.4, memory: 1.2, item: 1.1, handoff: 1.0, section: 0.9, log: 0.7 };
const RED_BONUS = 1.15;
const BODY_CHARS = 400;
const TEST_FILE = /\.(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__)\//i;
const LINK_RELATIONS = new Set(["imports_from", "imports", "calls", "re_exports", "dynamic_import", "indirect_call"]);
const PATH_REF = /(?:^|[\s`'"(\[])((?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]+\.[A-Za-z0-9]{1,6})/gu;
const BACKTICK_FILE = /`([\p{L}\p{N}_.-]+\.[A-Za-z0-9]{1,6})`/gu;
const BACKTICK_SYMBOL = /`([A-Za-z_$][\w$]{5,})(?=[(.`\s<,:\[])/g;
const SHA = /^[0-9a-f]{7,40}$/;
const RED = /🔴|🚫|⛔/;
const DONE = new Set(["done", "cancelled", "superseded", "dropped"]);

// ── helpers ───────────────────────────────────────────────────────────────
const posix = C.posix;
/** markdown ⇒ plain text for display & search */
function clean(s) {
  return String(s || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/<!--.*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/** date ⇒ ISO yyyy-mm-dd. yyyy-mm-dd · dd/mm/yyyy · dd/mm/yy · dd/mm (current year, or last year if that is > 60 days ahead) · dd.mm.yyyy */
function parseDate(s, now = new Date()) {
  const t = String(s || "");
  let m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (!m) return "";
  const d = +m[1], mo = +m[2];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return "";
  let y = m[3] ? +m[3] : now.getFullYear();
  if (m[3] && m[3].length === 2) y += 2000;
  if (m[3] && m[3].length === 3) return "";
  if (!m[3]) {
    const cand = new Date(Date.UTC(y, mo - 1, d));
    if (cand.getTime() - now.getTime() > 60 * 864e5) y -= 1;
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** the latest date mentioned in a text (tie-breaks only) */
function latestDate(s, now) {
  let best = "";
  for (const m of String(s || "").matchAll(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b20\d{2}-\d{2}-\d{2}\b/g)) {
    const d = parseDate(m[0], now);
    if (d && d > best) best = d;
  }
  return best;
}

// ── normalization & tokens (English + Hebrew) ─────────────────────────────
const NIQQUD = /[\u0591-\u05C7]/g;
const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const PREFIX1 = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);
const PREFIX2 = new Set(["וה", "וב", "ול", "ומ", "וש", "שה", "שב", "של", "מה", "כש", "לה", "בה", "כה"]);
const STOP = new Set(
  ("של את על עם זה זו לא כן גם או אם כל מה יש אין הוא היא הם הן אני אתה כמו רק עד אחרי לפני בין כי אבל אז כך יותר פחות עוד " +
    "the and of to in is for on an with or be it this that by are was were as at from not but have has had we you they our its")
    .split(" ")
    .map((w) => w.replace(/[ךםןףץ]/g, (c) => FINALS[c])),
);
function norm(s) {
  return String(s || "").toLowerCase().replace(NIQQUD, "").replace(/[״׳"'`‘’“”]/g, "").replace(/[ךםןףץ]/g, (c) => FINALS[c]);
}
/**
 * Search tokens: the word, plus — for a Hebrew word of 4+ letters — the variant without a one/two-letter prefix (ו ה ב ל מ ש כ, "וה" …)
 * and without a plural suffix (ות/ים); for an English word of 5+ letters — without a trailing "s"/"es"/"ing"/"ed".
 */
function tokens(s) {
  const out = [];
  for (const raw of norm(s).split(/[^0-9a-zא-ת.]+/)) {
    const w = raw.replace(/^\.+|\.+$/g, "");
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w);
    if (/^[א-ת]+$/.test(w) && w.length >= 4) {
      const forms = [w];
      if (w.length >= 5 && PREFIX2.has(w.slice(0, 2))) forms.push(w.slice(2));
      if (PREFIX1.has(w[0])) forms.push(w.slice(1));
      for (const f of forms) {
        if (f !== w) out.push(f);
        if (f.length >= 5 && /(?:ות|ימ)$/.test(f)) out.push(f.slice(0, -2));
      }
    } else if (/^[a-z]+$/.test(w) && w.length >= 5) {
      const stem = w.replace(/(?:ing|ed|es|s)$/, "");
      if (stem !== w && stem.length >= 4) out.push(stem);
    }
  }
  return out;
}

// ── ids ───────────────────────────────────────────────────────────────────
/**
 * Ids in a text: decisions (config `ids.decision`) · extra ids (`ids.extra`, e.g. ticket keys) · plan items that exist.
 * An item id below 10 (`2.8`) counts only after "§" / "item" / "task" / "סעיף" / the plan's name — otherwise "1.5 min" would count.
 */
function idsIn(text, re, itemIds, planNames = []) {
  const t = String(text || "");
  const ids = new Set();
  for (const m of t.matchAll(re.decision)) ids.add(normDecision(m[0]));
  for (const x of re.extra) for (const m of t.matchAll(x)) ids.add(m[0].toUpperCase());
  if (itemIds && itemIds.size) {
    const ctxRe = new RegExp(`(?:${["§", "item", "task", "סעיף", ...planNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))].join("|")})\\s*[^\\s]{0,3}\\s*$`, "i");
    for (const m of t.matchAll(re.item)) {
      const id = m[1];
      if (!itemIds.has(id)) continue;
      if (parseInt(id, 10) >= 10 || ctxRe.test(t.slice(Math.max(0, m.index - 16), m.index))) ids.add(id);
    }
  }
  return [...ids];
}
const normDecision = (id) => String(id).replace(/^~/, "").toUpperCase();

// ── parsers (pure: text in, rows out) ─────────────────────────────────────
/** raw — the original text (with backticks), used only for linking; removed before caching */
function row(o) {
  return {
    id: o.id, type: o.type, title: o.title || "", body: o.body || "", date: o.date || "", status: o.status || "",
    file: o.file, start: o.start, end: o.end || o.start, abs: o.abs, red: !!o.red, ids: o.ids || [], links: [], raw: o.raw,
  };
}
const cells = (ln) => ln.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
const SUPERSEDES = (decSrc) => new RegExp(`(?:\\bsupersed(?:es|ing)\\s+|\\breplac(?:es|ing)\\s+|\\binstead of\\s+|\\boverrides\\s+|מחליפ(?:ה|ים|ות)?\\s+(?:את\\s+)?|במקום\\s+)(${decSrc})`, "gi");
const SUPERSEDED_BY = (decSrc) => new RegExp(`(?:\\bsuperseded by\\s+|\\breplaced by\\s+|הוחלפה?\\s+ב-?\\s*)\\[?(${decSrc})`, "i");
function statusWord(s) {
  const t = String(s || "").toLowerCase();
  if (/supersed|הוחלף/.test(t)) return "superseded";
  if (/deprecat|reject|cancel|withdrawn|revoked|בוטל/.test(t)) return "cancelled";
  if (/propos|draft|pending|open|הצעה|טיוטה/.test(t)) return "open";
  if (/accept|approv|active|adopt|בתוקף|אושר/.test(t)) return "active";
  return "";
}
function linkSupersedes(rows, decSrc) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const re = SUPERSEDES(decSrc);
  for (const r of rows) {
    for (const m of `${r.title} ${r.body}`.matchAll(re)) {
      const old = byId.get(normDecision(m[1]));
      if (old && old !== r && old.status !== "cancelled") { old.supersededBy = r.id; old.status = "superseded"; }
    }
    const by = `${r.title} ${r.body}`.match(SUPERSEDED_BY(decSrc));
    if (by && byId.has(normDecision(by[1])) && normDecision(by[1]) !== r.id) { r.supersededBy = normDecision(by[1]); r.status = "superseded"; }
  }
}

/**
 * Decision log — two shapes, both supported in one file:
 *   table rows `| D12 | title | … | date |` (~~D12~~ ⇒ cancelled; a status cell like "Superseded" is read)
 *   headings  `## D12 — title` / `### DEC-7: title` (status from a "Status:" line; date from the body)
 * "supersedes / replaces / instead of D7" (also Hebrew "מחליפה את D7" / "במקום D7") ⇒ D7 superseded by this one.
 */
function parseDecisions(text, file, cx) {
  const { re, now, cfg } = cx;
  const lines = text.split(/\r?\n/);
  const rows = [];
  const decSrc = cfg.ids.decision;
  const tableRe = new RegExp(`^\\|\\s*(~~)?(${decSrc})(~~)?\\s*\\|`, "i");
  const headRe = new RegExp(`^(#{2,4})\\s+(~~)?(${decSrc})(~~)?\\b[\\s:.—–-]*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m = ln.match(tableRe);
    if (m) {
      const c = cells(ln);
      const struck = !!m[1] || /^~~/.test(c[1] || "");
      const st = c.slice(2).map(statusWord).find(Boolean);
      rows.push(row({
        id: normDecision(m[2]), type: "decision", title: clean(c[1]), body: clean(c.slice(2, -1).join(" ")).slice(0, BODY_CHARS),
        date: parseDate(c[c.length - 1], now) || latestDate(ln, now), status: struck ? "cancelled" : st || "active", file, start: i + 1,
        red: RED.test(ln), ids: idsIn(ln, re).filter((x) => x !== normDecision(m[2])), raw: ln,
      }));
      continue;
    }
    m = ln.match(headRe);
    if (m) {
      const level = m[1].length;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) { const h = lines[j].match(/^(#{1,6})\s/); if (h && h[1].length <= level) { end = j; break; } }
      const body = lines.slice(i + 1, end).join("\n");
      const stLine = body.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:status|סטטוס)(?:\*\*)?\s*:\s*(.+)$/im);
      const struck = !!m[2];
      rows.push(row({
        id: normDecision(m[3]), type: "decision", title: clean(m[5]) || normDecision(m[3]), body: clean(body).slice(0, BODY_CHARS),
        date: parseDate(m[5], now) || latestDate(body.slice(0, 400), now), status: struck ? "cancelled" : (stLine && statusWord(stLine[1])) || "active",
        file, start: i + 1, end, red: RED.test(ln), ids: idsIn(`${ln}\n${body}`, re).filter((x) => x !== normDecision(m[3])), raw: `${ln}\n${body}`,
      }));
    }
  }
  linkSupersedes(rows, decSrc);
  return rows;
}

/** An ADR file (Nygard / MADR): id from the file name (0007-use-x.md ⇒ ADR-0007), title from the H1, status from "Status" / frontmatter. */
function parseAdr(text, file, cx) {
  const { now } = cx;
  const base = path.posix.basename(file);
  const num = (base.match(/^(\d{3,5})-/) || [])[1];
  if (!num) return [];
  const lines = text.split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  const title = h1 >= 0 ? clean(lines[h1].replace(/^#\s+/, "").replace(/^(?:ADR[-\s]?)?\d+[.:\s-]+/i, "")) : base.replace(/^\d+-|\.md$/g, "").replace(/-/g, " ");
  let status = "";
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) { const s = fm[1].match(/^status:\s*(.+)$/im); if (s) status = statusWord(s[1]); }
  if (!status) { const s = text.match(/^\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(.+)$/im); if (s) status = statusWord(s[1]); }
  if (!status) {
    const k = lines.findIndex((l) => /^#{2,3}\s+status\b/i.test(l));
    if (k >= 0) status = statusWord(lines.slice(k + 1, k + 6).join(" "));
  }
  const dateLine = text.match(/^\s*(?:\*\*)?date(?:\*\*)?\s*:\s*(.+)$/im);
  return [row({
    id: `ADR-${num}`, type: "decision", title, body: clean(lines.slice(h1 + 1).join(" ")).slice(0, BODY_CHARS),
    date: (dateLine && parseDate(dateLine[1], now)) || (fm && parseDate((fm[1].match(/^date:\s*(.+)$/im) || [])[1], now)) || "",
    status: status || "active", file, start: 1, end: lines.length, red: RED.test(text.slice(0, 2000)), raw: text,
  })];
}

/**
 * Plan / task list — `- [ ] **3.4** text` · `- [x] 3.4 text` · `- [ ] text` (no id ⇒ file#Lnn), with indented continuation lines.
 * Markers: [ ] open · [~] in progress · [x] done · [!] blocked · [-] dropped. Also a changelog table `| date | sha | kind | what |` ⇒ log rows.
 */
function parsePlan(text, file, cx) {
  const { re, now } = cx;
  const lines = text.split(/\r?\n/);
  const items = [];
  const logs = [];
  const itemRe = new RegExp(`^\\s*[-*] \\[( |x|X|~|!|-)\\]\\s+(?:\\*\\*(${cx.cfg.ids.item})\\*\\*|(${cx.cfg.ids.item})(?=[\\s:.—–-]))?\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(itemRe);
    if (m) {
      let end = i;
      while (end + 1 < lines.length && /^\s{2,}\S/.test(lines[end + 1]) && !/^\s*[-*] \[[ xX~!-]\]/.test(lines[end + 1])) end++;
      const full = lines.slice(i, end + 1).join(" ");
      const rest = clean(full.replace(/^\s*[-*] \[[ xX~!-]\]\s+(?:\*\*[^*]+\*\*)?/, ""));
      const status = { " ": "open", x: "done", X: "done", "~": "in_progress", "!": "blocked", "-": "dropped" }[m[1]];
      const id = m[2] || m[3] || `${file}#L${i + 1}`;
      items.push(row({ id, type: "item", title: rest.slice(0, 160), body: rest.slice(0, BODY_CHARS), date: latestDate(full, now), status, file, start: i + 1, end: end + 1, red: RED.test(full), raw: full }));
      i = end;
      continue;
    }
    const g = ln.match(/^\|\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|20\d{2}-\d{2}-\d{2})\s*\|\s*`?([0-9a-f]{7,40})`?\s*\|\s*([^|]*)\|\s*(.*)\|\s*$/);
    if (g) {
      const t = clean(g[4]);
      logs.push(row({ id: g[2].slice(0, 8), type: "log", title: t.slice(0, 160), body: `${clean(g[3])} · ${t}`.slice(0, BODY_CHARS), date: parseDate(g[1], now), status: clean(g[3]), file, start: i + 1, raw: ln }));
    }
  }
  const itemIds = new Set(items.map((r) => r.id).filter((x) => !x.includes("#")));
  for (const r of [...items, ...logs]) r.ids = idsIn(lines.slice(r.start - 1, r.end).join(" "), re, itemIds).filter((x) => x !== r.id);
  return { items, logs, itemIds };
}

/** Markdown headings ⇒ sections (until the next heading of the same or higher level; ``` fences skipped). Handoff headings ⇒ "handoff". */
function parseSections(text, file, kind, cx) {
  const { re, now } = cx;
  const lines = text.split(/\r?\n/);
  const heads = [];
  let fence = false;
  lines.forEach((ln, i) => {
    if (/^\s*```/.test(ln)) fence = !fence;
    if (fence) return;
    const m = ln.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i + 1 });
  });
  return heads.map((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].line - 1; break; }
    const title = clean(h.title);
    const bodyText = clean(lines.slice(h.line, Math.min(end, h.line + 20)).join(" ")).slice(0, BODY_CHARS);
    const type = kind === "rules" ? "rule" : h.level >= 2 && re.handoff.test(title) ? "handoff" : "section";
    return row({
      id: `${file}#L${h.line}`, type, title, body: bodyText, date: parseDate(title, now) || latestDate(bodyText.slice(0, 120), now),
      status: /historical|archived|היסטורי/i.test(title) ? "historical" : "", file, start: h.line, end, red: RED.test(h.title),
      raw: lines.slice(h.line - 1, Math.min(end, h.line + 20)).join("\n"),
    });
  });
}

/** Agent rules file (CLAUDE.md / AGENTS.md / .cursorrules …) — every bullet is a rule (title = its bold part, or its first 100 chars) */
function parseRules(text, file) {
  const out = [];
  text.split(/\r?\n/).forEach((ln, i) => {
    const m = ln.match(/^[-*] (.+)$/);
    if (!m) return;
    const bold = m[1].match(/\*\*(.+?)\*\*/);
    const t = clean(m[1]);
    out.push(row({ id: `${file}#L${i + 1}`, type: "rule", title: (bold ? clean(bold[1]) : t).slice(0, 100), body: t.slice(0, BODY_CHARS), file, start: i + 1, red: RED.test(ln), raw: ln }));
  });
  return out;
}

/** Claude Code auto-memory: MEMORY.md ⇒ {"<file>.md": {red, label, hook}} */
function parseMemoryIndex(text) {
  const map = {};
  for (const ln of String(text || "").split(/\r?\n/)) {
    const links = [...ln.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)];
    links.forEach((m, k) => {
      const next = links[k + 1] ? links[k + 1].index : ln.length;
      const hook = clean(ln.slice(m.index + m[0].length, next)).replace(/^[—–\-·\s]+/, "");
      map[path.basename(m[2])] = { red: RED.test(m[1]), label: clean(m[1]), hook };
    });
  }
  return map;
}
/** a memory file: frontmatter (name · description · metadata.modified) + body */
function parseMemoryFile(text, abs, display, idx, archived, cx) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const head = fm ? fm[1] : "";
  const get = (k) => {
    const m = head.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "").replace(/\\(["'\\])/g, "$1") : "";
  };
  const body = clean(fm ? text.slice(fm[0].length) : text);
  const file = path.basename(abs);
  const meta = (idx && idx[file]) || {};
  const name = get("name") || file.replace(/\.md$/, "");
  return row({
    id: name, type: "memory", title: clean(get("description") || meta.label || name).slice(0, 200),
    body: `${meta.hook || ""} ${body}`.trim().slice(0, BODY_CHARS), date: parseDate(get("modified"), cx.now),
    status: archived ? "archived" : "active", file: display, abs, start: 1, end: text.split(/\r?\n/).length,
    red: !!meta.red, ids: idsIn(text, cx.re), raw: text,
  });
}

/**
 * Chunks for a long section / memory: after the 400 chars already in the parent row — ~600-char pieces (cut at a blank line after 300+).
 * So a fact deep inside a 15KB section is still found. A chunk points at its own line range; its title is the parent's.
 */
const CHUNK_CHARS = 600;
function chunkRows(parent, lines, now) {
  const out = [];
  const from = parent.type === "memory" ? 1 : parent.start + 1;
  const to = Math.min(lines.length, parent.end);
  let skip = BODY_CHARS;
  let buf = [];
  let size = 0;
  let start = from;
  const flush = (endLine) => {
    const text = clean(buf.join(" "));
    if (text.length >= 40) {
      const c = row({
        id: `${parent.file}#L${start}`, type: parent.type, title: parent.title, body: text.slice(0, CHUNK_CHARS + 200),
        date: latestDate(text, now) || parent.date, status: parent.status, file: parent.file, abs: parent.abs, start, end: endLine, red: parent.red,
        raw: buf.join("\n"),
      });
      c.parent = parent.id;
      out.push(c);
    }
    buf = [];
    size = 0;
  };
  let last = to;
  for (let i = from; i <= to; i++) {
    const ln = lines[i - 1] || "";
    if (/^#{1,4}\s/.test(ln) && i > from) { last = i - 1; break; }
    if (skip > 0) { skip -= ln.length + 1; start = i + 1; continue; }
    if (!buf.length) start = i;
    buf.push(ln);
    size += ln.length + 1;
    if (size >= CHUNK_CHARS || (size >= 300 && !ln.trim())) flush(i);
  }
  if (buf.length) flush(last);
  return out;
}

// ── edit map: what to show when a file is about to be edited ───────────────
const EDIT_TYPES = new Set(["decision", "rule", "memory"]);
const EDIT_SPEC_MAX = 8;
const EDIT_COMMIT_MAX = 2;
const EDIT_HUB_MAX = 6;
const EDIT_LINE_CHARS = 100;
const EDIT_ORDER = { decision: 0, rule: 1, memory: 2 };
const editRank = (x) => [EDIT_ORDER[x.r.type] * 2 + (x.r.type === "memory" && !x.r.red ? 1 : 0), -(x.mention ? x.mention.score : 0), x.n, -(Number((x.r.date || "0").replace(/-/g, "")) || 0)];
const byRank = (a, b) => { const ra = editRank(a), rb = editRank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; };
/** how strong a rule sentence is: 🔴/🔒/🚫 ⇒ 2 · never / must not / do not / always / required / forbidden (and Hebrew) ⇒ 1 */
const mentionScore = (t) => (/🔴|🔒|🚫|⛔/.test(t) ? 2 : /\b(never|must not|do not|don't|always|required|forbidden|mandatory)\b|אסור|לעולם|לא לגעת|חובה/i.test(t) ? 1 : 0);
/** the line in the raw text that mentions the token ⇒ {line, text, score}; the strongest mention wins, ties ⇒ the first */
function mentionOf(raw, startLine, token) {
  if (!raw || !token) return null;
  const lines = String(raw).split("\n");
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(token)) continue;
    const text = clean(lines[i]).replace(/^(?:[-*>]|\d+\.)\s+/, "").replace(/(?:[\w.-]+\/)+([\w.-]+\.[a-z]{1,5})/g, "$1");
    if (!text) continue;
    const m = { line: startLine + i, text, score: mentionScore(lines[i]) };
    if (!best || m.score > best.score) best = m;
  }
  return best;
}
const strongerMention = (a, b) => (!a ? b : !b ? a : b.score > a.score ? b : a);
function editLine(r, mention, lang) {
  const t = T(lang);
  const where = r.type === "memory" ? r.id : `${r.file}:L${mention ? mention.line : r.start}`;
  const id = r.type === "decision" ? `${r.id} · ` : "";
  const head = `${t.editPrefix} · ${t.type[r.type]}${r.type === "memory" && r.red ? " 🔴" : ""} ${id}`;
  const body = (mention ? mention.text : r.title).replace(/^🔴\s*/, "");
  const room = Math.max(24, EDIT_LINE_CHARS - head.length - where.length - 3);
  const txt = body.length > room ? `${body.slice(0, room - 1)}…` : body;
  return `${head}${txt} (${where})`;
}
/**
 * file ⇒ up to N lines: an active decision (explicit, or a focused commit carrying its id) · a rule (explicit) · an active memory (explicit).
 * Explicit before commit-linked · decision > rule > memory · newest first. Superseded / cancelled / archived never; "hub" rows
 * linked to more than 6 files are noise, not context, and are dropped.
 */
function buildEditMap(rows, cx) {
  const maxLines = (cx.cfg.edit && cx.cfg.edit.maxLines) || 3;
  const byFile = new Map();
  for (const r of rows) {
    if (!r.editFiles || !r.editFiles.size || r.parent) continue;
    if (r.type === "decision" && (r.supersededBy || r.status === "cancelled" || r.status === "superseded")) continue;
    if (r.type === "memory" && r.status === "archived") continue;
    const n = [...r.editFiles.values()].filter(Boolean).length || r.editFiles.size;
    for (const [f, explicitLink] of r.editFiles) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push({ r, explicitLink, n, mention: r.editMentions ? r.editMentions.get(f) : null });
    }
  }
  const freq = new Map();
  for (const list of byFile.values()) for (const { r } of list) freq.set(r, (freq.get(r) || 0) + 1);
  const files = {};
  for (const [f, raw] of byFile) {
    const all = raw.filter((x) => freq.get(x.r) <= EDIT_HUB_MAX);
    const explicitOnes = all.filter((x) => x.explicitLink).sort(byRank);
    const viaCommit = cx.re.code.test(f) ? all.filter((x) => !x.explicitLink).sort((a, b) => (b.r.date || "").localeCompare(a.r.date || "")).slice(0, EDIT_COMMIT_MAX) : [];
    const seen = new Set();
    const out = [];
    for (const { r, mention } of [...explicitOnes, ...viaCommit]) {
      const id = r.type === "rule" ? `${r.file}#L${mention ? mention.line : r.start}` : r.id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, text: editLine(r, mention, cx.cfg.language) });
      if (out.length >= maxLines) break;
    }
    if (out.length) files[f] = out;
  }
  // folders: a decision / rule / memory naming a folder covers the files in it (a row naming more than 6 folders is noise)
  const byDir = new Map();
  for (const r of rows) {
    if (!r.editDirs || !r.editDirs.size || r.parent || r.editDirs.size > EDIT_HUB_MAX) continue;
    if (r.type === "decision" && (r.supersededBy || r.status === "cancelled" || r.status === "superseded")) continue;
    if (r.type === "memory" && r.status === "archived") continue;
    for (const [d, mention] of r.editDirs) { if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push({ r, explicitLink: true, n: r.editDirs.size, mention }); }
  }
  const dirs = {};
  for (const [d, list] of byDir) {
    const seen = new Set();
    const out = [];
    for (const { r, mention } of list.sort(byRank)) {
      const id = r.type === "rule" ? `${r.file}#L${mention ? mention.line : r.start}` : r.id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, text: editLine(r, mention, cx.cfg.language) });
      if (out.length >= maxLines) break;
    }
    if (out.length) dirs[d] = out;
  }
  return { files, dirs };
}

/** git log --no-merges ⇒ commits {sha, date, subject, files} (code files only — docs never link to themselves) */
function parseGitLog(out, isDoc) {
  const commits = [];
  for (const block of String(out || "").split("\x1e")) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const [sha, date, ...subj] = lines[0].split("\t");
    if (!SHA.test(sha || "")) continue;
    commits.push({ sha: sha.slice(0, 8), date, subject: subj.join("\t"), files: lines.slice(1).map((f) => posix(f.trim())).filter((f) => f && !isDoc(f)) });
  }
  return commits;
}

/**
 * Links to code: (1) explicit — a path / a `file.ext` in backticks / a code-graph symbol in the text ⇒ specificity 0;
 * (2) through a commit — the row's id (or an extra id it mentions) in a commit subject ⇒ specificity = how many files that id touched.
 */
function linkRows(rows, commits, cx, tracked, symbols) {
  const { re, itemIds, isDoc } = cx;
  const idFiles = new Map();
  const idCommits = new Map();
  for (const c of commits) {
    for (const id of idsIn(c.subject, re, itemIds)) {
      if (!idFiles.has(id)) idFiles.set(id, new Set());
      for (const f of c.files) idFiles.get(id).add(f);
      if (!idCommits.has(id)) idCommits.set(id, []);
      if (idCommits.get(id).length < 5) idCommits.get(id).push(c.sha);
    }
  }
  const byBase = new Map();
  for (const f of tracked) { const b = path.posix.basename(f); byBase.set(b, byBase.has(b) ? null : f); }
  const trackedSet = new Set(tracked);
  const explicit = (text) => {
    const found = new Map();
    const put = (f, token) => { if (f && !found.has(f)) found.set(f, token); };
    for (const m of String(text || "").matchAll(PATH_REF)) if (trackedSet.has(m[1])) put(m[1], m[1]);
    for (const m of String(text || "").matchAll(BACKTICK_FILE)) put(byBase.get(m[1]), m[1]);
    if (symbols) for (const m of String(text || "").matchAll(BACKTICK_SYMBOL)) { const fs_ = symbols[m[1]]; if (fs_) for (const f of fs_) put(f, m[1]); }
    return [...found].filter(([f]) => !isDoc(f)).map(([f, token]) => [f, 0, token]);
  };
  // a folder named in backticks (`db/migrations/`) that holds tracked code ⇒ the rule covers every file in it
  const dirSet = new Set();
  for (const f of tracked) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) dirSet.add(`${parts.slice(0, i).join("/")}/`); }
  const explicitDirs = (text) => {
    const found = new Map();
    for (const m of String(text || "").matchAll(/`((?:[\p{L}\p{N}_.-]+\/)+)`/gu)) if (dirSet.has(m[1]) && !found.has(m[1])) found.set(m[1], m[1]);
    return found;
  };
  cx.explicitDirs = explicitDirs;
  const extraIdRe = re.extraExact;
  for (const r of rows) {
    const links = new Map();
    const add = (f, spec) => { if (!f || isDoc(f)) return; if (!links.has(f) || links.get(f) > spec) links.set(f, spec); };
    const exp = explicit(r.raw !== undefined ? r.raw : `${r.title} ${r.body}`);
    for (const [f] of exp) add(f, 0);
    if (EDIT_TYPES.has(r.type)) {
      r.editFiles = new Map(exp.map(([f]) => [f, true]));
      r.editMentions = new Map();
      r.editDirs = new Map();
      for (const [d, token] of explicitDirs(r.raw)) r.editDirs.set(d, r.type === "rule" ? mentionOf(r.raw, r.start, token) : null);
      if (r.type === "rule") for (const [f, , token] of exp) { const m = mentionOf(r.raw, r.start, token); if (m) r.editMentions.set(f, m); }
      const set = r.type === "decision" ? idFiles.get(r.id) : null;
      if (set && set.size <= EDIT_SPEC_MAX) for (const f of set) if (!r.editFiles.has(f) && !isDoc(f)) r.editFiles.set(f, false);
    }
    const own = r.type === "log" ? [] : [r.id, ...r.ids.filter((x) => extraIdRe.some((e) => e.test(x)))];
    if (r.type === "log") { const c = commits.find((x) => x.sha === r.id); if (c) for (const f of c.files) add(f, c.files.length); }
    const commitsOf = [];
    for (const id of own) {
      const set = idFiles.get(id);
      if (!set) continue;
      for (const f of set) add(f, set.size);
      for (const s of idCommits.get(id) || []) if (!commitsOf.includes(s)) commitsOf.push(s);
    }
    r.links = [...links.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 15);
    r.commits = commitsOf.slice(0, 5);
  }
  return { explicit };
}

/** code graph (graphify graph.json: nodes {id, label, source_file}, links {source, target, relation}) ⇒ per-file importers/tests/deps + symbol ⇒ files (≤3) */
function compactGraph(graph) {
  const fileOf = new Map();
  const symbolFiles = new Map();
  for (const n of graph.nodes || []) {
    if (!n.source_file) continue;
    const f = posix(n.source_file);
    fileOf.set(n.id, f);
    const label = String(n.label || "");
    if (n._callable || /\(\)$/.test(label)) {
      const name = label.replace(/\(\)$/, "");
      if (/^[A-Za-z_$][\w$]{5,}$/.test(name)) { if (!symbolFiles.has(name)) symbolFiles.set(name, new Set()); symbolFiles.get(name).add(f); }
    }
  }
  const files = {};
  const get = (f) => (files[f] = files[f] || { importers: new Set(), deps: new Set() });
  for (const l of graph.links || graph.edges || []) {
    if (!LINK_RELATIONS.has(l.relation)) continue;
    const a = fileOf.get(l.source);
    const b = fileOf.get(l.target);
    if (!a || !b || a === b) continue;
    get(b).importers.add(a);
    get(a).deps.add(b);
  }
  const outFiles = {};
  for (const [f, v] of Object.entries(files)) {
    const importers = [...v.importers].sort();
    outFiles[f] = { importers: importers.filter((x) => !TEST_FILE.test(x)), tests: importers.filter((x) => TEST_FILE.test(x)), deps: [...v.deps].sort() };
  }
  const symbols = {};
  for (const [name, set] of symbolFiles) if (set.size <= 3) symbols[name] = [...set];
  return { files: outFiles, symbols, builtAt: String(graph.built_at_commit || "").slice(0, 8) };
}

// ── location & sources ────────────────────────────────────────────────────
function realGit(args, cwd) {
  return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20, windowsHide: true }).trimEnd();
}
/** top (this worktree or the main checkout) · mainRoot (from the common dir — shared by all worktrees) · branch · head — one git call */
function locate(start = process.cwd(), git = realGit) {
  const [topRaw, commonRaw, head, branch] = git(["rev-parse", "--show-toplevel", "--git-common-dir", "HEAD", "--abbrev-ref", "HEAD"], start).split(/\r?\n/);
  const top = path.resolve(topRaw);
  const common = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(start, commonRaw);
  return { top, mainRoot: path.dirname(path.resolve(common)), branch, head };
}
/** Claude Code's per-project auto-memory folder (keyed by the main checkout, so all worktrees share it) */
function memoryDir(mainRoot, cfg) {
  if (process.env.CIS_MEMORY_DIR) return process.env.CIS_MEMORY_DIR;
  const m = cfg ? cfg.memory : "auto";
  if (m === false || m === "off") return null;
  if (typeof m === "string" && m !== "auto") return path.resolve(mainRoot, m.replace(/^~(?=$|[\\/])/, os.homedir()));
  return path.join(os.homedir(), ".claude", "projects", path.resolve(mainRoot).replace(/[^A-Za-z0-9]/g, "-"), "memory");
}
function findGraph(top, cfg) {
  const g = cfg ? cfg.graph : "auto";
  if (g === false || g === "off") return null;
  if (typeof g === "string" && g !== "auto") { const p = path.resolve(top, g); return fs.existsSync(p) ? p : null; }
  let d = top;
  for (let i = 0; i < 4 && d; i++) {
    const p = path.join(d, "graphify-out", "graph.json");
    if (fs.existsSync(p)) return p;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
function memorySources(memDir) {
  if (!memDir) return [];
  const out = [];
  for (const f of ls(memDir)) if (f.endsWith(".md") && f !== "MEMORY.md") out.push({ abs: path.join(memDir, f), display: `memory/${f}`, archived: false });
  for (const f of ls(path.join(memDir, "_archive"))) if (f.endsWith(".md")) out.push({ abs: path.join(memDir, "_archive", f), display: `memory/_archive/${f}`, archived: true });
  return out;
}
/** per-project local state shared by all worktrees, git-ignored: <main checkout>/.cis/local/ */
const localDir = (mainRoot) => path.join(mainRoot, C.CONFIG_DIR, "local");

// ── cache & build ─────────────────────────────────────────────────────────
const statSig = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}|${s.size}`; } catch { return "-"; } };
function cacheKey(env) {
  const h = crypto.createHash("sha1");
  h.update(`v${INDEX_VERSION}|${env.head}|lib|${statSig(__filename)}|cfg|${statSig(env.configFile)}|`);
  for (const s of env.sources) h.update(`${s.rel}|${statSig(path.join(env.top, s.rel))}\n`);
  if (env.memDir) {
    h.update(`mem|${statSig(env.memDir)}|${statSig(path.join(env.memDir, "MEMORY.md"))}\n`);
    for (const m of memorySources(env.memDir)) h.update(`${m.display}|${statSig(m.abs)}\n`);
  }
  h.update(`graph|${env.graphPath ? statSig(env.graphPath) : "-"}`);
  return h.digest("hex");
}
const cachePath = (top) => path.join(CACHE_DIR, `${crypto.createHash("sha1").update(path.resolve(top).toLowerCase()).digest("hex").slice(0, 12)}.json`);

/** the build environment for a location: config, sources, memory, graph */
function envFor(loc, opts = {}) {
  const conf = opts.conf || C.loadConfig(loc.top, { git: opts.git || realGit });
  return {
    top: loc.top, mainRoot: loc.mainRoot, head: loc.head, cfg: conf.config, re: conf.re, configFile: conf.file,
    sources: C.listSources(loc.top, conf.config),
    memDir: opts.memDir !== undefined ? opts.memDir : memoryDir(loc.mainRoot, conf.config),
    graphPath: opts.graphPath !== undefined ? opts.graphPath : findGraph(loc.top, conf.config),
    git: opts.git || realGit, now: opts.now,
  };
}

function buildIndex(env) {
  const now = env.now || new Date();
  const git = env.git || realGit;
  const { cfg, re } = env;
  const sourceSet = new Set(env.sources.map((s) => s.rel));
  const isDoc = (f) => sourceSet.has(f) || /\.(md|mdx|mdc|txt|rst|adoc)$/i.test(f);
  const read = (rel) => { try { return fs.readFileSync(path.join(env.top, rel), "utf8"); } catch { return ""; } };
  const cx = { re, cfg, now, isDoc, itemIds: new Set() };
  const rows = [];
  const planNames = [];
  for (const s of env.sources) {
    const text = read(s.rel);
    if (s.kind === "decisions") rows.push(...parseDecisions(text, s.rel, cx), ...parseSections(text, s.rel, "docs", cx).filter((r) => r.type === "handoff"));
    else if (s.kind === "adr") rows.push(...parseAdr(text, s.rel, cx));
    else if (s.kind === "plan") {
      const p = parsePlan(text, s.rel, cx);
      for (const id of p.itemIds) cx.itemIds.add(id);
      planNames.push(path.posix.basename(s.rel).replace(/\.[^.]+$/, ""));
      rows.push(...p.items, ...p.logs);
    } else if (s.kind === "rules") rows.push(...parseRules(text, s.rel), ...parseSections(text, s.rel, "rules", cx));
    else rows.push(...parseSections(text, s.rel, s.kind, cx));
  }
  for (const r of rows) if (r.type === "section" || r.type === "rule" || r.type === "handoff") r.ids = idsIn(`${r.title} ${r.body}`, re, cx.itemIds, planNames);
  let memIdx = {};
  if (env.memDir) try { memIdx = parseMemoryIndex(fs.readFileSync(path.join(env.memDir, "MEMORY.md"), "utf8")); } catch { /* no index */ }
  for (const m of memorySources(env.memDir)) {
    try { rows.push(parseMemoryFile(fs.readFileSync(m.abs, "utf8"), m.abs, m.display, memIdx, m.archived, cx)); } catch { /* unreadable */ }
  }
  let graph = { files: {}, symbols: {}, builtAt: "" };
  if (env.graphPath) try { graph = compactGraph(JSON.parse(fs.readFileSync(env.graphPath, "utf8"))); } catch { /* unreadable ⇒ none */ }
  let commits = [];
  let tracked = [];
  try { commits = parseGitLog(git(["log", "--no-merges", "--date=short", "--format=%x1e%h%x09%ad%x09%s", "--name-only", "-n", "5000", "HEAD"], env.top), isDoc); } catch { /* no history */ }
  try { tracked = git(["ls-files"], env.top).split("\n").map((f) => posix(f.trim())).filter(Boolean); } catch { /* no list */ }
  const { explicit } = linkRows(rows, commits, cx, tracked, graph.symbols);
  const linesOf = new Map();
  const getLines = (r) => {
    const k = r.abs || r.file;
    if (!linesOf.has(k)) { try { linesOf.set(k, fs.readFileSync(r.abs || path.join(env.top, r.file), "utf8").split(/\r?\n/)); } catch { linesOf.set(k, []); } }
    return linesOf.get(k);
  };
  const chunks = [];
  for (const r of rows) {
    if (!["section", "handoff", "rule", "memory", "decision"].includes(r.type)) continue;
    if (r.type === "decision" && r.end === r.start) continue;
    for (const c of chunkRows(r, getLines(r), now)) {
      const own = explicit(c.raw);
      if (r.editFiles) for (const [f, , token] of own) {
        r.editFiles.set(f, true);
        if (r.type === "rule") { const m = strongerMention(r.editMentions.get(f), mentionOf(c.raw, c.start, token)); if (m) r.editMentions.set(f, m); }
      }
      if (r.editDirs && cx.explicitDirs) for (const [d, token] of cx.explicitDirs(c.raw)) r.editDirs.set(d, strongerMention(r.editDirs.get(d), r.type === "rule" ? mentionOf(c.raw, c.start, token) : null));
      const seen = new Set(own.map(([f]) => f));
      c.links = [...own, ...r.links.filter(([f, s]) => s > 0 && !seen.has(f))].slice(0, 15);
      c.ids = idsIn(c.raw, re, cx.itemIds, planNames);
      chunks.push(c);
    }
  }
  rows.push(...chunks);
  const edit = cfg.edit && cfg.edit.enabled === false ? { files: {}, dirs: {} } : buildEditMap(rows, cx);
  for (const r of rows) { delete r.raw; delete r.editFiles; delete r.editMentions; delete r.editDirs; }
  for (const r of rows) r.tok = tokens(r.parent ? `${r.title} ${r.body}` : `${r.title} ${r.title} ${r.title} ${r.id} ${r.body}`).join(" ");
  return {
    version: INDEX_VERSION, head: env.head, builtAt: now.toISOString(), top: posix(env.top), memDir: env.memDir ? posix(env.memDir) : null,
    language: cfg.language, graphBuiltAt: graph.builtAt, rows, edit, graph: { files: graph.files, symbols: graph.symbols },
    commits: commits.slice(0, 4000).map((c) => ({ sha: c.sha, date: c.date, subject: c.subject.slice(0, 200), files: c.files.slice(0, 10), n: c.files.length })),
    tracked,
  };
}

const metaPath = (file) => `${file}.meta.json`;
const editPath = (file) => `${file}.edit.json`;
function readMeta(top, cacheFile) {
  try { return JSON.parse(fs.readFileSync(metaPath(cacheFile || cachePath(top)), "utf8")); } catch { return null; }
}
/** the cached index as is — even if stale (session start: show now, rebuild in the background); none ⇒ null */
function readCachedIndex(top, cacheFile) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile || cachePath(top), "utf8"));
    return c && c.index && c.index.version === INDEX_VERSION ? c.index : null;
  } catch { return null; }
}
/** is the cache fresh — the exact key loadIndex uses, without building */
function freshness(opts = {}) {
  const git = opts.git || realGit;
  const loc = opts.loc || locate(opts.cwd || process.cwd(), git);
  const env = envFor(loc, { ...opts, git });
  const meta = readMeta(loc.top, opts.cacheFile);
  const key = cacheKey(env);
  return { loc, env, meta, key, fresh: !!meta && meta.key === key };
}
/** the index — from the cache when the key matches, else built and saved. {index, fromCache, ms, loc, env} */
function loadIndex(opts = {}) {
  const t0 = Date.now();
  const git = opts.git || realGit;
  const loc = opts.loc || locate(opts.cwd || process.cwd(), git);
  const env = opts.env || envFor(loc, { ...opts, git });
  const key = cacheKey(env);
  const file = opts.cacheFile || cachePath(loc.top);
  if (!opts.force) {
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      if (c.key === key && c.index && c.index.version === INDEX_VERSION) return { index: c.index, fromCache: true, ms: Date.now() - t0, loc, env };
    } catch { /* no cache */ }
  }
  const index = buildIndex(env);
  const ms = Date.now() - t0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = (p, data) => { const tmp = `${p}.${process.pid}.tmp`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, p); };
    write(file, JSON.stringify({ key, index }));
    write(metaPath(file), JSON.stringify({ key, head: index.head, builtAt: index.builtAt, rows: index.rows.length, ms, top: index.top, graphBuiltAt: index.graphBuiltAt }));
    write(editPath(file), JSON.stringify({ key, head: index.head, top: index.top, files: (index.edit && index.edit.files) || {}, dirs: (index.edit && index.edit.dirs) || {} }));
  } catch { /* the cache is optional */ }
  return { index, fromCache: false, ms, loc, env };
}

// ── query & ranking ───────────────────────────────────────────────────────
const isSha = (q) => SHA.test(q);
function exactKind(q, re) {
  if (re.decisionExact.test(q)) return "decision";
  if (re.itemExact.test(q)) return "item";
  if (re.extraExact.some((x) => x.test(q))) return "extra";
  if (isSha(q)) return "sha";
  return null;
}
const normId = (q, kind) => (kind === "decision" ? normDecision(q) : kind === "extra" ? q.toUpperCase() : q.toLowerCase());

/** a file / symbol in the query ⇒ tracked paths (full path · path suffix · unique base name · code-graph symbol) */
function resolveFiles(index, q) {
  const t = posix(q.trim().replace(/^`|`$/g, "").replace(/\(\)$/, ""));
  const tracked = index.tracked || [];
  if (!t || /\s/.test(t)) return [];
  if (tracked.includes(t)) return [t];
  if (t.includes("/")) return tracked.filter((f) => f.endsWith(`/${t}`) || f.endsWith(t)).slice(0, 3);
  if (/\.[a-z0-9]{1,6}$/i.test(t)) return tracked.filter((f) => path.posix.basename(f) === t).slice(0, 3);
  const sym = index.graph && index.graph.symbols && index.graph.symbols[t];
  return sym ? sym.slice(0, 3) : [];
}

function bm25(rows, qTokens) {
  const k1 = 1.2, b = 0.75;
  const N = rows.length || 1;
  const toks = rows.map((r) => (Array.isArray(r.tok) ? r.tok : String(r.tok || "").split(" ").filter(Boolean)));
  const avg = toks.reduce((s, x) => s + x.length, 0) / N || 1;
  const uniq = [...new Set(qTokens)];
  const df = new Map(uniq.map((x) => [x, 0]));
  const tfs = toks.map((tk) => {
    const tf = new Map();
    for (const x of tk) if (df.has(x)) tf.set(x, (tf.get(x) || 0) + 1);
    for (const x of tf.keys()) df.set(x, df.get(x) + 1);
    return tf;
  });
  return rows.map((r, i) => {
    let s = 0;
    for (const x of uniq) {
      const f = tfs[i].get(x);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(x) + 0.5) / (df.get(x) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avg)));
    }
    return s;
  });
}

/**
 * query ⇒ {hits: [{row, score, why}], total, files, mode}. Order: exact id ⇒ link to the asked file/symbol (explicit first) ⇒ BM25 × type weight.
 * A superseded / cancelled row is never first unless asked by its exact id — and then the row that replaces it comes right after.
 */
function query(index, q, { n = 5, re } = {}) {
  const rx = re || C.compile(C.merge(C.DEFAULTS, {}));
  const lang = index.language;
  const W = T(lang).why;
  const rows = index.rows;
  const words = String(q || "").trim().split(/\s+/).filter(Boolean);
  const exact = new Set();
  for (const w of words) { const k = exactKind(w, rx); if (k) exact.add(normId(w, k)); }
  const isExactWord = (w) => !!exactKind(w, rx);
  const fileWords = words.filter((w) => resolveFiles(index, w).length);
  const files = [...new Set(fileWords.flatMap((w) => resolveFiles(index, w)))];
  const fileSet = new Set(files);
  const literal = fileWords.map((w) => tokens(path.posix.basename(posix(w).replace(/^`|`$/g, "").replace(/\(\)$/, "")))).filter((x) => x.length);
  const hasLiteral = (r) => { const s = ` ${Array.isArray(r.tok) ? r.tok.join(" ") : r.tok} `; return literal.some((ts) => ts.every((x) => s.includes(` ${x} `))); };
  const qTok = tokens(words.filter((w) => !isExactWord(w)).join(" "));
  const lexical = qTok.length ? bm25(rows, qTok) : rows.map(() => 0);
  const shaWords = [...exact].filter(isSha);
  const scored = rows.map((r, i) => {
    let score = 0;
    const why = [];
    const w = (TYPE_WEIGHT[r.type] || 1) * (r.red ? RED_BONUS : 1) * (/archived|historical/.test(r.status) ? 0.8 : 1);
    const idKey = r.type === "decision" ? normDecision(r.id) : /^[A-Z]+-\d/.test(r.id) ? r.id.toUpperCase() : String(r.id).toLowerCase();
    if (exact.has(idKey) || (r.type === "log" && shaWords.some((x) => r.id.startsWith(x.slice(0, 8))))) { score += 1000; why.push(W.id); }
    if (fileSet.size) {
      let l = r.links.find(([f]) => fileSet.has(f));
      if ((!l || l[1] > 0) && hasLiteral(r)) l = [files[0], 0];
      if (l) { score += 300 + (l[1] === 0 ? 100 : Math.max(0, 80 - l[1] * 4)) + 20 * w; why.push(l[1] === 0 ? W.explicit : W.commit(l[1])); }
    }
    if (lexical[i] > 0) { score += lexical[i] * w; why.push(W.text); }
    const dead = r.supersededBy || r.status === "cancelled" || r.status === "superseded";
    if (score > 0 && dead && !why.includes(W.id)) score *= 0.5;
    if (score > 0 && r.date) score += Number(r.date.replace(/-/g, "")) / 1e10;
    return { row: r, score, why };
  });
  let hits = scored.filter((h) => h.score > 0).sort((a, b) => b.score - a.score);
  const perFile = new Map();
  const perUnit = new Set();
  hits = hits.filter((h) => {
    if (h.why.includes(W.id)) return true;
    const unit = h.row.parent || h.row.id;
    if (perUnit.has(unit)) return false;
    const key = h.row.file.replace(/#.*$/, "");
    const c = perFile.get(key) || 0;
    if (c >= (h.row.type === "memory" ? 1 : 2)) return false;
    perUnit.add(unit);
    perFile.set(key, c + 1);
    return true;
  });
  const deadRow = (r) => r.supersededBy || r.status === "cancelled" || r.status === "superseded";
  if (hits.length > 1 && deadRow(hits[0].row) && !hits[0].why.includes(W.id)) {
    const k = hits.findIndex((h) => !deadRow(h.row));
    if (k > 0) hits.unshift(hits.splice(k, 1)[0]);
  }
  const top = hits[0] && hits[0].row;
  if (top && top.supersededBy) {
    const k = hits.findIndex((h) => h.row.type === "decision" && h.row.id === top.supersededBy);
    const rep = k >= 0 ? hits.splice(k, 1)[0] : { row: rows.find((r) => r.type === "decision" && r.id === top.supersededBy), score: 0, why: [W.replaces] };
    if (rep.row) hits.splice(1, 0, rep);
  }
  return { hits: hits.slice(0, n), total: hits.length, files, mode: exact.size ? "id" : files.length ? "file" : "text" };
}

/** the exact excerpt of a row: up to maxLines lines, each ≤240 chars */
function snippet(index, r, maxLines = 12) {
  try {
    const lines = fs.readFileSync(r.abs || path.join(index.top, r.file), "utf8").split(/\r?\n/);
    let from = Math.max(1, r.start);
    if (r.type === "memory" && !r.parent && lines[0] === "---") {
      const close = lines.indexOf("---", 1);
      if (close > 0) from = close + 2;
      while (from < lines.length && !lines[from - 1].trim()) from++;
    }
    const to = Math.min(lines.length, r.end || r.start, from + maxLines - 1);
    return lines.slice(from - 1, to).map((l) => (l.length > 240 ? `${l.slice(0, 239)}…` : l));
  } catch {
    return [];
  }
}
const ref = (r) => `${r.file}:L${r.start}${r.end && r.end !== r.start ? `-${r.end}` : ""}`;
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
function statusText(r, lang) {
  const t = T(lang);
  if (r.supersededBy) return t.supersededBy(r.supersededBy);
  return t.status[r.status] || r.status || "";
}

/** ctx output — at most maxBytes (3KB): the hits + a code-graph line per asked file + the excerpt of the first */
function formatQuery(index, q, res, maxBytes = 3000) {
  const t = T(index.language);
  const head = [t.ctxHead(short(q, 60), res.hits.length, res.total, String(index.head).slice(0, 8))];
  for (const f of res.files.slice(0, 2)) {
    const g = index.graph.files[f];
    head.push(g ? t.ctxGraph(f, g.importers.length, g.importers.length ? ` (${g.importers.slice(0, 3).map((x) => path.posix.basename(x)).join(" · ")}${g.importers.length > 3 ? " · …" : ""})` : "", g.tests.length, g.deps.length) : t.ctxGraphNone(f));
  }
  if (!res.hits.length) head.push(t.ctxNone);
  const list = res.hits.map((h, i) => {
    const r = h.row;
    const st = statusText(r, index.language);
    return `${i + 1}. [${t.type[r.type]}${r.red ? "🔴" : ""}] ${short(r.id, 48)} · ${short(r.title, 90)}${st ? ` · ${st}` : ""} · ${ref(r)}${h.why.length ? ` (${h.why.join(", ")})` : ""}`;
  });
  let snip = res.hits[0] ? [t.ctxExcerpt(ref(res.hits[0].row)), ...snippet(index, res.hits[0].row)] : [];
  const assemble = () => [...head, ...list, ...snip].join("\n");
  let out = assemble();
  while (Buffer.byteLength(out, "utf8") > maxBytes && snip.length > 1) { snip.pop(); out = assemble(); }
  while (Buffer.byteLength(out, "utf8") > maxBytes && list.length > 1) { list.pop(); out = assemble(); }
  if (Buffer.byteLength(out, "utf8") > maxBytes) out = Buffer.from(out, "utf8").subarray(0, maxBytes - 3).toString("utf8").replace(/\uFFFD$/, "") + "…";
  return out;
}

module.exports = {
  INDEX_VERSION, TYPE_WEIGHT, CACHE_DIR, DONE,
  clean, parseDate, latestDate, norm, tokens, idsIn, normDecision,
  parseDecisions, parseAdr, parsePlan, parseSections, parseRules, parseMemoryIndex, parseMemoryFile, chunkRows, parseGitLog, linkRows, compactGraph,
  realGit, locate, memoryDir, findGraph, memorySources, localDir, cacheKey, cachePath, envFor, buildIndex, loadIndex,
  metaPath, editPath, readMeta, readCachedIndex, freshness, buildEditMap, editLine, mentionOf,
  exactKind, resolveFiles, bm25, query, snippet, ref, short, statusText, formatQuery,
};
