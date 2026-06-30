#!/usr/bin/env node
/*
 * add-root.js — add a prefix/root/suffix to data.js's morpheme database,
 * end to end, with no manual file editing.
 *
 * Checks if the id already exists (no-ops if so — safe to re-run), checks for
 * form collisions within the same section, inserts the entry in the same
 * one-line style as the rest of the file, verifies the file still parses,
 * bumps data.js's cache-busting tag in index.html, then scans the live
 * dictionary for any EXISTING word containing one of the new forms whose
 * parse this addition would newly affect, flagging anything that looks like
 * the congee class of bug (see check-decomp.js) for human review.
 *
 * Usage:
 *   node scripts/add-root.js <section> <id> <forms> <origin> <source> <meaning>
 *
 *   section  one of: prefixes, roots, suffixes
 *   id       short identifier, e.g. "limen"
 *   forms    comma-separated surface spellings, e.g. "limin,limen"
 *   origin   source language, e.g. "Latin"
 *   source   the original word/element, e.g. "limen"
 *   meaning  short gloss, e.g. "threshold"
 *
 * Example:
 *   node scripts/add-root.js roots limen "limin,limen" Latin limen threshold
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA_JS = path.join(ROOT, "data.js");
const WORDS_DIR = path.join(ROOT, "words");

function fail(msg) { process.stderr.write("add-root: " + msg + "\n"); process.exit(1); }

const [section, id, formsArg, origin, source, meaning] = process.argv.slice(2);
const SECTIONS = ["prefixes", "roots", "suffixes"];
if (!SECTIONS.includes(section)) fail("section must be one of: " + SECTIONS.join(", "));
if (!id) fail("missing <id>");
if (!formsArg) fail("missing <forms> (comma-separated)");
if (!origin || !source || !meaning) fail("missing <origin> <source> <meaning>");
const forms = formsArg.split(",").map(function (f) { return f.trim(); }).filter(Boolean);
if (!forms.length) fail("<forms> parsed to an empty list");

// ---- 1. existence / collision check, against the CURRENTLY SHIPPED data.js ----
delete require.cache[require.resolve(DATA_JS)];
const MORPHEMES = require(DATA_JS).MORPHEMES;
const existing = MORPHEMES[section];

const byId = existing.find(function (e) { return e.id === id; });
if (byId) {
  console.log("already exists: " + section + "." + id + " (forms: " + byId.forms.join(", ") + ") — nothing to do");
  process.exit(0);
}
const formCollisions = existing.filter(function (e) { return e.forms.some(function (f) { return forms.includes(f); }); });
if (formCollisions.length) {
  fail("form collision in " + section + " with existing id(s): " +
    formCollisions.map(function (e) { return e.id + " (" + e.forms.filter(function (f) { return forms.includes(f); }).join(",") + ")"; }).join(", ") +
    " — pick different forms or confirm this is intentional and edit data.js by hand");
}

// ---- 2. insert, in the same one-line style as the rest of the file ----
const src = fs.readFileSync(DATA_JS, "utf8");
const lines = src.split("\n");
const startIdx = lines.findIndex(function (l) { return l.trim() === section + ": ["; });
if (startIdx === -1) fail("could not find \"" + section + ": [\" in data.js");
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^\s*\],?\s*$/.test(lines[i])) { endIdx = i; break; }
}
if (endIdx === -1) fail("could not find the end of the \"" + section + "\" array in data.js");

const formsLit = forms.map(function (f) { return JSON.stringify(f); }).join(", ");
const newLine = "    { id: " + JSON.stringify(id) + ", forms: [" + formsLit + "], origin: " +
  JSON.stringify(origin) + ", source: " + JSON.stringify(source) + ", meaning: " + JSON.stringify(meaning) + " }";

const lastEntryIdx = endIdx - 1;
if (!/,\s*$/.test(lines[lastEntryIdx])) lines[lastEntryIdx] = lines[lastEntryIdx] + ",";
lines.splice(endIdx, 0, newLine);

fs.writeFileSync(DATA_JS, lines.join("\n"));

// ---- 3. verify the file still parses ----
try {
  execFileSync(process.execPath, ["--check", DATA_JS]);
} catch (e) {
  fail("data.js failed to parse after edit — reverting.\n" + e.message + "\n" +
    "(the bad write is still on disk; fix manually or restore from git)");
}
console.log("added " + section + "." + id + " (forms: " + forms.join(", ") + ") to data.js");

// ---- 4. bump data.js's cache-busting tag ----
try {
  execFileSync(process.execPath, [path.join(__dirname, "bump-version.js"), "data"], { stdio: "inherit" });
} catch (e) {
  process.stderr.write("warning: could not auto-bump data.js?v= in index.html — bump it manually\n");
}

// ---- 5. scope-scan the live dictionary for words containing a new form, and
// flag any whose parse now looks like the congee class of bug ----
delete require.cache[require.resolve(DATA_JS)];
global.MORPHEMES = require(DATA_JS).MORPHEMES;
delete require.cache[require.resolve(path.join(ROOT, "engine.js"))];
const engine = require(path.join(ROOT, "engine.js"));
const { classify } = require("./decomp-lib.js");

const formRe = new RegExp(forms.map(function (f) { return f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|"));
const flagged = [];
let scanned = 0;
for (const f of fs.readdirSync(WORDS_DIR).filter(function (x) { return x.endsWith(".json"); })) {
  const obj = JSON.parse(fs.readFileSync(path.join(WORDS_DIR, f), "utf8"));
  for (const w of Object.keys(obj)) {
    if (obj[w].b) continue; // curated override — engine result doesn't reach the UI
    if (!formRe.test(w)) continue;
    scanned++;
    const r = classify(w, obj[w], engine.decompose);
    if (r && r.verdict !== "ok") flagged.push({ word: w, verdict: r.verdict, parts: r.parts });
  }
}
console.log("scanned " + scanned + " existing word(s) containing a new form");
if (flagged.length) {
  console.log(flagged.length + " flagged for review (heuristic — corroboration against each word's own etymology text):");
  flagged.forEach(function (r) { console.log("  " + r.verdict + "\t" + r.word + "\t" + r.parts); });
  console.log("If any of these are genuinely wrong, add a curated override:");
  console.log("  node scripts/word.js field <word> b <<JSON");
  console.log("  [{\"s\":\"<word>\",\"k\":\"word\"}]");
  console.log("  JSON");
} else {
  console.log("no existing words flagged — looks clean");
}
