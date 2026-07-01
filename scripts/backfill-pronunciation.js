#!/usr/bin/env node
/*
 * backfill-pronunciation.js — fill missing `i` (IPA) and `rs` (respelling)
 * from the CMU pronouncing dictionary, entirely mechanically.
 *
 * The original rich build already mined CMU, but words added since (kaikki
 * imports, inflection folding) skipped that step; this closes the gap for any
 * entry CMU covers. Only ever ADDS missing fields — an existing `i` (usually
 * Wiktionary's, often better) or `rs` is never touched, and `_at` is left
 * alone so "recently enriched" stays meaningful.
 *
 *   node scripts/backfill-pronunciation.js            # dry run: counts + samples
 *   node scripts/backfill-pronunciation.js --apply    # write shards, bump DATA_V
 *
 * Needs dev deps (npm install: cmu-pronouncing-dictionary).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");
const { convert } = require("./arpabet.js");
const cmudict = require("cmu-pronouncing-dictionary").dictionary;

const APPLY = process.argv.includes("--apply");
let addedIpa = 0, addedRs = 0, touchedShards = 0;
const samples = [];

for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const p = path.join(WORDS, f);
  const shard = JSON.parse(fs.readFileSync(p, "utf8"));
  let dirty = false;
  for (const [w, e] of Object.entries(shard)) {
    if (e.i && e.rs) continue;
    const arp = cmudict[w.toLowerCase()];
    if (!arp) continue;
    const c = convert(arp);
    if (!e.i && c.ipa) { e.i = c.ipa; addedIpa++; dirty = true; }
    if (!e.rs && c.resp) { e.rs = c.resp; addedRs++; dirty = true; }
    if (dirty && samples.length < 12) samples.push(w + "  " + (e.i || "") + "  " + (e.rs || ""));
  }
  if (dirty && APPLY) {
    fs.writeFileSync(p, stringifyShard(shard));
    JSON.parse(fs.readFileSync(p, "utf8")); // self-validate like word.js
    touchedShards++;
  }
}

console.log((APPLY ? "wrote" : "would add") + ": " + addedIpa + " IPA, " + addedRs + " respellings" +
  (APPLY ? " across " + touchedShards + " shard(s)" : ""));
console.log(samples.map((s) => "  " + s).join("\n"));
if (!APPLY) console.log("(dry run — pass --apply to write)");
else {
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
}
