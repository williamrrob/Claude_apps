// Build / refresh the word-review ledger used to audit every breakdown across
// multiple sessions. For each vocabulary word it records the breakdown the app
// actually shows, where it comes from, suspicion flags, and a frequency rank,
// then writes one ledger file per first letter under review/ plus a STATUS.md
// summary and a QUEUE.tsv of the highest-priority words still to review.
//
// The ledger is the persistent progress store: a word's "st" (status) is only
// ever set to ok/fixed by a human-reviewed pass; re-running this script
// PRESERVES existing statuses and only (re)classifies new/auto words. Frequency
// ranks are baked in so later sessions don't need the external frequency list.
//
// Run:  node scripts/build-review-ledger.js   [path-to-frequency-list]

"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const REVIEW = path.join(ROOT, "review");
const engine = require(path.join(ROOT, "engine.js"));
const curated = JSON.parse(fs.readFileSync(path.join(__dirname, "curated-breakdowns.json"), "utf8")).words;

const isStray = (p) => p.surface.length === 1 && p.kind !== "linker";

// load vocab
const vocab = {};
for (const f of fs.readdirSync(WORDS)) if (f.endsWith(".json")) Object.assign(vocab, JSON.parse(fs.readFileSync(path.join(WORDS, f))));
const words = Object.keys(vocab).sort();

// load human decisions (the authoritative record of words personally reviewed).
// review/decisions.log is append-only JSONL: {"w","st":"ok"|"fixed","note"}.
const prior = {};
const decLog = path.join(REVIEW, "decisions.log");
if (fs.existsSync(decLog)) {
  for (const line of fs.readFileSync(decLog, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.st === "ok" || r.st === "fixed") prior[r.w] = { st: r.st, note: r.note };
  }
}

