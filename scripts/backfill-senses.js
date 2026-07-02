#!/usr/bin/env node
/*
 * backfill-senses.js — common words carrying only ONE sense get their missing
 * senses from the Kaikki dump. WordNet gave many everyday words a single
 * sense; Wiktionary usually has the full spread ("bank": institution AND
 * riverbank). Additive only: existing senses are never touched, new ones
 * append after them, capped at 4 total. A new sense must clear a near-dup
 * check against every gloss already present (normalized containment or >60%
 * word overlap = duplicate). Examples ride along under the same quality gate
 * as backfill-etymology.js.
 *
 * Scope: words with exactly one sense AND frequency rank < --max-rank
 * (default 20000, from review/ranks.tsv) — the words users actually look up.
 *
 *   node scripts/backfill-senses.js <kaikki.jsonl> [--max-rank N]            # dry run
 *   node scripts/backfill-senses.js <kaikki.jsonl> [--max-rank N] --apply
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
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const MAX_RANK = Number(argOf("--max-rank", 20000));
const MAX_TOTAL = 4;

if (!SRC || SRC.startsWith("--") || !fs.existsSync(SRC)) {
  process.stderr.write("usage: node scripts/backfill-senses.js <kaikki.jsonl> [--max-rank N] [--apply]\n");
  process.exit(1);
}

const POS = { noun: "n.", verb: "v.", adj: "adj.", adv: "adv.", prep: "prep.", conj: "conj.",
  pron: "pron.", intj: "interj.", num: "num.", article: "art.", particle: "part.", det: "det.", name: "n." };

const normGloss = (g) => String(g == null ? "" : g).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

function nearDup(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) > 0.6;
}

// same example quality gate as backfill-etymology.js
function usableExample(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length < 15 || t.length > 300) return null;
  if (/^\d{4}/.test(t) || /^c\.\s*\d/.test(t)) return null;
  if (t.includes("[…]") || t.includes("[...]") || t.includes("ſ")) return null;
  if (/[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ一-鿿぀-ヿ가-힯]/.test(t)) return null;
  return t;
}
function pickExample(examples) {
  const pool = (examples || []).filter((x) => x.text);
  for (const x of pool) if (x.type !== "quotation" && !x.ref) { const t = usableExample(x.text); if (t) return t; }
  for (const x of pool) { const t = usableExample(x.text); if (t) return t; }
  return null;
}
const isFormOf = (s) => (s.tags || []).some((t) => /^(alt-of|form-of|abbreviation|initialism|misspelling)$/.test(String(t).toLowerCase()));

// ---- pass 1: find common one-sense words ----
const rank = new Map();
for (const line of fs.readFileSync(path.join(ROOT, "review", "ranks.tsv"), "utf8").split("\n").slice(1)) {
  const i = line.lastIndexOf("\t");
  if (i > 0) rank.set(line.slice(0, i), Number(line.slice(i + 1)));
}
const target = new Map(); // exact word -> existing entry glosses (normalized)
const byLower = new Map();
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const shard = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, rec] of Object.entries(shard)) {
    if (!Array.isArray(rec.d) || rec.d.length !== 1) continue;
    const rk = rank.get(w);
    if (rk == null || rk >= MAX_RANK) continue;
    target.set(w, rec.d.map((s) => normGloss(s.g)));
    const l = w.toLowerCase();
    if (!byLower.has(l)) byLower.set(l, []);
    byLower.get(l).push(w);
  }
}
process.stderr.write(target.size + " common (rank<" + MAX_RANK + ") one-sense words\n");

function resolveKey(kw) {
  const list = byLower.get(kw.toLowerCase());
  if (!list) return null;
  if (list.includes(kw)) return kw;
  return list.length === 1 ? list[0] : null;
}

async function main() {
  // pass 2: stream dump, collect candidate senses per word
  const pending = new Map(); // word -> [{p,g,x?},…]
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.word || (o.lang_code && o.lang_code !== "en")) continue;
    const key = resolveKey(o.word);
    if (!key) continue;
    const posLabel = POS[o.pos] || (o.pos ? o.pos + "." : "");
    for (const s of (o.senses || [])) {
      const gl = ((s.glosses || []).slice(-1)[0] || "").trim();
      if (!gl || isFormOf(s)) continue;
      if ((s.tags || []).some((t) => /^(obsolete|archaic|dated)$/.test(String(t).toLowerCase()))) continue;
      let list = pending.get(key);
      if (!list) pending.set(key, (list = []));
      if (list.length >= 8) continue; // enough candidates
      const o2 = { p: posLabel, g: gl };
      const ex = pickExample(s.examples);
      if (ex) o2.x = ex;
      list.push(o2);
    }
  }

  // pass 3: apply with near-dup filtering
  let enriched = 0, sensesAdded = 0, touched = 0;
  const samples = [];
  const byShard = new Map();
  for (const w of pending.keys()) {
    const k = w.slice(0, 2).toLowerCase() + ".json";
    if (!byShard.has(k)) byShard.set(k, []);
    byShard.get(k).push(w);
  }
  for (const [f, ws] of byShard) {
    const p = path.join(WORDS, f);
    if (!fs.existsSync(p)) continue;
    const shard = JSON.parse(fs.readFileSync(p, "utf8"));
    let dirty = false;
    for (const w of ws) {
      const rec = shard[w];
      if (!rec || !Array.isArray(rec.d) || rec.d.length !== 1) continue;
      const haveGlosses = rec.d.map((s) => normGloss(s.g));
      const adds = [];
      // Wiktionary gives every US township its own sense; those add noise,
      // not meaning. Allow at most one place sense per word, and none once a
      // place sense was skipped as a duplicate (the entry already covers the
      // principal place — later ones are strictly more obscure).
      const PLACE_RE = /\b(county seat|unincorporated community|census-designated place|township|shire of|local government area|borough|civil parish|a (town|city|village|hamlet|river|suburb|commune|neighbourhood|neighborhood) (in|of))\b/i;
      // If the entry's existing sense already describes a place, every place
      // candidate is a more obscure namesake — block them all.
      const GAZETTEER_RE = /\b(city|town|capital|county|river|state|community|village|country|kingdom|monarchy|nation|republic|island|peninsula|region|province)\b/;
      let placeBudget = haveGlosses.some((h) => GAZETTEER_RE.test(h)) ? 0 : 1;
      for (const cand of pending.get(w)) {
        if (rec.d.length + adds.length >= MAX_TOTAL) break;
        const n = normGloss(cand.g);
        if (!n) continue;
        const isPlace = PLACE_RE.test(cand.g);
        if (haveGlosses.some((h) => nearDup(h, n)) || adds.some((a) => nearDup(normGloss(a.g), n))) {
          if (isPlace) placeBudget = 0;
          continue;
        }
        if (isPlace) {
          if (placeBudget <= 0) continue;
          placeBudget--;
        }
        adds.push(cand);
      }
      if (!adds.length) continue;
      rec.d.push(...adds);
      enriched++; sensesAdded += adds.length; dirty = true;
      if (samples.length < 12) samples.push(w + " +" + adds.length + ": " + adds.map((a) => "(" + a.p + ") " + a.g.slice(0, 60)).join(" | "));
    }
    if (dirty && APPLY) {
      fs.writeFileSync(p, stringifyShard(shard));
      JSON.parse(fs.readFileSync(p, "utf8"));
      touched++;
    }
  }

  const L = [];
  L.push("BACKFILL-SENSES " + (APPLY ? "APPLIED" : "DRY RUN") + " (rank<" + MAX_RANK + ")");
  L.push("=".repeat(60));
  L.push("one-sense common words: " + target.size + "  -> " + (APPLY ? "enriched" : "would enrich") + ": " + enriched + " (+" + sensesAdded + " senses)");
  if (APPLY) L.push("shards written: " + touched);
  L.push("");
  for (const s of samples) L.push("  " + s);
  const out = path.join(ROOT, "backfill-senses-" + (APPLY ? "applied" : "dryrun") + ".txt");
  fs.writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write(L.join("\n") + "\n");
  if (!APPLY) process.stdout.write("(dry run — pass --apply to write)\n");
  else {
    const { bumpDataV } = require("./version-lib.js");
    const r = bumpDataV();
    if (r) process.stdout.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
  }
}

main().catch((e) => { process.stderr.write("backfill-senses: " + e.message + "\n"); process.exit(1); });
