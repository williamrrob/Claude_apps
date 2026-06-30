#!/usr/bin/env node
/*
 * bump-version.js — bump the cache-busting version for a changed file, in
 * whichever of the two places gates it (see app.js's own comment on DATA_V).
 *
 * Two independent schemes:
 *   1. `?v=N` query strings on <script>/<link> tags in index.html — gate the
 *      file's OWN content (styles.css, app.js, engine.js, data.js).
 *   2. `const DATA_V = "N";` inside app.js — gates every fetched JSON data
 *      file (words/*.json, morpheme-index.json, roots.json, etc.). Editing
 *      ANY words/*.json (or other DATA_V-gated file) needs this bumped, not
 *      the app.js script tag.
 *
 * Usage:
 *   node scripts/bump-version.js styles            # styles.css?v=
 *   node scripts/bump-version.js app                # app.js?v=
 *   node scripts/bump-version.js engine             # engine.js?v=
 *   node scripts/bump-version.js data               # data.js?v= (the vendored morpheme file)
 *   node scripts/bump-version.js datav              # DATA_V constant in app.js (words/*.json etc.)
 *   node scripts/bump-version.js app datav          # bump more than one target in one call
 *   node scripts/bump-version.js all                # bump every target
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const APP = path.join(ROOT, "app.js");

const TAG_TARGETS = { styles: "styles.css", app: "app.js", engine: "engine.js", data: "data.js" };

function bumpTag(filename) {
  let html = fs.readFileSync(INDEX, "utf8");
  const re = new RegExp("(" + filename.replace(".", "\\.") + "\\?v=)(\\d+)");
  const m = html.match(re);
  if (!m) { process.stderr.write("bump-version: no ?v= tag found for " + filename + " in index.html\n"); return null; }
  const next = String(Number(m[2]) + 1);
  html = html.replace(re, "$1" + next);
  fs.writeFileSync(INDEX, html);
  return { from: m[2], to: next };
}

function bumpDataV() {
  let src = fs.readFileSync(APP, "utf8");
  const re = /(const DATA_V = ")(\d+)(";)/;
  const m = src.match(re);
  if (!m) { process.stderr.write("bump-version: DATA_V constant not found in app.js\n"); return null; }
  const next = String(Number(m[2]) + 1);
  src = src.replace(re, "$1" + next + "$3");
  fs.writeFileSync(APP, src);
  return { from: m[2], to: next };
}

const args = process.argv.slice(2).map(function (a) { return a.toLowerCase(); });
if (!args.length) {
  process.stderr.write("usage: bump-version.js [styles|app|engine|data|datav|all]...\n");
  process.exit(1);
}
const targets = args.includes("all") ? ["styles", "app", "engine", "data", "datav"] : args;

for (const t of targets) {
  if (t === "datav") {
    const r = bumpDataV();
    if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
  } else if (TAG_TARGETS[t]) {
    const r = bumpTag(TAG_TARGETS[t]);
    if (r) console.log(TAG_TARGETS[t] + "?v= (index.html): " + r.from + " -> " + r.to);
  } else {
    process.stderr.write("bump-version: unknown target \"" + t + "\" (try: styles app engine data datav all)\n");
    process.exit(1);
  }
}
