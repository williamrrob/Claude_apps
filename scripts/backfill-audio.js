#!/usr/bin/env node
/*
 * backfill-audio.js — add `au` (pronunciation audio URL) from Wiktionary
 * commons files captured in vendor-data/kaikki-rich.sqlite. Additive only:
 * never overwrites an existing au. Prefers mp3 over ogg (iOS Safari can't
 * play ogg), prefers US-tagged audio, one per word.
 *
 * au stores only the path AFTER the shared commons prefix (saves ~4MB across
 * shards); the app prepends AUDIO_BASE (see app.js) when playing.
 *
 *   node scripts/backfill-audio.js            # dry run
 *   node scripts/backfill-audio.js --apply    # write + bump DATA_V
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

const APPLY = process.argv.includes("--apply");

const db = new DatabaseSync(path.join(ROOT, "vendor-data", "kaikki-rich.sqlite"), { readOnly: true });
const best = new Map(); // word -> {url, score}
for (const r of db.prepare("SELECT word, audio_ogg, audio_mp3, tags FROM sound WHERE audio_mp3 IS NOT NULL OR audio_ogg IS NOT NULL").all()) {
  const url = r.audio_mp3 || r.audio_ogg;
  if (!url || !/^https:\/\/upload\.wikimedia\.org\//.test(url)) continue;
  let score = 0;
  if (r.audio_mp3) score += 2;
  const tags = String(r.tags || "").toLowerCase();
  if (tags.includes("us") || tags.includes("general-american")) score += 1;
  const prev = best.get(r.word);
  if (!prev || score > prev.score) best.set(r.word, { url, score });
}
db.close();

let candidates = 0, added = 0, touched = 0;
const samples = [];
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const p = path.join(WORDS, f);
  const sh = JSON.parse(fs.readFileSync(p, "utf8"));
  let dirty = false;
  for (const [w, rec] of Object.entries(sh)) {
    const b = best.get(w) || best.get(w.toLowerCase());
    if (!b) continue;
    candidates++;
    if (rec.au) continue;
    rec.au = b.url.replace("https://upload.wikimedia.org/wikipedia/commons/transcoded/", "");
    added++; dirty = true;
    if (samples.length < 6) samples.push(w + "  " + rec.au.slice(0, 80));
  }
  if (dirty && APPLY) { fs.writeFileSync(p, stringifyShard(sh)); JSON.parse(fs.readFileSync(p, "utf8")); touched++; }
}

console.log("BACKFILL-AUDIO " + (APPLY ? "APPLIED" : "DRY RUN"));
console.log("words with usable audio: " + candidates + " -> " + (APPLY ? "added" : "would add") + ": " + added);
for (const s of samples) console.log("  " + s);
if (APPLY) {
  console.log("shards written: " + touched);
  const { bumpDataV } = require("./version-lib.js");
  const r = bumpDataV();
  if (r) console.log("DATA_V (app.js): " + r.from + " -> " + r.to);
} else console.log("(dry run — pass --apply to write)");
