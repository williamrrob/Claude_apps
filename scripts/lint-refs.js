#!/usr/bin/env node
/*
 * lint-refs.js — report relation targets that are not headwords in the dictionary.
 *
 * Synonym/antonym/related lists often point to words we don't carry as entries.
 * That isn't necessarily a bug (the link still conveys meaning), but the most
 * frequently-referenced missing targets are strong candidates for NEW headwords,
 * and one-off danglers can flag typos. This is a read-only report — it changes
 * nothing.
 *
 *   node scripts/lint-refs.js [--kind syn|ant|rel|all] [--limit 40]
 *
 * Reads rootwork.sqlite (run `npm run build:sqlite` first).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB = path.join(__dirname, "..", "rootwork.sqlite");
if (!fs.existsSync(DB)) { process.stderr.write("rootwork.sqlite missing — run: npm run build:sqlite\n"); process.exit(1); }
const db = new DatabaseSync(DB, { readOnly: true });

const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const KIND = arg("--kind", "all");
const LIMIT = parseInt(arg("--limit", "40"), 10) || 40;
const KINDS = KIND === "all" ? ["syn", "ant", "rel"] : [KIND];

// headword set (case-insensitive — relation targets aren't always same-cased)
const heads = new Set();
for (const r of db.prepare("SELECT word FROM words").all()) heads.add(r.word.toLowerCase());

let totalLinks = 0, totalDangling = 0;
const perKind = {};
const missCount = new Map(); // target -> times referenced (dangling), any kind

for (const kind of KINDS) {
  const rows = db.prepare("SELECT target FROM rel WHERE kind=?").all(kind);
  let dangling = 0;
  for (const { target } of rows) {
    totalLinks++;
    if (!heads.has(String(target).toLowerCase())) {
      dangling++; totalDangling++;
      const k = String(target);
      missCount.set(k, (missCount.get(k) || 0) + 1);
    }
  }
  perKind[kind] = { links: rows.length, dangling };
}

const ranked = [...missCount.entries()].sort((a, b) => b[1] - a[1]);

const L = [];
L.push("LINT REFS — relation targets missing from the dictionary (read-only)");
L.push("=".repeat(60));
for (const kind of KINDS) {
  const k = perKind[kind];
  const pct = k.links ? ((k.dangling / k.links) * 100).toFixed(1) : "0.0";
  L.push(kind + ": " + k.dangling + " / " + k.links + " links dangle (" + pct + "%)");
}
L.push("distinct missing targets: " + ranked.length);
L.push("");
L.push("---- top " + Math.min(LIMIT, ranked.length) + " most-referenced missing targets (headword candidates) ----");
for (const [t, n] of ranked.slice(0, LIMIT)) L.push(String(n).padStart(4) + "  " + t);
process.stdout.write(L.join("\n") + "\n");
