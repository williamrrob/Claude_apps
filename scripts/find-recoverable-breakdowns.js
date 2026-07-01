#!/usr/bin/env node
/*
 * find-recoverable-breakdowns.js — among words currently forced to display
 * whole (b: [{k:"word"}]), find ones where we already have real curated root
 * information in the etymology text, so the whole-word treatment is throwing
 * away information rather than correctly admitting ignorance.
 *
 * Two extraction tiers:
 *   SURFACE — the etymology contains an explicit "By surface analysis, X + Y
 *     [+ Z]" annotation. High confidence: this phrase specifically states the
 *     intended English-spelling morpheme split.
 *   PROSE   — no surface-analysis annotation, but the LAST "from ... + ..."
 *     derivation clause names two or more Latin-script source terms. Lower
 *     confidence: word order/inflection/assimilation make this noisier.
 *
 * For each extracted term list, checks whether the terms (lowercased, stripped
 * of macrons/diacritics and leading/trailing hyphens) concatenate to
 * reconstruct the headword's letters exactly. A clean match is a strong
 * candidate for a real letter-split breakdown (like solipsism: sol+ips+ism).
 * A named-but-non-tiling match is a candidate for the `bWhole` treatment
 * (show the real roots, don't force a letter split) — like congee: con + meō,
 * where "meō" surfaces as "gee".
 *
 * This is a FINDER, not a writer — it never touches word data. Output is a
 * report for human review; use word.js field/bWhole to apply any of them.
 *
 * Usage:
 *   node scripts/find-recoverable-breakdowns.js [--tier surface|prose|all] [--out report.txt]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const WORDS_DIR = path.join(__dirname, "..", "words");
const tierArg = process.argv.indexOf("--tier");
const TIER = tierArg !== -1 ? process.argv[tierArg + 1] : "all";
const outArg = process.argv.indexOf("--out");
const OUT = outArg !== -1 ? process.argv[outArg + 1] : path.join(__dirname, "..", "recoverable-dryrun.txt");

function stripDiacritics(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function cleanTerm(t) {
  return stripDiacritics(t).toLowerCase().replace(/^-+|-+$/g, "").replace(/[^a-z]/g, "");
}

// SURFACE tier: "By surface analysis, hiero- + phant." (also handles "prefix +
// root + suffix", extra whitespace, and a trailing period or semicolon).
const SURFACE_RE = /by surface analysis,?\s+([^.;]+)[.;]/i;
function extractSurface(ety) {
  const m = SURFACE_RE.exec(ety);
  if (!m) return null;
  const terms = m[1].split("+").map(function (t) { return cleanTerm(t); }).filter(Boolean);
  return terms.length >= 2 ? terms : null;
}

// PROSE tier: the LAST "from ... + ..." clause. Latin-script word immediately
// before an optional parenthetical, e.g. "sōlus ("alone")" or "ipse". Skips
// non-Latin-script scooped-up junk (Greek/Cyrillic terms) by requiring the
// captured term to be ASCII-after-diacritic-stripping.
const CLAUSE_RE = /from\s+([a-zA-Zà-ÿĀ-ſ][^.;]*)/gi;
const TERM_RE = /([A-Za-zà-ÿĀ-ſ]+)(?:\s*\([^)]*\))?/g;
function extractProse(ety) {
  let lastClause = null, m;
  while ((m = CLAUSE_RE.exec(ety))) if (m[1].includes("+")) lastClause = m[1];
  if (!lastClause) return null;
  const parts = lastClause.split("+");
  if (parts.length < 2) return null;
  const terms = [];
  for (const part of parts) {
    TERM_RE.lastIndex = 0;
    const tm = TERM_RE.exec(part.trim());
    if (!tm) return null;
    const cleaned = cleanTerm(tm[1]);
    if (!cleaned || cleaned.length < 2) return null;
    terms.push(cleaned);
  }
  return terms;
}

function tiles(word, terms) {
  const w = cleanTerm(word);
  // exact concatenation
  if (terms.join("") === w) return "exact";
  // allow the FIRST term to be a prefix that's only partially present (rare
  // assimilation) — try dropping trailing letters from term 1 down to len 2
  return null;
}

const files = fs.readdirSync(WORDS_DIR).filter(function (f) { return f.endsWith(".json"); }).sort();

// Load every shard once: needed both to scan candidates and to check whether
// an extracted "term" is itself an existing plain-English headword — if it
// is (buff, bump, monk, gas, land...), the etymology is almost certainly
// describing a MODERN COMPOUND (buffer = buff + er), not a bound classical
// root, and doesn't belong in this sweep (that's solipsism/congee's territory
// specifically: Latin/Greek roots that no longer look like standalone words).
const shardObjs = [];
const allWords = new Set();
for (const f of files) {
  const obj = JSON.parse(fs.readFileSync(path.join(WORDS_DIR, f), "utf8"));
  shardObjs.push(obj);
  for (const w of Object.keys(obj)) allWords.add(w.toLowerCase());
}

let scanned = 0, compoundSkipped = 0;
const tilesClean = [], namedOnly = [];

for (const obj of shardObjs) {
  for (const word of Object.keys(obj)) {
    const e = obj[word];
    if (!(e.b && e.b.length === 1 && e.b[0].k === "word" && e.e)) continue;
    if (/[\s-]/.test(word)) continue; // phrasal headwords out of scope
    scanned++;
    let terms = null, tier = null;
    if (TIER === "surface" || TIER === "all") { terms = extractSurface(e.e); if (terms) tier = "SURFACE"; }
    if (!terms && (TIER === "prose" || TIER === "all")) { terms = extractProse(e.e); if (terms) tier = "PROSE"; }
    if (!terms) continue;
    // Skip if any term (length >= 3, so short bound forms like "ic"/"al" don't
    // false-trigger just for coincidentally matching a short real word) is
    // itself a standalone headword — that's the modern-compound signal.
    if (terms.some(function (t) { return t.length >= 3 && allWords.has(t); })) { compoundSkipped++; continue; }
    const fit = tiles(word, terms);
    const row = { word: word, tier: tier, terms: terms };
    if (fit) tilesClean.push(row); else namedOnly.push(row);
  }
}

const lines = [];
lines.push("FIND-RECOVERABLE-BREAKDOWNS (tier=" + TIER + ")");
lines.push("=".repeat(60));
lines.push("whole-word overrides with etymology text scanned: " + scanned);
lines.push("skipped as modern compounds (a term is itself a standalone headword): " + compoundSkipped);
lines.push("clean letter-tile candidates (real breakdown possible): " + tilesClean.length);
lines.push("named-roots-but-no-tile candidates (bWhole candidates): " + namedOnly.length);
lines.push("");
lines.push("---- clean tile candidates ----");
for (const r of tilesClean) lines.push("[" + r.tier + "] " + r.word + "  =  " + r.terms.join(" + "));
lines.push("");
lines.push("---- named-but-not-tiling (bWhole) candidates ----");
for (const r of namedOnly) lines.push("[" + r.tier + "] " + r.word + "  ~  " + r.terms.join(" + "));

const report = lines.join("\n") + "\n";
fs.writeFileSync(OUT, report);
process.stdout.write(lines.slice(0, 80).join("\n") + "\n");
process.stderr.write("\nfull report (" + lines.length + " lines) written to " + OUT + "\n");
