// Merge hand-authored breakdowns (scripts/curated-breakdowns.json) into the
// per-word shards. These are the highest-authority breakdowns — they OVERRIDE
// MorphoLex / medical / engine output — for boundaries no automated source can
// represent. Each is verified to tile its word exactly.
//
// Run:  node scripts/build-curated.js

"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "curated-breakdowns.json"), "utf8"));
const words = doc.words;
const whole = doc.whole || [];
// relationship pointers: inflected / derived forms that descend from a base word.
// `plurals` is shorthand ({form: lemma} => "plural of lemma"); `relations` is the
// general form ({form: {t: "past tense of", l: "run"}}).
const rel = {};
Object.keys(doc.plurals || {}).forEach((w) => { rel[w] = { t: "plural of", l: doc.plurals[w] }; });
Object.keys(doc.relations || {}).forEach((w) => { rel[w] = doc.relations[w]; });
let applied = 0, missing = [];
const byShard = {};
Object.keys(words).forEach((w) => {
  const tiled = words[w].map((p) => p.s).join("");
  if (tiled !== w) throw new Error("curated breakdown for '" + w + "' does not tile: '" + tiled + "'");
  (byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {})[w] = words[w];
});
// verified plain English / proper nouns / clippings — present whole, never split
whole.forEach((w) => {
  (byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {})[w] = [{ s: w, k: "word" }];
});
for (const key of Object.keys(byShard)) {
  const p = path.join(WORDS, key + ".json");
  const shard = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  let touched = false;
  for (const w of Object.keys(byShard[key])) {
    if (!shard[w]) { missing.push(w); shard[w] = {}; }
    shard[w].b = byShard[key][w]; applied++; touched = true;
  }
  if (touched) fs.writeFileSync(p, JSON.stringify(shard));
}
// mark inflected / derived forms with a `rel` pointer ({t, l}) so the UI presents
// them as descending from a base word, not as standalone words.
let relApplied = 0;
const relByShard = {};
Object.keys(rel).forEach((w) => { (relByShard[w.slice(0, 2)] = relByShard[w.slice(0, 2)] || {})[w] = rel[w]; });
for (const key of Object.keys(relByShard)) {
  const p = path.join(WORDS, key + ".json");
  const shard = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  for (const w of Object.keys(relByShard[key])) {
    if (!shard[w]) { missing.push(w); shard[w] = {}; }
    shard[w].rel = relByShard[key][w]; relApplied++;
  }
  fs.writeFileSync(p, JSON.stringify(shard));
}
console.log("curated breakdowns applied:", applied, "| relations:", relApplied);
if (missing.length) console.log("  (added new word records for:", missing.join(", ") + ")");
