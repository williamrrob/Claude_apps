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

// A small blocklist so a discovery feature never surfaces crude terms.
const BLOCK = new Set(("clit dildo dominatrix bollocks cunt fuck shit dick cock pussy " +
  "wank twat slut whore boob tit arse").split(" "));

const buckets = Array.from({ length: NB }, () => []);

for (const f of fs.readdirSync(USAGE)) {
  if (!f.endsWith(".json")) continue;
  let sh;
  try { sh = JSON.parse(fs.readFileSync(path.join(USAGE, f), "utf8")); } catch { continue; }
  for (const w of Object.keys(sh)) {
    if (!/^[a-z]{3,14}$/.test(w) || BLOCK.has(w)) continue; // skip junk / crude / very long
    const a = sh[w];
    if (!a || a.length !== NB) continue;
    // Breadth filter: a word used in only one bucket is almost always rare/OCR
    // noise. Requiring usage across many eras keeps recognizable words and drops
    // the junk (so we surface "crinoline" / "telegraphy", not "chafeweed").
    let nz = 0, sum = 0, peak = 0;
    for (let i = 0; i < NB; i++) { if (a[i] > 0) nz++; sum += a[i]; if (a[i] > a[peak]) peak = i; }
    if (nz < 10) continue;
    // distinctiveness = how far the peak rises above the word's own average
    const distinct = a[peak] - sum / NB;
    buckets[peak].push({ w: w, s: distinct });
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
