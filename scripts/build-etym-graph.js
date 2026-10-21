#!/usr/bin/env node
/*
 * build-etym-graph.js — the ONE etymology graph the app renders.
 *
 * Source: the Wiktionary etymology prose already stored on every entry (`e`),
 * parsed by etym-parse.js (the same parser the browser uses for the
 * word-history timeline). No other dataset is merged in, so the ancestry tree,
 * the timeline, the doublets and the prose printed under them always agree.
 *
 * Output: g/<hh>.json — 256 shards keyed by hash(nodeKey) (see shardOf, mirrored
 * in app.js). nodeKey = "<language>|<folded term>"; English headwords are
 * "English|<word>". A node:
 *   { l, t, g?, tr?, hw?:1,            language, display form, gloss, translit, is a headword
 *     up:[[key, kind]…],                where it came from (kind: inh bor lbor der cal via aff cmp)
 *     en:[word…], ne:n,                 English headwords descending from it (top by frequency), total
 *     dbl:[[word, viaKey]…],            doublets (headwords) + the ancestor where their routes split
 *     cog:[[lang, term, gloss?]…] }     foreign cognates named in the prose
 *
 *   node scripts/build-etym-graph.js            (reads rootwork.sqlite → run `npm run build:sqlite` first)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const P = require("../etym-parse.js");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "g");

const db = new DatabaseSync(path.join(ROOT, "rootwork.sqlite"), { readOnly: true });
const headwords = new Set(db.prepare("select word from words").all().map((r) => r.word));
const rows = db.prepare("select word, ety from words where ety is not null and ety != ''").all();

const rank = new Map();
for (const line of fs.readFileSync(path.join(ROOT, "review", "ranks.tsv"), "utf8").split("\n").slice(1)) {
  const i = line.lastIndexOf("\t");
  if (i > 0) rank.set(line.slice(0, i), Number(line.slice(i + 1)));
}
const rankOf = (w) => (rank.has(w) ? rank.get(w) : 9e6 + w.length);

// language identity: dialect labels that name the same lexeme collapse
const LANG_ID = {
  "Classical Latin": "Latin",
  "Anglian Old English": "Old English", "West Saxon Old English": "Old English", "Late Old English": "Old English",
  "Northumbrian Old English": "Old English", "Mercian Old English": "Old English", "Kentish Old English": "Old English",
  "Early Middle English": "Middle English", "Late Middle English": "Middle English",
  "Northern Middle English": "Middle English", "Southern Middle English": "Middle English",
  "Hellenistic Ancient Greek": "Ancient Greek", "Attic Greek": "Ancient Greek", "Epic Greek": "Ancient Greek",
  "Modern French": "French",
};
const langId = (l) => LANG_ID[l] || l;
// identity family: period labels that cite the SAME written form share a node
// (Latin hospitālis = Late Latin hospitālis); display keeps the commonest label.
const FAMILY = (l) => /(?:^|\s)Latin$/.test(l) && l !== "Old Latin" ? "Latin"
  : /^(?:Ancient|Koine|Hellenistic|Byzantine|Attic|Epic|Doric|Ionic) Greek$/.test(l) ? "Ancient Greek" : langId(l);
// Romance etyma are cited in the Latin accusative; fold to the nominative citation form
function latinCitation(t) {
  return t.replace(/tatem$/, "tas").replace(/([st])ionem$/, "$1io").replace(/ationem$/, "atio")
    .replace(/torem$/, "tor").replace(/sorem$/, "sor").replace(/ionem$/, "io");
}
const keyOf = (l, t) => {
  const fam = FAMILY(l);
  let f = P.fold(t).replace(/^[\s.,;:]+|[\s.,;:]+$/g, "");
  if (fam === "Latin") f = latinCitation(f);
  return fam + "|" + f;
};

const nodes = new Map(); // key -> {forms:Map(display->count), glosses:Map, tr, l, up:Map(key->kind), hw, cog}
function node(l, t, g, tr) {
  const k = keyOf(l, t);
  let n = nodes.get(k);
  if (!n) { n = { labels: new Map(), forms: new Map(), glosses: new Map(), tr: tr || "", up: new Map() }; nodes.set(k, n); }
  n.labels.set(langId(l), (n.labels.get(langId(l)) || 0) + 1);
  n.forms.set(t, (n.forms.get(t) || 0) + 1);
  if (g) n.glosses.set(g, (n.glosses.get(g) || 0) + 1);
  if (tr && !n.tr) n.tr = tr;
  return k;
}
function link(child, parent, kind) {
  if (child === parent) return;
  const n = nodes.get(child);
  if (!n.up.has(parent)) n.up.set(parent, kind);
}
const mainComp = (p) => { const r = p.filter((c) => !c.aff); return (r.length ? r[r.length - 1] : p[p.length - 1]); };

// Preferred source: Wiktionary's structured templates (scripts/import-kaikki-etym.js).
// Prose parsing (etym-parse.js) is only the fallback for words the dump lacks.
const KE = path.join(ROOT, "vendor-data", "kaikki-etym.jsonl");
const kaikki = new Map();
if (fs.existsSync(KE)) {
  for (const line of fs.readFileSync(KE, "utf8").split("\n")) { if (line) { const r = JSON.parse(line); kaikki.set(r.w, r); } }
  process.stderr.write(`structured etymologies: ${kaikki.size}\n`);
}
const isAffix = (t) => /^-|-$/.test(t);
const doubletsOf = new Map();
let t0 = Date.now(), fromTemplates = 0, fromProse = 0;
const allRows = db.prepare("select word, ety from words").all();
for (const { word, ety } of allRows) {
  const kr = kaikki.get(word);
  const useK = kr && ((kr.ch && kr.ch.length) || kr.pa);
  if (!useK && !ety) continue;
  if (useK) {
    fromTemplates++;
    const me = node("English", word);
    nodes.get(me).hw = 1;
    for (const p of kr.pa || []) {
      const pk = node("English", p.t, p.g);
      if (headwords.has(p.t)) nodes.get(pk).hw = 1;
      link(me, pk, isAffix(p.t) ? "aff" : "cmp");
    }
    // walk the template chain, honouring its connectors
    let cur = me, child = null;
    for (const st of kr.ch || []) {
      const k = node(st.l, st.t, st.g);
      if ((st.j === "+" || st.j === "&") && child) {
        // a co-component ("hospes + -ālis") or parallel source ("Old English … and Old Norse …")
        // of the same word `cur` came from — not a further step back
        link(child, k, st.j === "+" ? (isAffix(st.t) ? "aff" : "cmp") : st.k || "der");
        if (st.j === "+" && !isAffix(st.t) && cur !== me && isAffix(nodes.get(cur).forms.keys().next().value || "")) {
          // "in- + crēdibilis": the stem, not the prefix, carries the line on
          nodes.get(child).up.set(cur, "aff");
          cur = k;
        }
        continue;
      }
      if (isAffix(st.t) && child && cur !== me) { link(cur === me ? me : child, k, "aff"); continue; }
      link(cur, k, st.k || "der");
      child = cur; cur = k;
    }
    // the entry's own prose sometimes names steps its templates don't (incredible:
    // "… from in- + crēdibilis, from crēdō"); continue from the last templated form
    if (ety && kr.ch && kr.ch.length) {
      const pc = P.parse(word, ety).chain;
      const last = kr.ch[kr.ch.length - 1];
      const at = pc.findIndex((stp) => !stp.p && P.fold(stp.t) === P.fold(last.t));
      if (at >= 0 && at < pc.length - 1) {
        let c2 = keyOf(last.l, last.t);
        for (const stp of pc.slice(at + 1)) {
          if (stp.p) {
            for (const c of stp.p) link(c2, node(c.l, c.t, c.g, c.tr), c.aff ? "aff" : "cmp");
            const m = mainComp(stp.p); c2 = keyOf(m.l, m.t);
          } else { const k2 = node(stp.l, stp.t, stp.g, stp.tr); link(c2, k2, stp.k || "der"); c2 = k2; }
        }
      }
    }
    if (kr.cg && kr.cg.length) nodes.get(me).cog = kr.cg.slice(0, 12).map((c) => (c.g ? [c.l, c.t, c.g] : [c.l, c.t]));
    const d = (kr.db || []).filter((w) => headwords.has(w) && w !== word);
    if (d.length) doubletsOf.set(word, d);
    continue;
  }
  fromProse++;
  const o = P.parse(word, ety);
  const me = node("English", word);
  nodes.get(me).hw = 1;
  // English surface analysis: incredible ← in- + credible
  for (const p of o.parts) {
    const pk = node("English", p.t, p.g);
    if (headwords.has(p.t)) nodes.get(pk).hw = 1;
    link(me, pk, p.aff ? "aff" : "cmp");
  }
  // ancestry chain
  let cur = me;
  for (const step of o.chain) {
    if (step.p) {
      for (const c of step.p) link(cur, node(c.l, c.t, c.g, c.tr), c.aff ? "aff" : "cmp");
      const m = mainComp(step.p);
      cur = keyOf(m.l, m.t);
    } else {
      const k = node(step.l, step.t, step.g, step.tr);
      link(cur, k, step.k || "der");
      cur = k;
    }
  }
  if (o.cognates.length) nodes.get(me).cog = o.cognates.slice(0, 12).map((c) => (c.g ? [c.l, c.t, c.g] : [c.l, c.t]));
  const d = o.doublets.filter((w) => headwords.has(w) && w !== word);
  if (d.length) doubletsOf.set(word, d);
}
// ---- ancestors' own entries (scripts/import-kaikki-ancestors.js) ------------
// Where a line of descent stops at an ancestor form, continue from that form's
// own Wiktionary entry, and give ancestor nodes the gloss their entry states.
const KA = path.join(ROOT, "vendor-data", "kaikki-ancestors.jsonl");
if (fs.existsSync(KA)) {
  const anc = new Map();
  for (const line of fs.readFileSync(KA, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    const k = keyOf(r.l, r.t);
    if (!anc.has(k)) anc.set(k, r); // first lemma entry for a spelling wins
  }
  let glossed = 0, extended = 0, added = 0;
  const before = nodes.size;
  const q = [];
  for (const [k, n] of nodes) if (!k.startsWith("English|")) q.push([k, 0]);
  const done = new Set();
  while (q.length) {
    const [k, depth] = q.shift();
    if (done.has(k)) continue;
    done.add(k);
    const r = anc.get(k), n = nodes.get(k);
    if (!r || !n) continue;
    if (r.g && !n.glosses.size) { n.glosses.set(r.g, 1); glossed++; }
    if (r.hom) n.hom = r.hom;
    if (n.up.size || depth >= 6) continue;
    let cur = k, child = null, grew = false;
    for (const p of r.pa || []) { const pk = node(r.l, p); link(k, pk, isAffix(p) ? "aff" : "cmp"); q.push([pk, depth + 1]); grew = true; }
    for (const st of r.ch || []) {
      const nk = node(st.l, st.t, st.g);
      if ((st.j === "+" || st.j === "&") && child) { link(child, nk, st.j === "+" ? (isAffix(st.t) ? "aff" : "cmp") : st.k || "der"); q.push([nk, depth + 1]); continue; }
      if (isAffix(st.t) && child) { link(child, nk, "aff"); q.push([nk, depth + 1]); continue; }
      link(cur, nk, st.k || "der");
      q.push([nk, depth + 1]);
      child = cur; cur = nk; grew = true;
    }
    if (grew) extended++;
  }
  added = nodes.size - before;
  process.stderr.write(`ancestor entries: ${anc.size}; ${extended} lines of descent continued, ${glossed} forms glossed, ${added} new ancestor forms\n`);
}

// ---- stage bridging: a parentless node whose exact form exists one stage
// earlier in its own language line (French blanc → Old French blanc) is the
// same word cited at a later date. Linked as "inh" with an inferred flag.
const STAGES = {
  "French": ["Middle French", "Old French"], "Middle French": ["Old French"],
  "English": ["Middle English", "Old English"], "Middle English": ["Old English"],
  "German": ["Middle High German", "Old High German"], "Middle High German": ["Old High German"],
  "Dutch": ["Middle Dutch", "Old Dutch"], "Middle Dutch": ["Old Dutch"],
  "Italian": ["Old Italian"], "Spanish": ["Old Spanish"], "Portuguese": ["Old Portuguese", "Galician-Portuguese"],
  "Swedish": ["Old Swedish", "Old Norse"], "Danish": ["Old Danish", "Old Norse"], "Icelandic": ["Old Norse"], "Norwegian": ["Old Norse"],
  "Irish": ["Middle Irish", "Old Irish"], "Welsh": ["Middle Welsh", "Old Welsh"], "Persian": ["Middle Persian", "Old Persian"],
  "Greek": ["Byzantine Greek", "Ancient Greek"], "Russian": ["Old East Slavic"], "Occitan": ["Old Occitan"], "Catalan": ["Old Catalan"],
};
const inferred = new Set();
let bridged = 0;
for (const [k, n] of nodes) {
  if (n.up.size || n.hw) continue;
  const lang = k.slice(0, k.indexOf("|")), term = k.slice(k.indexOf("|") + 1);
  for (const older of STAGES[lang] || []) {
    const ok = older + "|" + term;
    if (nodes.has(ok) && nodes.get(ok).up.size) { n.up.set(ok, "inh"); inferred.add(k + ">" + ok); bridged++; break; }
  }
}
process.stderr.write(`bridged ${bridged} later-stage citations to their earlier stage\n`);
process.stderr.write(`${fromTemplates} words from templates, ${fromProse} from prose → ${nodes.size} nodes in ${Date.now() - t0}ms\n`);

// ---- ancestors (BFS order, nearest first) ---------------------------------
function ancestors(k, cap) {
  const seen = new Map([[k, 0]]); const q = [k];
  while (q.length) {
    const x = q.shift(); const d = seen.get(x);
    if (d >= cap) continue;
    const n = nodes.get(x); if (!n) continue;
    for (const p of n.up.keys()) if (!seen.has(p)) { seen.set(p, d + 1); q.push(p); }
  }
  seen.delete(k);
  return seen;
}

// ---- English descendants per node -----------------------------------------
const desc = new Map();
for (const [k, n] of nodes) {
  if (!n.hw) continue;
  const w = k.slice(8);
  for (const a of ancestors(k, 12).keys()) {
    let s = desc.get(a); if (!s) desc.set(a, (s = []));
    s.push(w);
  }
}

// ---- doublets: symmetric, with the ancestor where the routes split ---------
const dbl = new Map();
function addD(a, b) { if (!dbl.has(a)) dbl.set(a, new Set()); dbl.get(a).add(b); }
for (const [w, list] of doubletsOf) for (const x of list) { addD(w, x); addD(x, w); }
function splitPoint(a, b) {
  const A = ancestors("English|" + a, 12), B = ancestors("English|" + b, 12);
  let best = null, bd = 1e9;
  for (const [k, da] of A) if (B.has(k)) { const s = da + B.get(k); if (s < bd) { bd = s; best = k; } }
  return best;
}
let verified = 0, pairs = 0;
const dblOut = new Map();
for (const [w, set] of dbl) {
  const arr = [];
  for (const x of set) {
    const via = splitPoint(w, x); pairs++;
    if (via) verified++;
    arr.push(via ? [x, via] : [x]);
  }
  arr.sort((p, q) => rankOf(p[0]) - rankOf(q[0]));
  dblOut.set(w, arr);
}
process.stderr.write(`doublets: ${dbl.size} words, ${pairs} directed pairs, ${verified} with a shared ancestor in the graph\n`);

// ---- write shards ------------------------------------------------------------
function shardOf(key) { // djb2 → 0..255, mirrored in app.js
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return (h & 255).toString(16).padStart(2, "0");
}
const top = (m) => { let b = null, c = -1; for (const [k, v] of m) if (v > c || (v === c && k.length > b.length)) { b = k; c = v; } return b; };
// prefer the form carrying diacritics/asterisk when counts tie (scholarly display)
function display(n) {
  let best = null, score = -1;
  for (const [f, c] of n.forms) {
    const marks = (f.normalize("NFD").match(/\p{M}/gu) || []).length + (f.startsWith("*") ? 1 : 0);
    const s = c * 10 + marks;
    if (s > score) { best = f; score = s; }
  }
  return best;
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const shards = {};
let written = 0;
for (const [k, n] of nodes) {
  const d = desc.get(k) || [];
  const isWord = !!n.hw;
  // keep a node only if something can reach it or it leads somewhere
  if (!isWord && !d.length) continue;
  const rec = { l: isWord ? "English" : top(n.labels), t: isWord ? k.slice(8) : display(n) };
  const g = top(n.glosses); if (g && !isWord) rec.g = g.length > 120 ? g.slice(0, 117) + "…" : g;
  if (n.tr && !isWord) rec.tr = n.tr;
  if (isWord) rec.hw = 1;
  if (n.up.size) rec.up = [...n.up].map(([p, kind]) => (inferred.has(k + ">" + p) ? [p, kind, 1] : [p, kind]));
  if (d.length) {
    const uniq = [...new Set(d)].filter((w) => w !== rec.t);
    uniq.sort((a, b) => rankOf(a) - rankOf(b));
    rec.ne = uniq.length;
    rec.en = uniq.slice(0, 48);
  }
  if (isWord && dblOut.has(rec.t)) rec.dbl = dblOut.get(rec.t);
  if (n.cog) rec.cog = n.cog;
  const s = shardOf(k);
  (shards[s] = shards[s] || {})[k] = rec;
  written++;
}
let bytes = 0;
for (const s of Object.keys(shards)) {
  const body = "{\n" + Object.keys(shards[s]).sort().map((k) => JSON.stringify(k) + ":" + JSON.stringify(shards[s][k])).join(",\n") + "\n}\n";
  fs.writeFileSync(path.join(OUT, s + ".json"), body);
  bytes += body.length;
}

// ---- doublet game pool: verified pairs between reasonably common words --------
const pool = [];
const seenPair = new Set();
for (const [w, arr] of dblOut) for (const [x, via] of arr) {
  if (!via) continue;
  const id = [w, x].sort().join("|");
  if (seenPair.has(id)) continue;
  seenPair.add(id);
  const r = Math.max(rankOf(w), rankOf(x));
  if (r > 60000) continue;
  const vn = nodes.get(via);
  pool.push({ a: w, b: x, via: via, vl: top(vn.labels), vt: display(vn) || via.split("|")[1], r: r });
}
pool.sort((p, q) => p.r - q.r);
fs.writeFileSync(path.join(ROOT, "doublets.json"), JSON.stringify(pool.map((p) => [p.a, p.b, p.vl, p.vt, p.via])));
process.stderr.write(`wrote ${written} nodes into ${Object.keys(shards).length} shards (${(bytes / 1048576).toFixed(1)} MB); doublet pool ${pool.length} pairs\n`);
