// Build rich, lazily-loadable per-word data from Wiktextract (kaikki.org).
//
// Streams the English Wiktionary extract on stdin (JSONL, one entry per line),
// keeps the words in our existing vocabulary, and writes sharded files under
// words/<first-two-letters>.json so the app can fetch just the shard it needs
// instead of one giant upfront download. Each word record:
//
//   { d:[{p,g,x?}], e:etymology, s:[syn], a:[ant], r:[related], i:ipa, rs:respelling }
//
// Definitions/etymology/relations come from Wiktionary; respelling from the CMU
// dictionary (scripts/arpabet.js). WordNet (dictionary.json) and our existing
// thesaurus.json are used only as fallbacks. Run:
//
//   curl -s <kaikki english jsonl url> | npm run build:rich

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const cmudict = require("cmu-pronouncing-dictionary").dictionary;
const { convert } = require("./arpabet.js");

const ROOT = path.join(__dirname, "..");
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "dictionary.json"), "utf8"));
const thes = JSON.parse(fs.readFileSync(path.join(ROOT, "thesaurus.json"), "utf8"));
const target = new Set(Object.keys(dict)); // ~77k single words we already define

const POSABBR = {
  noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", adj: "adj.",
  preposition: "prep.", conjunction: "conj.", pronoun: "pron.", interjection: "interj.",
  numeral: "num.", determiner: "det.", article: "art.", particle: "part.",
};
const posAbbr = (p) => POSABBR[p] || (p ? p.slice(0, 4) + "." : "");

