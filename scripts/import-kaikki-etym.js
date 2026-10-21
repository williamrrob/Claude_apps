#!/usr/bin/env node
/*
 * import-kaikki-etym.js — read Wiktionary's STRUCTURED etymology data from the
 * Kaikki English dump (wiktextract) instead of re-parsing prose.
 *
 *   input:  vendor-data/kaikki-en.jsonl.gz
 *           (https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz)
 *   output: vendor-data/kaikki-etym.jsonl — one line per English headword:
 *     { w, e,            full etymology text (the "Etymology tree" block removed)
 *       ch:[{l,t,g?,k}], line of descent from the inh/bor/der/… templates, nearest first
 *       pa:[{t,g?}],     English surface analysis from af/prefix/suffix/compound/surf/confix
 *       db:[word…],      doublets ({{doublet}})
 *       cg:[{l,t,g?}],   cognates ({{cog}}/{{ncog}})
 *       ss:{syn: gloss}  synonyms → the gloss of THIS word's sense they belong to }
 *           vendor-data/kaikki-langs.json — language code → name, learned from expansions
 *
 *   node scripts/import-kaikki-etym.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const ROOT = path.join(__dirname, "..");
const IN = path.join(ROOT, "vendor-data", "kaikki-en.jsonl.gz");
const OUT = path.join(ROOT, "vendor-data", "kaikki-etym.jsonl");

const CHAIN = new Map([
  ["inh", "inh"], ["inh+", "inh"], ["inh-lite", "inh"], ["inherited", "inh"],
  ["bor", "bor"], ["bor+", "bor"], ["borrowed", "bor"], ["ubor", "bor"], ["obor", "bor"],
  ["lbor", "lbor"], ["learned borrowing", "lbor"], ["slbor", "lbor"],
  ["der", "der"], ["der+", "der"], ["der-lite", "der"], ["derived", "der"],
  ["cal", "cal"], ["calque", "cal"], ["clq", "cal"], ["pcal", "cal"], ["sl", "cal"], ["psm", "cal"],
]);
const PARTS = new Set(["af", "affix", "prefix", "pre", "suffix", "suf", "confix", "con", "compound", "com", "blend", "surf", "univerbation", "univ"]);
const DOUBLET = new Set(["doublet", "dbt", "piecewise doublet"]);
const COG = new Set(["cog", "cognate", "ncog", "noncog", "nc"]);
const LEAD = /^(?:(?:Partly |Ultimately |Probably |Possibly )?(?:Inherited|Borrowed|Derived|Learned borrowing|Semi-learned borrowing|Unadapted borrowing|Orthographic borrowing|Calque|Partial calque|Semantic loan|Phono-semantic matching)\s+(?:from|of)\s+)/i;

const langVotes = new Map(); // code -> Map(name -> n)
function vote(code, name) {
  if (!code || !name || name.length > 40) return;
  let m = langVotes.get(code); if (!m) langVotes.set(code, (m = new Map()));
  m.set(name, (m.get(name) || 0) + 1);
}
const pos = (a, k) => (a && a[k] != null && String(a[k]).trim() !== "" ? String(a[k]).trim() : null);
// Wiktionary inline modifiers on a part: "non-<id:not>", "word<t:gloss><pos:noun>"
const modGloss = (v) => { const m = String(v || "").match(/<(?:t|gloss):([^>]*)>/); return m ? m[1].trim() : null; };
const bare = (v) => String(v || "").replace(/<[^>]*>/g, "").trim();

function chainStep(t) {
  const a = t.args || {};
  const code = pos(a, "2"), raw = pos(a, "3") || pos(a, "4"), term = raw && bare(raw);
  if (!code || !term || term === "-") return null;
  const g = pos(a, "t") || pos(a, "gloss") || pos(a, "5") || modGloss(raw);
  // language name = the expansion's lead, before the displayed form
  let exp = String(t.expansion || "").replace(LEAD, "");
  const shown = pos(a, "4") || term;
  const k = exp.indexOf(shown.split(",")[0]);
  if (k > 0) vote(code, exp.slice(0, k).trim());
  return { c: code, t: term, g: g || undefined, k: CHAIN.get(t.name) };
}
function partsOf(t) {
  const a = t.args || {};
  if (pos(a, "1") !== "en") return null;
  // a part tagged with another language isn't English surface analysis
  for (const key of Object.keys(a)) if (/^lang\d+$/.test(key) && a[key] && a[key] !== "en") return null;
  const nums = Object.keys(a).filter((x) => /^\d+$/.test(x) && Number(x) >= 2).sort((x, y) => x - y);
  let ps = nums.map((n) => ({ t: bare(a[n]), mg: modGloss(a[n]), i: Number(n) - 1 })).filter((p) => p.t);
  if (t.name === "prefix" || t.name === "pre") {
    if (ps.length < 2) return null;
    ps = ps.map((p, j) => ({ ...p, t: j < ps.length - 1 && !/-$/.test(p.t) ? p.t + "-" : p.t }));
  } else if (t.name === "suffix" || t.name === "suf") {
    if (ps.length < 2) return null;
    ps = ps.map((p, j) => ({ ...p, t: j > 0 && !/^-/.test(p.t) ? "-" + p.t : p.t }));
  } else if (t.name === "confix" || t.name === "con") {
    if (ps.length < 2) return null;
    ps = ps.map((p, j) => ({ ...p, t: j === 0 && !/-$/.test(p.t) ? p.t + "-" : j === ps.length - 1 && !/^-/.test(p.t) ? "-" + p.t : p.t }));
  }
  if (ps.length < 2) return null;
  return ps.map((p) => {
    const g = pos(a, "t" + p.i) || pos(a, "gloss" + p.i) || p.mg;
    const o = { t: p.t }; if (g) o.g = g; return o;
  });
}
function cleanText(word, e) {
  let s = String(e || "");
  // the "Etymology tree" block (rendered {{etymon}} tree) ends with "English <word>"
  if (/^Etymology tree\b/.test(s)) {
    const tag = "\nEnglish " + word + "\n";
    const k = s.indexOf(tag);
    s = k >= 0 ? s.slice(k + tag.length) : s.replace(/^Etymology tree[\s\S]*?\n(?=[A-Z][a-z]+ from|From |Borrowed |Inherited |Learned |Derived )/, "");
  }
  return s.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(IN).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const out = new Map(); // word -> record (first etymology wins; senses/synonyms merge)
  let n = 0;
  const t0 = Date.now();
  for await (const line of rl) {
    n++;
    if (n % 200000 === 0) process.stderr.write(`  ${n} lines, ${out.size} words, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    if (j.lang_code !== "en" || !j.word) continue;
    const w = j.word;
    let r = out.get(w);
    if (!r) { r = { w }; out.set(w, r); }
    const tpl = j.etymology_templates || [];
    if (!r.ch && (tpl.length || j.etymology_text)) {
      const ch = [], cg = [], db = [];
      let pa = null;
      // where each template's rendered text sits in the etymology, so we can
      // read the connector before it (", from" = next step, "+" = component,
      // "and" = a parallel source) rather than assume one straight line
      const text = String(j.etymology_text || "");
      let cursor = 0;
      const locate = (t) => {
        const exp = String(t.expansion || "").split("\n").pop();
        if (!exp) return null;
        const k = text.indexOf(exp, cursor);
        if (k < 0) return null;
        const sep = text.slice(cursor, k);
        cursor = k + exp.length;
        return sep;
      };
      for (const t of tpl) {
        const sep = locate(t);
        if (CHAIN.has(t.name)) {
          const s = chainStep(t);
          if (s && !(s.c === "en" && s.t === w)) {
            if (sep != null) {
              const tail = sep.slice(-24);
              if (/\+\s*$/.test(tail)) s.j = "+";
              else if (/\b(?:and|or)\s+$/.test(tail) && !/from\s+$/.test(tail)) s.j = "&";
            }
            ch.push(s);
          }
        }
        else if (PARTS.has(t.name)) { if (!pa) pa = partsOf(t); }
        else if (DOUBLET.has(t.name)) {
          const a = t.args || {};
          Object.keys(a).filter((x) => /^\d+$/.test(x) && Number(x) >= 2).sort((x, y) => x - y)
            .forEach((x) => { const v = bare(a[x]); if (v && v !== w && db.indexOf(v) < 0) db.push(v); });
        } else if (COG.has(t.name)) {
          const a = t.args || {};
          const code = pos(a, "1"), term = pos(a, "2") && bare(pos(a, "2"));
          if (code && term && code !== "en") {
            const g = pos(a, "t") || pos(a, "gloss") || pos(a, "4");
            const exp = String(t.expansion || ""); const k = exp.indexOf(term);
            if (k > 0) vote(code, exp.slice(0, k).trim());
            cg.push(g ? { c: code, t: term, g } : { c: code, t: term });
          }
        }
      }
      r.e = cleanText(w, j.etymology_text);
      r.ch = ch;
      if (pa) r.pa = pa;
      if (db.length) r.db = db;
      if (cg.length) r.cg = cg.slice(0, 14);
    }
    // synonyms → the gloss of the sense they belong to
    const senses = j.senses || [];
    const add = (syn, gloss) => {
      if (!syn || syn === w) return;
      r.ss = r.ss || {};
      if (!r.ss[syn] || (gloss && !r.ss[syn])) r.ss[syn] = gloss || r.ss[syn] || "";
    };
    for (const s of senses) {
      const gloss = (s.glosses || [])[(s.glosses || []).length - 1] || "";
      for (const sy of s.synonyms || []) add(sy.word, gloss);
    }
    for (const sy of j.synonyms || []) {
      // entry-level synonyms carry a "sense" label; match it to a sense gloss when it is one
      const lab = sy.sense || "";
      let gloss = "";
      if (lab) {
        const hit = senses.find((s) => (s.glosses || []).some((g) => g.toLowerCase().indexOf(lab.toLowerCase()) >= 0));
        gloss = hit ? hit.glosses[hit.glosses.length - 1] : lab;
      }
      add(sy.word, gloss);
    }
  }
  // resolve language codes
  const langs = {};
  for (const [code, m] of langVotes) { let b = null, c = -1; for (const [nm, v] of m) if (v > c) { b = nm; c = v; } langs[code] = b; }
  fs.writeFileSync(path.join(ROOT, "vendor-data", "kaikki-langs.json"), JSON.stringify(langs, null, 0));
  const ws = fs.createWriteStream(OUT);
  let withChain = 0, withParts = 0, withDbl = 0, withSS = 0, withSSgloss = 0;
  for (const r of out.values()) {
    if (r.ch) r.ch = r.ch.map((s) => { const o = { l: langs[s.c] || s.c, t: s.t, k: s.k }; if (s.g) o.g = s.g; if (s.j) o.j = s.j; return o; });
    if (r.cg) r.cg = r.cg.map((s) => { const o = { l: langs[s.c] || s.c, t: s.t }; if (s.g) o.g = s.g; return o; });
    if (r.ch && r.ch.length) withChain++;
    if (r.pa) withParts++;
    if (r.db) withDbl++;
    if (r.ss) { withSS++; if (Object.values(r.ss).some(Boolean)) withSSgloss++; }
    ws.write(JSON.stringify(r) + "\n");
  }
  ws.end();
  process.stderr.write(`done: ${n} lines → ${out.size} words; chain ${withChain}, parts ${withParts}, doublets ${withDbl}, synonyms ${withSS} (${withSSgloss} sense-linked); ${Object.keys(langs).length} language codes; ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
main();
