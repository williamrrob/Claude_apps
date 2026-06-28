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
 * Entry shape (see README): { d:[{p,g,x?}], e, s:[..], a:[..], r:[..], i, rs }
 *   d=definitions (p=part of speech, g=gloss, x=example), e=etymology,
 *   s=synonyms, a=antonyms, r=related, i=IPA, rs=respelling.
 *
 * Usage:
 *   node scripts/word.js get <word>                 # print one entry (cheap read)
 *   node scripts/word.js has <word>                 # exit 0 if present, 1 if not
 *   node scripts/word.js set <word>      < entry.json   # create/replace whole entry (JSON on stdin)
 *   node scripts/word.js field <word> <k> < value.json  # set ONE field (JSON value on stdin)
 *   node scripts/word.js rmfield <word> <k>         # delete one field
 *   node scripts/word.js rm <word>                  # delete the entry
 *   node scripts/word.js list <xx>                  # list words in a shard (keys only)
 *
 * Tips: pass JSON via a heredoc to avoid shell-quoting pain, e.g.
 *   node scripts/word.js field concord s <<'JSON'
 *   ["accord","agreement","harmony"]
 *   JSON
 */
"use strict";
const fs = require("fs");
const path = require("path");

const WORDS_DIR = path.join(__dirname, "..", "words");
const FIELDS = new Set(["d", "e", "s", "a", "r", "i", "rs"]);

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
function writeShard(p, obj) { fs.writeFileSync(p, stringifyShard(obj)); }

function readStdin() {
  const data = fs.readFileSync(0, "utf8").trim();
  if (!data) fail("expected JSON on stdin");
  try { return JSON.parse(data); }
  catch (e) { fail("invalid JSON on stdin: " + e.message); }
}

const [cmd, word, fieldKey] = process.argv.slice(2);
if (!cmd) fail("no command. try: get|has|set|field|rmfield|rm|list");

if (cmd === "list") {
  const key = String(word || "").toLowerCase();
  if (!/^[a-z]{2}$/.test(key)) fail("list needs a two-letter shard, e.g. 'co'");
  const obj = readShard(path.join(WORDS_DIR, key + ".json"));
  const keys = Object.keys(obj);
  process.stdout.write(keys.join("\n") + (keys.length ? "\n" : ""));
  process.stderr.write("(" + keys.length + " words in " + key + ".json)\n");
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
    shard[word] = entry;
    writeShard(p, shard);
    process.stderr.write((exists ? "updated " : "added ") + word + " in " + path.basename(p) + "\n");
    break;
  }

  case "field": {
    if (!fieldKey || !FIELDS.has(fieldKey)) fail("field needs one of: " + [...FIELDS].join(" "));
    const value = readStdin();
    if (!exists) shard[word] = {};
    shard[word][fieldKey] = value;
    writeShard(p, shard);
    process.stderr.write("set ." + fieldKey + " on " + word + "\n");
    break;
  }

  case "rmfield": {
    if (!exists) fail("not found: " + word);
    if (!fieldKey) fail("rmfield needs a <field>");
    delete shard[word][fieldKey];
    writeShard(p, shard);
    process.stderr.write("removed ." + fieldKey + " from " + word + "\n");
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
