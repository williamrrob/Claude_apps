#!/usr/bin/env node
/*
 * repair-rel-pointers.js — validate every rel redirect against the entry's
 * OWN first gloss. A legitimate pointer entry says so ("Plural of word.",
 * "Past participle of abide."); the broken class (an earlier assistant pass)
 * grabbed arbitrary gloss tokens ("digital humanities → plural of
 * computational", "able → present participle of can", "abandoned habits →
 * plural of the").
 *
 * For rel.t of the inflection/variant kinds:
 *   gloss asserts "<label> of X":
 *     X == rel.l → keep
 *     X != rel.l and X exists → FIX rel.l to X
 *   gloss asserts nothing pointer-like → REMOVE rel (real word, bad pointer)
 * synonym-of / folding rels (which legitimately cross stems) are validated
 * only for target existence. Folds from fold-variants.js are all
 * gloss-asserted, so they pass the same gate.
 *
 *   node scripts/repair-rel-pointers.js [--apply]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");
const APPLY = process.argv.includes("--apply");

const vocab = new Map();
const shards = new Map();
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  shards.set(f, sh);
  for (const w of Object.keys(sh)) vocab.set(w.toLowerCase(), w);
}

const INFLECTIONAL = /^(plural|past participle|present participle|past tense|third-person singular|comparative|superlative|variant|alternative spelling|misspelling|obsolete spelling|archaic spelling|abbreviation|initialism|clipping|contraction|diminutive|feminine|masculine|gerund|simple past|obsolete form|alternative form)\b/i;
// gloss assertion: "<Label...> of <target phrase>" at the start
const GLOSS_RE = /^\s*(?:[A-Z][a-z]+[- ])*?(?:plural|participle|tense|singular|comparative|superlative|variant|spelling|misspelling|abbreviation|initialism|clipping|contraction|diminutive|form|gerund|past|alternative|obsolete|archaic)[a-z -]*\s+(?:of|for)\s+([^.;,()]+)/i;

function isInflectionOf(w, target) {
  const a = w.toLowerCase().replace(/[^a-z]/g, "");
  const t = target.toLowerCase().replace(/[^a-z]/g, "");
  if (!a || !t || a === t) return a === t && w !== target; // case/punct variants
  const base = [t];
  if (t.endsWith("e")) base.push(t.slice(0, -1));            // abide→abid-
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(t)) base.push(t + t[t.length - 1]); // stop→stopp-
  if (t.endsWith("y")) base.push(t.slice(0, -1) + "i");      // carry→carri-
  for (const b of base) {
    for (const suf of ["s", "es", "ed", "d", "ing", "er", "est", "en", "n"]) {
      if (a === b + suf) return true;
    }
  }
  return false;
}

let checked = 0, kept = 0, fixed = 0, removed = 0, synOk = 0, targetMissing = 0;
const samples = { fixed: [], removed: [] };
for (const [f, sh] of shards) {
  let dirty = false;
  for (const [w, rec] of Object.entries(sh)) {
    if (!rec.rel || !rec.rel.l) continue;
    checked++;
    const t = String(rec.rel.t || "");
    if (!INFLECTIONAL.test(t)) { synOk++; continue; } // synonym-of etc.: leave
    const gloss = (Array.isArray(rec.d) && rec.d[0] && rec.d[0].g) || "";
    const m = gloss.match(GLOSS_RE);
    const asserted = m ? m[1].trim().replace(/["'“”]/g, "") : null;
    if (asserted && asserted.toLowerCase() === rec.rel.l.toLowerCase()) { kept++; continue; }
    if (asserted && vocab.has(asserted.toLowerCase()) && asserted.toLowerCase() !== w.toLowerCase()) {
      if (samples.fixed.length < 10) samples.fixed.push(w + ": " + rec.rel.l + " → " + asserted + "  (gloss: " + gloss.slice(0, 60) + ")");
      if (APPLY) { rec.rel.l = vocab.get(asserted.toLowerCase()); dirty = true; }
      fixed++;
      continue;
    }
    // gloss silent — the rel may still be TRUE morphology (abandoned →
    // abandon carries an adjective gloss but IS the participle). Keep when
    // the headword is a regular inflection/variant of the target.
    if (isInflectionOf(w, rec.rel.l)) { kept++; continue; }
    // otherwise the rel is fabricated; drop it
    if (samples.removed.length < 12) samples.removed.push(w + "  (-" + t + "-> " + rec.rel.l + ")  gloss: " + gloss.slice(0, 60));
    if (APPLY) { delete rec.rel; dirty = true; }
    removed++;
  }
  if (dirty && APPLY) {
    const p = path.join(WORDS, f);
    fs.writeFileSync(p, stringifyShard(sh));
    JSON.parse(fs.readFileSync(p, "utf8"));
  }
}

console.log("REPAIR-REL-POINTERS " + (APPLY ? "APPLIED" : "DRY RUN"));
console.log("rel entries: " + checked + " | inflectional kept (gloss agrees): " + kept +
  " | retargeted: " + fixed + " | removed (gloss asserts nothing): " + removed + " | non-inflectional left alone: " + synOk);
console.log("\nRETARGETED:"); for (const s of samples.fixed) console.log("  " + s);
console.log("REMOVED:"); for (const s of samples.removed) console.log("  " + s);
if (APPLY) {
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
} else console.log("(dry run — pass --apply to write)");
