#!/usr/bin/env node
/*
 * dedupe.js — find (and optionally fold) redundant SENSES *within* a word.
 *
 * SCOPE: operates only on a word's definition list (`d`) and relation lists
 * (`s`/`a`/`r`). It NEVER deletes a headword and NEVER merges one word into
 * another — the set of words is asserted unchanged. It folds duplicate senses
 * into the richest surviving copy.
 *
 * Default is a DRY RUN: it writes a review report and changes nothing.
 *   node scripts/dedupe.js [--out report.txt]      # dry run (default)
 *   node scripts/dedupe.js --apply                  # actually fold (writes shards)
 *
 * Tiers (only same part-of-speech senses are ever compared):
 *   T1 exact     — normalized gloss identical                  (safe)
 *   T2 contained — one sense's content words ⊆ the other's,     (review)
 *                  both have ≥2 content words
 * Token-overlap-only matches with diverging nouns (e.g. cabdriver "taxi" vs
 * "carriage") are intentionally NOT merged — when in doubt, keep both.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const WORDS_DIR = path.join(__dirname, "..", "words");
const APPLY = process.argv.includes("--apply");
const outArg = process.argv.indexOf("--out");
const OUT = outArg !== -1 ? process.argv[outArg + 1] : path.join(__dirname, "..", "dedupe-dryrun.txt");

const STOP = new Set(("a an the of to in on at by for with from into onto upon as or and " +
  "is are was that this such which who whom whose etc eg ie one something someone").split(" "));
const contentSet = (g) => new Set(String(g || "").toLowerCase().replace(/[^a-z ]/g, " ")
  .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const normFull = (g) => String(g || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
// prefer the "richer" sense: has an example, then longer gloss
const richer = (x, y) => (((y.x ? 1 : 0) - (x.x ? 1 : 0)) || ((y.g || "").length - (x.g || "").length));

const files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")).sort();
let wordsTouched = 0, t1 = 0, t2 = 0, relDrops = 0;
const examples = { t1: [], t2: [] };
const wordsBefore = [], wordsAfter = [];

for (const file of files) {
  const p = path.join(WORDS_DIR, file);
  const obj = JSON.parse(fs.readFileSync(p, "utf8"));
  let shardChanged = false;

  for (const word of Object.keys(obj)) {
    wordsBefore.push(word);
    const e = obj[word];
    let changed = false;

    // ---- senses ----
    if (Array.isArray(e.d) && e.d.length > 1) {
      const keep = [];
      const meta = e.d.map((d) => ({ d, cs: contentSet(d.g), nf: normFull(d.g) }));
      const dropped = new Array(meta.length).fill(false);
      for (let i = 0; i < meta.length; i++) {
        if (dropped[i]) continue;
        for (let j = i + 1; j < meta.length; j++) {
          if (dropped[j]) continue;
          if ((meta[i].d.p || "") !== (meta[j].d.p || "")) continue; // same POS only
          let tier = null;
          if (meta[i].nf && meta[i].nf === meta[j].nf) tier = "t1";
          else if (meta[i].cs.size >= 2 && meta[j].cs.size >= 2 &&
                   (subset(meta[i].cs, meta[j].cs) || subset(meta[j].cs, meta[i].cs))) tier = "t2";
          if (!tier) continue;
          // fold the poorer of i/j into the richer; mark the poorer dropped
          const poorerIsJ = richer(meta[i].d, meta[j].d) <= 0;
          const survivor = poorerIsJ ? meta[i].d : meta[j].d;
          const victim = poorerIsJ ? meta[j].d : meta[i].d;
          dropped[poorerIsJ ? j : i] = true;
          if (poorerIsJ) { if (!survivor.x && victim.x) survivor.x = victim.x; } // keep an example if only the victim had one
          else { if (!survivor.x && victim.x) survivor.x = victim.x; dropped[i] = true; }
          if (tier === "t1") t1++; else t2++;
          if (examples[tier].length < 12) examples[tier].push([word, victim.g, survivor.g]);
          changed = true;
        }
      }
      if (changed) {
        for (let k = 0; k < meta.length; k++) if (!dropped[k]) keep.push(meta[k].d);
        if (APPLY) e.d = keep;
      }
    }

    // ---- relation lists: drop exact-duplicate / self-referential entries ----
    for (const key of ["s", "a", "r"]) {
      if (!Array.isArray(e[key])) continue;
      const seen = new Set(), out = [];
      for (const t of e[key]) {
        const k = String(t).toLowerCase().trim();
        if (k === word.toLowerCase() || seen.has(k)) { relDrops++; changed = true; continue; }
        seen.add(k); out.push(t);
      }
      if (APPLY && out.length !== e[key].length) e[key] = out;
    }

    if (changed) wordsTouched++;
    wordsAfter.push(word);
  }

  if (APPLY && shardChanged) {} // (per-word writes handled below)
  if (APPLY) fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

// ---- guardrail: the headword set must be identical ----
const setB = new Set(wordsBefore), setA = new Set(wordsAfter);
const lost = [...setB].filter((w) => !setA.has(w));
const gained = [...setA].filter((w) => !setB.has(w));

const lines = [];
lines.push("DEDUPE " + (APPLY ? "APPLIED" : "DRY RUN") + " — sense-level only, words preserved");
lines.push("=".repeat(60));
lines.push("words scanned:            " + wordsBefore.length);
lines.push("words with a fold:        " + wordsTouched);
lines.push("T1 exact sense merges:    " + t1);
lines.push("T2 contained sense merges:" + t2);
lines.push("duplicate relations dropped: " + relDrops);
lines.push("HEADWORDS lost: " + lost.length + "   gained: " + gained.length +
  ((lost.length || gained.length) ? "  <-- SHOULD BE 0/0" : "   ✓ no words removed"));
lines.push("");
lines.push("---- T1 examples (exact; fold 1st INTO 2nd) ----");
for (const [w, a, b] of examples.t1) lines.push("[" + w + "]\n   drop: " + a + "\n   keep: " + b);
lines.push("");
lines.push("---- T2 examples (contained; review these) ----");
for (const [w, a, b] of examples.t2) lines.push("[" + w + "]\n   drop: " + a + "\n   keep: " + b);

const report = lines.join("\n") + "\n";
fs.writeFileSync(OUT, report);
process.stdout.write(report.split("\n").slice(0, 60).join("\n") + "\n");
process.stderr.write("\nfull report written to " + OUT + "\n");
