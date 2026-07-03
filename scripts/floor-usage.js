#!/usr/bin/env node
/*
 * floor-usage.js — zero out pre-existence "ghost" buckets in usage/<xx>.json.
 *
 * Google Books Ngrams OCR sprinkles phantom frequency centuries before a word
 * was coined (brougham, coined c. 1778, shows a 100%-of-peak spike in the
 * 1500s). This fixes the DATA at the source, so the peak marker, era-word
 * lists, and every future consumer see clean series.
 *
 * We floor ONLY on high-confidence coinage evidence in the entry's own
 * etymology prose — deliberately NOT on scraped quotation years, which are
 * the earliest citation Wiktionary happened to include (systematically too
 * late: they'd erase real historical usage of abashed, abominate, …):
 *
 *   1. EPONYM — "named after <person> (BIRTH–…)": the word cannot predate the
 *      person's birth year. Always safe (conservative: birth precedes coinage).
 *   2. COINAGE of a genuinely NEW word — "first attested in YYYY", "coined",
 *      clipping/blend/acronym — but ONLY when the etymology shows NO Middle
 *      English / Old English ancestry. A word "From Middle English …" predates
 *      1500 regardless of a later sense-specific attestation note, so those
 *      are left untouched.
 *
 * A bucket i covers (1500+25i)..(1524+25i); we zero i only when its ENTIRE
 * span ends before the floor year. If flooring would erase the whole series,
 * we skip (guards a wrong year). Bucket the year falls inside is kept.
 *
 *   node scripts/floor-usage.js            # dry run: counts + sample
 *   node scripts/floor-usage.js --apply    # rewrite usage/ shards, bump DATA_V
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const USAGE = path.join(ROOT, "usage");
const APPLY = process.argv.includes("--apply");

const BUCKET0 = 1500, SPAN = 25, N = 21;
const bucketEnd = (i) => BUCKET0 + SPAN * i + (SPAN - 1);

const EPONYM = /\bnamed (?:after|for|in honou?r of)\b/i;
const COINAGE = /\b(?:coined|first (?:attested|recorded|used|cited)|clipping of|blend of|acronym|initialism|neologism|introduced in)\b/i;
const OLD_ANCESTRY = /\b(?:Middle English|Old English|Old Norse|Middle Dutch|Old French|Middle French|Anglo-Norman|Proto-|Middle Low German)\b/;
const yearIn = (s) => { const m = String(s).match(/(?:c\.\s*|circa\s*)?\b(1[5-9][0-9]{2}|20[0-2][0-9])\b/); return m ? Number(m[1]) : null; };

// floor year from etymology prose, or null when no safe signal
function floorYear(e) {
  if (!e) return null;
  const s = String(e);
  if (EPONYM.test(s)) { const y = yearIn(s); if (y) return { y, why: "eponym" }; }
  if (COINAGE.test(s) && !OLD_ANCESTRY.test(s)) {
    // year adjacent to the coinage phrase (not some unrelated later citation)
    const m = s.match(/(?:coined|attested|recorded|used|cited|introduced|clipping of[^.]*?|blend of[^.]*?)\D{0,20}?\b(1[5-9][0-9]{2}|20[0-2][0-9])\b/i);
    if (m) return { y: Number(m[1]), why: "coinage" };
  }
  return null;
}

let checked = 0, floored = 0, bucketsZeroed = 0, skippedWipe = 0, touched = 0;
const samples = [];

for (const uf of fs.readdirSync(USAGE).filter((x) => x.endsWith(".json"))) {
  const up = path.join(USAGE, uf);
  const usage = JSON.parse(fs.readFileSync(up, "utf8"));
  const wf = path.join(WORDS, uf);
  const wshard = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, "utf8")) : {};
  let dirty = false;

  for (const [w, series] of Object.entries(usage)) {
    if (!Array.isArray(series) || series.length !== N) continue;
    checked++;
    const rec = wshard[w] || wshard[w.toLowerCase()];
    const fl = floorYear(rec && rec.e);
    if (!fl || fl.y < 1550 || fl.y > 2000) continue;

    const zero = [];
    for (let i = 0; i < N; i++) if (bucketEnd(i) < fl.y && series[i] > 0) zero.push(i);
    if (!zero.length) continue;

    const remaining = series.reduce((s, v, i) => s + (zero.includes(i) ? 0 : v), 0);
    if (remaining === 0) { skippedWipe++; continue; }

    if (samples.length < 18) {
      samples.push(w + " (" + fl.why + " " + fl.y + "): zeroed " +
        zero.map((i) => (BUCKET0 + 25 * i) + "s=" + series[i]).join(", "));
    }
    if (APPLY) { for (const i of zero) series[i] = 0; }
    floored++; bucketsZeroed += zero.length; dirty = true;
  }
  if (dirty && APPLY) { fs.writeFileSync(up, JSON.stringify(usage)); JSON.parse(fs.readFileSync(up, "utf8")); touched++; }
}

console.log("FLOOR-USAGE " + (APPLY ? "APPLIED" : "DRY RUN"));
console.log("series checked: " + checked + " | words floored: " + floored +
  " | buckets zeroed: " + bucketsZeroed + " | skipped (would wipe): " + skippedWipe);
console.log("\nghost buckets removed:");
for (const s of samples) console.log("  " + s);
if (APPLY) {
  console.log("\nshards written: " + touched);
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
} else console.log("\n(dry run — pass --apply to write)");
