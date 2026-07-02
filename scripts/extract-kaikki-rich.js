#!/usr/bin/env node
/*
 * extract-kaikki-rich.js — ONE streaming pass over the English Kaikki dump,
 * capturing the structured fields the original import flattened away, into
 * vendor-data/kaikki-rich.sqlite. Downstream apply scripts (folding, sense
 * grouping, forms repair, respelling audit, attestation floors, images) read
 * this instead of re-streaming 3GB each.
 *
 * Captured (rhymes and translations deliberately excluded):
 *   section(word, ety_num, pos, etymology)      one row per etymology section
 *   sense(word, ety_num, pos, gloss, tags, alt_of, form_of, qualifier,
 *         syns, ants, examples, attest_year, wikidata, topics)
 *   sound(word, ipa, enpr, audio_ogg, audio_mp3, tags)
 *   wordmeta(word, hyphenation, wikipedia)
 *
 * Only words we carry (words/*.json headwords, case-insensitive) are kept —
 * the table is for enriching OUR dictionary, not mirroring Wiktionary.
 *
 *   node scripts/extract-kaikki-rich.js          (~5 min)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "vendor-data", "kaikki-en.jsonl.gz");
const DB = path.join(ROOT, "vendor-data", "kaikki-rich.sqlite");
const WORDS = path.join(ROOT, "words");

if (!fs.existsSync(SRC)) { process.stderr.write("missing " + SRC + "\n"); process.exit(1); }

// our headwords, case-insensitive → exact key
const have = new Map();
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  for (const w of Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8")))) {
    if (!have.has(w.toLowerCase())) have.set(w.toLowerCase(), w);
  }
}

if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = new DatabaseSync(DB);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;
  CREATE TABLE section(word TEXT, ety_num INT, pos TEXT, etymology TEXT);
  CREATE TABLE sense(word TEXT, ety_num INT, pos TEXT, gloss TEXT, tags TEXT,
    alt_of TEXT, form_of TEXT, qualifier TEXT, syns TEXT, ants TEXT,
    examples TEXT, attest_year INT, wikidata TEXT, topics TEXT);
  CREATE TABLE sound(word TEXT, ipa TEXT, enpr TEXT, audio_ogg TEXT, audio_mp3 TEXT, tags TEXT);
  CREATE TABLE wordmeta(word TEXT, hyphenation TEXT, wikipedia TEXT);`);

const insSec = db.prepare("INSERT INTO section VALUES(?,?,?,?)");
const insSen = db.prepare("INSERT INTO sense VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
const insSnd = db.prepare("INSERT INTO sound VALUES(?,?,?,?,?,?)");
const insMeta = db.prepare("INSERT INTO wordmeta VALUES(?,?,?)");

const J = (v) => (v && v.length ? JSON.stringify(v) : null);
const names = (arr) => (arr || []).map((x) => (x && x.word) || (typeof x === "string" ? x : null)).filter(Boolean);
const lastGloss = (s) => ((s.glosses || []).slice(-1)[0] || "").trim();

function attestYear(s) {
  // earliest dated evidence: explicit attestations, else the oldest example ref year
  let y = null;
  for (const a of s.attestations || []) {
    const m = String(a.date || a.text || "").match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
    if (m) y = Math.min(y || 9999, Number(m[1]));
  }
  for (const x of s.examples || []) {
    const m = String(x.ref || "").match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
    if (m) y = Math.min(y || 9999, Number(m[1]));
  }
  return y;
}

function usableExamples(exs) {
  const out = [];
  for (const x of exs || []) {
    if (!x.text) continue;
    const t = String(x.text).replace(/\s+/g, " ").trim();
    if (t.length < 15 || t.length > 300) continue;
    if (/^\d{4}/.test(t) || t.includes("[…]") || t.includes("[...]") || t.includes("ſ")) continue;
    if (/[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ一-鿿぀-ヿ가-힯]/.test(t)) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let lines = 0, kept = 0, sections = 0, senses = 0, sounds = 0;
  db.exec("BEGIN");
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    if (lines % 400000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); process.stderr.write("  " + lines + " lines\n"); }
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.word || (o.lang_code && o.lang_code !== "en")) continue;
    const key = have.get(o.word.toLowerCase());
    if (!key) continue;
    kept++;
    const etyNum = o.etymology_number || 0;

    if (o.etymology_text) { insSec.run(key, etyNum, o.pos || null, o.etymology_text.slice(0, 2000)); sections++; }

    for (const s of o.senses || []) {
      const gloss = lastGloss(s);
      if (!gloss) continue;
      const alt = names(s.alt_of)[0] || null;
      const formOf = names(s.form_of)[0] || null;
      const tags = J((s.tags || []).map(String));
      insSen.run(key, etyNum, o.pos || null, gloss.slice(0, 400), tags,
        alt, formOf, s.qualifier || null,
        J(names(s.synonyms)), J(names(s.antonyms)),
        J(usableExamples(s.examples)), attestYear(s),
        (s.wikidata && s.wikidata[0]) || null, J((s.topics || []).map(String)));
      senses++;
    }

    for (const snd of o.sounds || []) {
      if (!snd.ipa && !snd.enpr && !snd.ogg_url && !snd.mp3_url) continue;
      insSnd.run(key, snd.ipa || null, snd.enpr || null, snd.ogg_url || null, snd.mp3_url || null,
        J((snd.tags || []).map(String)));
      sounds++;
    }

    const hyph = (o.hyphenations || []).map((h) => (h.parts || []).join("·")).filter(Boolean)[0] || null;
    const wp = Array.isArray(o.wikipedia) ? o.wikipedia[0] : o.wikipedia || null;
    if (hyph || wp) insMeta.run(key, hyph, wp || null);
  }
  db.exec("COMMIT");
  db.exec(`CREATE INDEX i_sec ON section(word); CREATE INDEX i_sen ON sense(word);
           CREATE INDEX i_snd ON sound(word); CREATE INDEX i_meta ON wordmeta(word);
           CREATE INDEX i_sen_alt ON sense(alt_of) WHERE alt_of IS NOT NULL;
           CREATE INDEX i_sen_form ON sense(form_of) WHERE form_of IS NOT NULL;`);
  const c = (t) => db.prepare("SELECT count(*) c FROM " + t).get().c;
  process.stderr.write("kept lines for our headwords: " + kept + "\n" +
    "sections: " + c("section") + " | senses: " + c("sense") + " | sounds: " + c("sound") + " | wordmeta: " + c("wordmeta") + "\n" +
    "alt_of senses: " + db.prepare("SELECT count(*) c FROM sense WHERE alt_of IS NOT NULL").get().c +
    " | form_of: " + db.prepare("SELECT count(*) c FROM sense WHERE form_of IS NOT NULL").get().c +
    " | with enpr: " + db.prepare("SELECT count(DISTINCT word) c FROM sound WHERE enpr IS NOT NULL").get().c +
    " | with audio: " + db.prepare("SELECT count(DISTINCT word) c FROM sound WHERE audio_ogg IS NOT NULL OR audio_mp3 IS NOT NULL").get().c +
    " | attested senses: " + db.prepare("SELECT count(*) c FROM sense WHERE attest_year IS NOT NULL").get().c + "\n");
  db.close();
  process.stderr.write("done → " + DB + "\n");
}

main().catch((e) => { process.stderr.write("extract-kaikki-rich: " + e.stack + "\n"); process.exit(1); });