// Frequency ranks. review/ranks.tsv is the ONE tracked rank store (the .jsonl
// ledgers are derived from shards + decisions.log + ranks.tsv, so they stay
// untracked). Sources, in order: ranks.tsv, then any prior ledger's baked
// ranks (legacy), then an external frequency list. Whatever we end up with is
// written back to ranks.tsv at the bottom so new sources persist.
const rank = {};
const freqPath = process.argv[2] || "/tmp/count_1w.txt";
const ranksPath = path.join(REVIEW, "ranks.tsv");
if (fs.existsSync(ranksPath)) {
  for (const line of fs.readFileSync(ranksPath, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const i = line.lastIndexOf("\t");
    const w = line.slice(0, i), r = Number(line.slice(i + 1));
    if (w && Number.isFinite(r)) rank[w] = r;
  }
}
if (fs.existsSync(REVIEW)) {
  for (const f of fs.readdirSync(REVIEW)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(REVIEW, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (typeof r.r === "number" && r.r < 9e6 && !(r.w in rank)) rank[r.w] = r.r;
    }
  }
}
if (!Object.keys(rank).length && fs.existsSync(freqPath)) {
  fs.readFileSync(freqPath, "utf8").split("\n").forEach((l, i) => { const w = l.split("\t")[0]; if (w && !(w in rank)) rank[w] = i; });
}
const RANK = (w) => (w in rank ? rank[w] : 9e6);

function classify(w) {
  const rec = vocab[w];
  if (Object.prototype.hasOwnProperty.call(curated, w)) return { src: "curated", b: curated[w].map((p) => p.s).join("·"), flags: [], st: "ok" };
  if (rec.b && rec.b.length >= 2) return { src: "data", b: rec.b.map((p) => p.s).join("·"), flags: [], st: "auto-data" };
  if (rec.b && rec.b.length === 1) return { src: "whole", b: w, flags: [], st: "auto-whole" };
  let r; try { r = engine.decompose(w); } catch (e) { return { src: "whole", b: w, flags: ["err"], st: "auto-whole" }; }
  const bad = !r.hasRoot || r.parts.some((p) => p.kind === "unknown") || (r.confidence || 0) < 0.6;
  const bigUnknown = r.parts.some((p) => p.kind === "unknown" && p.surface.length >= 4);
  if ((bad && (!r.hasRoot || bigUnknown)) || r.parts.length < 2) return { src: "whole", b: w, flags: [], st: "auto-whole" };
  const flags = [];
  if (r.parts.some(isStray)) flags.push("stray");
  if ((r.confidence || 0) < 0.75) flags.push("lowconf");
  if (r.parts.filter((p) => p.kind === "linker").length >= 2) flags.push("linkers");
  if (r.parts.some((p) => p.kind === "unknown")) flags.push("unknown");
  return { src: "engine", b: r.parts.map((p) => p.surface).join("·"), flags, st: flags.length ? "todo" : "todo-low" };
}

const byLetter = {};
const counts = { total: 0, curated: 0, data: 0, whole: 0, todo: 0, "todo-low": 0, ok: 0, fixed: 0 };
const queue = [];
for (const w of words) {
  counts.total++;
  const c = classify(w);
  let st = c.st;
  if (prior[w]) st = prior[w].st;               // human decision wins, persists
  const row = { w, r: RANK(w), src: c.src, b: c.b, flags: c.flags, st };
  if (prior[w] && prior[w].note) row.note = prior[w].note;
  const L = /^[a-z]/.test(w) ? w[0] : "_";
  (byLetter[L] = byLetter[L] || []).push(row);
  if (st === "todo" || st === "todo-low") { counts[st]++; queue.push(row); }
  else if (st === "ok") counts.ok++;
  else if (st === "fixed") counts.fixed++;
  else if (c.src === "curated") counts.curated++;
  else if (c.src === "data") counts.data++;
  else counts.whole++;
}

fs.mkdirSync(REVIEW, { recursive: true });
for (const L of Object.keys(byLetter)) {
  fs.writeFileSync(path.join(REVIEW, L + ".jsonl"), byLetter[L].map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// priority queue: suspicious first (stray > unknown > lowconf), then by frequency
const wq = { stray: 0, unknown: 1, lowconf: 2, linkers: 3 };
queue.sort((a, b) => {
  const sa = Math.min(99, ...a.flags.map((f) => wq[f] ?? 9)), sb = Math.min(99, ...b.flags.map((f) => wq[f] ?? 9));
  return sa - sb || a.r - b.r || a.w.localeCompare(b.w);
});
fs.writeFileSync(path.join(REVIEW, "QUEUE.tsv"),
  "word\trank\tflags\tcurrent_breakdown\n" +
  queue.slice(0, 4000).map((r) => [r.w, r.r >= 9e6 ? "-" : r.r, r.flags.join(",") || "-", r.b].join("\t")).join("\n") + "\n");

const reviewed = counts.ok + counts.fixed;
const todo = counts.todo + counts["todo-low"];
const status = `# Word-review progress

_Auto-generated by scripts/build-review-ledger.js — do not edit by hand._

Total words: **${counts.total}**

| status | count | meaning |
|---|---|---|
| reviewed ok | ${counts.ok} | human-checked, breakdown correct |
| reviewed & fixed | ${counts.fixed} | corrected (curated / engine / data fix) |
| trusted data (curated) | ${counts.curated} | hand-authored override |
| trusted data (MorphoLex/medical) | ${counts.data} | dataset breakdown, presumed good (spot-check) |
| shown whole | ${counts.whole} | not decomposed — can't be a wrong split |
| **todo — suspicious** | **${counts.todo}** | engine split with stray letters / low conf → review first |
| todo — low priority | ${counts["todo-low"]} | engine split, looks clean |

**Human-reviewed: ${reviewed} · Remaining to review: ${todo}**

Next batch: see \`review/QUEUE.tsv\` (highest priority first).
`;
fs.writeFileSync(path.join(REVIEW, "STATUS.md"), status);

// persist ranks so the untracked .jsonl ledgers stay fully regenerable
const ranked = Object.keys(rank).filter((w) => rank[w] < 9e6).sort((a, b) => rank[a] - rank[b]);
fs.writeFileSync(ranksPath, "word\trank\n" + ranked.map((w) => w + "\t" + rank[w]).join("\n") + "\n");

console.log(status);
