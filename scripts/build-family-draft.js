#!/usr/bin/env node
/*
 * build-family-draft.js — draft/refresh a family/<root>.json tree from data.
 *
 * Automates the hand step between family-candidates.js (membership) and
 * build-family.js (apply): places every family member under a derivational
 * PARENT (nearest base reachable by stripping one affix), preserving the curated
 * structure. Regions stay editorial — embedding clustering proved weak, so new
 * members land in an "unsorted" region for a human to file via editor.html.
 *
 * PROVENANCE: by:user placements/regions are kept verbatim; by:assistant ones are
 * refreshed; new members are added by:assistant. Inflections already collapse
 * globally (build-inflections.js), so they are pulled into `collapse` here too.
 *
 * Members = entries whose `root` field is <rootId> (set by build-family) plus any
 * word already placed/collapsed in the existing tree.
 *
 *   node scripts/build-family-draft.js <rootId> [--apply]   (default rootId: scrib)
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), WORDS = path.join(ROOT, "words"), FAMDIR = path.join(ROOT, "family");
const arg = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "scrib";
const APPLY = process.argv.includes("--apply");
const NOW = new Date().toISOString();

// load shards once (entry references the live shard object, so field edits persist)
const entry = {}, shardOf = {}, shards = {};
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  shards[f] = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const w of Object.keys(shards[f])) { entry[w] = shards[f][w]; shardOf[w] = f; }
}
const TOUCH = {};
// "all" = every curated family file (skip the non-tree helper files)
const SKIP = /^(variants|inflections|inflections_conservative|collections)$/;
const roots = arg === "all"
  ? fs.readdirSync(FAMDIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((r) => !SKIP.test(r))
  : [arg];

let totalNew = 0, totalWired = 0;
for (const rootId of roots) processRoot(rootId);
if (APPLY) for (const f of Object.keys(TOUCH)) fs.writeFileSync(path.join(WORDS, f), JSON.stringify(shards[f]));
console.log("\nTOTAL across " + roots.length + " root(s): " + totalNew + " new members placed, " + totalWired + " members wired (root/family set)");

function processRoot(rootId) {
const FAM = path.join(FAMDIR, rootId + ".json");
const prev = fs.existsSync(FAM) ? JSON.parse(fs.readFileSync(FAM, "utf8")) : null;

// ---- membership ----
const members = new Set();
for (const w of Object.keys(entry)) if (entry[w].root === rootId) members.add(w);
if (prev) { for (const p of prev.placements || []) members.add(p.w); for (const k of Object.keys(prev.collapse || {})) members.add((prev.collapse[k] || {}).l); }
members.delete(undefined);
const has = (w) => members.has(w);

// ---- derivational parent: nearest base reachable by stripping one affix ----
const SUF = ["ation", "ician", "tion", "sion", "ion", "ive", "ory", "or", "er", "ed", "ing", "able", "ible", "al", "ity", "ism", "ist", "ure", "ment", "ness", "ly", "s", "y"];
const PRE = ["non", "un", "in", "im", "ir", "il", "circum", "trans", "super", "sub", "pro", "pre", "re", "de", "con", "ad", "ex", "inter", "ob", "per", "se", "a"];
function parentOf(w) {
  const c = [];
  for (const s of SUF) if (w.endsWith(s) && w.length - s.length >= 3) { const b = w.slice(0, -s.length); for (const v of [b, b + "e", b.replace(/t$/, "be")]) if (has(v) && v !== w) c.push(v); }
  for (const p of PRE) if (w.startsWith(p) && w.length - p.length >= 4) { const b = w.slice(p.length); if (has(b) && b !== w) c.push(b); }
  c.sort((a, b) => b.length - a.length);
  return c[0] || null;
}

// ---- build placements (preserve human, refresh assistant, add new) ----
const placed = new Map();
let kept = 0;
// Preserve ALL existing placements verbatim — the curated parents are better than
// our affix-strip guess, so we never refresh them; we only ADD new members.
for (const p of (prev && prev.placements) || []) { placed.set(p.w, p); if (p.by === "user") kept++; }
let added = 0, pMatch = 0, pBoth = 0;
const regionOf = (w) => { const par = parentOf(w); const pp = par && placed.get(par); return (pp && pp.region) || "unsorted"; };
for (const w of members) {
  if (placed.has(w)) continue;
  // skip pure inflections — they live in `collapse`, not as tree nodes
  if (entry[w] && entry[w].rel && /\bof$/.test(entry[w].rel.t || "")) continue;
  placed.set(w, { w, s: null, region: regionOf(w), parent: parentOf(w), by: "assistant", at: NOW });
  added++;
}
// parent agreement vs the previous tree (validation signal)
for (const p of (prev && prev.placements) || []) { if (p.parent != null) { pBoth++; if ((placed.get(p.w) || {}).parent === p.parent) pMatch++; } }

// ---- collapse: inflected forms pointing at a member (from the global rel layer) ----
const collapse = Object.assign({}, (prev && prev.collapse) || {});
for (const w of Object.keys(entry)) {
  const r = entry[w].rel;
  if (r && r.l && has(r.l) && /\bof$/.test(r.t || "") && !/variant|spelling|form/i.test(r.t)) {
    if (!collapse[w] || collapse[w].by !== "user") collapse[w] = { l: r.l, t: r.t, by: "assistant", at: NOW };
  }
}

const regions = (prev && prev.regions) ? prev.regions.slice() : [];
if ([...placed.values()].some((p) => p.region === "unsorted") && !regions.some((r) => r.id === "unsorted"))
  regions.push({ id: "unsorted", label: "Unsorted", gloss: "newly added — file me", by: "assistant", at: NOW });

const out = {
  _note: (prev && prev._note) || "Family tree for the " + rootId + " family. by:user entries are preserved by regenerators.",
  root: rootId, rootLabel: (prev && prev.rootLabel) || rootId, rootGloss: (prev && prev.rootGloss) || "",
  regions, placements: [...placed.values()], collapse, meta: { version: (prev && prev.meta && prev.meta.version) || 1, updated: NOW },
};

// wire members into the app: set root + family on any placed member missing it
let wired = 0;
if (APPLY) {
  const famRel = "family/" + rootId + ".json";
  for (const p of out.placements) {
    const e = entry[p.w];
    if (!e || e.family) continue;                 // don't override a curated family pointer
    e.root = rootId; e.family = famRel; wired++; TOUCH[shardOf[p.w]] = true;
  }
}
totalNew += added; totalWired += wired;
console.log("[" + rootId + "] members " + members.size + " | placements " + out.placements.length +
  " (user " + kept + ", new " + added + ") | collapse " + Object.keys(collapse).length +
  " | parents " + pMatch + "/" + pBoth + (APPLY ? " | wired " + wired : ""));
if (added && roots.length <= 2) console.log("  new: " + [...placed.values()].filter((p) => p.by === "assistant" && p.at === NOW).slice(0, 12).map((p) => p.w + (p.parent ? "<" + p.parent : "")).join(", "));
if (APPLY && added > 0) fs.writeFileSync(FAM, JSON.stringify(out, null, 1)); // only rewrite changed trees
} // end processRoot
