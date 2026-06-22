// Find candidate singular/plural pairs by looking for words that differ only in
// their final position(s) according to known (mostly foreign) plural patterns,
// where BOTH forms exist in the vocabulary. This reduces the "which words are
// plurals?" problem from the whole dictionary to a small pool to hand-verify.
//
// Output: review/pair-candidates.tsv  (type \t singular \t plural)
//
// Run:  node scripts/find-pairs.js

"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");

const vocab = new Set();
for (const f of fs.readdirSync(WORDS)) {
  if (!f.endsWith(".json")) continue;
  Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"))).forEach((w) => vocab.add(w));
}

// each rule maps a singular ending to its plural ending (classical patterns).
// minStem keeps us from matching tiny words where the "ending" is the whole word.
const RULES = [
  { type: "us->i",    sing: /us$/,  pl: (w) => w.replace(/us$/, "i"),       minStem: 3 },
  { type: "a->ae",    sing: /a$/,   pl: (w) => w + "e",                     minStem: 4 },
  { type: "um->a",    sing: /um$/,  pl: (w) => w.replace(/um$/, "a"),       minStem: 4 },
  { type: "on->a",    sing: /on$/,  pl: (w) => w.replace(/on$/, "a"),       minStem: 5 },
  { type: "is->es",   sing: /is$/,  pl: (w) => w.replace(/is$/, "es"),      minStem: 4 },
  { type: "ix->ices", sing: /ix$/,  pl: (w) => w.replace(/ix$/, "ices"),    minStem: 3 },
  { type: "ex->ices", sing: /ex$/,  pl: (w) => w.replace(/ex$/, "ices"),    minStem: 3 },
  { type: "ma->mata", sing: /ma$/,  pl: (w) => w.replace(/ma$/, "mata"),    minStem: 4 },
];

const found = [];
const counts = {};
for (const w of vocab) {
  for (const r of RULES) {
    if (!r.sing.test(w)) continue;
    if (w.length - (w.match(r.sing)[0].length) < r.minStem) continue;
    const pl = r.pl(w);
    if (pl !== w && vocab.has(pl)) {
      found.push(r.type + "\t" + w + "\t" + pl);
      counts[r.type] = (counts[r.type] || 0) + 1;
    }
  }
}
found.sort();
fs.writeFileSync(path.join(ROOT, "review", "pair-candidates.tsv"),
  "type\tsingular\tplural\n" + found.join("\n") + "\n");

console.log("candidate pairs (both forms in vocab):", found.length);
Object.keys(counts).sort().forEach((t) => console.log("  " + t + ":", counts[t]));
console.log("-> review/pair-candidates.tsv");
