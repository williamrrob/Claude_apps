// Find candidate DERIVATIONAL pairs: a word that ends in a productive derivational
// suffix whose corresponding base form (suffix swapped) also exists in the vocab.
// Same idea as find-pairs.js but for derivation rather than inflection, producing
// a small pool to hand-verify before promoting into curated-breakdowns "relations".
//
// Output: review/derivation-candidates.tsv  (type \t derived \t base \t relation)
//
// Run:  node scripts/find-derivations.js

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

// derived ending -> base ending, with a relationship label. Ordered most-specific
// first so e.g. "biologist" resolves as -ologist->-ology, not -ist->-ism.
const RULES = [
  { end: "ologist",   to: "ology",  t: "one who studies", min: 1 },
  { end: "ological",  to: "ology",  t: "relating to",     min: 1 },
  { end: "ologic",    to: "ology",  t: "relating to",     min: 1 },
  { end: "ification", to: "ify",    t: "act of",          min: 2 },
  { end: "ization",   to: "ize",    t: "act of",          min: 2 },
  { end: "isation",   to: "ise",    t: "act of",          min: 2 },
  { end: "grapher",   to: "graphy", t: "one who works in", min: 1 },
  { end: "graphic",   to: "graphy", t: "relating to",     min: 1 },
  { end: "cratic",    to: "cracy",  t: "relating to",     min: 1 },
  { end: "phobic",    to: "phobia", t: "relating to",     min: 1 },
  { end: "philic",    to: "philia", t: "relating to",     min: 1 },
  { end: "phobe",     to: "phobia", t: "one who fears",   min: 1 },
  { end: "phile",     to: "philia", t: "one who loves",   min: 1 },
  { end: "ician",     to: "ics",    t: "expert in",       min: 3 },
  { end: "ician",     to: "ic",     t: "expert in",       min: 3 },
  { end: "crat",      to: "cracy",  t: "advocate of",     min: 1 },
  { end: "ation",     to: "ate",    t: "act of",          min: 3 },
  { end: "ist",       to: "ism",    t: "adherent of",     min: 3 },
  { end: "ist",       to: "y",      t: "practitioner in", min: 3 },
];

const found = [];
const counts = {};
const seen = new Set();
for (const w of vocab) {
  for (const r of RULES) {
    if (!w.endsWith(r.end)) continue;
    const stem = w.slice(0, w.length - r.end.length);
    if (stem.length < r.min) continue;
    const base = stem + r.to;
    if (base === w || !vocab.has(base)) continue;
    if (seen.has(w)) continue;        // one base per derived form (most specific wins)
    seen.add(w);
    found.push(r.end + "->" + r.to + "\t" + w + "\t" + base + "\t" + r.t);
    counts[r.end + "->" + r.to] = (counts[r.end + "->" + r.to] || 0) + 1;
    break;
  }
}
found.sort();
fs.writeFileSync(path.join(ROOT, "review", "derivation-candidates.tsv"),
  "type\tderived\tbase\trelation\n" + found.join("\n") + "\n");

console.log("candidate derivation pairs (both forms in vocab):", found.length);
Object.keys(counts).sort().forEach((t) => console.log("  " + t + ":", counts[t]));
console.log("-> review/derivation-candidates.tsv");
