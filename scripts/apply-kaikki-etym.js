#!/usr/bin/env node
/*
 * apply-kaikki-etym.js — write the structured Wiktionary data
 * (vendor-data/kaikki-etym.jsonl, from import-kaikki-etym.js) onto the word
 * shards, through scripts/word.js bulk-field (which validates and bumps DATA_V):
 *
 *   e   the full etymology, only where the stored one was clipped ("…") or
 *       carries a flattened etymon-tree blob
 *   wp  Wiktionary's own surface analysis (af/prefix/suffix/compound/surf)
 *   ss  synonym → the gloss of this word's sense it belongs to (only links
 *       whose sense is known; flat synonym lists stay in `s`)
 *
 *   node scripts/apply-kaikki-etym.js            dry run: counts + samples
 *   node scripts/apply-kaikki-etym.js --apply
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

const db = new DatabaseSync(path.join(ROOT, "rootwork.sqlite"), { readOnly: true });
const cur = new Map(db.prepare("select word, ety from words").all().map((r) => [r.word, r.ety || ""]));
const blobby = (e) => /^(?:Proto-|Etymology tree)|\S(?:bor|inh|der|lbor|cal)\.\s/.test(e.slice(0, 400));

const E = {}, WP = {}, SS = {};
for (const line of fs.readFileSync(path.join(ROOT, "vendor-data", "kaikki-etym.jsonl"), "utf8").split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (!cur.has(r.w)) continue;
  const old = cur.get(r.w);
  if (r.e && r.e.length > 20 && (/…/.test(old) || blobby(old)) && !/…/.test(r.e)) E[r.w] = r.e;
  if (r.pa && r.pa.length >= 2) WP[r.w] = r.pa;
  if (r.ss) {
    const m = {};
    for (const [syn, g] of Object.entries(r.ss)) if (g) m[syn] = g.length > 160 ? g.slice(0, 157) + "…" : g;
    if (Object.keys(m).length) SS[r.w] = m;
  }
}
const n = (o) => Object.keys(o).length;
process.stderr.write(`e: ${n(E)} restored · wp: ${n(WP)} · ss: ${n(SS)}\n`);
const sample = (o, k) => Object.keys(o).slice(0, k).forEach((w) => process.stderr.write(`  ${w}: ${JSON.stringify(o[w]).slice(0, 160)}\n`));
sample(E, 3); sample(WP, 4); sample(SS, 4);
if (!APPLY) { process.stderr.write("(dry run — pass --apply to write)\n"); process.exit(0); }
const write = (field, obj) => {
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i += 20000) {
    const part = {}; keys.slice(i, i + 20000).forEach((k) => (part[k] = obj[k]));
    execFileSync("node", [path.join(__dirname, "word.js"), "bulk-field", field], { input: JSON.stringify(part), stdio: ["pipe", "inherit", "inherit"], maxBuffer: 1 << 30 });
  }
};
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
for (const [f, o] of [["e", E], ["wp", WP], ["ss", SS]]) if (!only || only.split(",").includes(f)) write(f, o);
