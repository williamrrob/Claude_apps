#!/usr/bin/env node
/*
 * normalize-shards.js — rewrite every words/<xx>.json in the canonical
 * one-word-per-line format (see shard-format.js). One-time fix for the existing
 * mix of compact/pretty shards; safe to re-run (idempotent). Data is unchanged
 * (parse → re-serialize); only whitespace between words changes.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { stringifyShard } = require("./shard-format.js");

const WORDS_DIR = path.join(__dirname, "..", "words");
const files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json"));
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
