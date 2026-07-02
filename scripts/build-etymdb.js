#!/usr/bin/env node
/*
 * build-etymdb.js — fold the downloaded etymology sources into one queryable
 * SQLite file, vendor-data/etym.sqlite (derived; vendor-data/ is gitignored).
 *
 * Sources (all in vendor-data/; re-download URLs):
 *   etymology.csv          github.com/droher/etymology-db releases (etymology.csv.gz)
 *                          — 4.2M typed relations parsed from Wiktionary etymologies
 *   kaikki-<Lang>.jsonl.gz kaikki.org/dictionary/<Language>/kaikki.org-dictionary-<Lang>.jsonl.gz
 *                          — per-language lemma entries (gloss + etymology prose)
 *   etymdb-2.1/            github.com/clefourrier/EtymDB (LREC 2020)
 *                          — 1.8M lexemes + typed links, incl. reconstructed protoforms
 *
 * Tables:
 *   rel(term_lang, term, reltype, rel_lang, rel_term, position)   — etymology-db edges
 *   lemma(lang, word, pos, gloss, ety)                            — kaikki nodes
 *   etymdb_lex(id, lang, lexeme, meaning)                          — EtymDB nodes
 *   etymdb_link(type, id1, id2)                                    — EtymDB edges
 *
 * Query with scripts/etym.js (tree/rels/lemma). Rebuild any time:
 *   node scripts/build-etymdb.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");

const VENDOR = path.join(__dirname, "..", "vendor-data");
const DB = path.join(VENDOR, "etym.sqlite");

// same tree-prefix cleanup as backfill-etymology.js
function cleanEty(t) {
  let s = String(t || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (/^Etymology tree\b/.test(s)) {
    const m = s.match(/\b(From |Borrowed from |Coined |Named after |Blend of |Compound of |Short(?:ening)? (?:of|for) |Clipping of |Abbreviation of |Variant of |Alteration of |Univerbation of |Back-formation )/);
    if (!m) return "";
    s = s.slice(m.index);
  }
  return s.slice(0, 400);
}

function csvFields(line) {
  if (!line.includes('"')) return line.split(",");
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

async function main() {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  const db = new DatabaseSync(DB);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;");
  db.exec(`CREATE TABLE rel(term_lang TEXT, term TEXT, reltype TEXT, rel_lang TEXT, rel_term TEXT, position INT);
           CREATE TABLE lemma(lang TEXT, word TEXT, pos TEXT, gloss TEXT, ety TEXT);
           CREATE TABLE etymdb_lex(id INT, lang TEXT, lexeme TEXT, meaning TEXT);
           CREATE TABLE etymdb_link(type TEXT, id1 INT, id2 INT);`);

  // ---- etymology-db relations ----
  const relCsv = path.join(VENDOR, "etymology.csv");
  if (fs.existsSync(relCsv)) {
    const ins = db.prepare("INSERT INTO rel VALUES(?,?,?,?,?,?)");
    db.exec("BEGIN");
    let n = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(relCsv), crlfDelay: Infinity });
    for await (const line of rl) {
      n++; if (n === 1) continue;
      const f = csvFields(line);
      if (f.length < 8) continue;
      ins.run(f[1], f[2], f[3], f[5] || null, f[6] || null, Number(f[7]) || 0);
      if (n % 1000000 === 0) process.stderr.write("  rel: " + n + " rows\n");
    }
    db.exec("COMMIT");
    process.stderr.write("rel: " + (n - 1) + " rows loaded\n");
  } else process.stderr.write("SKIP rel — " + relCsv + " missing\n");

  // ---- kaikki lemmas ----
  const insL = db.prepare("INSERT INTO lemma VALUES(?,?,?,?,?)");
  for (const f of fs.readdirSync(VENDOR).filter((x) => /^kaikki-.*\.jsonl\.gz$/.test(x))) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(VENDOR, f)).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    db.exec("BEGIN");
    let kept = 0;
    for await (const line of rl) {
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o.word || !o.lang) continue;
      // skip pure inflection entries (form-of/alt-of only) — keeps Latin lean
      const senses = o.senses || [];
      const real = senses.find((s) => !(s.tags || []).some((t) => /^(form-of|alt-of)$/.test(t)) && (s.glosses || []).length);
      if (!real) continue;
      insL.run(o.lang, o.word, o.pos || null, (real.glosses.slice(-1)[0] || "").slice(0, 200), cleanEty(o.etymology_text) || null);
      kept++;
    }
    db.exec("COMMIT");
    process.stderr.write("lemma: " + f + " → " + kept + " lemmas\n");
  }

  // ---- EtymDB 2.1 ----
  const vals = path.join(VENDOR, "etymdb-2.1", "data", "split_etymdb", "etymdb_values.csv");
  const links = path.join(VENDOR, "etymdb-2.1", "data", "split_etymdb", "etymdb_links_info.csv");
  if (fs.existsSync(vals) && fs.existsSync(links)) {
    const insV = db.prepare("INSERT INTO etymdb_lex VALUES(?,?,?,?)");
    db.exec("BEGIN");
    let nv = 0;
    for await (const line of readline.createInterface({ input: fs.createReadStream(vals), crlfDelay: Infinity })) {
      const f = line.split("\t");
      if (f.length < 4) continue;
      insV.run(Number(f[0]), f[1], f[3], f[4] || null); nv++;
    }
    db.exec("COMMIT");
    const insK = db.prepare("INSERT INTO etymdb_link VALUES(?,?,?)");
    db.exec("BEGIN");
    let nk = 0;
    for await (const line of readline.createInterface({ input: fs.createReadStream(links), crlfDelay: Infinity })) {
      const f = line.split("\t");
      if (f.length < 3) continue;
      insK.run(f[0], Number(f[1]), Number(f[2])); nk++;
    }
    db.exec("COMMIT");
    process.stderr.write("etymdb: " + nv + " lexemes, " + nk + " links\n");
  } else process.stderr.write("SKIP etymdb-2.1 — files missing\n");

  process.stderr.write("indexing…\n");
  db.exec(`CREATE INDEX i_rel_term ON rel(term_lang, term);
           CREATE INDEX i_rel_rel  ON rel(rel_lang, rel_term);
           CREATE INDEX i_lemma    ON lemma(lang, word);
           CREATE INDEX i_elex_id  ON etymdb_lex(id);
           CREATE INDEX i_elex_lx  ON etymdb_lex(lang, lexeme);
           CREATE INDEX i_elink_1  ON etymdb_link(id1);
           CREATE INDEX i_elink_2  ON etymdb_link(id2);`);
  db.close();
  process.stderr.write("done → " + DB + "\n");
}

main().catch((e) => { process.stderr.write("build-etymdb: " + e.message + "\n"); process.exit(1); });
