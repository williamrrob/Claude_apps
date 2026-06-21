// Build a compact, built-in word-usage history from Google Books Ngrams.
//
// For each word in our vocabulary we fetch its yearly relative-frequency series
// (1500–2019) from the Ngrams JSON endpoint — batched, many words per request —
// then aggregate to 25-year (quarter-century) buckets and quantize each bucket to
// 0–100 of the word's own peak. The result ships as usage/<xx>.json so the chart
// loads alongside the word with no extra lag. Finer detail can be fetched live
// later (the endpoint is not CORS-enabled, so that path needs a proxy).
//
//   usage/<xx>.json :  { "<word>": [b0, b1, … b20], … }   // 21 quarter-centuries
//                       index i covers years (1500+25i) .. (1524+25i)
//
// Usage:
//   node scripts/build-usage.js --limit 60        # quick sample to stdout
//   node scripts/build-usage.js                   # full build -> usage/
//   node scripts/build-usage.js --shard ph        # just one shard

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const OUT = path.join(ROOT, "usage");

const Y0 = 1500, Y1 = 2019, NYEARS = Y1 - Y0 + 1; // 520 yearly points
const BUCKET = 25, NB = Math.ceil(NYEARS / BUCKET); // 21 buckets
const BATCH = 100;         // words per Ngrams request
const CONCURRENCY = 5;     // parallel requests
const PAUSE = 120;         // ms between launching requests (be polite)
const CORPUS = "en-2019";

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const LIMIT = arg("--limit") ? parseInt(arg("--limit"), 10) : 0;
const ONLY_SHARD = arg("--shard");
const SAMPLE = LIMIT > 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 rootwork-build" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// 520 yearly points -> 21 quarter-century buckets, normalised to the word's peak.
function bucketize(ts) {
  if (!ts || ts.length < NYEARS) return null;
  const sums = new Array(NB).fill(0);
  for (let i = 0; i < NYEARS; i++) sums[Math.floor(i / BUCKET)] += ts[i];
  let max = 0;
  for (const s of sums) if (s > max) max = s;
  if (max <= 0) return null; // no recorded usage
  return sums.map((s) => Math.round((s / max) * 100));
}

async function fetchBatch(words) {
  const url = "https://books.google.com/ngrams/json?content=" +
    words.map(encodeURIComponent).join(",") +
    "&year_start=" + Y0 + "&year_end=" + Y1 + "&corpus=" + CORPUS + "&smoothing=0";
  const arr = await fetchJSON(url);
  const out = {};
  if (Array.isArray(arr)) for (const s of arr) {
    if (s && s.ngram && s.timeseries) { const b = bucketize(s.timeseries); if (b) out[s.ngram] = b; }
  }
  return out;
}

function loadVocab() {
  const files = fs.readdirSync(WORDS).filter((f) => f.endsWith(".json") && (!ONLY_SHARD || f === ONLY_SHARD + ".json"));
  const byShard = {};
  for (const f of files) {
    const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
    const key = f.slice(0, 2);
    byShard[key] = Object.keys(sh).filter((w) => /^[a-z]+$/.test(w));
  }
  return byShard;
}

// Quick sample mode: a few words straight to stdout, no files.
async function sample() {
  const byShard = loadVocab();
  let printed = 0;
  for (const key of Object.keys(byShard).sort()) {
    for (let i = 0; i < byShard[key].length && printed < LIMIT; i += BATCH) {
      const res = await fetchBatch(byShard[key].slice(i, i + BATCH));
      console.log(JSON.stringify(res, null, 1));
      printed += BATCH;
    }
    if (printed >= LIMIT) break;
  }
}

// Full build: a concurrency pool over all batches, resumable (skips words already
// present in usage/<xx>.json), writing each shard as its last batch completes.
async function build() {
  fs.mkdirSync(OUT, { recursive: true });
  const byShard = loadVocab();
  const tasks = [];                 // { key, words }
  const acc = {};                   // key -> result object (seeded from existing file)
  const pending = {};               // key -> batches left to finish
  for (const key of Object.keys(byShard).sort()) {
    const existPath = path.join(OUT, key + ".json");
    let existing = {};
    if (fs.existsSync(existPath)) { try { existing = JSON.parse(fs.readFileSync(existPath, "utf8")); } catch {} }
    acc[key] = existing;
    const todo = byShard[key].filter((w) => !(w in existing));
    const chunks = [];
    for (let i = 0; i < todo.length; i += BATCH) chunks.push(todo.slice(i, i + BATCH));
    pending[key] = chunks.length;
    if (!chunks.length) continue;
    chunks.forEach((words) => tasks.push({ key, words }));
  }

  const totalBatches = tasks.length;
  let i = 0, done = 0, withData = 0;
  process.stderr.write(`tasks: ${totalBatches} batches across ${Object.keys(pending).length} shards\n`);

  async function worker() {
    while (i < tasks.length) {
      const t = tasks[i++];
      await sleep(PAUSE);
      const res = await fetchBatch(t.words);
      Object.assign(acc[t.key], res);
      done++; withData += Object.keys(res).length;
      if (--pending[t.key] === 0 && Object.keys(acc[t.key]).length) {
        fs.writeFileSync(path.join(OUT, t.key + ".json"), JSON.stringify(acc[t.key]));
      }
      if (done % 20 === 0) process.stderr.write(`  ${done}/${totalBatches} batches, +${withData} words with data\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write(`done: ${done} batches, ${withData} words with usage data\n`);
}

(SAMPLE ? sample() : build());
