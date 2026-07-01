#!/usr/bin/env node
/*
 * triage-queue.js — cluster the review queue by shared engine misfire, so one
 * human/assistant decision resolves dozens of words instead of one.
 *
 * Reads review/QUEUE.tsv (from build-review-ledger.js), re-decomposes each
 * word, and groups by SIGNATURE: the ordered list of known morphemes the
 * engine matched (ids), with a position marker when an affix matched at an
 * impossible spot (suffix at the start, prefix at the end). Words sharing a
 * signature almost always share the same wrong split for the same reason —
 * e.g. `suffix:s-plural@0 + suffix:ing` is the whole "s… word parsed as
 * plural-s + …ing" family.
 *
 *   node scripts/triage-queue.js                 # table: count · signature · samples
 *   node scripts/triage-queue.js --top 30        # show only the 30 biggest groups
 *   node scripts/triage-queue.js --emit <sig>    # list every queued word in that group
 *   node scripts/triage-queue.js --emit <sig> --whole
 *       # emit {"word":[{"s":"word","k":"word"}], ...} for the group — pipe into
 *       #   node scripts/word.js bulk-field b
 *       # to mark the whole group as unanalyzable wholes in ONE write.
 *
 * The judgment (is this group really all-wrong? whole vs a curated split?)
 * stays with the reviewer; this script just makes acting on it one command.
 * Record decisions in review/decisions.log as usual.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

global.MORPHEMES = require(path.join(ROOT, "data.js")).MORPHEMES;
const engine = require(path.join(ROOT, "engine.js"));

const args = process.argv.slice(2);
const TOP = args.includes("--top") ? Number(args[args.indexOf("--top") + 1]) || 50 : 50;
const EMIT = args.includes("--emit") ? args[args.indexOf("--emit") + 1] : null;
const WHOLE = args.includes("--whole");

const queuePath = path.join(ROOT, "review", "QUEUE.tsv");
if (!fs.existsSync(queuePath)) {
  process.stderr.write("triage-queue: review/QUEUE.tsv not found — run scripts/build-review-ledger.js first\n");
  process.exit(1);
}
const rows = fs.readFileSync(queuePath, "utf8").split("\n").slice(1)
  .filter((l) => l.trim()).map((l) => l.split("\t")[0]);

function signature(word) {
  let r;
  try { r = engine.decompose(word); } catch (e) { return "engine-error"; }
  const parts = r.parts || [];
  const sig = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.id) continue; // stems/unknowns are word-specific, not part of the pattern
    let tag = p.kind + ":" + p.id;
    if (p.kind === "suffix" && i === 0) tag += "@0";                 // suffix at the start
    if (p.kind === "prefix" && i === parts.length - 1) tag += "@end"; // prefix at the end
    sig.push(tag);
  }
  return sig.join(" + ") || "(no known parts)";
}

const groups = new Map(); // sig -> [words]
for (const w of rows) {
  const s = signature(w);
  if (!groups.has(s)) groups.set(s, []);
  groups.get(s).push(w);
}

if (EMIT) {
  const words = groups.get(EMIT);
  if (!words) {
    process.stderr.write("triage-queue: no group with signature " + JSON.stringify(EMIT) + "\n");
    process.exit(1);
  }
  if (WHOLE) {
    const out = {};
    for (const w of words) out[w] = [{ s: w, k: "word" }];
    process.stdout.write(JSON.stringify(out) + "\n");
    process.stderr.write(words.length + " word(s) — pipe into: node scripts/word.js bulk-field b\n");
  } else {
    process.stdout.write(words.join("\n") + "\n");
    process.stderr.write("(" + words.length + " word(s) in group)\n");
  }
  process.exit(0);
}

const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
process.stderr.write(rows.length + " queued words fall into " + sorted.length + " signature groups; top " + Math.min(TOP, sorted.length) + ":\n\n");
for (const [sig, words] of sorted.slice(0, TOP)) {
  const sample = words.slice(0, 8).join(", ") + (words.length > 8 ? ", …" : "");
  process.stdout.write(String(words.length).padStart(5) + "  " + sig + "\n       " + sample + "\n");
}
