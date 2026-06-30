#!/usr/bin/env node
/*
 * normalize-shards.js — rewrite every words/<xx>.json in the canonical
 * one-word-per-line format (see shard-format.js). One-time fix for the existing
 * mix of compact/pretty shards; safe to re-run (idempotent). Data is unchanged
 * (parse → re-serialize); only whitespace between words changes.
 *
 * --check: validate-only, no writes. Exits 1 if any shard fails to parse as
 * JSON. Pass specific filenames to scope the check to just the shards you
 * touched, e.g.:
 *   node scripts/normalize-shards.js --check li.json hi.json
 * With no filenames, checks every shard.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { stringifyShard } = require("./shard-format.js");

const WORDS_DIR = path.join(__dirname, "..", "words");
const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const named = argv.filter((a) => !a.startsWith("--"));
const files = (named.length ? named : fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")));

if (checkOnly) {
  const bad = [];
  for (const f of files) {
    const p = path.join(WORDS_DIR, f);
    try { JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { bad.push(f + ": " + e.message); }
  }
  if (bad.length) {
    bad.forEach((b) => console.error("INVALID " + b));
    console.error(`${bad.length}/${files.length} shard(s) failed to parse`);
    process.exit(1);
  }
  console.error(`${files.length} shard(s) OK`);
  process.exit(0);
}

let changed = 0, words = 0;
for (const f of files) {
  const p = path.join(WORDS_DIR, f);
  const raw = fs.readFileSync(p, "utf8");
  const obj = JSON.parse(raw);
  words += Object.keys(obj).length;
  const out = stringifyShard(obj);
  if (out !== raw) { fs.writeFileSync(p, out); changed++; }
}
console.error(`normalized ${changed}/${files.length} shards (${words} words) to one-word-per-line`);
