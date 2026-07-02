#!/usr/bin/env node
/*
 * enrich-etymology-facts.js — append single-fact etymology sentences from
 * etymology-db (vendor-data/etym.sqlite) to EVERY entry that lacks them:
 *
 *   doublet_with          → "Doublet of X."      (same ancestor, split paths)
 *   named_after           → "Named after X."
 *   clipping_of           → "Clipping of X."
 *   abbreviation_of       → "Abbreviation of X."
 *   initialism_of         → "Initialism of X."
 *   calque_of             → "Calque of <lang> X."
 *   back-formation_from   → "Back-formation from X."
 *   is_onomatopoeic       → "Of imitative origin."
 *
 * Additive and idempotent: a fact is appended to `e` only when the existing
 * text doesn't already state it (the related term isn't mentioned, in any
 * case). Entries with no `e` get the facts as their whole etymology.
 * doublet_with is treated symmetrically (a row in either direction).
 *
 *   node scripts/enrich-etymology-facts.js            # dry run
 *   node scripts/enrich-etymology-facts.js --apply    # write + bump DATA_V
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

const APPLY = process.argv.includes("--apply");
const MAX_E = 850; // don't grow an already-long etymology past this

const DBP = path.join(ROOT, "vendor-data", "etym.sqlite");
if (!fs.existsSync(DBP)) { process.stderr.write("vendor-data/etym.sqlite missing — run scripts/build-etymdb.js\n"); process.exit(1); }
const db = new DatabaseSync(DBP, { readOnly: true });

const FACT_TYPES = ["doublet_with", "named_after", "clipping_of", "abbreviation_of",
  "initialism_of", "calque_of", "back-formation_from", "is_onomatopoeic"];

// Pull all fact rows once (fast, ~50k rows English-side) instead of 222k queries.
const facts = new Map(); // exact English term -> [{reltype, rel_lang, rel_term}]
const addFact = (term, f) => {
  if (!facts.has(term)) facts.set(term, []);
  facts.get(term).push(f);
};
for (const r of db.prepare(
  "SELECT term, reltype, rel_lang, rel_term FROM rel WHERE term_lang='English' AND reltype IN (" +
  FACT_TYPES.map(() => "?").join(",") + ")").all(...FACT_TYPES)) {
  addFact(r.term, { reltype: r.reltype, rel_lang: r.rel_lang, rel_term: (r.rel_term || "").trim() });
}
// doublets are symmetric: index the reverse direction too
for (const r of db.prepare(
  "SELECT term, rel_term FROM rel WHERE reltype='doublet_with' AND rel_lang='English'").all()) {
  const rt = (r.rel_term || "").trim();
  if (rt) addFact(rt, { reltype: "doublet_with", rel_lang: "English", rel_term: r.term });
}
db.close();
process.stderr.write("fact index: " + facts.size + " English terms carry facts\n");

const factsFor = (w) => facts.get(w) || facts.get(w.toLowerCase()) ||
  facts.get(w[0].toUpperCase() + w.slice(1)) || null;

// diacritic-insensitive comparison (accūsātīvus ≡ accusativus)
const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

function renderFacts(w, list, existingE) {
  const eLower = fold(existingE);
  const wLower = fold(w);
  const out = [];
  const doublets = [];
  const seen = new Set();
  for (const f of list) {
    if (f.reltype !== "is_onomatopoeic" && !f.rel_term) continue;
    const rtLower = fold(f.rel_term);
    if (rtLower === wLower) continue;                     // self-reference
    if (rtLower && eLower.includes(rtLower)) continue;    // already stated
    if (f.reltype === "is_onomatopoeic" && /imitat|onomatopo/.test(eLower)) continue;
    const key = f.reltype + "|" + rtLower;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (f.reltype) {
      case "doublet_with": doublets.push(f.rel_term); break;
      case "named_after": out.push("Named after " + f.rel_term + "."); break;
      case "clipping_of": out.push("Clipping of " + f.rel_term + "."); break;
      case "abbreviation_of": out.push("Abbreviation of " + f.rel_term + "."); break;
      case "initialism_of": out.push("Initialism of " + f.rel_term + "."); break;
      case "calque_of": out.push("Calque of " + (f.rel_lang && f.rel_lang !== "English" ? f.rel_lang + " " : "") + f.rel_term + "."); break;
      case "back-formation_from": out.push("Back-formation from " + f.rel_term + "."); break;
      case "is_onomatopoeic": out.push("Of imitative origin."); break;
    }
  }
  if (doublets.length) {
    const d = doublets.slice(0, 4);
    out.unshift("Doublet of " + (d.length === 1 ? d[0] : d.slice(0, -1).join(", ") + " and " + d[d.length - 1]) + ".");
  }
  return out;
}

let considered = 0, enriched = 0, sentences = 0, touched = 0;
const samples = [];
const byType = {};
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const p = path.join(WORDS, f);
  const shard = JSON.parse(fs.readFileSync(p, "utf8"));
  let dirty = false;
  for (const [w, rec] of Object.entries(shard)) {
    const list = factsFor(w);
    if (!list) continue;
    considered++;
    if (rec.e && rec.e.length >= MAX_E) continue;
    const adds = renderFacts(w, list, rec.e);
    if (!adds.length) continue;
    let e = rec.e ? rec.e.trim() : "";
    for (const s of adds) {
      if (e.length + s.length + 1 > MAX_E && e) break;
      e = e ? e + " " + s : s;
      sentences++;
      const t = s.split(" ")[0];
      byType[t] = (byType[t] || 0) + 1;
    }
    if (e === (rec.e || "").trim()) continue;
    if (samples.length < 14) samples.push(w + (rec.e ? "  (append)" : "  (new e)") + ": …" + e.slice(-110));
    rec.e = e; enriched++; dirty = true;
  }
  if (dirty && APPLY) {
    fs.writeFileSync(p, stringifyShard(shard));
    JSON.parse(fs.readFileSync(p, "utf8"));
    touched++;
  }
}

const L = [];
L.push("ENRICH-ETYMOLOGY-FACTS " + (APPLY ? "APPLIED" : "DRY RUN"));
L.push("=".repeat(60));
L.push("entries with candidate facts: " + considered + "  -> " + (APPLY ? "enriched" : "would enrich") + ": " + enriched + " (" + sentences + " sentences)");
L.push("by fact: " + Object.entries(byType).map(([k, v]) => k + " " + v).join(", "));
if (APPLY) L.push("shards written: " + touched);
L.push("");
for (const s of samples) L.push("  " + s);
const out = path.join(ROOT, "enrich-facts-" + (APPLY ? "applied" : "dryrun") + ".txt");
fs.writeFileSync(out, L.join("\n") + "\n");
process.stdout.write(L.join("\n") + "\n");
if (!APPLY) process.stdout.write("(dry run — pass --apply to write)\n");
else {
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) process.stdout.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
}
