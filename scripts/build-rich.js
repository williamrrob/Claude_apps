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
  for (const s of o.senses) {
    if (r.d.length >= 4) break;
    if (!s.glosses || !s.glosses.length) continue;
    if (s.tags && (s.tags.includes("obsolete") || s.tags.includes("archaic"))) continue;
    const entry = { p: posAbbr(o.pos), g: s.glosses[s.glosses.length - 1] };
    const ex = (s.examples || []).find((e) => e.text && e.text.length < 160);
    if (ex) entry.x = ex.text;
    r.d.push(entry);
  }
  if (!r.e && o.etymology_text) { const e = cleanEt(o.etymology_text); if (e) r.e = e; }
  if (!r.i && o.sounds) {
    const ga = o.sounds.find((s) => s.ipa && (s.tags || []).some((t) => /General.American|GenAm|\bUS\b/.test(t)))
      || o.sounds.find((s) => s.ipa);
    if (ga) r.i = ga.ipa;
  }
  r.s = r.s.concat(pickWords(o.synonyms, 12, w));
  r.a = r.a.concat(pickWords(o.antonyms, 8, w));
  r.r = r.r.concat(pickWords(o.related, 12, w)).concat(pickWords(o.derived, 12, w));
});

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

    let d = (r.d || []).slice(0, 4);
    if (!d.length && dict[w]) d = dict[w].slice(0, 4).map((s) => ({ p: s.p, g: s.d }));
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
