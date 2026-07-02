#!/usr/bin/env node
/*
 * repair-etymology-truncation.js — fix the two legacy defects in stored `e`
 * fields, from the full Kaikki source text:
 *
 *   1. TRUNCATION: build-rich.js capped etymologies at 320 chars ("… "),
 *      import-kaikki.js/backfills at 400, sliced mid-sentence. The source
 *      dump has the full text.
 *   2. TREE DUMPS: older imports stored raw "Etymology tree …" ancestor dumps
 *      (recognizable by "▲" or glued "bor./der./inh." markers) instead of the
 *      prose; the tree-stripping in backfill-etymology.js postdates them.
 *
 * A stored e is REPLACED only when it is provably stale machine output of the
 * same source text — never when it could be hand-curated:
 *   (a) stored (minus a trailing ellipsis) is a prefix of the canonical clean
 *       text → pure truncation;
 *   (b) stored has tree-dump markers → re-clean from source;
 *   (c) stored ends mid-sentence AND shares its first 40 chars with the
 *       canonical text → same lineage, cut mid-thought.
 * Canonical text = tree-stripped source, cut at the last sentence end within
 * BUDGET chars (hard mid-sentence cap only if the first sentence exceeds it).
 *
 *   node scripts/repair-etymology-truncation.js <kaikki.jsonl>            # dry run
 *   node scripts/repair-etymology-truncation.js <kaikki.jsonl> --apply
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
const BUDGET = 700;

if (!SRC || SRC.startsWith("--") || !fs.existsSync(SRC)) {
  process.stderr.write("usage: node scripts/repair-etymology-truncation.js <kaikki.jsonl> [--apply]\n");
  process.exit(1);
}

const { cleanEtymology } = require("./ety-clean.js");
const TREE_MARK = /▲|\b(?:bor|der|inh|clq)\.\s|Etymology tree\b/;
const canonical = (t) => cleanEtymology(t, BUDGET);

const stripEll = (s) => s.replace(/\s*(…|\.\.\.)\s*$/, "").trim();
const endsClean = (s) => /[.!?”)\]]$/.test(s.trim());

// pass 1: which words have an e that might need repair
const suspect = new Map(); // exact word -> stored e
const byLower = new Map();
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const shard = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, rec] of Object.entries(shard)) {
    if (!rec.e) continue;
    if (!endsClean(rec.e) || TREE_MARK.test(rec.e)) {
      suspect.set(w, rec.e);
      const l = w.toLowerCase();
      if (!byLower.has(l)) byLower.set(l, []);
      byLower.get(l).push(w);
    }
  }
}
process.stderr.write(suspect.size + " stored etymologies look truncated or tree-dumped\n");

function resolveKey(kw) {
  const list = byLower.get(kw.toLowerCase());
  if (!list) return null;
  if (list.includes(kw)) return kw;
  return list.length === 1 ? list[0] : null;
}

async function main() {
  // pass 2: stream dump, compute replacements
  const replace = new Map(); // word -> new e
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.word || (o.lang_code && o.lang_code !== "en") || !o.etymology_text) continue;
    const key = resolveKey(o.word);
    if (!key || replace.has(key)) continue;
    const stored = suspect.get(key);
    const canon = canonical(o.etymology_text);
    if (!canon || canon === stored) continue;
    const treeDump = TREE_MARK.test(stored);
    const prefixOf = canon.startsWith(stripEll(stored));
    const sameLineage = canon.slice(0, 40) === stored.slice(0, 40);
    if (treeDump || prefixOf || (!endsClean(stored) && sameLineage)) replace.set(key, canon);
  }

  // pass 3: write per shard
  let repaired = 0, touched = 0, bytesBefore = 0, bytesAfter = 0;
  const samples = [];
  const byShard = new Map();
  for (const w of replace.keys()) {
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
      if (!rec || !rec.e || !suspect.has(w)) continue;
      bytesBefore += rec.e.length; bytesAfter += replace.get(w).length;
      if (samples.length < 10) samples.push(w + "\n    OLD: …" + rec.e.slice(-80) + "\n    NEW: …" + replace.get(w).slice(-80));
      rec.e = replace.get(w); repaired++; dirty = true;
    }
    if (dirty && APPLY) {
      fs.writeFileSync(p, stringifyShard(shard));
      JSON.parse(fs.readFileSync(p, "utf8"));
      touched++;
    }
  }

  const L = [];
  L.push("REPAIR-ETYMOLOGY-TRUNCATION " + (APPLY ? "APPLIED" : "DRY RUN"));
  L.push("=".repeat(60));
  L.push("suspect stored etymologies: " + suspect.size + "  -> " + (APPLY ? "repaired" : "would repair") + ": " + repaired);
  L.push("size delta: " + (bytesBefore / 1024).toFixed(0) + "KB -> " + (bytesAfter / 1024).toFixed(0) + "KB (+" + ((bytesAfter - bytesBefore) / 1024).toFixed(0) + "KB across all shards)");
  if (APPLY) L.push("shards written: " + touched);
  L.push("");
  for (const s of samples) L.push(s);
  const out = path.join(ROOT, "repair-etymology-" + (APPLY ? "applied" : "dryrun") + ".txt");
  fs.writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write(L.join("\n") + "\n");
  if (!APPLY) process.stdout.write("(dry run — pass --apply to write)\n");
  else {
    const { bumpDataV } = require("./version-lib.js");
    const r = bumpDataV();
    if (r) process.stdout.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
  }
}

main().catch((e) => { process.stderr.write("repair-etymology-truncation: " + e.message + "\n"); process.exit(1); });
