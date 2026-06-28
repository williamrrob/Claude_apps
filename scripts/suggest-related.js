#!/usr/bin/env node
/*
 * suggest-related.js — propose "related word" links from gloss embeddings.
 *
 * ~69% of headwords have no related (`r`) links. For each word this finds its
 * nearest neighbours by meaning (cosine over the stored word vectors in
 * embeddings.sqlite) and proposes the top few as related words — skipping the
 * word itself, anything already in its syn/ant/related lists, and obvious
 * morphological variants (same long stem) to cut near-duplicate spam.
 *
 * Unlike the 891 MB embeddings.sqlite (a local-only artifact), these links bake
 * into the shards, so the deployed static app gets "see also" suggestions at
 * zero runtime cost.
 *
 * DRY RUN by default (writes a proposal report); --apply merges proposals into
 * each word's `r` list (dedup-preserving). Sense-level metadata only — never
 * touches the headword set.
 *
 *   node scripts/suggest-related.js --word nostalgia
 *   node scripts/suggest-related.js --shard ca [--k 6] [--sim 0.78]
 *   node scripts/suggest-related.js --limit 2000        # first N missing-rel words
 *   node scripts/suggest-related.js --shard ca --apply
 *
 * A full-corpus run is O(words × 77k) dot products — scope it, or run a wide
 * --limit as a background job. Requires embeddings.sqlite (`npm run embed build`).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const embed = require("./embed.js");
const { stringifyShard } = require("./shard-format.js");

const EMPTY = "";
const WORDS_DIR = path.join(__dirname, "..", "words");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");          // include words that already have related links
const K = parseInt(arg("--k", "6"), 10);
const SIM = parseFloat(arg("--sim", "0.78"));
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const ONLY_SHARD = arg("--shard", null);
const ONLY_WORD = arg("--word", null);
const OUT = arg("--out", path.join(__dirname, "..", "suggest-related-dryrun.txt"));

if (!fs.existsSync(embed.EMB_DB)) {
  process.stderr.write("embeddings.sqlite missing — run: npm run embed build\n");
  process.exit(1);
}

// ---- load all word vectors into one flat matrix (fast neighbour scan) --------
const store = embed.openStore(true);
const rows = store.prepare("SELECT word, v FROM word").all();
const N = rows.length, DIM = embed.DIM;
const MAT = new Float32Array(N * DIM);
const WORDS = new Array(N);
const INDEX = new Map();
for (let i = 0; i < N; i++) {
  WORDS[i] = rows[i].word;
  INDEX.set(rows[i].word, i);
  MAT.set(embed.blobToF32(rows[i].v), i * DIM); // vectors are L2-normalized → dot == cosine
}

// existing s/a/r targets per word, to avoid proposing what's already linked
function existingLinks(e) {
  const s = new Set();
  for (const key of ["s", "a", "r"]) for (const t of (e[key] || [])) s.add(String(t).toLowerCase());
  return s;
}
// crude morphological-variant guard: share a 5+ char prefix and one contains the other
function variant(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x.length >= 5 && y.length >= 5 && x.slice(0, 5) === y.slice(0, 5) && (x.includes(y) || y.includes(x))) return true;
  return false;
}

function neighbours(word, exclude) {
  const qi = INDEX.get(word);
  if (qi === undefined) return [];
  const q = qi * DIM;
  const scored = [];
  for (let i = 0; i < N; i++) {
    if (i === qi) continue;
    const o = WORDS[i];
    if (exclude.has(o.toLowerCase())) continue;
    let dot = 0; const base = i * DIM;
    for (let d = 0; d < DIM; d++) dot += MAT[q + d] * MAT[base + d];
    if (dot >= SIM) scored.push([o, dot]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const cand of scored) {
    if (out.length >= K) break;
    if (cand[0].toLowerCase() === word.toLowerCase()) continue;
    if (out.some((x) => variant(x[0], cand[0])) || variant(word, cand[0])) continue;
    out.push(cand);
  }
  return out;
}

// ---- choose which shards / words to process ---------------------------------
let files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")).sort();
if (ONLY_WORD) files = [String(ONLY_WORD).slice(0, 2).toLowerCase() + ".json"];
else if (ONLY_SHARD) files = files.filter((f) => f === ONLY_SHARD + ".json");
else if (!LIMIT) {
  process.stderr.write("refusing a full-corpus run unscoped — use --word, --shard, or --limit N\n");
  process.exit(1);
}

const proposals = []; // [word, [[t,score],...]]
let scanned = 0, enriched = 0, added = 0;

for (const file of files) {
  const p = path.join(WORDS_DIR, file);
  if (!fs.existsSync(p)) continue;
  const obj = JSON.parse(fs.readFileSync(p, "utf8"));
  let shardChanged = false;

  for (const word of Object.keys(obj)) {
    if (ONLY_WORD && word !== ONLY_WORD) continue;
    const e = obj[word];
    const hasRel = Array.isArray(e.r) && e.r.length > 0;
    if (!ALL && hasRel) continue;            // default: only fill gaps
    if (!INDEX.has(word)) continue;          // no vector (no glosses)
    if (LIMIT && scanned >= LIMIT) break;
    scanned++;

    const nb = neighbours(word, existingLinks(e));
    if (!nb.length) continue;
    proposals.push([word, nb]);
    enriched++; added += nb.length;

    if (APPLY) {
      const seen = new Set((e.r || []).map((t) => String(t).toLowerCase()));
      const merged = (e.r || []).slice();
      for (const [t] of nb) if (!seen.has(t.toLowerCase())) { merged.push(t); seen.add(t.toLowerCase()); }
      e.r = merged;
      shardChanged = true;
    }
  }
  if (APPLY && shardChanged) fs.writeFileSync(p, stringifyShard(obj));
  if (LIMIT && scanned >= LIMIT) break;
}

// ---- report -----------------------------------------------------------------
const L = [];
L.push("SUGGEST-RELATED " + (APPLY ? "APPLIED" : "DRY RUN") +
  " — k≤" + K + ", cosine ≥ " + SIM + (ALL ? ", all words" : ", gap words only"));
L.push("=".repeat(60));
L.push("words considered:   " + scanned);
L.push("words enriched:     " + enriched);
L.push("related links " + (APPLY ? "added:        " : "proposed:     ") + added);
L.push("");
for (const [w, nb] of proposals.slice(0, 60)) {
  L.push("[" + w + "]  +" + nb.map((x) => x[0] + " (" + x[1].toFixed(2) + ")").join(", "));
}
if (proposals.length > 60) L.push("... (" + (proposals.length - 60) + " more in this report)");
const allLines = [];
allLines.push(L.slice(0, 4).join("\n"));
for (const [w, nb] of proposals) allLines.push("[" + w + "]  +" + nb.map((x) => x[0] + " (" + x[1].toFixed(2) + ")").join(", "));
fs.writeFileSync(OUT, allLines.join("\n") + "\n");
process.stdout.write(L.join("\n") + "\n");
process.stderr.write("\nfull report (" + proposals.length + " words) at " + OUT + "\n");
