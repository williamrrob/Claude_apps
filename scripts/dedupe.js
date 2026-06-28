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
 *   node scripts/dedupe.js --embed [--sim 0.9]      # semantic dedup (Ollama)
 *   node scripts/dedupe.js --shard uc               # limit to one shard
 *
 * Tiers (only same part-of-speech senses are ever compared):
 *   T1 exact     — normalized gloss identical                  (safe)
 *   T2 contained — one sense's content words ⊆ the other's,     (review)
 *                  both have ≥2 content words
 *   TE embedding — cosine of gloss vectors ≥ --sim (default .9) (with --embed)
 * Token-overlap-only matches with diverging nouns (e.g. cabdriver "taxi" vs
 * "carriage") are intentionally NOT merged — when in doubt, keep both.
 *
 * --embed is the robust path: pure text-overlap over-merges distinct senses
 * (e.g. absent "not existing" vs "away from a place"); embeddings tell them
 * apart. It reuses the gloss cache in embeddings.sqlite (from `embed build`) and
 * only calls Ollama for cache misses, so it's cheap once the corpus is built.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const WORDS_DIR = path.join(__dirname, "..", "words");
const APPLY = process.argv.includes("--apply");
const INCLUDE_T2 = process.argv.includes("--t2"); // T2 over-merges distinct senses; off by default
const EMBED = process.argv.includes("--embed");   // semantic merge via Ollama embeddings
const simArg = process.argv.indexOf("--sim");
const SIM = simArg !== -1 ? parseFloat(process.argv[simArg + 1]) : 0.9;
const outArg = process.argv.indexOf("--out");
const OUT = outArg !== -1 ? process.argv[outArg + 1] : path.join(__dirname, "..", "dedupe-dryrun.txt");

// Lazy embedding support: reuse the gloss cache in embeddings.sqlite when present
// (built by `embed build`), embedding only cache misses via Ollama.
let embed = null, embCache = null, getCachedGloss = null;
if (EMBED) {
  embed = require("./embed.js");
  if (fs.existsSync(embed.EMB_DB)) {
    embCache = embed.openStore(true);
    getCachedGloss = embCache.prepare("SELECT v FROM gloss WHERE hash=?");
  }
}
// Vectors for a word's glosses: cache hits first, one Ollama batch for the rest.
async function vectorsFor(glosses) {
  const out = new Array(glosses.length);
  const need = [], needIdx = [];
  for (let i = 0; i < glosses.length; i++) {
    const hit = getCachedGloss && getCachedGloss.get(embed.hashGloss(glosses[i]));
    if (hit) out[i] = embed.blobToF32(hit.v);
    else { need.push(glosses[i]); needIdx.push(i); }
  }
  if (need.length) {
    const fresh = await embed.embedTexts(need, "doc");
    for (let k = 0; k < need.length; k++) out[needIdx[k]] = fresh[k];
  }
  return out;
}

const STOP = new Set(("a an the of to in on at by for with from into onto upon as or and " +
  "is are was that this such which who whom whose etc eg ie one something someone").split(" "));
