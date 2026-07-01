#!/usr/bin/env node
/*
 * symmetrize-relations.js — enforce that synonym/antonym/related relations
 * are symmetric: if A lists B in `s` (synonyms), `a` (antonyms), or `r`
 * (related), B should list A back in the SAME field. The three lists are
 * symmetrized independently and never cross-pollinated — a synonym pointer
 * only ever creates a reciprocal synonym pointer, never an antonym or
 * related one.
 *
 * Wiktionary-derived data is commonly asymmetric this way (A's page lists B
 * as a synonym; B's own page was written/edited separately and never
 * mentions A back), so this is a real, expected gap, not an edge case.
 *
 * A reciprocal is only added when the target word actually HAS an entry —
 * an "orphan" reference (a word that mentions a target with no dictionary
 * entry at all) is reported but left alone, since there's nothing to add it to.
 *
 * Default is a DRY RUN: writes a report, changes nothing.
 *   node scripts/symmetrize-relations.js [--out report.txt]   # dry run (default)
 *   node scripts/symmetrize-relations.js --apply               # actually add the missing reciprocals
 *   node scripts/symmetrize-relations.js --shard co             # only scan words in this shard as
 *                                                                 the SOURCE side (targets can still
 *                                                                 live in any shard — the whole
 *                                                                 dictionary is loaded regardless)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { stringifyShard } = require("./shard-format.js");
const { bumpDataV } = require("./version-lib.js");

const WORDS_DIR = path.join(__dirname, "..", "words");
const APPLY = process.argv.includes("--apply");
const outArg = process.argv.indexOf("--out");
const OUT = outArg !== -1 ? process.argv[outArg + 1] : path.join(__dirname, "..", "symmetrize-dryrun.txt");
const shardArg = process.argv.indexOf("--shard");
const ONLY_SHARD = shardArg !== -1 ? process.argv[shardArg + 1] : null;

const FIELDS = ["s", "a", "r"];
const FIELD_NAME = { s: "synonym", a: "antonym", r: "related" };

// ---- load every shard into one map, remembering which file each word lives in ----
const files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")).sort();
const shards = {};   // filename -> parsed object (mutated in place, written back if --apply)
const wordFile = {}; // word -> filename it lives in
for (const f of files) {
  const obj = JSON.parse(fs.readFileSync(path.join(WORDS_DIR, f), "utf8"));
  shards[f] = obj;
  for (const w of Object.keys(obj)) wordFile[w] = f;
}
const scopeFiles = ONLY_SHARD ? files.filter((f) => f === ONLY_SHARD + ".json") : files;

let added = 0, orphans = 0;
const addedExamples = [], orphanExamples = [];
const affectedFiles = new Set();
const now = new Date().toISOString();

for (const f of scopeFiles) {
  const obj = shards[f];
  for (const word of Object.keys(obj)) {
    const entry = obj[word];
    for (const field of FIELDS) {
      const list = entry[field];
      if (!Array.isArray(list) || !list.length) continue;
      for (const raw of list) {
        const target = String(raw);
        if (!target || target.toLowerCase() === word.toLowerCase()) continue; // no self-refs
        const targetFile = wordFile[target];
        if (!targetFile) {
          orphans++;
          if (orphanExamples.length < 30) orphanExamples.push(word + " --[" + field + "]--> \"" + target + "\" (no entry for \"" + target + "\")");
          continue;
        }
        const targetEntry = shards[targetFile][target];
        const backList = Array.isArray(targetEntry[field]) ? targetEntry[field] : [];
        const hasBack = backList.some(function (t) { return String(t).toLowerCase() === word.toLowerCase(); });
        if (hasBack) continue;
        added++;
        affectedFiles.add(targetFile);
        if (addedExamples.length < 40) addedExamples.push(word + " --[" + FIELD_NAME[field] + "]--> " + target + "  (" + (APPLY ? "added" : "would add") + " \"" + word + "\" to " + target + "'s " + field + ")");
        if (APPLY) {
          targetEntry[field] = backList.concat([word]);
          targetEntry._at = now;
        }
      }
    }
  }
}

if (APPLY) {
  for (const f of affectedFiles) fs.writeFileSync(path.join(WORDS_DIR, f), stringifyShard(shards[f]));
  if (affectedFiles.size) {
    const r = bumpDataV();
    if (r) process.stderr.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
  }
}

const lines = [];
lines.push("SYMMETRIZE-RELATIONS " + (APPLY ? "APPLIED" : "DRY RUN") + (ONLY_SHARD ? " (scanned as source: shard " + ONLY_SHARD + " only)" : ""));
lines.push("=".repeat(60));
lines.push("reciprocal relations " + (APPLY ? "added" : "that would be added") + ": " + added);
lines.push("shards " + (APPLY ? "touched" : "that would be touched") + ": " + affectedFiles.size);
lines.push("orphan references (target word has no dictionary entry at all): " + orphans);
lines.push("");
lines.push("---- additions" + (addedExamples.length < added ? " (first " + addedExamples.length + " of " + added + ")" : "") + " ----");
lines.push.apply(lines, addedExamples);
lines.push("");
lines.push("---- orphan references" + (orphanExamples.length < orphans ? " (first " + orphanExamples.length + " of " + orphans + ")" : "") + " ----");
lines.push.apply(lines, orphanExamples);

const report = lines.join("\n") + "\n";
fs.writeFileSync(OUT, report);
process.stdout.write(lines.slice(0, 60).join("\n") + "\n");
process.stderr.write("\nfull report written to " + OUT + "\n");
