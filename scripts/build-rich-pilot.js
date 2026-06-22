// PILOT enrichment for the scribere (scrib-/script-) family.
//
// Demonstrates the build-rich.js improvements (lifted sense cap, WordNet merge,
// per-sense domain tags from Wiktionary topics) on a small family, by fetching
// per-word data from kaikki.org instead of the full multi-GB dump. Patches just
// the matched words' records in their shards (preserving existing breakdown `b`
// and relation `rel` fields and every other word in the shard).
//
// Run:  node scripts/build-rich-pilot.js

"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const cmudict = require("cmu-pronouncing-dictionary").dictionary;
const { convert } = require("./arpabet.js");
const { extractSenses, mergeWordNet, cleanEt, MAX_SENSES } = require("./build-rich.js");

const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "dictionary.json"), "utf8"));

// the pilot family: members of a morpheme-index root (default scrib), plus any
// vocab word literally containing the root forms. Usage: node build-rich-pilot.js [rootId]
const rootId = process.argv[2] || "scrib";
const vocab = new Set();
for (const f of fs.readdirSync(WORDS)) {
  if (!f.endsWith(".json")) continue;
  Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"))).forEach((w) => vocab.add(w));
}
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, "morpheme-index.json"), "utf8"));
const members = new Set(Array.isArray(idx[rootId]) ? idx[rootId] : []);
const family = [...members].filter((w) => vocab.has(w)).sort();

function kaikkiUrl(w) {
  return "https://kaikki.org/dictionary/English/meaning/" + w[0] + "/" + w.slice(0, 2) + "/" + w + ".jsonl";
}
function fetchEntries(w) {
  try {
    const out = execFileSync("curl", ["-s", "--max-time", "20", kaikkiUrl(w)], { maxBuffer: 1 << 24, encoding: "utf8" });
    if (!out || out[0] === "<") return []; // 404 page
    return out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function pickWords(arr, max, exclude) {
  const out = [], seen = new Set();
  for (const x of arr || []) {
    const w = x && x.word;
    if (!w || w === exclude || !/^[a-z]{2,}$/.test(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

const byShard = {};
let enriched = 0, missed = [];
for (const w of family) {
  const entries = fetchEntries(w);
  const rec = { d: [], s: [], a: [], r: [] };
  for (const o of entries) {
    if (!o.senses) continue;
    if (rec.d.length < MAX_SENSES) rec.d = rec.d.concat(extractSenses(o, MAX_SENSES - rec.d.length));
    if (!rec.e && o.etymology_text) { const e = cleanEt(o.etymology_text); if (e) rec.e = e; }
    if (!rec.i && o.sounds) {
      const ga = o.sounds.find((s) => s.ipa && (s.tags || []).some((t) => /General.American|GenAm|\bUS\b/.test(t))) || o.sounds.find((s) => s.ipa);
      if (ga) rec.i = ga.ipa;
    }
    rec.s = rec.s.concat(pickWords(o.synonyms, 12, w));
    rec.a = rec.a.concat(pickWords(o.antonyms, 8, w));
    rec.r = rec.r.concat(pickWords(o.related, 12, w)).concat(pickWords(o.derived, 12, w));
  }
  let d = mergeWordNet(rec.d.slice(0, MAX_SENSES), dict[w], MAX_SENSES);
  if (!d.length) { missed.push(w); continue; }

  const out = { d: d };
  if (rec.e) out.e = rec.e;
  const dd = (a, m) => { const o = [], seen = new Set(); for (const x of a) { if (x !== w && !seen.has(x)) { seen.add(x); o.push(x); } if (o.length >= m) break; } return o; };
  const s = dd(rec.s, 8), a = dd(rec.a, 6), r = dd(rec.r, 10);
  if (s.length) out.s = s;
  if (a.length) out.a = a;
  if (r.length) out.r = r;
  const arp = cmudict[w]; const c = arp ? convert(arp) : null;
  const ipa = rec.i || (c && c.ipa);
  if (ipa) out.i = ipa;
  if (c) out.rs = c.resp;

  (byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {})[w] = out;
  enriched++;
  process.stderr.write("  " + w + ": " + d.length + " senses (" + d.filter((x) => x.dom).length + " domain-tagged)\n");
}

// patch shards, preserving existing breakdown (b) and relation (rel) and all other words
for (const key of Object.keys(byShard)) {
  const p = path.join(WORDS, key + ".json");
  const shard = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  for (const w of Object.keys(byShard[key])) {
    const prev = shard[w] || {};
    const next = byShard[key][w];
    if (prev.b) next.b = prev.b;     // keep curated/engine breakdown
    if (prev.rel) next.rel = prev.rel; // keep inflection/derivation pointer
    shard[w] = next;
  }
  fs.writeFileSync(p, JSON.stringify(shard));
}
console.log("\n"+rootId+" family:", family.length, "words | enriched:", enriched, "| no data:", missed.length);
if (missed.length) console.log("  no kaikki/WordNet entry:", missed.join(", "));
