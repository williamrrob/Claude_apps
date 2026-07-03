#!/usr/bin/env node
/*
 * score-junk.js — CONFLUENCE score for junk/nonce terms (olicity class:
 * fandom ships, ephemeral internet coinages, one-off blends). No single
 * signal convicts — good rare words trip one or two — so we sum independent
 * weak signals and only the high-confluence tail is "confident junk".
 * REPORT ONLY: writes review/junk-scores.tsv, mutates nothing.
 *
 * Signals (all from data we already have):
 *   +3 gloss self-incrimination: "portmanteau/blend of <Name> and <Name>",
 *      "ship(ping) name", "fandom", "fan-made", "a romantic pairing"
 *   +2 no measurable history: usage series absent or all-zero
 *   +2 isolation: single sense AND no synonyms/antonyms/related
 *   +1 no frequency rank (absent from the ~250k frequency list)
 *   +1 no pronunciation on file (i)
 *   +1 no wiki/wikidata link and no dated attestation
 *   +1 register-only: Wiktionary tags are purely slang/internet/fandom
 * Control words (susurrus, zeugma, quisling, …) should stay LOW.
 *
 *   node scripts/score-junk.js [--min N]   # print words scoring >= N (default 6)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const USAGE = path.join(ROOT, "usage");
const MIN = (() => { const i = process.argv.indexOf("--min"); return i !== -1 ? Number(process.argv[i + 1]) : 6; })();

const rank = new Set();
for (const line of fs.readFileSync(path.join(ROOT, "review", "ranks.tsv"), "utf8").split("\n").slice(1)) {
  const i = line.lastIndexOf("\t"); if (i > 0) rank.add(line.slice(0, i).toLowerCase());
}

// rich data: tags/wikidata/attestation per word
const db = new DatabaseSync(path.join(ROOT, "vendor-data", "kaikki-rich.sqlite"), { readOnly: true });
const rich = new Map(); // word(lc) -> {tags:Set, wiki:bool, attest:bool}
for (const r of db.prepare("SELECT word, tags, wikidata, attest_year FROM sense").all()) {
  const k = r.word.toLowerCase();
  let e = rich.get(k); if (!e) rich.set(k, (e = { tags: new Set(), wiki: false, attest: false }));
  for (const t of JSON.parse(r.tags || "[]")) e.tags.add(String(t).toLowerCase());
  if (r.wikidata) e.wiki = true;
  if (r.attest_year) e.attest = true;
}
const meta = new Map();
for (const r of db.prepare("SELECT word, wikipedia FROM wordmeta WHERE wikipedia IS NOT NULL").all()) meta.set(r.word.toLowerCase(), true);
db.close();

const usageHas = new Map(); // word -> true if any nonzero bucket
for (const f of fs.readdirSync(USAGE).filter((x) => x.endsWith(".json"))) {
  const o = JSON.parse(fs.readFileSync(path.join(USAGE, f), "utf8"));
  for (const [w, s] of Object.entries(o)) if (Array.isArray(s) && s.some((v) => v > 0)) usageHas.set(w.toLowerCase(), true);
}

const GLOSS_JUNK = /\b(portmanteau|blend) of\s+[A-Z][a-z]+\s+and\s+[A-Z][a-z]+|\bship(?:ping)? name\b|\bfandom\b|\bfan-?(?:made|fiction|art)\b|romantic (?:pairing|relationship) (?:of|between)|\b(?:a|the) pairing of\b/;
const REGISTER = ["slang", "internet", "informal", "neologism", "fandom", "humorous", "derogatory"];
const SUBSTANTIVE_TAGS = ["chemistry", "medicine", "biology", "physics", "law", "botany", "anatomy", "mathematics", "linguistics", "archaic", "obsolete", "historical", "dialectal"];

const rows = [];
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const [w, rec] of Object.entries(sh)) {
    if (/[\s]/.test(w) || rec.rel) continue; // skip phrases and pointers
    const lc = w.toLowerCase();
    const r = rich.get(lc) || { tags: new Set(), wiki: false, attest: false };
    let score = 0; const why = [];
    const gloss = (rec.d && rec.d[0] && rec.d[0].g) || "";
    if (GLOSS_JUNK.test(gloss)) { score += 3; why.push("gloss"); }
    if (!usageHas.get(lc)) { score += 2; why.push("no-usage"); }
    const isolated = (rec.d || []).length <= 1 && !(rec.s && rec.s.length) && !(rec.a && rec.a.length) && !(rec.r && rec.r.length);
    if (isolated) { score += 2; why.push("isolated"); }
    if (!rank.has(lc)) { score += 1; why.push("no-rank"); }
    if (!rec.i) { score += 1; why.push("no-pron"); }
    if (!r.wiki && !meta.get(lc) && !r.attest) { score += 1; why.push("no-wiki/attest"); }
    const regOnly = r.tags.size && [...r.tags].some((t) => REGISTER.includes(t)) && ![...r.tags].some((t) => SUBSTANTIVE_TAGS.includes(t));
    if (regOnly) { score += 1; why.push("register"); }
    // a substantive-domain tag is a strong KEEP — pardon technical rare words
    if ([...r.tags].some((t) => SUBSTANTIVE_TAGS.includes(t))) score -= 3;
    if (score >= MIN) rows.push({ w, score, why: why.join(","), gloss: gloss.slice(0, 64) });
  }
}
rows.sort((a, b) => b.score - a.score || a.w.localeCompare(b.w));
fs.writeFileSync(path.join(ROOT, "review", "junk-scores.tsv"),
  "word\tscore\tsignals\tgloss\n" + rows.map((r) => [r.w, r.score, r.why, r.gloss].join("\t")).join("\n") + "\n");

const dist = {};
for (const r of rows) dist[r.score] = (dist[r.score] || 0) + 1;
console.log("JUNK CONFLUENCE — " + rows.length + " words score >= " + MIN + " (of ~220k)");
console.log("score distribution: " + Object.keys(dist).sort((a, b) => b - a).map((s) => s + ":" + dist[s]).join("  "));
console.log("\ntop of the confident-junk pile:");
for (const r of rows.slice(0, 30)) console.log("  " + r.score + "  " + r.w + "  [" + r.why + "]  " + r.gloss);

// control: known-good rare words should NOT reach MIN
const control = ["susurrus", "zeugma", "quisling", "petrichor", "defenestration", "sesquipedalian", "borborygmus", "apricity", "syzygy"];
const byWord = new Map(rows.map((r) => [r.w.toLowerCase(), r.score]));
console.log("\ncontrol (good rare words — should be blank/low): " +
  control.map((c) => c + "=" + (byWord.get(c) || "<" + MIN)).join("  "));
