// Generate medical-vocabulary breakdowns and merge them into the per-word shards.
//
// The base engine had no medical/scientific morphemes, so it confidently
// mis-split medical words into unrelated classical pieces with stray single
// letters (esophageal → e·soph·a·ge·al, "wisdom of the earth"; gastric →
// g·astr·ic). Adding those morphemes to the engine's general matcher would
// mis-fire on common words (uter→comp·uter), so instead we use them surgically.
//
// We run an *augmented* engine (base morphemes + scripts/med-morphemes.json) and
// emit a breakdown for a word only when:
//   * the base engine's parse is GARBAGE — it has no real root, an unknown, low
//     confidence, or a stray non-linker single letter (the tell-tale sign), and
//   * the augmented parse is fully clean (no unknown, no stray single letters,
//     >=2 parts) and genuinely uses a medical morpheme.
// So a word the base engine already handled well (abdominal → ab·domin·al,
// antimicrobial → anti·micro·bi·al) is never touched — no regressions.
//
// A hand-reviewed skip list removes the few cases where a medical morpheme
// cleanly tiles a non-medical word (omega→o·mega, deaden→de·aden, the -itise
// verbs that "-itis" grabs). Results land in each word's authoritative `b` slot,
// with the medical morpheme's meaning + origin carried inline (it isn't in the
// app's DB).
//
// Run:  node scripts/build-medbreakdowns.js   (after build-medroots.py)

"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");

const med = JSON.parse(fs.readFileSync(path.join(__dirname, "med-morphemes.json"), "utf8")).morphemes;
const data = require(path.join(ROOT, "data.js"));
const M = data.MORPHEMES;
const firstSense = (m) => m.split(",")[0].trim();

// hand-reviewed exclusions: non-medical words a medical morpheme happens to tile
const SKIP_WORD = new Set((
  "omega superior superiority deaden deadened anointer litheness metatherian alecto " +
  "columbo suricata transmigrante synovitis compost impost signpost confidante"
).split(" "));
const SKIP_RE = /itise[drs]?$/; // sensitise / sensitised — "-itis" mis-grabs these

const isStray = (p) => p.surface.length === 1 && p.kind !== "linker";

// 1) baseline engine — is each word's parse garbage (override-worthy) or fine?
let engine = require(path.join(ROOT, "engine.js"));
let vocab = [];
for (const f of fs.readdirSync(WORDS)) {
  if (f.endsWith(".json")) vocab = vocab.concat(Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f)))));
}
const baseBad = {};
for (const w of vocab) {
  try {
    const r = engine.decompose(w);
    baseBad[w] = !r.hasRoot || r.confidence < 0.6 || r.parts.some((p) => p.kind === "unknown") || r.parts.some(isStray);
  } catch (e) { baseBad[w] = false; }
}

// 2) augmented engine — base morphemes + medical ones
med.forEach((m) => {
  const e = { id: m.id, forms: m.forms, origin: m.origin, source: m.source, meaning: m.meaning };
  (m.cat === "suffix" ? M.suffixes : M.roots).push(e);
});
delete require.cache[require.resolve(path.join(ROOT, "engine.js"))];
engine = require(path.join(ROOT, "engine.js"));
const medById = {};
med.forEach((m) => { medById[m.id] = m; });

// 3) emit only where the base was garbage and the augmented parse is clean+medical
const out = {};
for (const w of vocab) {
  if (!baseBad[w] || SKIP_WORD.has(w) || SKIP_RE.test(w)) continue;
  let r; try { r = engine.decompose(w); } catch (e) { continue; }
  if (!r.hasRoot || r.parts.length < 2 || r.parts.some((p) => p.kind === "unknown") || r.parts.some(isStray)) continue;
  if (!r.parts.some((p) => medById[p.id])) continue;
  out[w] = r.parts.map(function (p) {
    const m = medById[p.id];
    return m ? { s: p.surface, k: p.kind, g: firstSense(m.meaning), o: m.origin } : { s: p.surface, k: p.kind };
  });
}

// 4) merge into shards — fill an empty `b` slot or replace a "whole" marker; a
// real multi-part split from MorphoLex/Wiktionary always wins.
const byShard = {};
Object.keys(out).forEach((w) => { (byShard[w.slice(0, 2)] = byShard[w.slice(0, 2)] || {})[w] = out[w]; });
let added = 0;
for (const key of Object.keys(byShard)) {
  const p = path.join(WORDS, key + ".json");
  if (!fs.existsSync(p)) continue;
  const shard = JSON.parse(fs.readFileSync(p, "utf8"));
  let touched = false;
  for (const w of Object.keys(byShard[key])) {
    const rec = shard[w];
    if (!rec || (rec.b && rec.b.length >= 2)) continue;
    rec.b = byShard[key][w]; added++; touched = true;
  }
  if (touched) fs.writeFileSync(p, JSON.stringify(shard));
}
console.log("medical breakdowns generated:", Object.keys(out).length, "| merged into shards:", added);
