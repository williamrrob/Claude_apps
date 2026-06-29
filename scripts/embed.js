#!/usr/bin/env node
/*
 * embed.js — on-device gloss embeddings via Ollama (nomic-embed-text, 768-dim).
 *
 * No cloud, no API keys: talks to a local Ollama at localhost:11434. Used for
 *   (1) semantic sense-dedup — see dedupe.js --embed (transient, nothing stored);
 *   (2) semantic search — `find similar <word>` (needs the persisted store below).
 *
 * Persisted store: embeddings.sqlite (gitignored, like rootwork.sqlite). Kept
 * SEPARATE from rootwork.sqlite on purpose: rootwork.sqlite is deleted and
 * rebuilt from shards on every `build:sqlite`, which would throw away every
 * vector and force a full (~77k) recompute. Tables:
 *   gloss(hash PRIMARY KEY, gloss, v BLOB)  — cache, keyed by gloss text; lets a
 *                                             re-run embed only new/changed glosses
 *   word(word PRIMARY KEY, v BLOB)          — L2-normalized mean of a word's sense
 *                                             vectors, so cosine == dot product
 *   meta(k PRIMARY KEY, val)                — model name, dims
 *
 * CLI:
 *   node scripts/embed.js build [--limit N] [--force]   build/refresh the store
 *   node scripts/embed.js word <word>                   show a word's sense vectors (debug)
 *   node scripts/embed.js ping                          check Ollama + model
 *
 * Reads senses from rootwork.sqlite (run `npm run build:sqlite` first).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const SRC_DB = path.join(ROOT, "rootwork.sqlite");
const EMB_DB = process.env.EMB_DB || path.join(ROOT, "embeddings.sqlite");

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const DIM = 768;
const BATCH = 64;
const EMPTY = "";

// ---- Ollama embedding ----------------------------------------------------
// nomic-embed-text is trained with task prefixes; use the right one per use.
const PREFIX = { doc: "search_document: ", query: "search_query: ", none: EMPTY };

async function embedTexts(texts, kind) {
  if (!texts.length) return [];
  const pre = PREFIX[kind] != null ? PREFIX[kind] : EMPTY;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH).map((t) => pre + String(t == null ? EMPTY : t));
    const res = await fetch(OLLAMA + "/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: slice }),
    });
    if (!res.ok) throw new Error("ollama /api/embed " + res.status + ": " + (await res.text()));
    const json = await res.json();
    if (!json.embeddings || json.embeddings.length !== slice.length) {
      throw new Error("ollama returned " + (json.embeddings || []).length + " vectors for " + slice.length + " inputs");
    }
    for (const v of json.embeddings) out.push(Float32Array.from(v));
  }
  return out;
}

// ---- vector helpers ------------------------------------------------------
function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function meanVec(vs) {
  const out = new Float32Array(DIM);
  for (const v of vs) for (let i = 0; i < DIM; i++) out[i] += v[i];
  for (let i = 0; i < DIM; i++) out[i] /= vs.length;
  return out;
}
// cosine for raw (un-normalized) vectors
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
const hashGloss = (g) => crypto.createHash("sha1").update(String(g == null ? EMPTY : g)).digest("hex");

// BLOB <-> Float32Array (slice to a fresh, 4-byte-aligned ArrayBuffer)
function blobToF32(u8) {
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return new Float32Array(ab);
}
const f32ToBlob = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);

// ---- store reader (used by find.js, dedupe.js, sense-merge.js, ...) -------
// Memoized: the module holds the DatabaseSync for its whole lifetime so callers'
// prepared statements never get finalized by GC reclaiming an unreferenced
// handle (node:sqlite finalizes a statement when its Database is collected).
let _store = null;
function openStore(readOnly) {
  if (!fs.existsSync(EMB_DB)) {
    throw new Error("embeddings.sqlite missing — run: node scripts/embed.js build");
  }
  if (!_store) _store = new DatabaseSync(EMB_DB, { readOnly: readOnly !== false });
  return _store;
}

module.exports = {
  embedTexts, normalize, meanVec, cosine, hashGloss, blobToF32, f32ToBlob,
  openStore, DIM, MODEL, OLLAMA, EMB_DB, SRC_DB,
};

// ---- CLI -----------------------------------------------------------------
if (require.main === module) main();

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "ping") return await ping();
    if (cmd === "build") return await build(rest);
    if (cmd === "word") return await showWord(rest[0]);
    process.stderr.write("commands: build [--limit N] [--force] | word <word> | ping\n");
    process.exit(1);
  } catch (e) {
    process.stderr.write("embed.js: " + e.message + "\n");
    process.exit(1);
  }
}

async function ping() {
  const res = await fetch(OLLAMA + "/api/tags");
  if (!res.ok) throw new Error("Ollama not reachable at " + OLLAMA);
  const names = (await res.json()).models.map((m) => m.name);
  const ok = names.some((n) => n === MODEL || n.startsWith(MODEL + ":"));
  process.stdout.write("ollama " + OLLAMA + " ok — " + names.length + " models; " +
    MODEL + ": " + (ok ? "present" : "MISSING (ollama pull " + MODEL + ")") + "\n");
  if (ok) {
    const [v] = await embedTexts(["hello"], "doc");
    process.stdout.write("embed test: " + v.length + " dims, first=" + v[0].toFixed(4) + "\n");
  }
}

async function showWord(word) {
  if (!word) throw new Error("word needs a <word>");
  if (!fs.existsSync(SRC_DB)) throw new Error("rootwork.sqlite missing — run: npm run build:sqlite");
  const db = new DatabaseSync(SRC_DB, { readOnly: true });
  const rows = db.prepare("SELECT pos, gloss FROM senses WHERE word=? AND gloss IS NOT NULL").all(word);
  db.close();
  if (!rows.length) throw new Error("no senses for " + word);
  const vs = await embedTexts(rows.map((r) => r.gloss), "doc");
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write("[" + i + "] (" + (rows[i].pos || "?") + ") " + rows[i].gloss + "\n");
  }
  process.stdout.write("\npairwise cosine:\n");
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++)
      process.stdout.write("  [" + i + "]x[" + j + "] " + cosine(vs[i], vs[j]).toFixed(3) + "\n");
}

async function build(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li !== -1 ? parseInt(args[li + 1], 10) || 0 : 0;

  if (!fs.existsSync(SRC_DB)) throw new Error("rootwork.sqlite missing — run: npm run build:sqlite");
  await ensureModel();

  const src = new DatabaseSync(SRC_DB, { readOnly: true });
  if (force && fs.existsSync(EMB_DB)) fs.unlinkSync(EMB_DB);
  const db = new DatabaseSync(EMB_DB);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS gloss (hash TEXT PRIMARY KEY, gloss TEXT, v BLOB);
    CREATE TABLE IF NOT EXISTS word  (word TEXT PRIMARY KEY, v BLOB);
    CREATE TABLE IF NOT EXISTS meta  (k TEXT PRIMARY KEY, val TEXT);
  `);
  db.prepare("INSERT OR REPLACE INTO meta(k,val) VALUES ('model',?),('dim',?)").run(MODEL, String(DIM));

  const getGloss = db.prepare("SELECT v FROM gloss WHERE hash=?");
  const putGloss = db.prepare("INSERT OR REPLACE INTO gloss(hash,gloss,v) VALUES (?,?,?)");
  const putWord = db.prepare("INSERT OR REPLACE INTO word(word,v) VALUES (?,?)");

  // group glosses by word (one row per sense, ordered so a word's senses adjoin)
  const senses = src.prepare("SELECT word, gloss FROM senses WHERE gloss IS NOT NULL ORDER BY word").all();
  const byWord = new Map();
  for (const s of senses) {
    let arr = byWord.get(s.word);
    if (!arr) byWord.set(s.word, (arr = []));
    arr.push(s.gloss);
  }
  let words = [...byWord.entries()].map((e) => ({ word: e[0], glosses: e[1] }));
  if (limit > 0) words = words.slice(0, limit);

  const haveWord = db.prepare("SELECT 1 FROM word WHERE word=?");
  const t0 = Date.now();
  let done = 0, embedded = 0, cached = 0, skipped = 0;

  // Pass 1: pick words needing work and collect their UNCACHED glosses, deduped
  // by hash, across all words. Skip a word only if it's done AND every gloss is
  // cached (an uncached gloss means a sense was added/changed → re-embed).
  const todo = [];
  const needMap = new Map(); // hash -> gloss text (unique, uncached)
  for (const row of words) {
    if (!force && haveWord.get(row.word)) {
      let allCached = true;
      for (const g of row.glosses) if (!getGloss.get(hashGloss(g))) { allCached = false; break; }
      if (allCached) { skipped++; continue; }
    }
    todo.push(row);
    for (const g of row.glosses) { const h = hashGloss(g); if (!needMap.has(h) && !getGloss.get(h)) needMap.set(h, g); }
  }

  // Pass 2: embed uncached glosses in big cross-word batches (≫ the 1–2 glosses a
  // single word has — measured ~3× faster than per-word requests on this GPU).
  const uniq = [...needMap.values()];
  const FLUSH = 256; // embedTexts chunks this into 64-wide requests internally
  for (let i = 0; i < uniq.length; i += FLUSH) {
    const chunk = uniq.slice(i, i + FLUSH);
    const fresh = await embedTexts(chunk, "doc");
    db.exec("BEGIN");
    for (let k = 0; k < chunk.length; k++) { putGloss.run(hashGloss(chunk[k]), chunk[k], f32ToBlob(fresh[k])); embedded++; }
    db.exec("COMMIT");
    if (i % (FLUSH * 8) === 0) {
      const rate = embedded / ((Date.now() - t0) / 1000);
      process.stderr.write("  embedding " + embedded + "/" + uniq.length + " glosses  " + rate.toFixed(0) + "/s\n");
    }
  }

  // Pass 3: every gloss is now cached — compute each word's mean vector.
  for (const row of todo) {
    const vecs = [];
    for (const g of row.glosses) { const hit = getGloss.get(hashGloss(g)); if (hit) { vecs.push(blobToF32(hit.v)); cached++; } }
    if (vecs.length) putWord.run(row.word, f32ToBlob(normalize(meanVec(vecs))));
    done++;
  }
  db.close();
  src.close();
  const mb = (fs.statSync(EMB_DB).size / 1048576).toFixed(1);
  process.stderr.write("embeddings.sqlite: " + done + " words processed, " + skipped +
    " already done, " + embedded + " glosses embedded, " + cached + " from cache — " +
    mb + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s\n");
}

async function ensureModel() {
  const res = await fetch(OLLAMA + "/api/tags").catch(() => null);
  if (!res || !res.ok) throw new Error("Ollama not reachable at " + OLLAMA + " (is `ollama serve` running?)");
  const names = (await res.json()).models.map((m) => m.name);
  if (!names.some((n) => n === MODEL || n.startsWith(MODEL + ":")))
    throw new Error("model " + MODEL + " not pulled — run: ollama pull " + MODEL);
}
