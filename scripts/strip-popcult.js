#!/usr/bin/env node
/*
 * strip-popcult.js — remove pop-culture / TV-episode junk from word shards.
 *
 * Removes entries that match ANY of:
 *   1. dom in the POP_DOMS set (fiction, anime, comics, video-games, computer-games)
 *   2. Gloss explicitly describes a fictional character, TV episode, or animated character
 *   3. Word is all-caps and 2-4 chars with no real definition (acronym clutter)
 *
 * Dry-run by default. Pass --apply to write changes.
 *   node scripts/strip-popcult.js
 *   node scripts/strip-popcult.js --apply
 */
"use strict";
const fs = require("fs"), path = require("path");
const WORDS = path.join(__dirname, "..", "words");
const APPLY = process.argv.includes("--apply");

const POP_DOMS = new Set(["fiction", "anime", "comics", "video-games", "computer-games"]);

// Gloss patterns that clearly indicate fictional/episode references
const EPISODE_RE = /^(an? episode of\b|a character (in|from|on) (the\b|a\b)|a fictional (character|creature|entity|being|alien|robot|person|animal|anthropomorphic)|a tv series\b|a television (series|show|program|episode)\b)/i;

let totalRemoved = 0, totalKept = 0;
const removedSamples = [];

for (const f of fs.readdirSync(WORDS).filter(x => x.endsWith(".json"))) {
  const fpath = path.join(WORDS, f);
  const sh = JSON.parse(fs.readFileSync(fpath, "utf8"));
  const before = Object.keys(sh).length;
  const out = {};

  for (const [w, r] of Object.entries(sh)) {
    const dom = r.d && r.d[0] && r.d[0].dom;
    const gloss = r.d && r.d[0] && r.d[0].g || "";

    let remove = false;
    if (dom && POP_DOMS.has(dom)) remove = true;
    else if (EPISODE_RE.test(gloss)) remove = true;

    if (remove) {
      totalRemoved++;
      if (removedSamples.length < 20) removedSamples.push(`${w}: [${dom||""}] ${gloss.slice(0, 70)}`);
    } else {
      out[w] = r;
      totalKept++;
    }
  }

  if (APPLY && Object.keys(out).length < before) {
    fs.writeFileSync(fpath, JSON.stringify(out));
  }
}

console.log(`\nRemoved: ${totalRemoved}  Kept: ${totalKept}`);
console.log(`\nSample removals:`);
removedSamples.forEach(s => console.log("  -", s));
if (!APPLY) console.log("\nDry run — pass --apply to write changes.");
