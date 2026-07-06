#!/usr/bin/env node
"use strict";
/*
 * mw-enrich.js — pull Merriam-Webster Collegiate Dictionary + Thesaurus data
 * for a word and STAGE it on the entry's `_mw` field (never touches the live
 * flat fields d/e/s/a/i). Each MW homograph becomes one object in the `_mw`
 * array, carrying its own part of speech, senses, etymology, thesaurus lists,
 * inflections/stems and phrases — so the app can render one card per homograph
 * ("desert" the noun vs "desert" the verb) instead of grouping by section.
 *
 * The mapping itself lives in ../mw-map.js (shared with the browser's auto-fetch
 * in app.js so the CLI and the live app produce identical staging). This script
 * only does the I/O: fetch the two APIs, hand the raw arrays to mapMwResponse,
 * write the result via word.js.
 *
 * WHY staging (not overwrite): MW is the highest-quality source we have for
 * definitions/thesaurus, but our existing `e` etymologies sometimes trace
 * deeper (to PIE) than MW's prose. `_mw` keeps BOTH until a human (or, later,
 * a trusted LLM) promotes the staged data into the live fields and drops `_mw`.
 *
 * Keys: MW registers Dictionary and Thesaurus as separate products, each with
 * its own key. Pass via env MW_DICT_KEY / MW_THES_KEY (or --dict-key/--thes-key).
 *
 * Usage:
 *   MW_DICT_KEY=… MW_THES_KEY=… node scripts/mw-enrich.js <word> [--apply]
 *     (dry-run by default; --apply writes _mw via word.js field <word> _mw)
 *
 * Behind a proxy, run with NODE_USE_ENV_PROXY=1 so fetch honors HTTPS_PROXY.
 */
const path = require("path");
const { execFileSync } = require("child_process");
const MWMap = require("../mw-map.js");

const WORD_JS = path.join(__dirname, "word.js");
function fail(msg) { process.stderr.write("mw-enrich: " + msg + "\n"); process.exit(1); }

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const DICT_KEY = flag("--dict-key") || process.env.MW_DICT_KEY;
const THES_KEY = flag("--thes-key") || process.env.MW_THES_KEY;
const word = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--dict-key" && argv[i - 1] !== "--thes-key")[0];
if (!word) fail("needs a <word>");
if (!DICT_KEY) fail("no dictionary key (set MW_DICT_KEY or pass --dict-key)");

async function getJson(url, label) {
  let res;
  try { res = await fetch(url); }
  catch (e) { fail(label + " fetch failed (" + e.message + ") — offline? behind a proxy try NODE_USE_ENV_PROXY=1"); }
  if (!res.ok) fail(label + " returned HTTP " + res.status);
  return res.json();
}

(async () => {
  const dict = await getJson(
    "https://dictionaryapi.com/api/v3/references/collegiate/json/" + encodeURIComponent(word) + "?key=" + DICT_KEY,
    "dictionary");
  if (Array.isArray(dict) && typeof dict[0] === "string") fail(JSON.stringify(word) + " not in MW dictionary. Suggestions: " + dict.slice(0, 5).join(", "));

  let thes = [];
  if (THES_KEY) {
    thes = await getJson(
      "https://dictionaryapi.com/api/v3/references/thesaurus/json/" + encodeURIComponent(word) + "?key=" + THES_KEY,
      "thesaurus");
  } else {
    process.stderr.write("mw-enrich: no thesaurus key — skipping synonyms/antonyms/related\n");
  }

  const mw = MWMap.mapMwResponse(dict, thes, word);
  if (!mw.length) fail("MW returned no entries matching headword " + JSON.stringify(word));

  process.stdout.write(JSON.stringify(mw, null, 2) + "\n");
  if (!APPLY) {
    process.stderr.write("staged " + mw.length + " homograph(s) — dry run. Re-run with --apply to write _mw onto '" + word + "'.\n");
    return;
  }
  execFileSync("node", [WORD_JS, "field", word, "_mw"], { input: JSON.stringify(mw), stdio: ["pipe", "inherit", "inherit"] });
  process.stderr.write("wrote _mw (" + mw.length + " homograph(s)) onto '" + word + "'\n");
})();
