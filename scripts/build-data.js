// Build the vendored data files Rootwork ships:
//
//   dictionary.json      word -> [{ p: part-of-speech, d: definition }, ...]
//   morpheme-index.json  morphemeId -> [related words, ...]  (short→long)
//   pronunciation.json   word -> [IPA, respelling]
//   thesaurus.json       word -> { s: [synonyms], a: [antonyms] }
//
// Definitions come from WordNet via the `wordnet` npm package; pronunciations
// from the CMU Pronouncing Dictionary (`cmu-pronouncing-dictionary`), converted
// to IPA + a Merriam-Webster style respelling. Both are dev dependencies — we do
// NOT hand-write this data. The morpheme index is produced by running this
// project's own decomposition engine over the dictionary's vocabulary, so "other
// words with this root" stays consistent with what the app shows.
//
// Run with:  npm run build:data

"use strict";

const fs = require("fs");
const path = require("path");
const wordnet = require("wordnet");
const cmudict = require("cmu-pronouncing-dictionary").dictionary;
const { convert } = require("./arpabet.js");
const engine = require("../engine.js");

const ROOT = path.join(__dirname, "..");
const MAX_SENSES = 3;        // definitions kept per word
const RELATED_COMMON = 44;   // shortest (≈ most common) related words kept
const RELATED_RARE = 16;     // longest (≈ rarest) related words kept
const MAX_SYN = 8;
const MAX_ANT = 6;
const isWord = (w) => /^[a-z]{2,}$/.test(w);

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
  const thes = {};
  for (const w of words) {
    if (!isWord(w)) continue; // single, lowercase, alphabetic
    let defs;
    try { defs = await wordnet.lookup(w); } catch { continue; }
    const senses = [];
    const seen = new Set();
    const syn = new Set();
    const ant = new Set();
    for (const d of defs) {
      const def = cleanGloss(d.glossary);
      const p = POS[d.meta.synsetType] || d.meta.synsetType;
      const key = p + "|" + def;
      if (!seen.has(key) && senses.length < MAX_SENSES) {
        seen.add(key);
        senses.push({ p: p, d: def });
      }
      // Synonyms: the other members of each synset.
      (d.meta.words || []).forEach((m) => { if (isWord(m.word) && m.word !== w) syn.add(m.word); });
      // Antonyms: the "!" pointers, whose target synset words come with the data.
      (d.meta.pointers || []).forEach((ptr) => {
        if (ptr.pointerSymbol !== "!" || !ptr.data || !ptr.data.meta) return;
        (ptr.data.meta.words || []).forEach((m) => { if (isWord(m.word) && m.word !== w) ant.add(m.word); });
      });
    }
    if (senses.length) dict[w] = senses;
    const s = Array.from(syn).slice(0, MAX_SYN);
    const a = Array.from(ant).slice(0, MAX_ANT);
    if (s.length || a.length) {
      thes[w] = {};
      if (s.length) thes[w].s = s;
      if (a.length) thes[w].a = a;
    }
  }
  const dictWords = Object.keys(dict);
  console.log("dictionary words:", dictWords.length);
  console.log("thesaurus entries:", Object.keys(thes).length);

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

  // Keep both ends per morpheme: the shortest words (≈ most common) and, for big
  // affixes, a few of the longest (≈ rarest) so the UI can show "common + rare".
  // Stored shortest→longest so the client can slice each end.
  const indexOut = {};
  for (const id of Object.keys(index)) {
    const sorted = Array.from(index[id]).sort((a, b) => a.length - b.length || a.localeCompare(b));
    indexOut[id] = sorted.length <= RELATED_COMMON + RELATED_RARE
      ? sorted
      : sorted.slice(0, RELATED_COMMON).concat(sorted.slice(-RELATED_RARE));
  }
  console.log("indexed morphemes:", Object.keys(indexOut).length);

  // Pronunciation for the words we actually define (IPA + respelling).
  const pron = {};
  for (const w of dictWords) {
    const arp = cmudict[w];
    if (!arp) continue;
    const c = convert(arp);
    if (c) pron[w] = [c.ipa, c.resp];
  }
  console.log("pronunciations:", Object.keys(pron).length);

  fs.writeFileSync(path.join(ROOT, "dictionary.json"), JSON.stringify(dict));
  fs.writeFileSync(path.join(ROOT, "morpheme-index.json"), JSON.stringify(indexOut));
  fs.writeFileSync(path.join(ROOT, "pronunciation.json"), JSON.stringify(pron));
  fs.writeFileSync(path.join(ROOT, "thesaurus.json"), JSON.stringify(thes));

  const mb = (f) => (fs.statSync(path.join(ROOT, f)).size / 1048576).toFixed(2);
  console.log("wrote dictionary.json (" + mb("dictionary.json") + " MB)");
  console.log("wrote morpheme-index.json (" + mb("morpheme-index.json") + " MB)");
  console.log("wrote pronunciation.json (" + mb("pronunciation.json") + " MB)");
  console.log("wrote thesaurus.json (" + mb("thesaurus.json") + " MB)");
}

main().catch((e) => { console.error(e); process.exit(1); });
