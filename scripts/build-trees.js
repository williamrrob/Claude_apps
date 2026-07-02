#!/usr/bin/env node
/*
 * build-trees.js — extract per-word etymology ANCESTRY TREES into
 * trees/<xx>.json shards (same sharding as words/), for the future
 * ancestry-tree card. Data-only; no app wiring here.
 *
 * Two complementary sources, both shipped per word:
 *   c: the ancestry CHAIN from etymology-db rows (vendor-data/etym.sqlite) —
 *      the word's own recorded hops in order, e.g. about → Middle English
 *      aboute → Old English onbūtan. Flat but reliable spine.
 *   t: branching SUBTREES parsed from the Wiktionary `etymon` template's
 *      embedded JSON (etymology_templates in vendor-data/kaikki-en.jsonl).
 *      These reach Proto-Indo-European and branch at compounds (būtan =
 *      bi- + ūtan → PIE *h₁epi and *úd). Wiktextract mangles the outermost
 *      object of many trees, so we salvage every well-formed sub-blob rather
 *      than trusting the whole; the chain provides the missing top hops.
 *
 * Node form (compact): [lang, term, kind, children?]
 *   kind: "inh" inherited | "der" derived | "bor" borrowed | "" unknown
 *
 * Gloss lookups for ancestor terms stay in vendor-data/etym.sqlite (lemma
 * table) — the UI can fetch them lazily later if we decide to ship them.
 *
 *   node scripts/build-trees.js            # writes trees/, prints stats
 */
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const TREES = path.join(ROOT, "trees");
const KAIKKI = path.join(ROOT, "vendor-data", "kaikki-en.jsonl");
const DBP = path.join(ROOT, "vendor-data", "etym.sqlite");

const MAX_DEPTH = 12, MAX_NODES = 60, MAX_SUBTREES = 4;

if (!fs.existsSync(KAIKKI) || !fs.existsSync(DBP)) {
  process.stderr.write("need vendor-data/kaikki-en.jsonl and vendor-data/etym.sqlite\n");
  process.exit(1);
}

// our headwords: only ship trees for words we carry
const have = new Map(); // lowercase -> exact key
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  for (const w of Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8")))) {
    if (!have.has(w.toLowerCase())) have.set(w.toLowerCase(), w);
  }
}

// ---- salvage parseable JSON blobs from an etymon expansion ----
function jsonBlobs(s) {
  const out = [];
  let i = s.indexOf("{");
  while (i !== -1 && out.length < 24) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    const blob = s.slice(i, end + 1).replace(/\n/g, " ");
    let parsed = null;
    try { parsed = JSON.parse(blob); } catch (e) {}
    if (parsed) { out.push(parsed); i = s.indexOf("{", end + 1); }
    else i = s.indexOf("{", i + 1);
  }
  return out;
}

const KIND = { inherited: "inh", derived: "der", borrowed: "bor" };

// wiktextract node -> compact [lang, term, kind, children?]; null if empty
function compact(node, depth, budget) {
  if (!node || depth > MAX_DEPTH || budget.n >= MAX_NODES) return null;
  const lang = node.lang_name || "";
  const term = (node.term || "").trim();
  if (!lang && !term) return null;
  budget.n++;
  const kids = [];
  for (const c of node.children || []) {
    const kind = KIND[c.keyword] || "";
    for (const tm of c.terms || []) {
      const k = compact(tm, depth + 1, budget);
      if (k) { if (kind && !k[2]) k[2] = kind; kids.push(k); }
    }
  }
  const out = [lang, term, ""];
  if (kids.length) out.push(kids);
  return out;
}

const treeSize = (t) => 1 + (t[3] ? t[3].reduce((a, c) => a + treeSize(c), 0) : 0);
const treeDepth = (t) => 1 + (t[3] ? Math.max(...t[3].map(treeDepth)) : 0);

