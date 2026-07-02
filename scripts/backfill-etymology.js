#!/usr/bin/env node
/*
 * backfill-etymology.js — fill missing `e` (etymology) and missing per-sense
 * `x` (example sentences) from a Kaikki/Wiktextract dump, entirely
 * mechanically. Same posture as backfill-pronunciation.js: only ever ADDS
 * missing fields — an existing `e` or `x` is never touched, `_at` is left
 * alone, dry run by default.
 *
 * Etymology: first non-empty etymology_text among the word's pos-lines,
 * whitespace-collapsed and capped at 400 chars (the import-kaikki.js
 * convention, so backfilled entries look like imported ones).
 *
 * Examples: a sense gains an example only when a Kaikki sense's
 * most-specific gloss NORMALIZES TO EXACTLY the same string as ours — no
 * fuzzy matching, so an example can't land on the wrong sense. (Most of our
 * glosses came from Wiktionary in the first place, so exact matches are
 * common.)
 *
 * Case handling matches import-kaikki.js: a Kaikki headword resolves to our
 * exact-case key first, then to a unique case-insensitive match.
 *
 *   node scripts/backfill-etymology.js <kaikki.jsonl>            # dry run
 *   node scripts/backfill-etymology.js <kaikki.jsonl> --apply    # write + bump DATA_V
 *   [--limit-shards xx,yy]   only touch these shards (for spot verification)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

const SRC = process.argv[2];
const APPLY = process.argv.includes("--apply");
const argOf = (n) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : null; };
const LIMIT_SHARDS = argOf("--limit-shards") ? new Set(argOf("--limit-shards").split(",")) : null;

if (!SRC || SRC.startsWith("--") || !fs.existsSync(SRC)) {
  process.stderr.write("usage: node scripts/backfill-etymology.js <kaikki.jsonl> [--apply]\n");
  process.exit(1);
}

const normGloss = (g) => String(g == null ? "" : g).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

// Some Wiktionary etymologies arrive as an ancestor "tree" dump ("Etymology
// tree English absent-minded Middle English -ly …") with the actual prose
// sentence, if any, appended after it. Keep only the prose ("From …"); if the
// tree has no prose tail, skip the word rather than ship the dump.
function cleanEty(t) {
  let s = String(t).replace(/\s+/g, " ").trim();
  if (/^Etymology tree\b/.test(s)) {
    const m = s.match(/\b(From |Borrowed from |Coined |Named after |Blend of |Compound of |Short(?:ening)? (?:of|for) |Clipping of |Abbreviation of |Variant of |Alteration of |Univerbation of |Back-formation )/);
    if (!m) return "";
    s = s.slice(m.index);
  }
  return s.slice(0, 400);
}

// Example-sentence quality gate: no citation headers, no editorial elisions,
// no pre-modern typography or non-Latin scripts, not uselessly short/long.
function usableExample(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length < 15 || t.length > 300) return null;
  if (/^\d{4}/.test(t) || /^c\.\s*\d/.test(t)) return null;            // "1893, Bret Harte, …"
  if (t.includes("[…]") || t.includes("[...]") || t.includes("ſ")) return null;
  if (/[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ一-鿿぀-ヿ가-힯]/.test(t)) return null;
  return t;
}

// Prefer Wiktionary's invented usage examples over literary quotations, then
// clean quotations as a fallback.
function pickExample(examples) {
  const pool = (examples || []).filter((x) => x.text);
  for (const x of pool) if (x.type !== "quotation" && !x.ref) { const t = usableExample(x.text); if (t) return t; }
  for (const x of pool) { const t = usableExample(x.text); if (t) return t; }
  return null;
}

// ---- pass 1: scan shards for gaps ----
// needsEty: exact headword -> shard key
// needsX:   exact headword -> Set(normalized gloss of senses lacking x)
const needsEty = new Map();
const needsX = new Map();
const byLower = new Map(); // lowercase -> [exact keys] (for case-insensitive resolve)
const shardFiles = fs.readdirSync(WORDS).filter((f) => f.endsWith(".json"))
  .filter((f) => !LIMIT_SHARDS || LIMIT_SHARDS.has(f.replace(".json", "")));

let totalEntries = 0, lackEty = 0, sensesLackingX = 0;
for (const f of shardFiles) {
  const shard = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, rec] of Object.entries(shard)) {
    totalEntries++;
    let interested = false;
    if (!rec.e) { needsEty.set(w, f); lackEty++; interested = true; }
    if (Array.isArray(rec.d)) {
      let want = null;
      for (const s of rec.d) {
        if (!s || s.x || !s.g) continue;
        const n = normGloss(s.g);
        if (!n) continue;
        (want = want || new Set()).add(n);
        sensesLackingX++;
      }
      if (want) { needsX.set(w, want); interested = true; }
    }
    if (interested) {
      const l = w.toLowerCase();
      if (!byLower.has(l)) byLower.set(l, []);
      byLower.get(l).push(w);
    }
  }
}
process.stderr.write("scanned " + totalEntries + " entries in " + shardFiles.length + " shard(s): " +
  lackEty + " lack etymology, " + sensesLackingX + " senses lack an example (" + needsX.size + " words)\n");

// ---- pass 2: stream the dump, collect additions ----
const pendingEty = new Map(); // exact key -> ety string
const pendingX = new Map();   // exact key -> Map(normGloss -> example text)

function resolveKey(kw) {
  const list = byLower.get(kw.toLowerCase());
  if (!list) return null;
  if (list.includes(kw)) return kw;         // exact-case match
  return list.length === 1 ? list[0] : null; // unique case-insensitive match
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    if (lines % 500000 === 0) process.stderr.write("  …" + lines + " dump lines\n");
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.word || (o.lang_code && o.lang_code !== "en")) continue;
    const key = resolveKey(o.word);
    if (!key) continue;

    if (needsEty.has(key) && !pendingEty.has(key) && o.etymology_text) {
      const e = cleanEty(o.etymology_text);
      if (e) pendingEty.set(key, e);
    }
    const want = needsX.get(key);
    if (want) {
      for (const s of (o.senses || [])) {
        const gl = ((s.glosses || []).slice(-1)[0] || "").trim();
        if (!gl) continue;
        const n = normGloss(gl);
        if (!want.has(n)) continue;
        const ex = pickExample(s.examples);
        if (!ex) continue;
        let m = pendingX.get(key);
        if (!m) pendingX.set(key, (m = new Map()));
        if (!m.has(n)) m.set(n, ex);
      }
    }
  }

  // ---- pass 3: apply per shard ----
  const byShard = new Map(); // shard file -> Set(exact keys to touch)
  for (const key of pendingEty.keys()) {
    const f = needsEty.get(key);
    if (!byShard.has(f)) byShard.set(f, new Set());
    byShard.get(f).add(key);
  }
  for (const key of pendingX.keys()) {
    const f = key.slice(0, 2).toLowerCase() + ".json";
    if (!fs.existsSync(path.join(WORDS, f))) continue;
    if (LIMIT_SHARDS && !LIMIT_SHARDS.has(f.replace(".json", ""))) continue;
    if (!byShard.has(f)) byShard.set(f, new Set());
    byShard.get(f).add(key);
  }

  let addedEty = 0, addedX = 0, touchedShards = 0;
  const samplesE = [], samplesX = [];
  for (const [f, keys] of byShard) {
    const p = path.join(WORDS, f);
    const shard = JSON.parse(fs.readFileSync(p, "utf8"));
    let dirty = false;
    for (const key of keys) {
      const rec = shard[key];
      if (!rec) continue;
      const ety = pendingEty.get(key);
      if (ety && !rec.e) {  // re-check: never overwrite
        rec.e = ety; addedEty++; dirty = true;
        if (samplesE.length < 12) samplesE.push(key + "  e: " + ety.slice(0, 110));
      }
      const exs = pendingX.get(key);
      if (exs && Array.isArray(rec.d)) {
        for (const s of rec.d) {
          if (!s || s.x || !s.g) continue;
          const ex = exs.get(normGloss(s.g));
          if (!ex) continue;
          s.x = ex; addedX++; dirty = true;
          if (samplesX.length < 12) samplesX.push(key + "  [" + s.g.slice(0, 40) + "]  x: " + ex.slice(0, 90));
        }
      }
    }
    if (dirty && APPLY) {
      fs.writeFileSync(p, stringifyShard(shard));
      JSON.parse(fs.readFileSync(p, "utf8")); // self-validate like word.js
      touchedShards++;
    }
  }

  const L = [];
  L.push("BACKFILL-ETYMOLOGY " + (APPLY ? "APPLIED" : "DRY RUN"));
  L.push("=".repeat(60));
  L.push("entries lacking e: " + lackEty + "  -> " + (APPLY ? "filled" : "would fill") + ": " + addedEty);
  L.push("senses lacking x: " + sensesLackingX + "  -> " + (APPLY ? "filled" : "would fill") + ": " + addedX);
  if (APPLY) L.push("shards written: " + touchedShards);
  L.push("");
  L.push("---- sample etymologies ----");
  for (const s of samplesE) L.push("  " + s);
  L.push("---- sample examples ----");
  for (const s of samplesX) L.push("  " + s);
  const out = path.join(ROOT, "backfill-etymology-" + (APPLY ? "applied" : "dryrun") + ".txt");
  fs.writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write(L.join("\n") + "\n");
  if (!APPLY) process.stdout.write("(dry run — pass --apply to write)\n");
  else {
    const { bumpDataV } = require("./version-lib.js");
    const r = bumpDataV();
    if (r) process.stdout.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
  }
}

main().catch((e) => { process.stderr.write("backfill-etymology: " + e.message + "\n"); process.exit(1); });
