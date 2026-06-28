#!/usr/bin/env node
/*
 * find.js — cheap dictionary queries against rootwork.sqlite (built by
 * build-sqlite.js). Returns just the matching words (one per line) so an
 * assistant building rich entries can discover candidates/relations/gaps
 * without scanning shards. Run `npm run build:sqlite` first if the DB is stale.
 *
 *   node scripts/find.js root <id>            words built on a root  (e.g. scrib)
 *   node scripts/find.js prefix <id>          words with a prefix    (e.g. pre)
 *   node scripts/find.js suffix <id>          words with a suffix    (e.g. ion)
 *   node scripts/find.js morph <id>           words with any part    (e.g. ven)
 *   node scripts/find.js meaning <text...>    full-text over glosses+etymology
 *   node scripts/find.js rel <word>           a word's syn/ant/related
 *   node scripts/find.js revsyn <word>        words that list <word> as a synonym
 *   node scripts/find.js similar <word>       nearest words by meaning (needs
 *                                             embeddings.sqlite — build with
 *                                             `npm run embed build`)
 *   node scripts/find.js missing <field> [--root id|--prefix id]
 *                                             gap-finder: words lacking syn|ant|
 *                                             rel|ex|ety|ipa  (great for enrichment)
 *   node scripts/find.js stats                row counts overview
 *   node scripts/find.js q "<SELECT ...>"     raw SQL escape hatch
 *
 * Options: --limit N (default 200, use 0 for all).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB = path.join(__dirname, "..", "rootwork.sqlite");
if (!fs.existsSync(DB)) { process.stderr.write("rootwork.sqlite missing — run: npm run build:sqlite\n"); process.exit(1); }
const db = new DatabaseSync(DB, { readOnly: true });

const argv = process.argv.slice(2);
let limit = 200;
const li = argv.indexOf("--limit");
if (li !== -1) { limit = parseInt(argv[li + 1], 10) || 0; argv.splice(li, 2); }
const flag = (name) => { const i = argv.indexOf(name); if (i === -1) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const root = flag("--root"), prefix = flag("--prefix"), suffix = flag("--suffix");

const [cmd, ...rest] = argv;
const lim = limit > 0 ? ` LIMIT ${limit}` : "";

function emit(rows, col) {
  for (const r of rows) process.stdout.write((col ? r[col] : Object.values(r).join("\t")) + "\n");
  process.stderr.write(`(${rows.length}${limit && rows.length === limit ? "+, --limit to see more" : ""})\n`);
}
function words(sql, params) { emit(db.prepare(sql + lim).all(...(params || [])), "word"); }

switch (cmd) {
  case "root":   words("SELECT DISTINCT word FROM morph WHERE kind='root'   AND id=? ORDER BY word", [rest[0]]); break;
  case "prefix": words("SELECT DISTINCT word FROM morph WHERE kind='prefix' AND id=? ORDER BY word", [rest[0]]); break;
  case "suffix": words("SELECT DISTINCT word FROM morph WHERE kind='suffix' AND id=? ORDER BY word", [rest[0]]); break;
  case "morph":  words("SELECT DISTINCT word FROM morph WHERE id=? ORDER BY word", [rest[0]]); break;

  case "meaning":
    words("SELECT word FROM fts WHERE body MATCH ? ORDER BY rank", [rest.join(" ")]); break;

  case "rel":
    emit(db.prepare("SELECT kind, target FROM rel WHERE word=? ORDER BY kind" + lim).all(rest[0])); break;

  case "revsyn":
    words("SELECT DISTINCT word FROM rel WHERE kind='syn' AND target=? ORDER BY word", [rest[0]]); break;

  case "similar": {
    // Semantic neighbours via stored gloss embeddings (embeddings.sqlite). Word
    // vectors are L2-normalized, so cosine similarity is just a dot product.
    const target = rest[0];
    if (!target) { process.stderr.write("similar needs a <word>\n"); process.exit(1); }
    const embed = require("./embed.js");
    let store;
    try { store = embed.openStore(true); }
    catch (e) { process.stderr.write(e.message + "\n"); process.exit(1); }

    // Look up the query word's vector; if it isn't in the store yet, embed its
    // senses on the fly (same "doc" prefix as the corpus) so it's comparable.
    let qv;
    const row = store.prepare("SELECT v FROM word WHERE word=?").get(target);
    if (row) {
      qv = embed.blobToF32(row.v);
    } else {
      const senses = db.prepare("SELECT gloss FROM senses WHERE word=? AND gloss IS NOT NULL").all(target);
      if (!senses.length) { process.stderr.write("no senses for '" + target + "' (unknown word?)\n"); process.exit(1); }
      embed.embedTexts(senses.map((s) => s.gloss), "doc")
        .then((vs) => { qv = embed.normalize(embed.meanVec(vs)); rank(); })
        .catch((e) => { process.stderr.write("embed: " + e.message + "\n"); process.exit(1); });
      break;
    }
    rank();

    function rank() {
      const all = store.prepare("SELECT word, v FROM word").all();
      const scored = [];
      for (const r of all) {
        if (r.word === target) continue;
        const v = embed.blobToF32(r.v);
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += qv[i] * v[i];
        scored.push([r.word, dot]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const top = limit > 0 ? scored.slice(0, limit) : scored;
      for (const [w, s] of top) process.stdout.write(w + "\t" + s.toFixed(3) + "\n");
      process.stderr.write("(" + top.length + " of " + scored.length + " embedded words)\n");
    }
    break;
  }

  case "missing": {
    // "lacks <field>" condition, parameterized on a word-column expression so it
    // works whether we lead with the morph table (fast, when filtered) or words.
    const field = rest[0];
    const cond = (wc) => ({
      syn: `NOT EXISTS(SELECT 1 FROM rel r WHERE r.word=${wc} AND r.kind='syn')`,
      ant: `NOT EXISTS(SELECT 1 FROM rel r WHERE r.word=${wc} AND r.kind='ant')`,
      rel: `NOT EXISTS(SELECT 1 FROM rel r WHERE r.word=${wc} AND r.kind='rel')`,
      ex:  `NOT EXISTS(SELECT 1 FROM senses s WHERE s.word=${wc} AND s.example IS NOT NULL)`,
      ety: `COALESCE((SELECT ety FROM words ww WHERE ww.word=${wc}),'')=''`,
      ipa: `COALESCE((SELECT ipa FROM words ww WHERE ww.word=${wc}),'')=''`,
    }[field]);
    if (!cond("x")) { process.stderr.write("missing <field> must be: syn|ant|rel|ex|ety|ipa\n"); process.exit(1); }
    // Lead with the indexed morph lookup when a morpheme filter is given (a root
    // has only a few hundred words), else scan words.
    const mkind = root ? "root" : prefix ? "prefix" : suffix ? "suffix" : null;
    const mid = root || prefix || suffix;
    if (mkind) {
      words(`SELECT DISTINCT m.word FROM morph m WHERE m.kind='${mkind}' AND m.id=? AND ${cond("m.word")} ORDER BY m.word`, [mid]);
    } else {
      words(`SELECT w.word FROM words w WHERE ${cond("w.word")} ORDER BY w.word`, []);
    }
    break;
  }

  case "stats": {
    for (const t of ["words", "senses", "rel", "morph"]) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      process.stdout.write(`${t}\t${n}\n`);
    }
    break;
  }

  case "q": {
    const rows = db.prepare(rest.join(" ") + lim).all();
    emit(rows);
    break;
  }

  default:
    process.stderr.write("commands: root prefix suffix morph meaning rel revsyn similar missing stats q\n");
    process.exit(1);
}
