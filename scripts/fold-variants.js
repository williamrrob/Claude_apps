#!/usr/bin/env node
/*
 * fold-variants.js — fold variant/pointer entries onto their canonical form
 * with a rel redirect (the eaten → eat pattern), per the owner-approved
 * rules (2026-07-03):
 *
 *   X folds into Y only when ALL hold:
 *   1. X is a pointer entry: EITHER Wiktionary explicitly tags X's senses
 *      alt_of/form_of → Y (vendor-data/kaikki-rich.sqlite), OR X's sole
 *      gloss is exactly the headword Y.
 *   2. X and Y are morphological kin (shared stem after suffix-stripping,
 *      or X's etymology names Y). Explicit alt_of counts as kin by
 *      definition. This is the load-bearing rule — "abearance → Behavior"
 *      is a DEFINITION, not a variant, and must never fold.
 *   3. Parts of speech overlap.
 *   4. Y is clearly more common: rank(Y)*2 <= rank(X), or Y ranked while X
 *      is not. Close ranks → skip (cross-link candidates, not folds).
 *   5. Safety: Y exists, Y has no rel of its own (no chains), X has no rel
 *      and no multi-piece curated b, and X/Y differ beyond case.
 *
 *   node scripts/fold-variants.js            # dry run
 *   node scripts/fold-variants.js --apply    # write rel pointers via word.js bulk semantics
 * Applied folds are logged to review/folds.log (append-only JSONL).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

const APPLY = process.argv.includes("--apply");

// ---- inputs ----
const rank = new Map();
for (const line of fs.readFileSync(path.join(ROOT, "review", "ranks.tsv"), "utf8").split("\n").slice(1)) {
  const i = line.lastIndexOf("\t");
  if (i > 0) rank.set(line.slice(0, i), Number(line.slice(i + 1)));
}
const rankOf = (w) => rank.get(w) ?? rank.get(w.toLowerCase()) ?? Infinity;

const vocab = new Map();
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, r] of Object.entries(sh)) vocab.set(w, r);
}
const findWord = (t) => (vocab.has(t) ? t : vocab.has(t.toLowerCase()) ? t.toLowerCase() : null);

const db = new DatabaseSync(path.join(ROOT, "vendor-data", "kaikki-rich.sqlite"), { readOnly: true });
// explicit variant markings: word -> {target, kind} when EVERY tagged sense agrees
const explicit = new Map();
for (const r of db.prepare(`SELECT word, alt_of, form_of, tags, count(*) c FROM sense
    WHERE alt_of IS NOT NULL OR form_of IS NOT NULL GROUP BY word, alt_of, form_of`).all()) {
  const target = r.alt_of || r.form_of;
  const prev = explicit.get(r.word);
  if (prev && prev.target !== target) { prev.conflict = true; continue; }
  const kind = /alternative spelling|alt-of/.test(String(r.tags)) || r.alt_of ? "alternative spelling of" : "variant of";
  explicit.set(r.word, prev || { target, kind });
}
db.close();

// ---- rule helpers ----
const stem = (s) => s.toLowerCase().replace(/(ical|ic|al|ous|ly|ness|ity|ise|ize|isation|ization|our|or|re|er|e)$/,"");
// kin = one stripped stem is a prefix of the other (egotistic/egotistical via
// "egotist"; abeyancy/abeyance via "abeyanc"). Deliberately NOT "etymology
// mentions target" — a foreign source's gloss mentions its translation
// (Spanish nada ("nothing")) without nada being a variant of nothing.
const kin = (x, y) => {
  const a = stem(x), b = stem(y);
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
};
// a sense that only POINTS at another word, in our own data
const POINTER_RE = /^((alternative|archaic|obsolete|dated|nonstandard|informal|eye.dialect|mis)\s*)*(spelling|form|typography|rendering)\s+of\s+([A-Za-z-]+)/i;
function pointerTarget(g, w) {
  const t = (g || "").trim().replace(/[.。]$/, "");
  const m = t.match(POINTER_RE);
  if (m) return m[4];
  if (/^[A-Za-z-]+$/.test(t) && t.toLowerCase() !== w.toLowerCase()) return t; // bare-word gloss
  return null;
}
const posSet = (rec) => new Set((rec.d || []).map((s) => s.p).filter(Boolean));
const posOverlap = (a, b) => {
  const A = posSet(a), B = posSet(b);
  if (!A.size || !B.size) return true; // unknown — don't block
  for (const p of A) if (B.has(p)) return true;
  return false;
};

// ---- collect candidates ----
const folds = []; // {w, target, kind, why}
const skipped = { rank: 0, kin: 0, pos: 0, chain: 0, conflict: 0 };
for (const [w, rec] of vocab) {
  if (rec.rel) continue;                                   // already a pointer
  if (rec.b && rec.b.length > 1) continue;                 // deliberate curated breakdown
  if (!Array.isArray(rec.d) || !rec.d.length) continue;

  // EVERY sense of OUR entry must point at the same target — an entry with
  // any real definitional sense is a real word, never folded (the humane/
  // cote/evaluator lesson: Wiktionary's alt_of marks one archaic sense,
  // while our entry holds the living word).
  const targets = new Set();
  let allPointers = true;
  for (const s of rec.d) {
    const t = pointerTarget(s.g, w);
    if (!t) { allPointers = false; break; }
    targets.add(t.toLowerCase());
  }
  if (!allPointers || targets.size !== 1) continue;
  const target = findWord([...targets][0]);
  if (!target) continue;
  const ex = explicit.get(w) || explicit.get(w.toLowerCase());
  const kind = ex && !ex.conflict && findWord(ex.target) === target && ex.kind === "alternative spelling of"
    ? "alternative spelling of" : "variant of";
  const why = (ex && findWord(ex.target) === target ? "gloss+alt_of agree" : "all senses point");
  if (target.toLowerCase() === w.toLowerCase()) continue;
  if (!kin(w, target)) { skipped.kin++; continue; }
  const trec = vocab.get(target);
  if (!trec || trec.rel) { skipped.chain++; continue; }
  if (!posOverlap(rec, trec)) { skipped.pos++; continue; }
  const rw = rankOf(w), rt = rankOf(target);
  const clearly = (rt !== Infinity && rw === Infinity) || rt * 2 <= rw;
  if (!clearly) { skipped.rank++; continue; }
  folds.push({ w, target, kind, why });
}

// ---- report / apply ----
folds.sort((a, b) => rankOf(a.w) - rankOf(b.w));
console.log("FOLD-VARIANTS " + (APPLY ? "APPLIED" : "DRY RUN"));
console.log("=".repeat(60));
console.log("folds: " + folds.length + "  | skipped — rank too close: " + skipped.rank +
  ", non-kin gloss: " + skipped.kin + ", pos mismatch: " + skipped.pos + ", would chain: " + skipped.chain);
console.log("\nmost common words being folded (sanity — these should all be obvious variants):");
for (const f of folds.slice(0, 18)) console.log("  " + f.w + " → " + f.target + "  (" + f.kind + "; " + f.why + "; ranks " + (rankOf(f.w) === Infinity ? "-" : rankOf(f.w)) + "→" + (rankOf(f.target) === Infinity ? "-" : rankOf(f.target)) + ")");

if (APPLY) {
  const byShard = new Map();
  for (const f of folds) {
    const k = f.w.slice(0, 2).toLowerCase() + ".json";
    if (!byShard.has(k)) byShard.set(k, []);
    byShard.get(k).push(f);
  }
  let touched = 0;
  for (const [k, list] of byShard) {
    const p = path.join(WORDS, k);
    if (!fs.existsSync(p)) continue;
    const sh = JSON.parse(fs.readFileSync(p, "utf8"));
    let dirty = false;
    for (const f of list) {
      const rec = sh[f.w];
      if (!rec || rec.rel) continue;
      rec.rel = { t: f.kind, l: f.target };
      dirty = true;
    }
    if (dirty) { fs.writeFileSync(p, stringifyShard(sh)); JSON.parse(fs.readFileSync(p, "utf8")); touched++; }
  }
  const log = folds.map((f) => JSON.stringify({ w: f.w, fold: f.target, kind: f.kind, why: f.why })).join("\n") + "\n";
  fs.appendFileSync(path.join(ROOT, "review", "folds.log"), log);
  console.log("\nwrote rel pointers across " + touched + " shard(s); logged to review/folds.log");
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
} else {
  fs.writeFileSync(path.join(ROOT, "fold-variants-dryrun.txt"),
    folds.map((f) => f.w + "\t" + f.target + "\t" + f.kind + "\t" + f.why).join("\n") + "\n");
  console.log("\n(full list → fold-variants-dryrun.txt; pass --apply to write)");
}