async function main() {
  // pass 1: subtrees from kaikki etymon templates
  const subtrees = new Map(); // exact key -> [tree,…]
  let linesSeen = 0, wordsWithEtymon = 0, blobsParsed = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(KAIKKI), crlfDelay: Infinity });
  let cur = null, curTrees = null, curSeen = null;
  const flush = () => {
    if (!cur || !curTrees || !curTrees.length) return;
    const key = have.get(cur.toLowerCase());
    if (!key) return;
    // dedupe identical roots, keep the deepest few
    curTrees.sort((a, b) => treeSize(b) - treeSize(a));
    const picked = [];
    const roots = new Set();
    for (const t of curTrees) {
      const r = t[0] + "|" + t[1];
      if (roots.has(r)) continue;
      roots.add(r);
      picked.push(t);
      if (picked.length >= MAX_SUBTREES) break;
    }
    if (picked.length) subtrees.set(key, picked);
  };
  for await (const line of rl) {
    linesSeen++;
    if (!line.includes('"etymon"')) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.word || (o.lang_code && o.lang_code !== "en")) continue;
    if (o.word !== cur) { flush(); cur = o.word; curTrees = []; curSeen = new Set(); wordsWithEtymon++; }
    for (const t of o.etymology_templates || []) {
      if (t.name !== "etymon" || !t.expansion) continue;
      const sig = t.expansion.slice(0, 120);
      if (curSeen.has(sig)) continue;
      curSeen.add(sig);
      for (const blob of jsonBlobs(t.expansion)) {
        const c = compact(blob, 0, { n: 0 });
        if (c && (c[3] || c[1])) { curTrees.push(c); blobsParsed++; }
      }
    }
  }
  flush();
  process.stderr.write("kaikki: " + wordsWithEtymon + " en words carried etymon templates; " +
    blobsParsed + " subtree blobs parsed; " + subtrees.size + " of our headwords got subtrees\n");

  // pass 2: ancestry chains from etymology-db for every word that has either
  const db = new DatabaseSync(DBP, { readOnly: true });
  const ANC = ["inherited_from", "derived_from", "borrowed_from", "learned_borrowing_from",
    "unadapted_borrowing_from", "orthographic_borrowing_from", "semi_learned_borrowing_from"];
  const qRows = db.prepare("SELECT reltype, rel_lang, rel_term FROM rel WHERE term_lang='English' AND term = ? ORDER BY rowid");
  const chainFor = (w) => {
    let rows = qRows.all(w);
    if (!rows.length && w !== w.toLowerCase()) rows = qRows.all(w.toLowerCase());
    if (!rows.length) {
      const cap = w[0].toUpperCase() + w.slice(1);
      if (cap !== w) rows = qRows.all(cap);
    }
    const chain = []; const seen = new Set();
    for (const r of rows) {
      if (!ANC.includes(r.reltype)) continue;
      const term = (r.rel_term || "").trim();
      if (!term) continue;
      const key = r.rel_lang + "|" + term;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push([r.rel_lang || "", term, r.reltype.startsWith("inherited") ? "inh" : r.reltype.includes("borrow") ? "bor" : "der"]);
      if (chain.length >= 8) break;
    }
    return chain;
  };

  // candidates: words with subtrees, plus every headword with ancestry rows
  const candidates = new Set(subtrees.keys());
  for (const r of db.prepare(
    "SELECT DISTINCT term FROM rel WHERE term_lang='English' AND reltype IN (" + ANC.map(() => "?").join(",") + ")").all(...ANC)) {
    const key = have.get(String(r.term).toLowerCase());
    if (key) candidates.add(key);
  }

  const byShard = new Map();
  let withChain = 0, withBoth = 0, total = 0;
  for (const w of candidates) {
    const c = chainFor(w);
    const t = subtrees.get(w);
    if (!c.length && !t) continue;
    const entry = {};
    if (c.length) { entry.c = c; withChain++; }
    if (t) entry.t = t;
    if (c.length && t) withBoth++;
    const sk = w.slice(0, 2).toLowerCase();
    if (!/^[a-z]{2}$/.test(sk)) continue;
    if (!byShard.has(sk)) byShard.set(sk, {});
    byShard.get(sk)[w] = entry;
    total++;
  }
  db.close();

  fs.mkdirSync(TREES, { recursive: true });
  for (const old of fs.readdirSync(TREES).filter((x) => x.endsWith(".json"))) fs.unlinkSync(path.join(TREES, old));
  let bytes = 0;
  for (const [sk, obj] of byShard) {
    const sorted = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    const body = Object.keys(sorted).map((k) => JSON.stringify(k) + ":" + JSON.stringify(sorted[k]));
    const s = "{\n" + body.join(",\n") + "\n}";
    JSON.parse(s); // self-validate
    fs.writeFileSync(path.join(TREES, sk + ".json"), s);
    bytes += s.length;
  }
  process.stderr.write("trees/: " + total + " words (" + withChain + " with chains, " + subtrees.size +
    " with subtrees, " + withBoth + " both) across " + byShard.size + " shards, " + (bytes / 1048576).toFixed(1) + " MB\n");

  // demo
  const demo = ["about", "december", "solipsism", "synchronize"];
  for (const w of demo) {
    const sk = w.slice(0, 2);
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(TREES, sk + ".json"), "utf8"));
      if (obj[w]) process.stderr.write("  " + w + ": " + JSON.stringify(obj[w]).slice(0, 220) + "\n");
    } catch (e) {}
  }
}

main().catch((e) => { process.stderr.write("build-trees: " + e.stack + "\n"); process.exit(1); });
