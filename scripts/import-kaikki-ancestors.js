#!/usr/bin/env node
/*
 * import-kaikki-ancestors.js — the other half of Wiktionary: the entries for
 * the ANCESTOR forms themselves (Latin hospitālis, Old French hostel, PIE
 * *gʰóstis …), from the all-languages Kaikki dump. Each carries its own gloss
 * and its own etymology, so a line of descent can continue from an ancestor's
 * entry where the English entry stopped.
 *
 *   input:  vendor-data/raw-wiktextract-data.jsonl.gz
 *           (https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz)
 *           vendor-data/kaikki-langs.json (code → name, from import-kaikki-etym.js)
 *   output: vendor-data/kaikki-ancestors.jsonl — one line per (language, form):
 *           { l, t, g?, ch:[{l,t,g?,k,j?}], hom? }   hom = number of distinct
 *           etymologies Wiktionary lists for this spelling (a homograph flag)
 *
 *   node scripts/import-kaikki-ancestors.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const ROOT = path.join(__dirname, "..");
const IN = path.join(ROOT, "vendor-data", "raw-wiktextract-data.jsonl.gz");
const OUT = path.join(ROOT, "vendor-data", "kaikki-ancestors.jsonl");
const LANGS = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor-data", "kaikki-langs.json"), "utf8"));

const CHAIN = new Map([
  ["inh", "inh"], ["inh+", "inh"], ["inh-lite", "inh"], ["bor", "bor"], ["bor+", "bor"], ["ubor", "bor"], ["obor", "bor"],
  ["lbor", "lbor"], ["slbor", "lbor"], ["der", "der"], ["der+", "der"], ["der-lite", "der"],
  ["cal", "cal"], ["calque", "cal"], ["clq", "cal"],
]);
const PARTS = new Set(["af", "affix", "prefix", "pre", "suffix", "suf", "confix", "con", "compound", "com"]);
const pos = (a, k) => (a && a[k] != null && String(a[k]).trim() !== "" ? String(a[k]).trim() : null);
const bare = (v) => String(v || "").replace(/<[^>]*>/g, "").trim();
const modGloss = (v) => { const m = String(v || "").match(/<(?:t|gloss):([^>]*)>/); return m ? m[1].trim() : null; };

// which languages to keep: every ancestor language (codes seen in English
// etymology templates), English itself excluded
const keepCodes = new Set(Object.keys(LANGS).filter((c) => c !== "en"));
const LC = /"lang_code": "([^"]+)"/;
const WD = /"word": "((?:[^"\\]|\\.)*)"/;
const LG = /"lang": "([^"]+)"/;
// node identity, mirrored from build-etym-graph.js (family-collapsed language + folded form)
const fold = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[*]/g, "").trim();
const FAMILY = (l) => (/(?:^|\s)Latin$/.test(l) && l !== "Old Latin" ? "Latin"
  : /^(?:Ancient|Koine|Hellenistic|Byzantine|Attic|Epic|Doric|Ionic) Greek$/.test(l) ? "Ancient Greek" : l);
const latinCitation = (t) => t.replace(/tatem$/, "tas").replace(/([st])ionem$/, "$1io").replace(/ationem$/, "atio").replace(/torem$/, "tor").replace(/sorem$/, "sor").replace(/ionem$/, "io");
const keyOf = (l, t) => { const fam = FAMILY(l); let f = fold(t); if (fam === "Latin") f = latinCitation(f); return fam + "|" + f; };
// keep: every form already on the map, and every lemma in an ancestor-stage
// language (so a chain can keep climbing through forms the map hasn't met yet)
const onMap = new Set();
for (const f of fs.readdirSync(path.join(ROOT, "g"))) for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "g", f), "utf8")))) if (!k.startsWith("English|")) onMap.add(k);
const ANCESTRAL = /^(?:Proto-|Pre-|Old |Middle |Late |Medieval |Vulgar |Classical |Ecclesiastical |Ancient |Koine |Byzantine |Hellenistic )|^(?:Latin|Sanskrit|Avestan|Gothic|Frankish|Anglo-Norman|Akkadian|Sumerian|Hittite|Aramaic|Hebrew|Coptic|Egyptian|Pali|Prakrit|Etruscan|Oscan|Umbrian|Gaulish|Tocharian [AB]|Mycenaean Greek|Classical Syriac|Old Norse)$/;

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(IN).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const out = new Map(); // "lang|word" -> rec
  let n = 0, kept = 0;
  const t0 = Date.now();
  for await (const line of rl) {
    n++;
    if (n % 1000000 === 0) process.stderr.write(`  ${n / 1e6}M lines, ${out.size} forms, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    // parse every line: in big entries the top-level lang_code sits deep in
    // the record and nested objects carry their own, so no regex shortcut is safe
    let j; try { j = JSON.parse(line); } catch (e) { continue; }
    if (!j.lang_code || !keepCodes.has(j.lang_code)) continue;
    if (!j.word || !j.lang) continue;
    if (!ANCESTRAL.test(j.lang) && !onMap.has(keyOf(j.lang, j.word))) continue;
    const m = [null, j.lang_code];
    const senses = j.senses || [];
    // inflected forms ("genitive of …") are not lemmas
    if (senses.length && senses.every((s) => s.form_of || s.alt_of || (s.tags || []).includes("form-of"))) continue;
    const key = j.lang + "|" + j.word;
    let r = out.get(key);
    if (!r) { r = { l: j.lang, t: j.word, ety: new Set() }; out.set(key, r); }
    kept++;
    if (j.etymology_number) r.ety.add(j.etymology_number);
    if (!r.g) {
      const s = senses.find((x) => (x.glosses || []).length && !x.form_of);
      if (s) { const g = s.glosses[s.glosses.length - 1]; r.g = g.length > 140 ? g.slice(0, 137) + "…" : g; }
    }
    if (r.ch) continue; // first etymology wins (etymology 1)
    const ch = [];
    let pa = null;
    const text = String(j.etymology_text || "");
    let cursor = 0;
    for (const t of j.etymology_templates || []) {
      const exp = String(t.expansion || "").split("\n").pop();
      let sep = null;
      if (exp) { const k = text.indexOf(exp, cursor); if (k >= 0) { sep = text.slice(cursor, k); cursor = k + exp.length; } }
      const a = t.args || {};
      if (CHAIN.has(t.name)) {
        const code = pos(a, "2"), raw = pos(a, "3") || pos(a, "4"), term = raw && bare(raw);
        if (!code || !term || term === "-") continue;
        const g = pos(a, "t") || pos(a, "gloss") || pos(a, "5") || modGloss(raw);
        const st = { l: LANGS[code] || code, t: term, k: CHAIN.get(t.name) };
        if (g) st.g = g;
        if (sep != null) { const tail = sep.slice(-24); if (/\+\s*$/.test(tail)) st.j = "+"; else if (/\b(?:and|or)\s+$/.test(tail) && !/from\s+$/.test(tail)) st.j = "&"; }
        ch.push(st);
      } else if (!pa && PARTS.has(t.name) && pos(a, "1") === m[1]) {
        // same-language formation (Latin in- + crēdibilis): the parts, in the entry's language
        const nums = Object.keys(a).filter((x) => /^\d+$/.test(x) && Number(x) >= 2).sort((x, y) => x - y);
        let ps = nums.map((x) => bare(a[x])).filter(Boolean);
        if (t.name === "prefix" || t.name === "pre") ps = ps.map((p, i) => (i < ps.length - 1 && !/-$/.test(p) ? p + "-" : p));
        if (t.name === "suffix" || t.name === "suf") ps = ps.map((p, i) => (i > 0 && !/^-/.test(p) ? "-" + p : p));
        if (ps.length >= 2) pa = ps;
      }
    }
    r.ch = ch;
    if (pa) r.pa = pa;
  }
  const ws = fs.createWriteStream(OUT);
  let withCh = 0, hom = 0;
  for (const r of out.values()) {
    const o = { l: r.l, t: r.t };
    if (r.g) o.g = r.g;
    if (r.ch && r.ch.length) { o.ch = r.ch; withCh++; }
    if (r.pa) o.pa = r.pa;
    if (r.ety.size > 1) { o.hom = r.ety.size; hom++; }
    if (o.g || o.ch || o.pa) ws.write(JSON.stringify(o) + "\n");
  }
  ws.end();
  process.stderr.write(`done: ${n} lines, ${kept} lemma entries kept → ${out.size} forms (${withCh} with an etymology chain, ${hom} homographs) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
main();
