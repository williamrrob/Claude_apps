// Build the vendored data files Rootwork ships:
//
//   dictionary.json      word -> [{ p: part-of-speech, d: definition }, ...]
//   morpheme-index.json  morphemeId -> [related words, ...]
//
// Definitions come from WordNet via the `wordnet` npm package (a dev dependency
// — we do NOT hand-write definitions). The morpheme index is produced by running
// this project's own decomposition engine over the dictionary's vocabulary, so
// "other words with this root" stays consistent with what the app shows.
//
// Run with:  npm run build:data

"use strict";

const fs = require("fs");
const path = require("path");
const wordnet = require("wordnet");
const engine = require("../engine.js");

const ROOT = path.join(__dirname, "..");
const MAX_SENSES = 3;        // definitions kept per word
const MAX_RELATED = 30;      // related words kept per morpheme

const POS = { noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", adj: "adj." };

// Drop WordNet's quoted example sentences; keep the definition clause(s).
function cleanGloss(gloss) {
  const kept = gloss.split(";").filter((s) => !s.includes('"')).join("; ").trim();
  return kept || gloss.split(";")[0].trim();
}

async function main() {
  await wordnet.init();
  const words = await wordnet.list();

  const dict = {};
  for (const w of words) {
    if (!/^[a-z]{2,}$/.test(w)) continue; // single, lowercase, alphabetic
    let defs;
    try { defs = await wordnet.lookup(w); } catch { continue; }
    const senses = [];
    const seen = new Set();
    for (const d of defs) {
      const def = cleanGloss(d.glossary);
      const p = POS[d.meta.synsetType] || d.meta.synsetType;
      const key = p + "|" + def;
      if (seen.has(key)) continue;
      seen.add(key);
      senses.push({ p: p, d: def });
      if (senses.length >= MAX_SENSES) break;
    }
    if (senses.length) dict[w] = senses;
  }
  const dictWords = Object.keys(dict);
  console.log("dictionary words:", dictWords.length);

  // Morpheme index: which dictionary words genuinely contain each morpheme.
  // Quality gates keep this from filling up with force-parsed junk (the engine
  // will always find *some* split): the word must be a real word (>=4 letters),
  // fully explained by known morphemes (no "unknown" leftover), built on a real
  // root, and the morpheme must appear via a form of >=3 letters (so a 2-letter
  // form like "bi" doesn't drag in "big", "bit", "bin"...).
  const index = {};
  for (const w of dictWords) {
    if (w.length < 4) continue;
    let result;
    try { result = engine.decompose(w); } catch { continue; }
    if (!result || !result.parts || !result.hasRoot) continue;
    if (result.parts.some((p) => p.kind === "unknown")) continue;
    for (const part of result.parts) {
      if (!part.id || part.surface.length < 3) continue;
      (index[part.id] = index[part.id] || new Set()).add(w);
    }
  }

  // Keep a manageable, friendly set per morpheme: shorter (more common) words
  // first, then alphabetical. Stored as plain arrays.
  const indexOut = {};
  for (const id of Object.keys(index)) {
    indexOut[id] = Array.from(index[id])
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, MAX_RELATED);
  }
  console.log("indexed morphemes:", Object.keys(indexOut).length);

  fs.writeFileSync(path.join(ROOT, "dictionary.json"), JSON.stringify(dict));
  fs.writeFileSync(path.join(ROOT, "morpheme-index.json"), JSON.stringify(indexOut));

  const mb = (f) => (fs.statSync(path.join(ROOT, f)).size / 1048576).toFixed(2);
  console.log("wrote dictionary.json (" + mb("dictionary.json") + " MB)");
  console.log("wrote morpheme-index.json (" + mb("morpheme-index.json") + " MB)");
}

main().catch((e) => { console.error(e); process.exit(1); });
