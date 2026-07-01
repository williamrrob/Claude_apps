#!/usr/bin/env node
/*
 * word.js — cheap, surgical edits to the word dictionary (words/<xx>.json).
 *
 * WHY: each shard is keyed by a word's first two letters and the common ones are
 * huge (co.json ≈ 1.8 MB). Reading a whole shard into an assistant's context just
 * to change one entry is enormously expensive. This CLI does the file I/O in a
 * subprocess, so an edit costs only the tokens of the command + the one entry —
 * not the megabyte shard. It is the intended interface for editing the dictionary.
 *
 * Entry shape (see README): { d:[{p,g,x?}], e, s:[..], a:[..], r:[..], i, rs, b, cl }
 *   d=definitions (p=part of speech, g=gloss, x=example), e=etymology,
 *   s=synonyms, a=antonyms, r=related, i=IPA, rs=respelling,
 *   b=curated breakdown override (see app.js chooseBreakdown), cl=cluster tags (see below).
 *
 * Usage:
 *   node scripts/word.js get <word>                 # print one entry (cheap read)
 *   node scripts/word.js has <word>                 # exit 0 if present, 1 if not
 *   node scripts/word.js set <word>      < entry.json   # create/replace whole entry (JSON on stdin)
 *   node scripts/word.js field <word> <k> < value.json  # set ONE field (JSON value on stdin)
 *   node scripts/word.js append <word> <k> < item.json  # push one item onto an array field (e.g. add a sense to `d` without clobbering the rest)
 *   node scripts/word.js rmfield <word> <k>         # delete one field
 *   node scripts/word.js rm <word>                  # delete the entry
 *   node scripts/word.js list <xx>                  # list words in a shard (keys only)
 *   node scripts/word.js missing <w1> <w2> ...      # check a whole candidate batch in one process
 *   node scripts/word.js bulk-set < entries.json    # write MANY new entries in one call: {"word1":{...},"word2":{...}}
 *   node scripts/word.js bulk-field <k> < values.json   # set the SAME field on MANY existing words: {"word1":<v1>,"word2":<v2>}
 *
 * Every write (set/field/append/rmfield/bulk-set/cluster) self-validates the
 * shard it touched, auto-runs the decomp false-positive check, and auto-bumps
 * DATA_V in app.js once on clean exit — no separate validate/check/bump steps
 * needed for the common case.
 *
 * Clusters: a lightweight tag connecting words that share a conceptual space
 * but NOT a root/morpheme (that's what family/<root>.json is for). Stored as
 * the `cl` field, an array of cluster-id strings, on each member word.
 *   node scripts/word.js cluster <clusterId> <word1> <word2> ...   # tag N words in one shot
 *   node scripts/word.js cluster-list <clusterId>                  # find every word tagged with it (scans all shards)
 *
 * Tips: pass JSON via a heredoc to avoid shell-quoting pain, e.g.
 *   node scripts/word.js field concord s <<'JSON'
 *   ["accord","agreement","harmony"]
 *   JSON
 *
 * The "add a thematic cluster" pipeline (as of 2026-06-30), and what's scripted:
 *   1. curate candidate words                                    — manual/editorial, stays manual
 *   2. `missing <words...>`                                       [done]
 *   3. draft + write each entry via `set`                         [done] (drafting content stays manual)
 *   4. flags engine false-positive splits (today's congee/exegete bug class)
 *      for review — runs AUTOMATICALLY after every `set`/`field`/`rmfield`
 *      (see checkWritten() below); `node scripts/check-decomp.js <word...>`
 *      or `--all` is still there for ad hoc/bulk checks
 *                                                                  [done, automatic]
 *   5. add a curated `b` override when step 4 flags a real bad parse
 *                                                                  [mechanism done, judgment manual]
 *   6. `cluster <id> <words...>` to tag the group                 [done]
 *   7. `node scripts/bump-version.js [styles|app|engine|data|datav|all]`
 *                                                                  [done — see bump-version.js]
 *   8. `node scripts/normalize-shards.js --check [files...]` validates JSON
 *                                                                  [done]
 *   9. verify live via preview_eval, then commit + push           [manual — needs judgment]
 *
 * Adding a new prefix/root/suffix to data.js (not just a word) is also
 * scripted end to end, including a scoped collision scan of the existing
 * dictionary: see `node scripts/add-root.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const WORDS_DIR = path.join(__dirname, "..", "words");
const FIELDS = new Set(["d", "e", "s", "a", "r", "i", "rs", "b", "bWhole", "cl", "vars", "forms", "rel"]);

function fail(msg) { process.stderr.write("word.js: " + msg + "\n"); process.exit(1); }

function shardKey(word) {
  const key = String(word || "").slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(key)) fail("word must start with two ascii letters: " + JSON.stringify(word));
  return key;
}
function shardPath(word) { return path.join(WORDS_DIR, shardKey(word) + ".json"); }

function readShard(p) {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { fail("could not parse " + p + ": " + e.message); }
}
// Stable write: one word per line (see shard-format.js). Key insertion order is
// preserved, so edits produce minimal diffs (only the touched word's line
// changes; new words are appended).
const { stringifyShard } = require("./shard-format.js");
const { bumpDataV } = require("./version-lib.js");
let didWriteWords = false;
function writeShard(p, obj) {
  fs.writeFileSync(p, stringifyShard(obj));
  // Self-validate: re-read what was just written so a corrupt shard never sits
  // silently on disk. Replaces having to remember a separate
  // `normalize-shards.js --check` call after every word.js-driven edit.
  try { JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { fail("wrote " + p + " but it failed to re-parse — this should never happen: " + e.message); }
  didWriteWords = true;
}
// DATA_V gates every words/*.json fetch (see app.js). Bumping it once per
// process, on clean exit, means any command that ends up writing a shard
// auto-invalidates the client cache — no separate bump-version.js call to
// remember. Multiple writes in one invocation (cluster, bulk-set) still only
// bump once; failed runs (fail() exits 1) never bump at all.
process.on("exit", function (code) {
  if (!didWriteWords || code !== 0) return;
  const r = bumpDataV();
  if (r) process.stderr.write("DATA_V (app.js): " + r.from + " -> " + r.to + "\n");
});

// Word-overlap similarity between two gloss texts, used by `append` to flag
// likely-redundant senses. Jaccard over normalized, stopword-stripped word
// sets — cheap and good enough to flag for human review, not a hard rule.
const STOPWORDS = new Set(["a", "an", "the", "of", "in", "to", "and", "or", "is", "are", "that", "this", "as", "with", "for", "on", "by", "be", "its", "from", "into", "or", "than", "especially"]);
function wordSet(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(function (w) { return w.length > 2 && !STOPWORDS.has(w); }));
}
function jaccardSim(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(function (w) { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

function readStdin() {
  const data = fs.readFileSync(0, "utf8").trim();
  if (!data) fail("expected JSON on stdin");
  try { return JSON.parse(data); }
  catch (e) { fail("invalid JSON on stdin: " + e.message); }
}

// Auto-run after every set/field/rmfield: catches the congee/exegete class of
// bug (a confident-but-wrong engine parse) at write time instead of relying on
// someone remembering to run check-decomp.js separately afterward. Lazy-loaded
// since most word.js calls don't touch the dictionary content at all.
let _decompCheck = null;
function checkWritten(w, entry) {
  if (!entry || entry.b) return; // curated override already shields the UI from the engine
  if (/[\s-]/.test(w)) return; // phrasal headwords skip decomposition entirely
  if (!_decompCheck) {
    try {
      const ROOT = path.join(__dirname, "..");
      delete require.cache[require.resolve(path.join(ROOT, "data.js"))];
      global.MORPHEMES = require(path.join(ROOT, "data.js")).MORPHEMES;
      delete require.cache[require.resolve(path.join(ROOT, "engine.js"))];
      const engine = require(path.join(ROOT, "engine.js"));
      const { classify } = require("./decomp-lib.js");
      _decompCheck = function (word, e) { return classify(word, e, engine.decompose); };
    } catch (err) {
      process.stderr.write("word.js: (skipped decomp check — " + err.message + ")\n");
      _decompCheck = function () { return null; };
    }
  }
  const r = _decompCheck(w, entry);
  if (r && r.verdict === "SUSPECT") {
    process.stderr.write("word.js: ⚠ SUSPECT parse for \"" + w + "\": " + r.parts +
      " — engine split doesn't corroborate against this word's own etymology text. " +
      "Review with `node scripts/check-decomp.js " + w + "`; if it's really wrong, add a curated override:\n" +
      "  node scripts/word.js field " + w + " b <<JSON\n  [{\"s\":\"" + w + "\",\"k\":\"word\"}]\n  JSON\n");
  } else if (r && r.verdict === "UNVERIFIED") {
    process.stderr.write("word.js: note: \"" + w + "\" parses as " + r.parts +
      " but has no etymology text to corroborate it against — can't confirm either way.\n");
  }
}

const [cmd, word, fieldKey] = process.argv.slice(2);
if (!cmd) fail("no command. try: get|has|set|field|rmfield|rm|list|missing|cluster|cluster-list");

if (cmd === "list") {
  const key = String(word || "").toLowerCase();
  if (!/^[a-z]{2}$/.test(key)) fail("list needs a two-letter shard, e.g. 'co'");
  const obj = readShard(path.join(WORDS_DIR, key + ".json"));
  const keys = Object.keys(obj);
  process.stdout.write(keys.join("\n") + (keys.length ? "\n" : ""));
  process.stderr.write("(" + keys.length + " words in " + key + ".json)\n");
  process.exit(0);
}

if (cmd === "missing") {
  // Check a whole candidate list in ONE process instead of N `has` calls — the
  // cheap way to find out which words in a batch still need writing.
  const candidates = process.argv.slice(3);
  if (!candidates.length) fail("missing needs at least one <word>");
  const cache = {}; // shardPath -> shard obj, so repeats in the same shard don't re-read
  const out = [];
  for (const w of candidates) {
    const sp = shardPath(w);
    if (!cache[sp]) cache[sp] = readShard(sp);
    const exists = Object.prototype.hasOwnProperty.call(cache[sp], w);
    out.push((exists ? "EXISTS  " : "MISSING ") + w);
  }
  process.stdout.write(out.join("\n") + "\n");
  const missingCount = out.filter((l) => l.startsWith("MISSING")).length;
  process.stderr.write(missingCount + "/" + candidates.length + " missing\n");
  process.exit(0);
}

if (cmd === "bulk-set") {
  // Write N entries in ONE process instead of N separate `set` calls — the
  // whole point being a round of new words costs one tool call, not one per
  // word. Stdin is a single JSON object: {"word1": {...entry...}, "word2": {...}}.
  const entries = readStdin();
  if (typeof entries !== "object" || Array.isArray(entries) || entries === null) fail("bulk-set expects a JSON object of {word: entry, ...} on stdin");
  const words = Object.keys(entries);
  if (!words.length) fail("bulk-set: empty object, nothing to write");
  for (const w of words) {
    const e = entries[w];
    if (typeof e !== "object" || Array.isArray(e) || e === null) fail("bulk-set: entry for " + JSON.stringify(w) + " must be a JSON object");
  }
  const touched = {}; // shardPath -> shard obj, so words in the same shard share one read/write
  const now = new Date().toISOString();
  for (const w of words) {
    const sp = shardPath(w);
    if (!touched[sp]) touched[sp] = readShard(sp);
    entries[w]._at = now;
    touched[sp][w] = entries[w];
  }
  for (const sp of Object.keys(touched)) writeShard(sp, touched[sp]);
  process.stderr.write("wrote " + words.length + " word(s) across " + Object.keys(touched).length + " shard(s): " + words.join(", ") + "\n");
  for (const w of words) checkWritten(w, entries[w]);
  process.exit(0);
}

if (cmd === "bulk-field") {
  // Set the SAME field on N existing words in one call — the field-update
  // counterpart to bulk-set. Stdin: {"word1": <value1>, "word2": <value2>, ...}.
  const fieldKeyArg = word; // reuse the 3rd argv slot (cmd, fieldKey, ...)
  if (!fieldKeyArg || !FIELDS.has(fieldKeyArg)) fail("bulk-field needs one of: " + [...FIELDS].join(" ") + " as its argument");
  const values = readStdin();
  if (typeof values !== "object" || Array.isArray(values) || values === null) fail("bulk-field expects a JSON object of {word: value, ...} on stdin");
  const words = Object.keys(values);
  if (!words.length) fail("bulk-field: empty object, nothing to write");
  const missing = [];
  const touched = {};
  for (const w of words) {
    const sp = shardPath(w);
    if (!touched[sp]) touched[sp] = readShard(sp);
    if (!Object.prototype.hasOwnProperty.call(touched[sp], w)) { missing.push(w); continue; }
  }
  if (missing.length) fail("not found, nothing written: " + missing.join(", "));
  const now = new Date().toISOString();
  for (const w of words) {
    const sp = shardPath(w);
    touched[sp][w][fieldKeyArg] = values[w];
    touched[sp][w]._at = now;
  }
  for (const sp of Object.keys(touched)) writeShard(sp, touched[sp]);
  process.stderr.write("set ." + fieldKeyArg + " on " + words.length + " word(s) across " + Object.keys(touched).length + " shard(s): " + words.join(", ") + "\n");
  for (const w of words) checkWritten(w, touched[shardPath(w)][w]);
  process.exit(0);
}

if (cmd === "cluster") {
  const clusterId = word;
  const members = process.argv.slice(4);
  if (!clusterId) fail("cluster needs a <clusterId>");
  if (!members.length) fail("cluster needs at least one word after the clusterId");
  const missing = [];
  const touched = {}; // shardPath -> shard obj, so words in the same shard share one read/write
  for (const w of members) {
    const sp = shardPath(w);
    if (!touched[sp]) touched[sp] = readShard(sp);
    if (!Object.prototype.hasOwnProperty.call(touched[sp], w)) { missing.push(w); continue; }
    const e = touched[sp][w];
    const tags = new Set(e.cl || []);
    tags.add(clusterId);
    e.cl = [...tags];
  }
  if (missing.length) fail("not found, nothing written: " + missing.join(", "));
  for (const sp of Object.keys(touched)) writeShard(sp, touched[sp]);
  process.stderr.write("tagged " + members.length + " word(s) with cluster \"" + clusterId + "\": " + members.join(", ") + "\n");
  process.exit(0);
}

// `cluster` tags a whole entry — too coarse for a common multi-sense word
// where only ONE definition belongs to the cluster (e.g. "shadow" has 6
// senses; only the Jungian one is). sense-cluster tags individual d[] items.
if (cmd === "sense-cluster") {
  const clusterId = word;
  const pairs = process.argv.slice(4); // each "word:senseIndex", e.g. "shadow:5"
  if (!clusterId) fail("sense-cluster needs a <clusterId>");
  if (!pairs.length) fail("sense-cluster needs at least one word:index pair after the clusterId");
  const touched = {};
  const bad = [];
  const parsed = [];
  for (const pair of pairs) {
    const m = /^(.+):(\d+)$/.exec(pair);
    if (!m) { bad.push(pair + " (expected word:index, e.g. shadow:5)"); continue; }
    const w = m[1], idx = Number(m[2]);
    const sp = shardPath(w);
    if (!touched[sp]) touched[sp] = readShard(sp);
    const e = touched[sp][w];
    if (!e) { bad.push(w + " (not found)"); continue; }
    if (!e.d || !e.d[idx]) { bad.push(w + ":" + idx + " (no sense at that index — entry has " + ((e.d && e.d.length) || 0) + ")"); continue; }
    parsed.push({ w: w, idx: idx, sense: e.d[idx] });
  }
  if (bad.length) fail("problems, nothing written: " + bad.join("; "));
  for (const p of parsed) {
    const tags = new Set(p.sense.cl || []);
    tags.add(clusterId);
    p.sense.cl = [...tags];
  }
  const touchedWords = new Set(parsed.map(function (p) { return p.w; }));
  touchedWords.forEach(function (w) { touched[shardPath(w)][w]._at = new Date().toISOString(); });
  for (const sp of Object.keys(touched)) if (Object.keys(touched[sp]).some(function (w) { return touchedWords.has(w); })) writeShard(sp, touched[sp]);
  process.stderr.write("sense-tagged " + parsed.length + " sense(s) with cluster \"" + clusterId + "\": " + pairs.join(", ") + "\n");
  process.exit(0);
}

if (cmd === "cluster-list") {
  const clusterId = word;
  if (!clusterId) fail("cluster-list needs a <clusterId>");
  const hits = [];
  for (const f of fs.readdirSync(WORDS_DIR).filter((x) => x.endsWith(".json"))) {
    const obj = readShard(path.join(WORDS_DIR, f));
    for (const w of Object.keys(obj)) if ((obj[w].cl || []).includes(clusterId)) hits.push(w);
  }
  process.stdout.write(hits.join("\n") + (hits.length ? "\n" : ""));
  process.stderr.write("(" + hits.length + " word(s) tagged \"" + clusterId + "\")\n");
  process.exit(0);
}

if (!word) fail(cmd + " needs a <word>");
const p = shardPath(word);
const shard = readShard(p);
const exists = Object.prototype.hasOwnProperty.call(shard, word);

switch (cmd) {
  case "get":
    if (!exists) fail("not found: " + word);
    process.stdout.write(JSON.stringify(shard[word], null, 2) + "\n");
    break;

  case "has":
    process.exit(exists ? 0 : 1);
    break;

  case "set": {
    const entry = readStdin();
    if (typeof entry !== "object" || Array.isArray(entry) || entry === null) fail("set expects a JSON object");
    entry._at = new Date().toISOString(); // last touched via this CLI — feeds the app's "recently added/enriched" list
    shard[word] = entry;
    writeShard(p, shard);
    process.stderr.write((exists ? "updated " : "added ") + word + " in " + path.basename(p) + "\n");
    checkWritten(word, shard[word]);
    break;
  }

  case "field": {
    if (!fieldKey || !FIELDS.has(fieldKey)) fail("field needs one of: " + [...FIELDS].join(" "));
    const value = readStdin();
    if (!exists) shard[word] = {};
    shard[word][fieldKey] = value;
    shard[word]._at = new Date().toISOString();
    writeShard(p, shard);
    process.stderr.write("set ." + fieldKey + " on " + word + "\n");
    checkWritten(word, shard[word]);
    break;
  }

  // Push one item onto an array field without a read-modify-write round trip
  // (e.g. adding a new sense to an existing word's `d` without clobbering its
  // other senses, or appending a related word to `r`). `field` REPLACES the
  // whole value; this is the cheap way to extend it instead.
  case "append": {
    if (!fieldKey || !FIELDS.has(fieldKey)) fail("append needs one of: " + [...FIELDS].join(" "));
    const value = readStdin();
    if (!exists) shard[word] = {};
    const cur = shard[word][fieldKey];
    if (cur !== undefined && !Array.isArray(cur)) fail("append: ." + fieldKey + " on " + word + " isn't an array");
    const arr = cur || [];
    if (typeof value !== "object" || value === null) {
      // Plain string arrays (s/r/cl/vars/forms): an exact duplicate is never
      // useful — skip instead of silently doubling it up.
      if (arr.includes(value)) { process.stderr.write("word.js: ." + fieldKey + " on " + word + " already contains " + JSON.stringify(value) + " — not duplicating\n"); break; }
    } else if (fieldKey === "d" && typeof value.g === "string") {
      // Senses: an exact-text duplicate is blocked outright. A near-duplicate
      // (high word overlap) is flagged but still appended — sometimes a
      // narrower technical sense legitimately reuses most of a general
      // sense's wording, and that's a judgment call, not a hard rule.
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (!s || typeof s.g !== "string") continue;
        if (s.g.trim().toLowerCase() === value.g.trim().toLowerCase()) {
          fail("append: " + word + " already has this exact sense (index " + i + "): \"" + s.g.slice(0, 80) + "\"");
        }
        const sim = jaccardSim(value.g, s.g);
        if (sim >= 0.3) {
          process.stderr.write("word.js: ⚠ possible redundant sense on " + word + " — " + Math.round(sim * 100) +
            "% word overlap with existing sense " + i + ": \"" + s.g.slice(0, 70) + "\". Appended anyway; review with `node scripts/word.js get " + word + "`.\n");
        }
      }
    }
    shard[word][fieldKey] = arr.concat([value]);
    shard[word]._at = new Date().toISOString();
    writeShard(p, shard);
    process.stderr.write("appended to ." + fieldKey + " on " + word + " (" + shard[word][fieldKey].length + " item(s) now)\n");
    checkWritten(word, shard[word]);
    break;
  }

  case "rmfield": {
    if (!exists) fail("not found: " + word);
    if (!fieldKey) fail("rmfield needs a <field>");
    delete shard[word][fieldKey];
    shard[word]._at = new Date().toISOString();
    writeShard(p, shard);
    process.stderr.write("removed ." + fieldKey + " from " + word + "\n");
    checkWritten(word, shard[word]);
    break;
  }

  case "rm":
    if (!exists) fail("not found: " + word);
    delete shard[word];
    writeShard(p, shard);
    process.stderr.write("removed " + word + " from " + path.basename(p) + "\n");
    break;

  default:
    fail("unknown command: " + cmd);
}
