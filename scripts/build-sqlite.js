#!/usr/bin/env node
/*
 * build-sqlite.js — compile the per-word shards (words/<xx>.json) into a single
 * queryable SQLite database (rootwork.sqlite).
 *
 * Purpose: let tooling (and an assistant building out rich entries) ask
 * "find all words with this root / prefix / meaning / missing a field" with one
 * cheap SQL query instead of scanning megabytes of shards. The DB is a derived
 * build artifact (gitignored); regenerate any time with `npm run build:sqlite`.
 *
 * Tables:
 *   words(word PK, ipa, rs, ety)
 *   senses(word, pos, gloss, example)
 *   rel(word, kind {syn|ant|rel}, target)
 *   morph(word, kind {prefix|root|suffix|linker|unknown}, id, surface, origin, meaning)
 *       — morpheme breakdown from engine.js (heuristic; good for discovery)
 *   fts  USING fts5(word UNINDEXED, body)   — glosses + etymology, for meaning search
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const engine = require("../engine.js");

const ROOT = path.join(__dirname, "..");
const WORDS_DIR = path.join(ROOT, "words");
const OUT = path.join(ROOT, "rootwork.sqlite");

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
const db = new DatabaseSync(OUT);

db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE words  (word TEXT PRIMARY KEY, ipa TEXT, rs TEXT, ety TEXT);
  CREATE TABLE senses (word TEXT, pos TEXT, gloss TEXT, example TEXT);
  CREATE TABLE rel    (word TEXT, kind TEXT, target TEXT);
  CREATE TABLE morph  (word TEXT, kind TEXT, id TEXT, surface TEXT, origin TEXT, meaning TEXT);
`);

// The FTS index (for `find meaning`) needs an FTS5-enabled SQLite. Node's
// bundled SQLite only gained FTS5 in later 22.x/23+ builds, so create it when
// available and degrade gracefully (no meaning-search) when it isn't.
let hasFts = false;
try { db.exec("CREATE VIRTUAL TABLE fts USING fts5(word UNINDEXED, body);"); hasFts = true; }
catch (e) { console.error("note: SQLite has no FTS5 in this Node — skipping `fts` table (`find meaning` disabled)"); }

const insWord  = db.prepare("INSERT OR REPLACE INTO words(word,ipa,rs,ety) VALUES (?,?,?,?)");
const insSense = db.prepare("INSERT INTO senses(word,pos,gloss,example) VALUES (?,?,?,?)");
const insRel   = db.prepare("INSERT INTO rel(word,kind,target) VALUES (?,?,?)");
const insMorph = db.prepare("INSERT INTO morph(word,kind,id,surface,origin,meaning) VALUES (?,?,?,?,?,?)");
const insFts   = hasFts ? db.prepare("INSERT INTO fts(word,body) VALUES (?,?)") : null;

const files = fs.readdirSync(WORDS_DIR).filter(f => f.endsWith(".json")).sort();
let nWords = 0, nSenses = 0, nRel = 0, nMorph = 0;
const t0 = Date.now();

db.exec("BEGIN");
for (const file of files) {
  const obj = JSON.parse(fs.readFileSync(path.join(WORDS_DIR, file), "utf8"));
  for (const word of Object.keys(obj)) {
    const e = obj[word] || {};
    insWord.run(word, e.i || null, e.rs || null, e.e || null);
    nWords++;

    const glosses = [];
    for (const d of (e.d || [])) {
      insSense.run(word, d.p || null, d.g || null, d.x || null);
      nSenses++;
      if (d.g) glosses.push(d.g);
    }
    for (const [kind, key] of [["syn", "s"], ["ant", "a"], ["rel", "r"]]) {
      for (const t of (e[key] || [])) { insRel.run(word, kind, t); nRel++; }
    }
    // morpheme breakdown (heuristic, from the engine) — only contentful parts
    try {
      const dec = engine.decompose(word);
      for (const p of (dec && dec.parts || [])) {
        if (p.kind === "prefix" || p.kind === "root" || p.kind === "suffix") {
          insMorph.run(word, p.kind, p.id || p.surface, p.surface, p.origin || null, p.meaning || null);
          nMorph++;
        }
      }
    } catch (e) { /* skip words the engine can't handle */ }

    // searchable text: glosses + etymology
    const body = (glosses.join(" · ") + " " + (e.e || "")).trim();
    if (body && insFts) insFts.run(word, body);
  }
}
db.exec("COMMIT");

db.exec(`
  CREATE INDEX idx_senses_word ON senses(word);
  CREATE INDEX idx_rel_word    ON rel(word, kind);
  CREATE INDEX idx_rel_target  ON rel(kind, target);
  CREATE INDEX idx_morph_word  ON morph(word);
  CREATE INDEX idx_morph_id    ON morph(kind, id);
  ANALYZE;
`);
db.close();

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.error(`built rootwork.sqlite: ${nWords} words, ${nSenses} senses, ${nRel} relations, ` +
  `${nMorph} morphemes — ${mb} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
