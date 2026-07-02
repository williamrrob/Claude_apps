#!/usr/bin/env node
/*
 * build-trees.js (v2) — regenerate the per-word ancestry data served to the
 * app, now FROM THE CANONICAL GRAPH (vendor-data/etymgraph.sqlite, built by
 * scripts/build-etymgraph.js) instead of raw sources:
 *
 *   trees/<xx>.json     one tree per headword. Node:
 *                       { l: language, t: term, k: inh|bor|der|aff|cmp|root
 *                         (kind of the edge FROM the child TO this node),
 *                         s: "e"|"k"|"y" source letters (edb/ket/etydb),
 *                         g: gloss (ancestors only), hw: headword when the
 *                         node resolves to an entry we carry, x: 1 when the
 *                         node's parentage is contested, d: descendant count
 *                         + n: canonical key when the node is pivotable via
 *                         the descendants index, c: [parent nodes…] }
 *                       ALL parent routes are included — contested ones
 *                       render with their marks; precedence orders, never
 *                       hides (TREES_PLAN.md v2).
 *   trees/_desc.json    reverse descendants index: canonical node key →
 *                       [English headwords that descend from it], for the
 *                       cousins pivot. Built by walking UP from every
 *                       headword (depth-capped) and crediting each ancestor
 *                       passed — cheap and exact for display purposes.
 *
 *   node scripts/build-trees.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const TREES = path.join(ROOT, "trees");
const DBP = path.join(ROOT, "vendor-data", "etymgraph.sqlite");

// Budgets sized for the entry CARD (renders ~14 rows), not the full forest —
// the uncapped graph denormalizes to ~522MB across 98k words, which is
// undeployable. The massive-tree view gets a normalized node store later.
const MAX_DEPTH = 8, MAX_NODES = 24, MAX_PARENTS = 3, DESC_DEPTH = 5, DESC_CAP = 40;
const RANK_GATE = 150000; // only ship trees for words this common (or better)
const DESC_MIN = 3;       // pivot chips only where 3+ of our words descend
const SRC_LETTER = { edb: "e", ket: "k", etydb: "y" };
const KIND_RANK = { inh: 0, bor: 1, der: 2, cmp: 3, aff: 4, root: 5 };

if (!fs.existsSync(DBP)) { process.stderr.write("run scripts/build-etymgraph.js first\n"); process.exit(1); }
const db = new DatabaseSync(DBP, { readOnly: true });

// word ranks for ordering descendant lists
const rank = new Map();
const ranksPath = path.join(ROOT, "review", "ranks.tsv");
if (fs.existsSync(ranksPath)) {
  for (const line of fs.readFileSync(ranksPath, "utf8").split("\n").slice(1)) {
    const i = line.lastIndexOf("\t");
    if (i > 0) rank.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
}
const rankOf = (w) => (rank.has(w) ? rank.get(w) : 9e6);

// ---- load graph into memory (2M nodes / ~3M edges is fine here) ----
process.stderr.write("loading graph…\n");
const nodes = new Map(); // id -> {lang, term, norm, gloss, headword, contested}
for (const r of db.prepare("SELECT id, lang, term, norm, gloss, headword, contested FROM node").all()) {
  nodes.set(r.id, r);
}
const up = new Map(); // child id -> [{parent, kind, srcs:Set}]
for (const r of db.prepare("SELECT child, parent, kind, src FROM edge").all()) {
  let list = up.get(r.child);
  if (!list) up.set(r.child, (list = []));
  let e = list.find((x) => x.parent === r.parent && x.kind === r.kind);
  if (!e) { e = { parent: r.parent, kind: r.kind, srcs: new Set() }; list.push(e); }
  e.srcs.add(SRC_LETTER[r.src] || "?");
}
db.close();
process.stderr.write("graph: " + nodes.size + " nodes, edge lists for " + up.size + " children\n");

// ---- descendants index: walk up from every headword, credit ancestors ----
process.stderr.write("crediting ancestors…\n");
const desc = new Map(); // ancestor id -> Set(headword)
const headwordNodes = [];
for (const [id, n] of nodes) if (n.headword) headwordNodes.push(id);
for (const id of headwordNodes) {
  const hw = nodes.get(id).headword;
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < DESC_DEPTH && frontier.length; d++) {
    const next = [];
    for (const c of frontier) {
      for (const e of up.get(c) || []) {
        if (seen.has(e.parent)) continue;
        seen.add(e.parent);
        let s = desc.get(e.parent);
        if (!s) desc.set(e.parent, (s = new Set()));
        s.add(hw);
        next.push(e.parent);
      }
    }
    frontier = next;
  }
}
let pivotable = 0;
for (const s of desc.values()) if (s.size >= 2) pivotable++;
process.stderr.write("ancestors credited: " + desc.size + " (" + pivotable + " with 2+ descendants)\n");

// ---- per-headword tree ----
function buildTree(rootId) {
  const budget = { n: 0 };
  const onPath = new Set();
  const expanded = new Set(); // a shared ancestor expands once; later visits are leaf refs
  function walk(id, kind, srcs, depth) {
    if (budget.n >= MAX_NODES || depth > MAX_DEPTH || onPath.has(id)) return null;
    const n = nodes.get(id);
    if (!n) return null;
    budget.n++;
    const already = expanded.has(id);
    expanded.add(id);
    const out = { l: n.lang, t: n.term };
    if (kind) out.k = kind;
    // source attribution: omit the default single-source "e" (etymology-db)
    if (srcs) { const s = [...srcs].sort().join(""); if (s !== "e") out.s = s; }
    if (n.gloss && depth > 0) out.g = String(n.gloss).split(/[;,(]/)[0].trim().slice(0, 50);
    if (n.headword && depth > 0) out.hw = n.headword;
    if (n.contested) out.x = 1;
    // pivot marker only — the client recomputes the canonical key from l+t
    const dset = desc.get(id);
    if (dset && dset.size >= DESC_MIN) out.d = dset.size;
    // PIE is the deepest ancestor the app shows (ETYMOLOGY_PRINCIPLES.md);
    // edges between PIE roots are reconstruction-internal cross-references,
    // not ancestry a reader should walk.
    const terminal = already || n.lang === "Proto-Indo-European";
    const parents = terminal ? [] : (up.get(id) || []).slice().sort((a, b) =>
      (b.srcs.size - a.srcs.size) || ((KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)))
      .slice(0, MAX_PARENTS);
    onPath.add(id);
    const kids = [];
    for (const e of parents) {
      const k = walk(e.parent, e.kind, e.srcs, depth + 1);
      if (k) kids.push(k);
    }
    onPath.delete(id);
    if (kids.length) out.c = kids;
    return out;
  }
  return walk(rootId, null, null, 0);
}

const byShard = new Map();
let total = 0;
for (const id of headwordNodes) {
  if (!(up.get(id) || []).length) continue; // no ancestry — no tree
  const n = nodes.get(id);
  if (rankOf(n.headword) >= RANK_GATE) continue; // long-tail words wait for the node store
  const t = buildTree(id);
  if (!t || !t.c) continue;
  const sk = n.headword.slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(sk)) continue;
  if (!byShard.has(sk)) byShard.set(sk, {});
  byShard.get(sk)[n.headword] = t;
  total++;
}

fs.mkdirSync(TREES, { recursive: true });
for (const old of fs.readdirSync(TREES).filter((x) => x.endsWith(".json"))) fs.unlinkSync(path.join(TREES, old));
let bytes = 0;
for (const [sk, obj] of byShard) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  const body = Object.keys(sorted).map((k) => JSON.stringify(k) + ":" + JSON.stringify(sorted[k]));
  const s = "{\n" + body.join(",\n") + "\n}";
  JSON.parse(s);
  fs.writeFileSync(path.join(TREES, sk + ".json"), s);
  bytes += s.length;
}

// ---- descendants index file ----
const idx = {};
for (const [aid, set] of desc) {
  if (set.size < DESC_MIN) continue;
  const n = nodes.get(aid);
  const words = [...set].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, DESC_CAP);
  idx[n.norm] = words;
}
// shard the pivot index by the first character of the folded TERM (the part
// after "lang|"), so the client fetches a small slice on first pivot tap
const idxShards = new Map();
for (const [key, words] of Object.entries(idx)) {
  const term = key.slice(key.indexOf("|") + 1);
  let c = (term[0] || "_").toLowerCase();
  if (!/^[a-z]$/.test(c)) c = "_";
  if (!idxShards.has(c)) idxShards.set(c, {});
  idxShards.get(c)[key] = words;
}
let idxBytes = 0;
for (const [c, obj] of idxShards) {
  const s = JSON.stringify(obj);
  fs.writeFileSync(path.join(TREES, "_desc-" + c + ".json"), s);
  idxBytes += s.length;
}

process.stderr.write("trees/: " + total + " word trees across " + byShard.size + " shards, " +
  (bytes / 1048576).toFixed(1) + " MB | desc index: " + Object.keys(idx).length + " pivot nodes in " +
  idxShards.size + " shards, " + (idxBytes / 1048576).toFixed(1) + " MB\n");

for (const w of ["about", "december", "solipsism", "effects"]) {
  const sk = w.slice(0, 2);
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(TREES, sk + ".json"), "utf8"));
    if (obj[w]) process.stderr.write("  " + w + ": " + JSON.stringify(obj[w]).slice(0, 260) + "\n");
  } catch (e) {}
}
