#!/usr/bin/env node
/*
 * seed-breakdowns.js — give engine-blind words a curated breakdown (b) from
 * the etymology graph's structure rows (egotism = ego + -t- + -ism sits in
 * etymology-db while the engine shows nothing).
 *
 * Safety comes from LETTER TILING: the components, in recorded order with
 * affix hyphens stripped and diacritics folded, must reconstruct the word's
 * letters exactly. A garbled extraction essentially never tiles by accident
 * (the find-recoverable-breakdowns.js precedent). Additional gates:
 *   - entry has no b already (curated beats seeded)
 *   - the ENGINE is blind on the word (would show whole: <2 parts, no root,
 *     or a big unknown) — never replaces a working engine split
 *   - 2–4 pieces, at least one ≥3 chars
 * Pieces are self-contained (src/o/g from the graph) so they can't bind to
 * coincidentally same-spelled engine morphemes (hybridPart contract).
 * Kinds from hyphen shape: X- prefix · -X suffix · -X- linker · bare root.
 *
 *   node scripts/seed-breakdowns.js            # dry run
 *   node scripts/seed-breakdowns.js --apply    # write b fields + bump DATA_V
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

global.MORPHEMES = require(path.join(ROOT, "data.js")).MORPHEMES;
const engine = require(path.join(ROOT, "engine.js"));

const APPLY = process.argv.includes("--apply");
const fold = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\*/g, "").trim();

// structure rows per English word, in recorded order
const db = new DatabaseSync(path.join(ROOT, "vendor-data", "etym.sqlite"), { readOnly: true });
const KINDS = new Set(["compound_of", "has_affix", "has_prefix", "has_suffix", "has_confix", "derived_from", "has_prefix_with_root"]);
const rows = db.prepare(`SELECT term, reltype, rel_lang, rel_term FROM rel
  WHERE term_lang='English' AND reltype IN ('compound_of','has_affix','has_prefix','has_suffix','has_confix','derived_from','has_prefix_with_root')
  AND rel_term != '' ORDER BY rowid`).all();
const byWord = new Map();
for (const r of rows) {
  let l = byWord.get(r.term);
  if (!l) byWord.set(r.term, (l = []));
  if (l.length < 12) l.push(r);
}
// graph glosses for piece annotations
const gdb = new DatabaseSync(path.join(ROOT, "vendor-data", "etymgraph.sqlite"), { readOnly: true });
const qGloss = gdb.prepare("SELECT gloss FROM node WHERE norm=? AND gloss IS NOT NULL LIMIT 1");
const glossOf = (lang, term) => {
  const g = qGloss.get(lang + "|" + fold(term));
  return g ? String(g.gloss).split(/[;,(]/)[0].trim().slice(0, 40) : null;
};

function engineBlind(w) {
  let r;
  try { r = engine.decompose(w); } catch (e) { return true; }
  if (!r || (r.parts || []).length < 2 || !r.hasRoot) return true;
  return r.parts.some((p) => p.kind === "unknown" && p.surface.length >= 4);
}

// greedy left-to-right tiling over the candidate pool (longest match first)
function tile(word, cands) {
  const target = fold(word).replace(/[^a-z]/g, "");
  if (target.length < 5) return null;
  const pool = cands.map((c) => {
    const raw = c.rel_term.trim();
    const core = fold(raw).replace(/^-+|-+$/g, "").replace(/[^a-z]/g, "");
    if (!core) return null;
    const kind = /^-.*-$/.test(raw) ? "linker" : /^-/.test(raw) ? "suffix" : /-$/.test(raw) ? "prefix" : "root";
    return { raw, core, kind, lang: c.rel_lang };
  }).filter(Boolean);
  const pieces = [];
  let pos = 0;
  const used = new Set();
  while (pos < target.length && pieces.length < 4) {
    let best = null;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const p = pool[i];
      if (target.startsWith(p.core, pos) && (!best || p.core.length > pool[best].core.length)) best = i;
    }
    if (best == null) return null;
    used.add(best);
    pieces.push(pool[best]);
    pos += pool[best].core.length;
  }
  if (pos !== target.length || pieces.length < 2) return null;
  if (!pieces.some((p) => p.core.length >= 3)) return null;
  // hyphen-less sources leave kind "root" on things that are plainly affixes
  // (a-, -ary): fall back to position for short pieces
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.kind !== "root") continue;
    if (i === 0 && p.core.length <= 2 && pieces.length > 1) p.kind = "prefix";
    else if (i === pieces.length - 1 && p.core.length <= 3) p.kind = "suffix";
    else if (i > 0 && i < pieces.length - 1 && p.core.length <= 2) p.kind = "linker";
  }
  return pieces;
}

let considered = 0, seeded = 0, touched = 0;
const samples = [];
const pending = new Map(); // shard -> {word: b}
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, rec] of Object.entries(sh)) {
    if (rec.b || /[\s-]/.test(w)) continue;
    const cands = byWord.get(w) || byWord.get(w.toLowerCase());
    if (!cands || cands.length < 2) continue;
    considered++;
    if (!engineBlind(w)) continue;
    const pieces = tile(w, cands);
    if (!pieces) continue;
    // map folded cores back onto the word's actual letters for surfaces
    const b = [];
    let cursor = 0;
    const wordLetters = w;
    for (const p of pieces) {
      const s = wordLetters.slice(cursor, cursor + p.core.length);
      cursor += p.core.length;
      const piece = { s, k: p.kind };
      if (p.lang && p.lang !== "English") {
        // foreign component: self-contained (src blocks coincidental
        // morpheme binding), with origin + gloss from the graph
        piece.src = p.raw;
        piece.o = p.lang;
        const g = glossOf(p.lang, p.raw);
        if (g && g.length >= 3) piece.g = g;
      }
      // English components stay bare so hybridPart can bind them to real
      // engine morphemes (ism/ed/ly get their glosses and tree buttons);
      // English word-glosses are homograph traps (ab → "abdominal muscle")
      b.push(piece);
    }
    if (cursor !== w.length) continue; // diacritic/case mismatch — skip
    seeded++;
    if (samples.length < 14) samples.push(w + " = " + b.map((x) => x.s + "(" + x.k + (x.g ? ": " + x.g : "") + ")").join(" + "));
    const key = f;
    if (!pending.has(key)) pending.set(key, {});
    pending.get(key)[w] = b;
  }
}
db.close(); gdb.close();

console.log("SEED-BREAKDOWNS " + (APPLY ? "APPLIED" : "DRY RUN"));
console.log("=".repeat(60));
console.log("engine-blind words with 2+ structure rows considered: " + considered + " | tiled cleanly: " + seeded);
for (const s of samples) console.log("  " + s);
if (APPLY) {
  for (const [f, obj] of pending) {
    const p = path.join(WORDS, f);
    const sh = JSON.parse(fs.readFileSync(p, "utf8"));
    let dirty = false;
    for (const [w, b] of Object.entries(obj)) { if (sh[w] && !sh[w].b) { sh[w].b = b; dirty = true; } }
    if (dirty) { fs.writeFileSync(p, stringifyShard(sh)); JSON.parse(fs.readFileSync(p, "utf8")); touched++; }
  }
  console.log("shards written: " + touched);
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
} else {
  fs.writeFileSync(path.join(ROOT, "seed-breakdowns-dryrun.txt"),
    [...pending.values()].flatMap((o) => Object.entries(o).map(([w, b]) => w + "\t" + b.map((x) => x.s + ":" + x.k).join("+"))).join("\n") + "\n");
  console.log("(full list → seed-breakdowns-dryrun.txt; pass --apply to write)");
}
