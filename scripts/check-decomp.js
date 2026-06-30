#!/usr/bin/env node
/*
 * check-decomp.js — flag words where the heuristic engine (engine.js) produces
 * a CONFIDENT but possibly bogus morpheme split, so a human can review and add
 * a curated `b` override (see word.js) if needed.
 *
 * The dangerous case isn't a messy parse — chooseBreakdown() in app.js already
 * falls back to showing the word whole when the parse has an "unknown" chunk or
 * low confidence. The dangerous case is a CLEAN split (every letter covered by
 * a real prefix/root/suffix, confidence >= 0.6) that is nonetheless wrong,
 * because two unrelated morphemes happened to share spelling (e.g. congee was
 * read as con- "with" + ge "earth", a coincidence with zero etymological basis
 * for either of congee's actual senses). chooseBreakdown() shows these
 * confidently and wrongly — there's no automatic safety net for this class.
 *
 * Heuristic: for a clean multi-part split, check whether each ROOT part's
 * meaning/source/id is corroborated anywhere in the word's own etymology text
 * (`e`). If a root shows no corroboration, flag it SUSPECT for human review.
 * This is a heuristic aid, not a guarantee — false positives/negatives happen
 * (e.g. words with no etymology text on file can't be corroborated either way).
 *
 * Usage:
 *   node scripts/check-decomp.js <word> [word2 ...]   # check specific words
 *   node scripts/check-decomp.js --all                # scan the whole dictionary
 *   node scripts/check-decomp.js --all --shard=co     # scan one shard only
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORDS_DIR = path.join(ROOT, "words");

global.MORPHEMES = require(path.join(ROOT, "data.js")).MORPHEMES;
const engine = require(path.join(ROOT, "engine.js"));
const { isCleanSplit, classify: classifyLib } = require("./decomp-lib.js");

function readShard(p) {
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function shardPath(word) {
  const key = String(word || "").slice(0, 2).toLowerCase();
  return path.join(WORDS_DIR, key + ".json");
}

function classify(word, entry) {
  const r = classifyLib(word, entry, engine.decompose);
  return r && Object.assign({ word: word }, r);
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const shardArg = args.find(function (a) { return a.startsWith("--shard="); });
const onlyShard = shardArg ? shardArg.split("=")[1] : null;
const words = args.filter(function (a) { return !a.startsWith("--"); });

if (!all && !words.length) {
  process.stderr.write("usage: check-decomp.js <word...> | --all [--shard=xx]\n");
  process.exit(1);
}

let results = [];
if (all) {
  const files = fs.readdirSync(WORDS_DIR).filter(function (f) { return f.endsWith(".json"); })
    .filter(function (f) { return !onlyShard || f === onlyShard + ".json"; });
  for (const f of files) {
    const obj = readShard(path.join(WORDS_DIR, f));
    for (const w of Object.keys(obj)) {
      if (obj[w].b) continue; // curated override already in place — engine result is moot
      if (/[\s-]/.test(w)) continue; // phrasal headwords skip decomposition entirely
      const r = classify(w, obj[w]);
      if (r && r.verdict !== "ok") results.push(r);
    }
  }
} else {
  for (const w of words) {
    const sp = shardPath(w);
    const obj = readShard(sp);
    const entry = obj[w];
    if (entry && entry.b) { console.log(w + "  CURATED (b override in place, engine result ignored by the app)"); continue; }
    const d = engine.decompose(w);
    const parts = d.parts.map(function (p) { return p.kind + ":" + p.surface; }).join(" + ");
    if (!isCleanSplit(d)) { console.log(w + "  WHOLE-FALLBACK  " + parts + "  (chooseBreakdown already shows this whole, no action needed)"); continue; }
    const r = classify(w, entry);
    console.log(w + "  " + (r ? r.verdict : "ok") + "  " + parts);
  }
  process.exit(0);
}

results.forEach(function (r) { console.log(r.verdict + "\t" + r.word + "\t" + r.parts); });
process.stderr.write(results.length + " word(s) flagged (SUSPECT = corroboration failed, UNVERIFIED = no etymology text to check against)\n");
