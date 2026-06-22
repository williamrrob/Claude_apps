// Apply rule-derived derivation relations (from scripts/find-derivations.js) to the
// shards as `rel` {t,l} pointers, so derived forms show "expert in <base>" etc. and
// link to their base. High-precision families only; the noisy "ist->y" family is held
// for individual review, and review/relation-exceptions.txt blocks false positives.
//
// These are RULE-derived (not individually human-okayed) — they add a relation banner
// but do not change a word's breakdown or its review status. Hand-authored relations in
// curated-breakdowns.json are applied afterwards by build-curated.js and take priority.
//
// Run:  node scripts/find-derivations.js && node scripts/build-relations.js

"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");

// families to hold back from auto-apply (need individual review for sense/labels)
const HOLD = new Set(["ist->y"]);
// softer labels where the rule label would be misleading (e.g. medical -phile cells)
const RELABEL = { "phile->philia": "related to", "philic->philia": "related to" };

const exceptions = new Set();
const exFile = path.join(ROOT, "review", "relation-exceptions.txt");
if (fs.existsSync(exFile)) {
  for (const line of fs.readFileSync(exFile, "utf8").split("\n")) {
    const w = line.split("#")[0].trim();
    if (w) exceptions.add(w);
  }
}

const tsv = fs.readFileSync(path.join(ROOT, "review", "derivation-candidates.tsv"), "utf8").trim().split("\n");
tsv.shift(); // header
const byShard = {};
let applied = 0, held = 0, skipped = 0;
for (const line of tsv) {
  const [type, derived, base, relRaw] = line.split("\t");
  if (HOLD.has(type)) { held++; continue; }
  if (exceptions.has(derived)) { skipped++; continue; }
  const t = RELABEL[type] || relRaw;
  (byShard[derived.slice(0, 2)] = byShard[derived.slice(0, 2)] || {})[derived] = { t: t, l: base };
}

for (const key of Object.keys(byShard)) {
  const p = path.join(WORDS, key + ".json");
  const shard = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  for (const w of Object.keys(byShard[key])) {
    if (!shard[w]) shard[w] = {};
    shard[w].rel = byShard[key][w]; applied++;
  }
  fs.writeFileSync(p, JSON.stringify(shard));
}
console.log("rule-derived relations applied:", applied, "| held for review:", held, "| skipped (exceptions):", skipped);