const contentSet = (g) => new Set(String(g || "").toLowerCase().replace(/[^a-z ]/g, " ")
  .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const normFull = (g) => String(g || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
// prefer the "richer" sense: has an example, then longer gloss
const richer = (x, y) => (((y.x ? 1 : 0) - (x.x ? 1 : 0)) || ((y.g || "").length - (x.g || "").length));

const { stringifyShard } = require("./shard-format.js");

// Optional --shard <xx> limits the run to one two-letter shard (handy for
// testing or targeted dedup); default is every shard.
const shardArg = process.argv.indexOf("--shard");
const ONLY_SHARD = shardArg !== -1 ? process.argv[shardArg + 1] : null;
let files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")).sort();
if (ONLY_SHARD) files = files.filter((f) => f === ONLY_SHARD + ".json");
let wordsTouched = 0, t1 = 0, t2 = 0, te = 0, relDrops = 0;
const examples = { t1: [], t2: [], te: [] };
const wordsBefore = [], wordsAfter = [];

main().catch((e) => { process.stderr.write("dedupe.js: " + e.message + "\n"); process.exit(1); });

async function main() {
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
      // In embed mode, get a vector per gloss up front (cache + one Ollama batch).
      if (EMBED) {
        const vs = await vectorsFor(meta.map((m) => m.d.g));
        for (let i = 0; i < meta.length; i++) meta[i].v = vs[i];
      }
      const dropped = new Array(meta.length).fill(false);
      for (let i = 0; i < meta.length; i++) {
        if (dropped[i]) continue;
        for (let j = i + 1; j < meta.length; j++) {
          if (dropped[j]) continue;
          if ((meta[i].d.p || "") !== (meta[j].d.p || "")) continue; // same POS only
          let tier = null, score = null;
          if (meta[i].nf && meta[i].nf === meta[j].nf) tier = "t1";
          else if (EMBED) {
            // Semantic near-duplicate: distinct senses score well below SIM, so
            // this won't conflate e.g. absent "not existing" vs "away".
            if (meta[i].v && meta[j].v) {
              score = embed.cosine(meta[i].v, meta[j].v);
              if (score >= SIM) tier = "te";
            }
          } else if (meta[i].cs.size >= 2 && meta[j].cs.size >= 2 &&
                   (subset(meta[i].cs, meta[j].cs) || subset(meta[j].cs, meta[i].cs))) tier = "t2";
          if (!tier) continue;
          // fold the poorer of i/j into the richer
          const poorerIsJ = richer(meta[i].d, meta[j].d) <= 0;
          const dropIdx = poorerIsJ ? j : i, keepIdx = poorerIsJ ? i : j;
          if (tier === "t1") t1++; else if (tier === "te") te++; else t2++;
          if (examples[tier].length < 12)
            examples[tier].push([word, meta[dropIdx].d.g, meta[keepIdx].d.g, score]);
          // T2 (contained) conflates distinct senses → report-only unless --t2.
          if (tier === "t2" && !INCLUDE_T2) continue;
          if (!meta[keepIdx].d.x && meta[dropIdx].d.x) meta[keepIdx].d.x = meta[dropIdx].d.x; // keep an example
          dropped[dropIdx] = true;
          changed = true;
          if (dropIdx === i) break; // i was folded away; stop comparing it
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

    if (changed) { wordsTouched++; shardChanged = true; }
    wordsAfter.push(word);
  }

  // Only rewrite shards that actually changed, so untouched shards keep their
  // existing formatting and we don't churn all 508 files for a few edits.
  if (APPLY && shardChanged) fs.writeFileSync(p, stringifyShard(obj));
}

// ---- guardrail: the headword set must be identical ----
const setB = new Set(wordsBefore), setA = new Set(wordsAfter);
const lost = [...setB].filter((w) => !setA.has(w));
const gained = [...setA].filter((w) => !setB.has(w));

const lines = [];
lines.push("DEDUPE " + (APPLY ? "APPLIED" : "DRY RUN") +
  (EMBED ? " — semantic (cosine ≥ " + SIM + (embCache ? ", gloss cache" : ", no cache") + ")" : "") +
  " — sense-level only, words preserved");
lines.push("=".repeat(60));
lines.push("words scanned:            " + wordsBefore.length);
lines.push("words with a fold:        " + wordsTouched);
lines.push("T1 exact sense merges:    " + t1);
lines.push("T2 contained sense merges:" + t2);
if (EMBED) lines.push("TE embedding sense merges:" + te);
lines.push("duplicate relations dropped: " + relDrops);
lines.push("HEADWORDS lost: " + lost.length + "   gained: " + gained.length +
  ((lost.length || gained.length) ? "  <-- SHOULD BE 0/0" : "   ✓ no words removed"));
lines.push("");
lines.push("---- T1 examples (exact; fold 1st INTO 2nd) ----");
for (const [w, a, b] of examples.t1) lines.push("[" + w + "]\n   drop: " + a + "\n   keep: " + b);
if (EMBED) {
  lines.push("");
  lines.push("---- TE examples (cosine ≥ " + SIM + "; fold 1st INTO 2nd) ----");
  for (const [w, a, b, s] of examples.te)
    lines.push("[" + w + "  cos=" + (s == null ? "?" : s.toFixed(3)) + "]\n   drop: " + a + "\n   keep: " + b);
} else {
  lines.push("");
  lines.push("---- T2 examples (contained; review these) ----");
  for (const [w, a, b] of examples.t2) lines.push("[" + w + "]\n   drop: " + a + "\n   keep: " + b);
}

const report = lines.join("\n") + "\n";
fs.writeFileSync(OUT, report);
process.stdout.write(report.split("\n").slice(0, 60).join("\n") + "\n");
process.stderr.write("\nfull report written to " + OUT + "\n");
} // end main
