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

const words = JSON.parse(fs.readFileSync(path.join(__dirname, "curated-breakdowns.json"), "utf8")).words;
let applied = 0, missing = [];
const byShard = {};
Object.keys(words).forEach((w) => {
  const tiled = words[w].map((p) => p.s).join("");
  if (tiled !== w) throw new Error("curated breakdown for '" + w + "' does not tile: '" + tiled + "'");
  (byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {})[w] = words[w];
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
console.log("curated breakdowns applied:", applied);
if (missing.length) console.log("  (added new word records for:", missing.join(", ") + ")");
