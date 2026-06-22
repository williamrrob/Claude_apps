// Apply a hand-classified word family (family/<root>.json) to the shards:
//   - each collapsed inflection gets a `rel` {t,l} pointer to its lemma
//   - each lemma gets a `forms` list of the inflections that fold into it
// and validate that the curated tree + collapse cover the whole family and that
// every referenced word actually has a record.
//
// Run:  node scripts/build-family.js [rootId]   (default: scrib)

"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const rootId = process.argv[2] || "scrib";

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "family", rootId + ".json"), "utf8"));

const vocab = new Set();
for (const f of fs.readdirSync(WORDS)) {
  if (!f.endsWith(".json")) continue;
  Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"))).forEach((w) => vocab.add(w));
}

// placement format: every placed word, and the collapse map
const treeWords = (doc.placements || []).map((p) => p.w);
const collapse = doc.collapse || {};
const covered = new Set(treeWords.concat(Object.keys(collapse)));

// --- validation ---
const dangling = [...covered].filter((w) => !vocab.has(w));
const dupNodeAndCollapse = treeWords.filter((w) => collapse[w]);
const badTargets = Object.keys(collapse).filter((w) => !treeWords.includes(collapse[w].l));
// family per the morpheme index (what the engine considers built on this root)
let idxMembers = [];
try { const idx = JSON.parse(fs.readFileSync(path.join(ROOT, "morpheme-index.json"), "utf8")); const v = idx[rootId]; idxMembers = Array.isArray(v) ? v : (v && v.words) || []; } catch {}
const omitted = idxMembers.filter((w) => !covered.has(w));

console.log("tree nodes:", treeWords.length, "| collapsed:", Object.keys(collapse).length, "| covered:", covered.size);
console.log("morpheme-index members:", idxMembers.length, "| omitted from family file:", omitted.length, omitted.join(", ") || "(none)");
if (dangling.length) console.log("!! referenced but no record:", dangling.join(", "));
if (dupNodeAndCollapse.length) console.log("!! both a node AND collapsed:", dupNodeAndCollapse.join(", "));
if (badTargets.length) console.log("!! collapse target not a node:", badTargets.join(", "));

// A past participle that also functions as an adverb earns its own card, so it
// must NOT be collapsed away. Drop such entries from the collapse set (they stay
// standalone) and report them so they can be placed in the tree instead.
function senseOf(w) { const p = path.join(WORDS, w.slice(0, 2) + ".json"); try { return (JSON.parse(fs.readFileSync(p, "utf8"))[w] || {}).d || []; } catch { return []; } }
const promoted = [];
Object.keys(collapse).forEach((w) => {
  if (/past/.test(collapse[w].t) && senseOf(w).some((d) => /adv/i.test(d.p || ""))) {
    promoted.push(w); delete collapse[w];
  }
});
if (promoted.length) console.log("promoted (past participle that works as an adverb — give its own card):", promoted.join(", "));

// --- apply: rel pointers on inflections + forms list on lemmas ---
const formsByLemma = {};
Object.keys(collapse).forEach((w) => { (formsByLemma[collapse[w].l] = formsByLemma[collapse[w].l] || []).push(w); });

const byShard = {};
Object.keys(collapse).forEach((w) => { (byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {})[w] = { rel: { t: collapse[w].t, l: collapse[w].l } }; });
Object.keys(formsByLemma).forEach((w) => { const s = byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {}; (s[w] = s[w] || {}).forms = formsByLemma[w].sort(); });

let relApplied = 0, formsApplied = 0;
for (const key of Object.keys(byShard)) {
  const p = path.join(WORDS, key + ".json");
  const shard = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  for (const w of Object.keys(byShard[key])) {
    if (!shard[w]) shard[w] = {};
    if (byShard[key][w].rel) { shard[w].rel = byShard[key][w].rel; relApplied++; }
    if (byShard[key][w].forms) { shard[w].forms = byShard[key][w].forms; formsApplied++; }
  }
  fs.writeFileSync(p, JSON.stringify(shard));
}
console.log("applied:", relApplied, "rel pointers,", formsApplied, "forms lists");
