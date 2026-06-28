#!/usr/bin/env node
/*
 * sense-merge.js — collapse a word's overlapping senses into ONE clean
 * definition with a local generative model (qwen2.5:3b via Ollama).
 *
 * Pipeline: gloss embeddings (from embeddings.sqlite, built by `embed build`)
 * cluster a word's SAME-PART-OF-SPEECH senses by cosine ≥ --sim; each cluster of
 * 2+ is rewritten by qwen2.5:3b into a single merged gloss. Unlike dedupe.js —
 * which keeps the richer of two near-duplicate senses verbatim — this *generates*
 * a new gloss that captures their shared meaning.
 *
 * SCOPE/SAFETY: sense-level only — never deletes a headword, never merges across
 * parts of speech. DRY RUN by default (writes a before→after report); --apply
 * writes shards. Every generated gloss is validated (non-empty, length-bounded,
 * no refusal/label cruft); a cluster is left untouched if validation fails.
 *
 *   node scripts/sense-merge.js [--sim 0.92] [--shard ab|--word foo|--limit N]
 *   node scripts/sense-merge.js --apply
 *
 * Requires: embeddings.sqlite (`npm run embed build`) and Ollama serving
 * qwen2.5:3b (`ollama pull qwen2.5:3b`).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const embed = require("./embed.js");
const { stringifyShard } = require("./shard-format.js");

const EMPTY = "";
const WORDS_DIR = path.join(__dirname, "..", "words");
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; };
const APPLY = process.argv.includes("--apply");
const SIM = parseFloat(arg("--sim", "0.92"));
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;        // max clusters to process (0 = all)
const ONLY_SHARD = arg("--shard", null);
const ONLY_WORD = arg("--word", null);
const MODEL = arg("--model", "qwen2.5:3b");
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const OUT = arg("--out", path.join(__dirname, "..", "sense-merge-dryrun.txt"));

const POS = { "n.": "noun", "v.": "verb", "adj.": "adjective", "adv.": "adverb",
  "prep.": "preposition", "conj.": "conjunction", "pron.": "pronoun", "interj.": "interjection" };
const posName = (p) => POS[p] || (p ? "(" + p + ")" : "word");

// ---- embedding cache (reuse embeddings.sqlite; embed misses transiently) -----
let embStore = null, getCachedGloss = null;
if (fs.existsSync(embed.EMB_DB)) {
  embStore = embed.openStore(true); // keep a reference so the statement isn't finalized
  getCachedGloss = embStore.prepare("SELECT v FROM gloss WHERE hash=?");
}
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

// ---- clustering: connected components over the cosine ≥ SIM graph (same POS) --
function clusters(meta) {
  const n = meta.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if ((meta[i].d.p || EMPTY) !== (meta[j].d.p || EMPTY)) continue;
      if (meta[i].v && meta[j].v && embed.cosine(meta[i].v, meta[j].v) >= SIM) parent[find(i)] = find(j);
    }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  return [...groups.values()].filter((g) => g.length > 1);
}

// ---- generation -------------------------------------------------------------
async function mergeGloss(word, pos, glosses) {
  const list = glosses.map((g, i) => (i + 1) + ". " + g).join("\n");
  const prompt = 'You merge dictionary definitions. Below are ' + glosses.length +
    ' definitions of the ' + posName(pos) + ' "' + word + '" that overlap in meaning. ' +
    'Write ONE concise definition that captures their shared meaning. Output ONLY the ' +
    'definition text — no numbering, no quotes, no label, no commentary. Do not add ' +
    'meaning that is not in the inputs.\n\n' + list + '\n\nMerged definition:';
  const res = await fetch(OLLAMA + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0 } }),
  });
  if (!res.ok) throw new Error("ollama /api/generate " + res.status + ": " + (await res.text()));
  return clean((await res.json()).response);
}

function clean(s) {
  let t = String(s == null ? EMPTY : s).trim();
  t = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || EMPTY; // first non-empty line
  t = t.replace(/^(merged\s+definition|definition)\s*:\s*/i, EMPTY);     // strip a label
  t = t.replace(/^["'`]+|["'`]+$/g, EMPTY).trim();                        // strip wrapping quotes
  return t;
}

// A merged gloss must be a plausible definition, not a refusal or a runaway.
function valid(merged, inputs) {
  if (!merged || merged.length < 3) return false;
  if (!/[a-z]/i.test(merged)) return false;
  if (/^(i\b|i'm|sorry|as an|i cannot|i can't|unfortunately)/i.test(merged)) return false;
  const longest = Math.max(...inputs.map((g) => g.length));
  if (merged.length > longest * 2 + 60) return false; // not wildly longer than its sources
  return true;
}

// ---- main -------------------------------------------------------------------
let files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")).sort();
if (ONLY_WORD) files = [String(ONLY_WORD).slice(0, 2).toLowerCase() + ".json"];
else if (ONLY_SHARD) files = files.filter((f) => f === ONLY_SHARD + ".json");

const wordsBefore = [], wordsAfter = [];
let merged = 0, sensesRemoved = 0, wordsTouched = 0, skipped = 0, capped = false;
const examples = [];

main().catch((e) => { process.stderr.write("sense-merge.js: " + e.message + "\n"); process.exit(1); });

async function main() {
  await ensureModel();
  const t0 = Date.now();

  for (const file of files) {
    const p = path.join(WORDS_DIR, file);
    if (!fs.existsSync(p)) continue;
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    let shardChanged = false;

    for (const word of Object.keys(obj)) {
      if (ONLY_WORD && word !== ONLY_WORD) { continue; }
      wordsBefore.push(word);
      const e = obj[word];
      if (!Array.isArray(e.d) || e.d.length < 2) { wordsAfter.push(word); continue; }

      const meta = e.d.map((d) => ({ d }));
      const vs = await vectorsFor(meta.map((m) => m.d.g || EMPTY));
      for (let i = 0; i < meta.length; i++) meta[i].v = vs[i];

      const groups = clusters(meta);
      if (!groups.length) { wordsAfter.push(word); continue; }

      const removeIdx = new Set();
      const newSense = new Map(); // anchor index -> merged sense object
      for (const g of groups) {
        if (LIMIT && merged >= LIMIT) { capped = true; break; }
        const idx = g.slice().sort((a, b) => a - b);
        const glosses = idx.map((i) => meta[i].d.g).filter(Boolean);
        if (glosses.length < 2) continue;
        let mg;
        try { mg = await mergeGloss(word, meta[idx[0]].d.p, glosses); }
        catch (err) { process.stderr.write("  merge failed for " + word + ": " + err.message + "\n"); skipped++; continue; }
        if (!valid(mg, glosses)) { skipped++; continue; }

        // surviving sense: merged gloss at the anchor (first) position; keep an example
        const anchor = idx[0];
        const ex = idx.map((i) => meta[i].d.x).find(Boolean);
        const s = { p: meta[anchor].d.p, g: mg };
        if (ex) s.x = ex;
        newSense.set(anchor, s);
        for (let k = 1; k < idx.length; k++) removeIdx.add(idx[k]);
        merged++;
        sensesRemoved += idx.length - 1;
        if (examples.length < 25) examples.push([word, meta[anchor].d.p, glosses.slice(), mg]);
      }

      if (newSense.size) {
        const rebuilt = [];
        for (let i = 0; i < meta.length; i++) {
          if (removeIdx.has(i)) continue;
          rebuilt.push(newSense.has(i) ? newSense.get(i) : meta[i].d);
        }
        if (APPLY) { e.d = rebuilt; shardChanged = true; }
        wordsTouched++;
      }
      wordsAfter.push(word);
      if (capped) break;
    }

    if (APPLY && shardChanged) fs.writeFileSync(p, stringifyShard(obj));
    if (capped) break;
  }

  // ---- guardrail: headword set unchanged --------------------------------
  const setB = new Set(wordsBefore), setA = new Set(wordsAfter);
  const lost = [...setB].filter((w) => !setA.has(w)).length;

  const L = [];
  L.push("SENSE-MERGE " + (APPLY ? "APPLIED" : "DRY RUN") + " — " + MODEL +
    ", cosine ≥ " + SIM + (getCachedGloss ? ", gloss cache" : ", no cache") +
    (capped ? " (stopped at --limit " + LIMIT + ")" : EMPTY));
  L.push("=".repeat(60));
  L.push("words scanned:        " + wordsBefore.length);
  L.push("words with a merge:   " + wordsTouched);
  L.push("clusters merged:      " + merged);
  L.push("senses removed:       " + sensesRemoved);
  L.push("clusters skipped (invalid/error): " + skipped);
  L.push("HEADWORDS lost: " + lost + (lost ? "  <-- SHOULD BE 0" : "   ✓ no words removed"));
  L.push("");
  L.push("---- examples (inputs -> merged) ----");
  for (const [w, pos, ins, out] of examples) {
    L.push("[" + w + "] (" + (pos || "?") + ")");
    for (const g of ins) L.push("   - " + g);
    L.push("   => " + out);
  }
  const report = L.join("\n") + "\n";
  fs.writeFileSync(OUT, report);
  process.stdout.write(report.split("\n").slice(0, 70).join("\n") + "\n");
  process.stderr.write("\n" + merged + " clusters in " + ((Date.now() - t0) / 1000).toFixed(1) +
    "s — full report at " + OUT + "\n");
}

async function ensureModel() {
  const res = await fetch(OLLAMA + "/api/tags").catch(() => null);
  if (!res || !res.ok) throw new Error("Ollama not reachable at " + OLLAMA);
  const names = (await res.json()).models.map((m) => m.name);
  if (!names.some((n) => n === MODEL || n.startsWith(MODEL.split(":")[0] + ":")))
    throw new Error("model " + MODEL + " not pulled — run: ollama pull " + MODEL);
}
