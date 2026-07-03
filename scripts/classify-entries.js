#!/usr/bin/env node
/*
 * classify-entries.js — assign every entry a TYPE and a RICHNESS tier, from
 * signals we already have. Report only: writes review/classification.tsv and
 * per-category candidate samples for qwen validation. Mutates nothing.
 *
 * TYPE (first match wins):
 *   phrase       headword contains whitespace
 *   inflection   has a rel redirect (plural/variant/spelling of …)
 *   coinage      NARROW fandom/pop-culture: gloss self-identifies as a ship,
 *                fandom, franchise-fan term, stan/-cest/fanfic coinage, or a
 *                proper-noun blend. (Candidate — qwen confirms; general slang
 *                and genuine nonce vocab are NOT swept here.)
 *   name         proper noun: capitalized head AND gloss names a person/place
 *                ("A surname", "A given name", "A city/town/… in …")
 *   established  everything else (the default real-word bucket)
 *
 * RICHNESS (one tier): rich when the entry carries real substance —
 *   has etymology AND (2+ senses OR an example OR any relations OR audio).
 *   else not-rich.
 *
 *   node scripts/classify-entries.js            # counts + write TSV
 *   node scripts/classify-entries.js --sample N # also emit N per category → review/class-sample-<type>.txt
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const USAGE = path.join(ROOT, "usage");
const SAMPLE = (() => { const i = process.argv.indexOf("--sample"); return i !== -1 ? Number(process.argv[i + 1]) : 0; })();

// rich-data signals
const db = new DatabaseSync(path.join(ROOT, "vendor-data", "kaikki-rich.sqlite"), { readOnly: true });
const tags = new Map(), attest = new Set();
for (const r of db.prepare("SELECT word, tags, attest_year FROM sense").all()) {
  const k = r.word.toLowerCase();
  let s = tags.get(k); if (!s) tags.set(k, (s = new Set()));
  for (const t of JSON.parse(r.tags || "[]")) s.add(String(t).toLowerCase());
  if (r.attest_year) attest.add(k);
}
db.close();

const usageHas = new Set();
for (const f of fs.readdirSync(USAGE).filter((x) => x.endsWith(".json"))) {
  const o = JSON.parse(fs.readFileSync(path.join(USAGE, f), "utf8"));
  for (const [w, s] of Object.entries(o)) if (Array.isArray(s) && s.some((v) => v > 0)) usageHas.add(w.toLowerCase());
}

// NARROW fandom/pop-culture gloss patterns (widened from score-junk.js)
const COINAGE_GLOSS = new RegExp([
  "\\bfandom\\b", "\\bfan-?(?:made|fiction|fic|art|vid|dom)\\b", "\\bfanfic",
  "\\bship(?:ping)? name\\b", "\\b(?:a|the) (?:romantic )?pairing of\\b",
  "romantic (?:pairing|relationship) (?:of|between)", "\\breal-person pairing\\b",
  "(?:portmanteau|blend) of\\s+[A-Z][\\w'-]+\\s+and\\s+[A-Z][\\w'-]+",
  "\\bstan(?:dom)?\\b", "-cest\\b", "\\bfursona\\b", "\\bwaifu\\b",
  "fan of (?:the )?(?:musical|series|show|film|band|franchise)",
  "\\bsubgenre of\\b.*fan", "\\bcharacters?\\b.*\\band\\b.*(?:from the|in the)\\s+(?:series|show|film|game|franchise)",
].join("|"));
const NAME_GLOSS = /^(?:A|An|The)\s+(?:surname|given name|male given name|female given name|patronymic|placeholder name|city|town|village|hamlet|capital|county|river|lake|mountain|island|province|state|country|region|municipality|commune|district|prefecture|borough|nickname)\b/i;
// pardons: a real substantive register keeps a word out of coinage
const SUBSTANTIVE = ["archaic", "obsolete", "historical", "dialectal", "chemistry", "medicine", "biology", "physics", "law", "botany", "anatomy", "mathematics", "linguistics", "nautical", "military", "heraldry"];

function classify(w, rec) {
  const lc = w.toLowerCase();
  const gloss = (rec.d && rec.d[0] && rec.d[0].g) || "";
  const t = tags.get(lc) || new Set();
  // a proper-name gloss wins even for multi-word heads, so "John Smith" and
  // "New York" classify as name, not phrase
  const looksName = /^[A-Z]/.test(w) && NAME_GLOSS.test(gloss);
  // …or a Title-Case multi-word head that reads as a personal name even when
  // the gloss is prose ("An American poet."), guarded to avoid ordinary
  // capitalized idioms
  const titleCaseName = /\s/.test(w) && /^[A-Z][a-z'’.-]*(?:\s[A-Z][a-z'’.-]*)+$/.test(w) &&
    /\b(?:surname|given name|full name|footballer|politician|actor|actress|singer|writer|poet|author|painter|musician|composer|philosopher|scientist|player|born|\d{4})\b/i.test(gloss);
  // administrative places whose gloss doesn't lead with "A city…" — qwen
  // caught "Jack County", "Dukes County" (gloss: "One of 254 counties in…")
  const placeName = /^[A-Z]/.test(w) &&
    /\b(?:count(?:y|ies)|province|prefecture|municipalit(?:y|ies)|department|district|region|state|territory|canton|parish|oblast|governorate|voivodeship)\b/i.test(gloss) &&
    /\b(?:in|of|one of)\b/i.test(gloss);
  // inflection ONLY when the gloss is a PURE pointer (plural/participle/
  // spelling of X) — a lexicalized form with its own real meaning (dedicated,
  // accursed, slaked) is an established word despite carrying a rel
  const pureInflectionGloss = /^(?:(?:present |past )?participle|plural|singular|gerund|simple past|past tense|comparative|superlative|(?:alternative|obsolete|archaic|dated|eye[- ]dialect|nonstandard|American|British|Oxford) (?:spelling|form)|alternative form|misspelling|initialism|abbreviation|contraction|inflection|(?:third-person|first-person) singular)\b[^.]*\bof\b/i.test(gloss.trim());
  let type;
  if (looksName || titleCaseName || placeName) type = "name";
  else if (/\s/.test(w)) type = "phrase";
  else if (rec.rel && pureInflectionGloss) type = "inflection";
  else if (COINAGE_GLOSS.test(gloss) && ![...t].some((x) => SUBSTANTIVE.includes(x))) type = "coinage";
  else if (/^[A-Z]/.test(w) && NAME_GLOSS.test(gloss)) type = "name";
  else type = "established";

  const rich = !!rec.e && ((rec.d || []).length >= 2 || (rec.d && rec.d.some((s) => s.x)) ||
    (rec.s && rec.s.length) || (rec.a && rec.a.length) || (rec.r && rec.r.length) || rec.au);
  return { type, rich: rich ? "rich" : "not-rich" };
}

const counts = {}; const richCounts = { rich: 0, "not-rich": 0 };
const samples = {}; const out = [];
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, rec] of Object.entries(sh)) {
    const c = classify(w, rec);
    counts[c.type] = (counts[c.type] || 0) + 1;
    richCounts[c.rich]++;
    out.push(w + "\t" + c.type + "\t" + c.rich);
    if (SAMPLE) {
      (samples[c.type] = samples[c.type] || []).push(w + "\t" + ((rec.d && rec.d[0] && rec.d[0].g) || "").slice(0, 80));
    }
  }
}
fs.writeFileSync(path.join(ROOT, "review", "classification.tsv"), "word\ttype\trichness\n" + out.join("\n") + "\n");

console.log("CLASSIFY-ENTRIES — " + out.length + " entries");
console.log("type:     " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join("  "));
console.log("richness: rich " + richCounts.rich + "  not-rich " + richCounts["not-rich"]);
if (SAMPLE) {
  for (const [type, list] of Object.entries(samples)) {
    // deterministic shuffle for a representative spread
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = list.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).slice(0, SAMPLE).map((x) => x[1]);
    fs.writeFileSync(path.join(ROOT, "review", "class-sample-" + type + ".txt"), pick.join("\n") + "\n");
  }
  console.log("wrote review/class-sample-<type>.txt (" + SAMPLE + " each)");
}
