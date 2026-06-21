// Build eras.json from the usage data: for each quarter-century bucket, the words
// that *peaked* in that era, ranked by how sharply concentrated they are there
// (a word used almost only in 1800–1824 is more era-defining than a flat one).
//
//   eras.json : { "0": ["word", …], … "20": [ … ] }   // index i -> years 1500+25i
//
// Run after scripts/build-usage.js:  node scripts/build-eras.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const USAGE = path.join(ROOT, "usage");
const NB = 21, TOP = 100;

const buckets = Array.from({ length: NB }, () => []);

for (const f of fs.readdirSync(USAGE)) {
  if (!f.endsWith(".json")) continue;
  const sh = JSON.parse(fs.readFileSync(path.join(USAGE, f), "utf8"));
  for (const w of Object.keys(sh)) {
    if (!/^[a-z]{3,14}$/.test(w)) continue;       // skip junk / very long
    const a = sh[w];
    if (!a || a.length !== NB) continue;
    let peak = 0;
    for (let i = 1; i < NB; i++) if (a[i] > a[peak]) peak = i;
    if (a[peak] < 60) continue;                    // needs a real crest
    // sharpness = peak minus the strongest *other* bucket (0–100)
    let other = 0;
    for (let i = 0; i < NB; i++) if (i !== peak && a[i] > other) other = a[i];
    const sharp = a[peak] - other;
    buckets[peak].push({ w: w, s: sharp });
  }
}

const out = {};
buckets.forEach((list, i) => {
  list.sort((x, y) => y.s - x.s || x.w.length - y.w.length || x.w.localeCompare(y.w));
  out[i] = list.slice(0, TOP).map((x) => x.w);
});

const dest = path.join(ROOT, "eras.json");
fs.writeFileSync(dest, JSON.stringify(out));
const counts = Object.keys(out).map((i) => out[i].length);
console.log("eras.json written:", (fs.statSync(dest).size / 1024).toFixed(1), "KB");
console.log("words per era:", counts.join(","));
console.log("sample 1800s:", (out[12] || []).slice(0, 12).join(", "));
