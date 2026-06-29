#!/usr/bin/env node
/*
 * import-kaikki.js — add new headwords to Rootwork from a Wiktionary extract
 * (Kaikki.org wiktextract JSONL: one JSON object per word+pos).
 *
 * Brings in the registers the WordNet-based build can't: internet slang, idioms,
 * rare/erudite vocabulary, loanwords. ADDITIVE ONLY — it never overwrites an
 * existing headword (so the curated 77.6k entries are untouched); it only adds
 * words we don't already carry. Once added, `npm run embed build` embeds the new
 * glosses incrementally, putting them in the same vector space as everything else.
 *
 * Each kept word maps to the Rootwork shape { d:[{p,g,x?,dom?}], e, s, a, r, i }.
 * A sense's optional `dom` (the dictionary's existing domain field, e.g. "law",
 * "computing", "philosophy") comes from the most specific Wiktionary topic —
 * a clean structured label, not the gloss-header hierarchy folded into the text.
 *
 * Groups (a word is kept if any sense matches a requested group):
 *   slang   — slang/informal/colloquial/vulgar/internet/neologism/derogatory
 *   idioms  — idiomatic, pos "phrase", or a multi-word headword
 *   rare    — rare/literary/formal/poetic (erudite)
 *   archaic — archaic/obsolete/dated/historical
 *   loan    — etymology marks a borrowing from another language
 *
 *   node scripts/import-kaikki.js <file.jsonl> [--groups slang,idioms,rare,loan]
 *        [--max-senses 4] [--limit N] [--apply]
 *
 * DRY RUN by default: prints per-group counts and sample entries, writes nothing.
 * Reads existing headwords from rootwork.sqlite (run `npm run build:sqlite`).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const { stringifyShard } = require("./shard-format.js");

const EMPTY = "";
const WORDS_DIR = path.join(__dirname, "..", "words");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const SRC = process.argv[2];
const APPLY = process.argv.includes("--apply");
const GROUPS = new Set((arg("--groups", "slang,idioms,rare,loan")).split(",").map((s) => s.trim()).filter(Boolean));
// Topic-based selection (Wiktionary topics[], e.g. "philosophy","law") — picks
// senses by domain regardless of register. Empty by default.
const TOPICS = new Set((arg("--topics", "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const MAX_SENSES = parseInt(arg("--max-senses", "4"), 10);
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const GATE = !process.argv.includes("--no-gate"); // quality-gate idiom/archaic-only words
const MAX_SYN = 8, MAX_REL = 12;

if (!SRC || SRC.startsWith("--") || !fs.existsSync(SRC)) {
  process.stderr.write("usage: node scripts/import-kaikki.js <file.jsonl> [--groups ...] [--apply]\n");
  process.exit(1);
}

// Existing headwords + their senses. We never overwrite an existing entry, but
// we DO add genuinely-new senses to it (e.g. the internet sense of an existing
// word) — guarded against duplicating senses it already has.
const SENSES_EXISTING = !process.argv.includes("--no-existing-senses");
const MAX_TOTAL_SENSES = parseInt(arg("--max-total-senses", "8"), 10);
const normGloss = (g) => String(g == null ? EMPTY : g).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

const DB = path.join(__dirname, "..", "rootwork.sqlite");
if (!fs.existsSync(DB)) { process.stderr.write("rootwork.sqlite missing — run: npm run build:sqlite\n"); process.exit(1); }
const dbh = new DatabaseSync(DB, { readOnly: true });
const existing = new Set();
const existingGloss = new Map(); // lc word -> Set(normalized gloss)
for (const r of dbh.prepare("SELECT word FROM words").all()) existing.add(r.word.toLowerCase());
for (const r of dbh.prepare("SELECT word, gloss FROM senses WHERE gloss IS NOT NULL").all()) {
  const w = r.word.toLowerCase();
  let s = existingGloss.get(w); if (!s) existingGloss.set(w, (s = new Set()));
  s.add(normGloss(r.gloss));
}
dbh.close();

const POS = { noun: "n.", verb: "v.", adj: "adj.", adv: "adv.", prep: "prep.", conj: "conj.",
  pron: "pron.", intj: "interj.", num: "num.", article: "art.", particle: "part.", det: "det.",
  phrase: "phrase", prep_phrase: "phrase", proverb: "phrase", name: "n." };

const lc = (s) => String(s == null ? EMPTY : s).toLowerCase();
const catText = (arr) => (arr || []).map((c) => (typeof c === "string" ? c : (c && c.name) || EMPTY)).join(" ").toLowerCase();

const SLANG = ["slang", "informal", "colloquial", "vulgar", "internet", "neologism", "derogatory", "humorous", "slur", "offensive"];
const RARE = ["rare", "literary", "formal", "poetic"];
const ARCHAIC = ["archaic", "obsolete", "dated", "historical"];
// A true loanword is an explicit BORROWING, not mere Latin/French ancestry
// (almost all English is etymologically Latinate) — so require "borrowed from"
// / "unadapted borrowing" / "loanword" / "calque", not "from <language>".
const LOAN_RE = /\b(borrowed from|unadapted borrowing|loan(word|ed)|calque of)\b/;
const NONSENSE_RE = /^used other than (figuratively|idiomatically)/i;

function senseTagGroups(sense) {
  const tags = new Set((sense.tags || []).map(lc));
  const cats = catText(sense.categories);
  const g = new Set();
  if (SLANG.some((t) => tags.has(t)) || /\b(internet|slang)\b/.test(cats)) g.add("slang");
  if (tags.has("idiomatic") || cats.includes("idioms")) g.add("idioms");
  if (RARE.some((t) => tags.has(t))) g.add("rare");
  if (ARCHAIC.some((t) => tags.has(t))) g.add("archaic");
  return g;
}
const isFormOf = (s) => (s.tags || []).some((t) => /^(alt-of|form-of|abbreviation|initialism|misspelling)$/.test(lc(t)));

// Map Wiktionary topics[] -> a single `dom` (the dictionary's existing field):
// prefer the most specific topic, skipping broad umbrella categories.
const UMBRELLA = new Set(["sciences", "natural-sciences", "physical-sciences", "human-sciences",
  "applied-sciences", "social-sciences", "lifestyle", "hobbies"]);
function pickDom(topics) {
  if (!Array.isArray(topics) || !topics.length) return null;
  const specific = topics.filter((t) => !UMBRELLA.has(lc(t)));
  const t = specific[0] || topics[0];
  return t ? lc(t) : null;
}

// Build a Rootwork entry from the accumulated kaikki lines of one word.
function build(word, lines) {
  const wgroups = new Set();
  const wtopics = new Set();
  if (word.includes(" ")) wgroups.add("idioms");
  let ety = EMPTY, ipa = EMPTY;
  const syn = [], rel = [], ant = [];
  const senses = [];

  for (const o of lines) {
    if (o.pos === "phrase" || o.pos === "proverb") wgroups.add("idioms");
    const et = (o.etymology_text || EMPTY);
    if (et && LOAN_RE.test(lc(et))) wgroups.add("loan");
    if (catText(o.categories).includes("borrowed from")) wgroups.add("loan");
    if (!ety && et) ety = et.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!ipa) for (const s of (o.sounds || [])) if (s.ipa) { ipa = s.ipa; break; }
    for (const s of (o.synonyms || [])) if (s.word) syn.push(s.word);
    for (const s of (o.antonyms || [])) if (s.word) ant.push(s.word);
    for (const key of ["related", "derived", "coordinate_terms"]) for (const s of (o[key] || [])) if (s.word) rel.push(s.word);

    const posLabel = POS[o.pos] || (o.pos ? o.pos + "." : EMPTY);
    for (const s of (o.senses || [])) {
      // glosses can be hierarchical (broad topic header → specific sense); keep
      // the most-specific (last) element, not the topic header.
      const gl = ((s.glosses || []).slice(-1)[0] || EMPTY).trim();
      if (!gl || isFormOf(s) || NONSENSE_RE.test(gl)) continue;
      for (const x of senseTagGroups(s)) wgroups.add(x);
      const stopics = (s.topics || []).map(lc);
      const sense = { p: posLabel, g: gl, _g: senseTagGroups(s), _t: stopics };
      const ex = (s.examples || []).find((e) => e.text);
      if (ex) sense.x = ex.text;
      // domain — match the dictionary's existing `dom` convention (one lowercase
      // string per sense, e.g. "anatomy"/"law"/"philosophy"). Pick the most
      // specific Wiktionary topic, skipping broad umbrella terms.
      const dom = pickDom(s.topics);
      if (dom) sense.dom = dom;
      for (const t of stopics) if (TOPICS.has(t)) wtopics.add(t);
      senses.push(sense);
    }
  }
  if (!senses.length) return null;

  // keep matching-group senses first, cap, strip helper field
  const matched = [...wgroups].filter((g) => GROUPS.has(g));
  const matchedTopics = [...wtopics];
  if (!matched.length && !matchedTopics.length) return null;
  // Quality-gate words that qualify ONLY via the bloat-heavy groups (idioms /
  // archaic): require some richness (an example, an etymology, or 2+ senses) so
  // we drop bare long-tail phrases but keep established ones. A topic match
  // (e.g. philosophy) is always worth keeping, so it bypasses the gate.
  if (GATE && !matchedTopics.length && matched.length && matched.every((g) => g === "idioms" || g === "archaic")) {
    const rich = senses.some((s) => s.x) || !!ety || senses.length >= 2;
    if (!rich) return null;
  }
  const swant = (s) => ([...s._g].some((g) => GROUPS.has(g)) || s._t.some((t) => TOPICS.has(t)) ? 1 : 0);
  senses.sort((a, b) => swant(b) - swant(a));
  const d = senses.slice(0, MAX_SENSES).map((s) => { const o = { p: s.p, g: s.g }; if (s.x) o.x = s.x; if (s.dom) o.dom = s.dom; return o; });

  const dedup = (a, cap) => [...new Set(a.map((w) => String(w)))].filter((w) => lc(w) !== lc(word)).slice(0, cap);
  const e = { d };
  if (ety) e.e = ety;
  const S = dedup(syn, MAX_SYN), A = dedup(ant, MAX_SYN), R = dedup(rel, MAX_REL);
  if (S.length) e.s = S;
  if (A.length) e.a = A;
  if (R.length) e.r = R;
  if (ipa) e.i = ipa;
  return { groups: wgroups, topics: wtopics, entry: e, senses };
}

// shardable headword: first two chars ascii letters (matches word.js)
const shardKey = (w) => { const k = lc(w).slice(0, 2); return /^[a-z]{2}$/.test(k) ? k : null; };

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  const counts = { seen: 0, kept: 0, unshardable: 0, existingNoNew: 0, existingTouched: 0, sensesAdded: 0 };
  const byGroup = {}, byGroupEx = {}; const samples = [], samplesEx = [];
  const byTopic = {}, byTopicEx = {};
  const pending = new Map();    // shardKey -> { word: entry }            (new headwords)
  const pendingAdd = new Map(); // shardKey -> { word: [senseObj, ...] }  (senses for existing)

  let curWord = null, buf = [];
  const flush = () => {
    if (!curWord || !buf.length) return;
    counts.seen++;
    const wl = curWord.toLowerCase();
    const key = shardKey(curWord);
    if (!key) { counts.unshardable++; return; }
    const built = build(curWord, buf);
    if (!built) return; // matched no requested group (or quality-gated out)

    if (existing.has(wl)) {
      // existing headword: only ADD new, group-matching senses it doesn't have
      if (!SENSES_EXISTING) return;
      const have = existingGloss.get(wl) || new Set();
      const seen = new Set(have);
      const adds = [];
      for (const s of built.senses) {
        // sense itself must match a requested group OR topic
        if (![...s._g].some((g) => GROUPS.has(g)) && !s._t.some((t) => TOPICS.has(t))) continue;
        const n = normGloss(s.g);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        const o = { p: s.p, g: s.g }; if (s.x) o.x = s.x; if (s.dom) o.dom = s.dom;
        adds.push(o);
      }
      if (!adds.length) { counts.existingNoNew++; return; }
      counts.existingTouched++; counts.sensesAdded += adds.length;
      for (const g of built.groups) if (GROUPS.has(g)) byGroupEx[g] = (byGroupEx[g] || 0) + 1;
      for (const t of built.topics) byTopicEx[t] = (byTopicEx[t] || 0) + 1;
      if (samplesEx.length < 18) samplesEx.push([curWord, adds.slice(0, 2).map((a) => "(" + (a.p || "?") + ")" + (a.dom ? " [" + a.dom + "]" : EMPTY) + " " + a.g)]);
      if (APPLY) { if (!pendingAdd.has(key)) pendingAdd.set(key, {}); pendingAdd.get(key)[curWord] = adds; }
      return;
    }

    // brand-new headword
    counts.kept++;
    for (const g of built.groups) if (GROUPS.has(g)) byGroup[g] = (byGroup[g] || 0) + 1;
    for (const t of built.topics) byTopic[t] = (byTopic[t] || 0) + 1;
    const tag = [...[...built.groups].filter((g) => GROUPS.has(g)), ...built.topics];
    if (samples.length < 30) samples.push([curWord, tag, built.entry]);
    if (APPLY) { if (!pending.has(key)) pending.set(key, {}); pending.get(key)[curWord] = built.entry; }
    if (LIMIT && counts.kept >= LIMIT) { rl.close(); }
  };

  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.lang_code && o.lang_code !== "en") continue;
    if (!o.word) continue;
    if (o.word !== curWord) { flush(); curWord = o.word; buf = []; }
    buf.push(o);
  }
  flush();

  // write: one load+write per shard, applying new headwords and sense-additions
  let added = 0, sensesWritten = 0, shardsTouched = 0;
  if (APPLY) {
    const keys = new Set([...pending.keys(), ...pendingAdd.keys()]);
    for (const key of keys) {
      const p = path.join(WORDS_DIR, key + ".json");
      const obj = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      let changed = false;
      for (const [w, entry] of Object.entries(pending.get(key) || {})) {
        if (Object.prototype.hasOwnProperty.call(obj, w)) continue; // never overwrite
        obj[w] = entry; added++; changed = true;
      }
      for (const [w, adds] of Object.entries(pendingAdd.get(key) || {})) {
        const cur = obj[w];
        if (!cur || !Array.isArray(cur.d)) continue; // only extend a real existing entry
        const have = new Set(cur.d.map((dd) => normGloss(dd.g)));
        let room = MAX_TOTAL_SENSES - cur.d.length;
        for (const s of adds) {
          if (room <= 0) break;
          const n = normGloss(s.g);
          if (have.has(n)) continue;
          cur.d.push(s); have.add(n); room--; sensesWritten++; changed = true;
        }
      }
      if (changed) { fs.writeFileSync(p, stringifyShard(obj)); shardsTouched++; }
    }
  }

  const L = [];
  L.push("IMPORT-KAIKKI " + (APPLY ? "APPLIED" : "DRY RUN") + " — groups: " + ([...GROUPS].join(",") || "(none)") +
    (TOPICS.size ? " | topics: " + [...TOPICS].join(",") : EMPTY) + (GATE ? " (idiom/archaic quality-gated)" : EMPTY));
  L.push("=".repeat(60));
  L.push("words in source seen:     " + counts.seen);
  L.push("unshardable (non-ascii/short initial): " + counts.unshardable);
  L.push("NEW headwords kept:       " + counts.kept);
  for (const g of GROUPS) L.push("   " + g + ": " + (byGroup[g] || 0));
  for (const t of TOPICS) L.push("   topic:" + t + ": " + (byTopic[t] || 0));
  L.push("EXISTING words gaining senses: " + counts.existingTouched + " (+" + counts.sensesAdded + " senses)");
  for (const g of GROUPS) if (byGroupEx[g]) L.push("   " + g + ": " + byGroupEx[g]);
  for (const t of TOPICS) if (byTopicEx[t]) L.push("   topic:" + t + ": " + byTopicEx[t]);
  if (APPLY) L.push("WRITTEN: " + added + " new headwords, " + sensesWritten + " senses added, across " + shardsTouched + " shards");
  L.push("");
  L.push("---- sample NEW entries ----");
  for (const [w, gs, e] of samples) {
    L.push("[" + w + "] {" + gs.join(",") + "}");
    for (const dd of e.d.slice(0, 2)) L.push("   (" + (dd.p || "?") + ")" + (dd.dom ? " [" + dd.dom + "]" : EMPTY) + " " + dd.g);
    if (e.e) L.push("   ety: " + e.e.slice(0, 120));
  }
  L.push("");
  L.push("---- sample NEW SENSES on existing words ----");
  for (const [w, gl] of samplesEx) { L.push("[" + w + "] +"); for (const g of gl) L.push("   " + g); }
  const out = path.join(__dirname, "..", "import-kaikki-" + (APPLY ? "applied" : "dryrun") + ".txt");
  fs.writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write(L.join("\n") + "\n");
  process.stderr.write("\nreport at " + out + "\n");
}

main().catch((e) => { process.stderr.write("import-kaikki.js: " + e.message + "\n"); process.exit(1); });
