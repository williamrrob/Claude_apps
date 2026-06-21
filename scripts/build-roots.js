// Build a searchable lexicon of Latin / Greek / PIE source words ("roots") that
// actually feed English vocabulary — derived from data, not hand-curated.
//
// We already ship per-word etymologies under words/<xx>.json (extracted from
// Wiktionary). Those etymologies name the source lemma, its romanization and a
// gloss right inline, e.g.  «from Ancient Greek βίος (bíos, “life”)»  or
// «from Latin scribere (“to write”)». This script scans every English entry,
// collects those citations, and writes roots.json:
//
//   { "<ascii key>": { l, lang, g, rom?, en:[english words], n } , ... }
//
//   l    canonical lemma (original script, with macrons/diacritics)
//   lang source language (Latin, Ancient Greek, Proto-Indo-European, …)
//   g    short gloss
//   rom  romanization (Greek/PIE), also used as an extra search key
//   en   English words built on it (most common first), capped
//   n    how many English words cite it (popularity)
//
// Keys are ASCII-folded + lowercased so "scribere", "bios", "bi/o" all resolve.
// Obscure lemmas we don't have are looked up live against the Wiktionary API at
// runtime, so this only needs to cover the common, English-relevant ones.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");

const SRC_LANGS = [
  "Proto-Indo-European", "Proto-Hellenic", "Proto-Italic", "Proto-Germanic",
  "Ancient Greek", "Hellenistic Greek", "Koine Greek", "Greek",
  "Late Latin", "Medieval Latin", "New Latin", "Vulgar Latin", "Latin",
];
// Normalise the many Wiktionary labels down to what we show on the timeline.
const LANG_CANON = {
  "Greek": "Ancient Greek", "Hellenistic Greek": "Ancient Greek", "Koine Greek": "Ancient Greek",
  "Late Latin": "Latin", "Medieval Latin": "Latin", "New Latin": "Latin", "Vulgar Latin": "Latin",
};
const LANG_RE = new RegExp(
  "\\b(" + SRC_LANGS.join("|") + ")\\s+([^\\s,;.()]+)\\s*(?:\\(([^)]*)\\))?", "g");

// Strip macrons / breves / accents so search keys are plain ASCII; transliterate
// the handful of non-Latin scripts we care about via NFD + diacritic removal.
function fold(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
// Split a parenthetical into (romanization, gloss): the gloss is the quoted
// part, the romanization is the unquoted lead (mirrors app.js extractSource).
function splitParen(inner) {
  if (!inner) return { rom: "", gloss: "" };
  const qi = inner.search(/[“"]/);
  const firstTok = (s) => (s.trim().split(/[\s,;]+/)[0] || "");
  if (qi < 0) return { rom: firstTok(inner), gloss: "" };
  let gloss = inner.slice(qi).replace(/[“”"]/g, "").trim();
  if ((gloss.match(/\(/g) || []).length > (gloss.match(/\)/g) || []).length)
    gloss = gloss.replace(/\s*\([^()]*$/, "").trim();
  // a romanization is a single token; the gloss is the quoted part
  return { rom: firstTok(inner.slice(0, qi)), gloss: gloss.split(";")[0].trim() };
}
// Wiktionary's borrowed/derived/inherited template markers sometimes survive
// glued to a lemma before a period ("attributusbor."); peel them off.
function preclean(e) {
  return e.replace(/(?:bor|der|inh|cog|cal|abbr|clip|cln|pej|dim|lbor|rel|eq|q)\.(?=[\s,;)]|$)/g, " ");
}

const roots = Object.create(null);
function add(lang, lemma, rom, gloss, enWord) {
  lemma = lemma.replace(/[*]/g, "").trim();
  // skip affixes / bound fragments and template-marker noise (e.g. "-alisbor.")
  if (!lemma || lemma.length < 2 || /^-|-$/.test(lemma) || /\b(bor|der|inh|cog|cal)\.$/.test(lemma)) return;
  const canonLang = LANG_CANON[lang] || lang;
  const isPIE = /Proto-/.test(canonLang);
  // Greek/PIE lemmas are in non-Latin script (βίος, *gʷeyh₃-); key them by their
  // romanization (bios, gweyh) since that's how an English speaker searches.
  let key = fold(lemma);
  if (!/[a-z]/.test(key) && rom) key = fold(rom);
  // must be a single clean token (drops parse artifacts like "kalligraphia, literally")
  if (!/^[a-z][a-z'-]{1,}$/.test(key)) return;
  let r = roots[key];
  if (!r) r = roots[key] = { l: lemma, lang: canonLang, g: gloss || "", rom: rom || "", en: [], _en: new Set(), n: 0 };
  // keep the most informative record if we see the lemma several times
  if (!r.g && gloss) r.g = gloss;
  if (!r.rom && rom) r.rom = rom;
  if (!isPIE && /Proto-/.test(r.lang) && !/Proto-/.test(canonLang)) { r.lang = canonLang; r.l = lemma; }
  if (enWord && !r._en.has(enWord)) { r._en.add(enWord); r.n++; if (r.en.length < 24) r.en.push(enWord); }
}

let scanned = 0;
for (const f of fs.readdirSync(WORDS)) {
  if (!f.endsWith(".json")) continue;
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const w of Object.keys(sh)) {
    scanned++;
    const e = sh[w] && sh[w].e;
    if (!e) continue;
    let m;
    const ec = preclean(e);
    LANG_RE.lastIndex = 0;
    while ((m = LANG_RE.exec(ec))) {
      const sp = splitParen(m[3]);
      add(m[1], m[2], sp.rom, sp.gloss, /^[a-z]{2,}$/.test(w) ? w : null);
    }
  }
}

// Keep the English-relevant set: a real gloss OR at least two English words.
// Prefer shorter English derivatives (more likely to be common headwords).
const out = Object.create(null);
let kept = 0;
for (const key of Object.keys(roots)) {
  const r = roots[key];
  if (!r.g && r.n < 2) continue;
  r.en.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const rec = { l: r.l, lang: r.lang, g: r.g, en: r.en.slice(0, 16), n: r.n };
  if (r.rom && fold(r.rom) !== key) rec.rom = r.rom;
  out[key] = rec;
  // index Greek/PIE by romanization too, so "bios" finds βίος
  if (rec.rom) { const rk = fold(rec.rom); if (/^[a-z][a-z'-]{1,}$/.test(rk) && rk !== key && !out[rk]) out[rk] = rec; }
  kept++;
}

const dest = path.join(ROOT, "roots.json");
fs.writeFileSync(dest, JSON.stringify(out));
const byLang = {};
for (const k in out) byLang[out[k].lang] = (byLang[out[k].lang] || 0) + 1;
console.log("english entries scanned:", scanned);
console.log("root lemmas kept:", kept, "(keys incl. romanizations:", Object.keys(out).length + ")");
console.log("by language:", JSON.stringify(byLang));
console.log("size:", (fs.statSync(dest).size / 1048576).toFixed(2), "MB ->", dest);
