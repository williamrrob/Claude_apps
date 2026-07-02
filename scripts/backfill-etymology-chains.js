#!/usr/bin/env node
/*
 * backfill-etymology-chains.js — stage-2 etymology backfill for entries the
 * English Wiktionary dump couldn't cover: ASSEMBLE a standard-form etymology
 * from vendor-data/etym.sqlite (etymology-db relation rows + per-language
 * Kaikki lemma glosses; build with scripts/build-etymdb.js).
 *
 * Nothing here is authored: every hop and affix comes from a structured
 * Wiktionary parse, rendered into the same formulas Wiktionary itself uses —
 *   ancestry rows  → "From Middle English worde, from Old English word (“…”)."
 *   affix/compound → "By surface analysis, sōlus + ipse + -ism."
 * The "By surface analysis" phrasing deliberately matches the existing corpus
 * convention so find-recoverable-breakdowns.js can parse these back into
 * curated breakdowns later.
 *
 * Same discipline as backfill-etymology.js: only fills MISSING `e`, never
 * overwrites, `_at` untouched, dry run by default.
 *
 *   node scripts/backfill-etymology-chains.js            # dry run
 *   node scripts/backfill-etymology-chains.js --apply    # write + bump DATA_V
 *   [--limit-shards xx,yy]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

const APPLY = process.argv.includes("--apply");
const argOf = (n) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : null; };
const LIMIT_SHARDS = argOf("--limit-shards") ? new Set(argOf("--limit-shards").split(",")) : null;

const DBP = path.join(ROOT, "vendor-data", "etym.sqlite");
if (!fs.existsSync(DBP)) { process.stderr.write("vendor-data/etym.sqlite missing — run scripts/build-etymdb.js\n"); process.exit(1); }
const db = new DatabaseSync(DBP, { readOnly: true });

// ancestry hop rows, in the order the Wiktionary etymology listed them (rowid)
const ANCESTRY = ["inherited_from", "derived_from", "borrowed_from", "learned_borrowing_from",
  "unadapted_borrowing_from", "orthographic_borrowing_from", "semi_learned_borrowing_from"];
const SIMPLE = { clipping_of: "Clipping of", abbreviation_of: "Abbreviation of", initialism_of: "Initialism of",
  "back-formation_from": "Back-formation from", calque_of: "Calque of", named_after: "Named after" };
const STRUCTURE = new Set(["has_prefix", "has_suffix", "has_affix", "has_confix", "compound_of", "blend_of", "has_prefix_with_root"]);

const qRows = db.prepare("SELECT reltype, rel_lang, rel_term, position, rowid FROM rel WHERE term_lang='English' AND term = ? ORDER BY rowid");
const qGloss = db.prepare("SELECT gloss FROM lemma WHERE lang = ? AND word = ? AND gloss != '' LIMIT 1");

function rowsFor(word) {
  let r = qRows.all(word);
  if (!r.length && word !== word.toLowerCase()) r = qRows.all(word.toLowerCase());
  if (!r.length) {
    const cap = word[0].toUpperCase() + word.slice(1);
    if (cap !== word) r = qRows.all(cap);
  }
  return r;
}

const glossOf = (lang, term) => {
  if (!lang || !term) return null;
  const g = qGloss.get(lang, term);
  return g ? g.gloss : null;
};

// Render one word's rows into etymology prose; null if nothing usable.
function assemble(word) {
  const rows = rowsFor(word);
  if (!rows.length) return null;

  const pieces = [];

  // 1) ancestry chain: successive "from <lang> <term>" hops in listed order;
  //    stop at a repeat (cycle) or after 5 hops; skip hops with no term.
  const chain = [];
  const seen = new Set();
  for (const r of rows) {
    if (!ANCESTRY.includes(r.reltype)) continue;
    r.rel_term = (r.rel_term || "").trim();
    if (!r.rel_term) continue;
    const key = r.rel_lang + " " + r.rel_term;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(r);
    if (chain.length >= 5) break;
  }
  if (chain.length) {
    const hops = chain.map((r, i) => {
      const verb = i === 0 ? (r.reltype.includes("borrow") ? "Borrowed from" : "From") : "from";
      let t = verb + " " + r.rel_lang + " " + r.rel_term;
      if (i === chain.length - 1) {
        const g = glossOf(r.rel_lang, r.rel_term);
        if (g) t += " (“" + g + "”)";
      }
      return t;
    });
    pieces.push(hops.join(", ") + ".");
  }

  // 2) simple single-hop formulas (only if no chain found)
  if (!pieces.length) {
    for (const r of rows) {
      const label = SIMPLE[r.reltype];
      if (!label || !r.rel_term) continue;
      pieces.push(label + " " + (r.rel_lang && r.rel_lang !== "English" ? r.rel_lang + " " : "") + r.rel_term + ".");
      break;
    }
  }

  // 3) surface analysis from structure rows, in position order
  const struct = rows.filter((r) => STRUCTURE.has(r.reltype) && r.rel_term)
    .sort((a, b) => a.position - b.position || a.rowid - b.rowid);
  if (struct.length >= 2 || (struct.length === 1 && pieces.length)) {
    const seen2 = new Set();
    const parts = [];
    for (const r of struct) {
      let t = r.rel_term;
      if (r.reltype === "has_suffix") t = "-" + t.replace(/^-/, "");
      if (r.reltype === "has_prefix") t = t.replace(/-$/, "") + "-";
      if (r.rel_lang && r.rel_lang !== "English" && r.reltype !== "has_suffix" && r.reltype !== "has_prefix") t = r.rel_lang + " " + t;
      if (seen2.has(t)) continue;
      seen2.add(t);
      parts.push(t);
    }
    if (parts.length >= 2) pieces.push("By surface analysis, " + parts.join(" + ") + ".");
  }

  if (!pieces.length) return null;
  return pieces.join(" ").slice(0, 400);
}

// ---- walk shards ----
let lack = 0, filled = 0, touchedShards = 0;
const samples = [];
const files = fs.readdirSync(WORDS).filter((f) => f.endsWith(".json"))
  .filter((f) => !LIMIT_SHARDS || LIMIT_SHARDS.has(f.replace(".json", "")));
for (const f of files) {
  const p = path.join(WORDS, f);
  const shard = JSON.parse(fs.readFileSync(p, "utf8"));
  let dirty = false;
  for (const [w, rec] of Object.entries(shard)) {
    if (rec.e) continue;
    lack++;
    if (/[\s]/.test(w)) continue; // phrases: relation rows are unreliable there
    const e = assemble(w);
    if (!e) continue;
    rec.e = e; filled++; dirty = true;
    if (samples.length < 25) samples.push(w + "  e: " + e.slice(0, 150));
  }
  if (dirty && APPLY) {
    fs.writeFileSync(p, stringifyShard(shard));
    JSON.parse(fs.readFileSync(p, "utf8")); // self-validate
    touchedShards++;
  }
}
db.close();

const L = [];
L.push("BACKFILL-ETYMOLOGY-CHAINS " + (APPLY ? "APPLIED" : "DRY RUN"));
L.push("=".repeat(60));
L.push("entries still lacking e: " + lack + "  -> " + (APPLY ? "filled" : "would fill") + ": " + filled);
if (APPLY) L.push("shards written: " + touchedShards);
L.push("");
L.push("---- samples ----");
for (const s of samples) L.push("  " + s);
const out = path.join(ROOT, "backfill-etymology-chains-" + (APPLY ? "applied" : "dryrun") + ".txt");
fs.writeFileSync(out, L.join("\n") + "\n");
process.stdout.write(L.join("\n") + "\n");
if (!APPLY) process.stdout.write("(dry run — pass --apply to write)\n");
else {
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) process.stdout.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
}