function cleanEt(t) {
  if (!t) return "";
  t = t.replace(/\s+/g, " ").replace(/^Etymology tree\s*/i, "").trim();
  if (t.length > 320) {
    const cut = t.slice(0, 320);
    const i = cut.lastIndexOf(". ");
    t = (i > 120 ? cut.slice(0, i + 1) : cut.trimEnd()) + " …";
  }
  return t;
}
function pickWords(arr, max, exclude) {
  const out = [], seen = new Set();
  for (const x of arr || []) {
    const w = x && x.word;
    if (!w || w === exclude || !/^[a-z]{2,}$/.test(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
function shardKey(w) { return w.slice(0, 2).toLowerCase(); }

const MAX_SENSES = 12; // was effectively 4; lifted so distinct senses survive
// Collapse a sense's Wiktionary topics into one concise domain label (its
// "location" in meaning space). Broad umbrella topics are skipped in favour of a
// specific one (computing over sciences).
const BROAD_TOPICS = new Set([
  "sciences", "natural-sciences", "physical-sciences", "human-sciences",
  "social-sciences", "applied-sciences", "engineering", "mathematics",
]);
function pickDomain(topics) {
  if (!topics || !topics.length) return null;
  const specific = topics.find((t) => !BROAD_TOPICS.has(t));
  return specific || topics[0];
}
function normGloss(g) { return String(g || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 45); }
// All non-archaic senses of one part-of-speech block, with a domain tag.
function extractSenses(o, limit) {
  const out = [];
  for (const s of o.senses || []) {
    if (out.length >= limit) break;
    if (!s.glosses || !s.glosses.length) continue;
    if (s.tags && (s.tags.includes("obsolete") || s.tags.includes("archaic"))) continue;
    const entry = { p: posAbbr(o.pos), g: s.glosses[s.glosses.length - 1] };
    const ex = (s.examples || []).find((e) => e.text && e.text.length < 160);
    if (ex) entry.x = ex.text;
    const dom = pickDomain(s.topics);
    if (dom) entry.dom = dom;
    out.push(entry);
  }
  return out;
}
// Append WordNet senses (dictionary.json) Wiktionary didn't cover, deduped by gloss.
function mergeWordNet(d, wnEntry, limit) {
  if (!wnEntry) return d;
  const have = new Set(d.map((x) => normGloss(x.g)));
  for (const s of wnEntry) {
    if (d.length >= limit) break;
    const g = s.d; if (!g) continue;
    const key = normGloss(g);
    if (have.has(key)) continue;
    have.add(key);
    d.push({ p: s.p, g: g });
  }
  return d;
}

// Reusable extraction helpers (used by build-rich-pilot.js for per-word fetches).
module.exports = { extractSenses, pickDomain, mergeWordNet, posAbbr, cleanEt, normGloss, MAX_SENSES };

// Below: the full-dump streaming build. Guarded so requiring this file for its
// helpers doesn't hang waiting on stdin.
if (require.main === module) {

const rec = Object.create(null);
function ensure(w) { return rec[w] || (rec[w] = { d: [], s: [], a: [], r: [] }); }

const rl = readline.createInterface({ input: process.stdin });
let lines = 0;
rl.on("line", function (line) {
  lines++;
  if ((lines % 200000) === 0) process.stderr.write("  ..." + lines + " lines\n");
  if (line.indexOf('"senses"') < 0) return; // skip redirects / entries without senses
  let o; try { o = JSON.parse(line); } catch { return; }
  const w = o.word;
  if (!w || !target.has(w) || !o.senses) return;

  const r = ensure(w);
  if (r.d.length < MAX_SENSES) r.d = r.d.concat(extractSenses(o, MAX_SENSES - r.d.length));
  if (!r.e && o.etymology_text) { const e = cleanEt(o.etymology_text); if (e) r.e = e; }
  if (!r.i && o.sounds) {
    const ga = o.sounds.find((s) => s.ipa && (s.tags || []).some((t) => /General.American|GenAm|\bUS\b/.test(t)))
      || o.sounds.find((s) => s.ipa);
    if (ga) r.i = ga.ipa;
  }
  r.s = r.s.concat(pickWords(o.synonyms, 12, w));
  r.a = r.a.concat(pickWords(o.antonyms, 8, w));
  r.r = r.r.concat(pickWords(o.related, 12, w)).concat(pickWords(o.derived, 12, w));
  if (!r.b && o.etymology_templates) { const b = extractBreakdown(o.etymology_templates, w); if (b) r.b = b; }
});

// Wiktionary's own morphological analysis (affix/prefix/suffix/confix/compound),
// as ordered parts [{ s: surface, k: kind, g: gloss }]. This is the authoritative
// split the app uses to rescue words the heuristic engine mangles.
function stripAnno(s) { return String(s).replace(/<[^>]*>/g, "").trim(); }
function extractBreakdown(templates, word) {
  const want = { prefix: 1, suffix: 1, confix: 1, affix: 1, compound: 1, blend: 1 };
  const t = templates.find((x) => want[x.name] && x.args);
  if (!t) return null;
  const a = t.args;
  const keys = Object.keys(a).filter((k) => /^[0-9]+$/.test(k) && Number(k) >= 2).sort((x, y) => x - y);
  const raw = keys.map((k) => stripAnno(a[k])).filter(Boolean);
  if (raw.length < 2) return null;

  function gloss(i) { // i: 1-based part index
    if (a["t" + i]) return a["t" + i];
    if (a["gloss" + i]) return a["gloss" + i];
    if (a["pos" + i]) { const m = a["pos" + i].match(/[‘'"“]([^’'"”]+)[’'"”]/); return m ? m[1] : null; }
    return null;
  }
  const n = raw.length;
  const parts = raw.map(function (s, idx) {
    let k;
    if (t.name === "compound" || t.name === "blend") k = "root";
    else if (t.name === "prefix") k = idx === 0 ? "prefix" : "root";
    else if (t.name === "suffix") k = idx === n - 1 ? "suffix" : "root";
    else if (t.name === "confix") k = idx === 0 ? "prefix" : idx === n - 1 ? "suffix" : "root";
    else k = s.charAt(0) === "-" ? "suffix" : s.charAt(s.length - 1) === "-" ? "prefix" : "root";
    const out = { s: s.replace(/^-|-$/g, ""), k: k };
    const g = gloss(idx + 1);
    if (g) out.g = g;
    return out;
  }).filter((p) => p.s);

  // Only keep it if the surfaces actually tile the word (so the breakdown line
  // still reads as the word); otherwise the engine's segmentation is better.
  if (parts.length < 2) return null;
  if (parts.map((p) => p.s).join("").toLowerCase() !== word.toLowerCase()) return null;
  return parts;
}

rl.on("close", function () {
  const dedupe = (a, m, w) => {
    const out = [], seen = new Set();
    for (const x of a) { if (x !== w && !seen.has(x)) { seen.add(x); out.push(x); } if (out.length >= m) break; }
    return out;
  };
  const shards = {};
  let withData = 0;
  for (const w of target) {
    const r = rec[w] || {};
    const out = {};

    let d = (r.d || []).slice(0, MAX_SENSES);
    d = mergeWordNet(d, dict[w], MAX_SENSES); // pull in WordNet senses Wiktionary missed
    if (d.length) out.d = d;
    if (r.e) out.e = r.e;

    let s = dedupe(r.s || [], 8, w);
    if (!s.length && thes[w] && thes[w].s) s = thes[w].s;
    let a = dedupe(r.a || [], 6, w);
    if (!a.length && thes[w] && thes[w].a) a = thes[w].a;
    const rel = dedupe(r.r || [], 10, w);
    if (s.length) out.s = s;
    if (a.length) out.a = a;
    if (rel.length) out.r = rel;

    const arp = cmudict[w];
    const c = arp ? convert(arp) : null;
    const ipa = r.i || (c && c.ipa);
    if (ipa) out.i = ipa;
    if (c) out.rs = c.resp;
    if (r.b) out.b = r.b;

    if (!Object.keys(out).length) continue;
    withData++;
    const k = shardKey(w);
    (shards[k] = shards[k] || {})[w] = out;
  }

  const dir = path.join(ROOT, "words");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f));
  let files = 0, total = 0;
  for (const k of Object.keys(shards)) {
    const p = path.join(dir, k + ".json");
    fs.writeFileSync(p, JSON.stringify(shards[k]));
    files++; total += fs.statSync(p).size;
  }
  console.log("lines read:", lines);
  console.log("words with data:", withData, "of", target.size);
  console.log("shard files:", files, "total MB:", (total / 1048576).toFixed(2));
});

} // end require.main guard
