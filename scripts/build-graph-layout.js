#!/usr/bin/env node
/*
 * build-graph-layout.js — lay the whole etymology graph out as ONE map, which
 * is the app's main screen. The geometry is meant to be read (Saussure's two
 * axes):
 *
 *   axis of successions (diachrony) = RADIUS. Each connected family is a
 *     radial tree around its deepest ancestor; a node's distance from that
 *     center is the TIME elapsed between the ancestor's language stage and its
 *     own (PIE at the core → Latin → Old French → Middle English → English on
 *     the rim). Long branches are long histories; rings are eras.
 *   axis of simultaneities (synchrony) = ADJACENCY. Around the circle, a
 *     node's wedge is shared with its branch; between families, placement is
 *     purely relational — families that share compounds / cross-links are
 *     packed next to each other, inside regions by language group.
 *
 * Input: g/*.json (scripts/build-etym-graph.js) + rootwork.sqlite headwords.
 * Output (served):
 *   graph/info.json      { n, families, langs, eras, bounds, regions, trees }
 *   graph/labels.json    [display term per node]
 *   graph/xy.bin         Float32 x,y per node
 *   graph/meta.bin       Uint8 family, size per node
 *   graph/lang.bin       Uint16 language id per node
 *   graph/tree.bin       Int32 primary parent (-1 root)
 *   graph/links.bin      Int32 pairs child,parent (cross-links)
 *   graph/n/<c>.json     node details for nodes c*1024 … c*1024+1023:
 *                        { i: { g, tr, up:[[idx,kind,inferred?]], en:[words], ne, dbl:[[word, viaIdx]], cog } }
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const GDIR = path.join(ROOT, "g");
const OUT = path.join(ROOT, "graph");
const CHUNK = 1024;

// ---- language → family --------------------------------------------------------
const FAMILIES = [
  ["English", /^English$/],
  ["Older English", /^(?:Middle|Old|Early Modern) English$|^Scots$|^Middle Scots$/],
  ["Germanic", /Germanic|Norse|Saxon|Frisian|German|Dutch|Danish|Swedish|Norwegian|Icelandic|Faroese|Gothic|Frankish|Flemish|Afrikaans|Yiddish|Norn|Limburgish|Luxembourgish/],
  ["Latin & Romance", /Latin|French|Norman|Italian|Spanish|Portuguese|Catalan|Occitan|Provençal|Galician|Romanian|Sicilian|Neapolitan|Venetan|Lombard|Picard|Walloon|Romance|Italic|Oscan|Umbrian|Sardinian|Ladino|Asturian|Aragonese|Friulian|Corsican|Romansh|Dalmatian|Mozarabic/],
  ["Greek", /Greek|Hellenic|Mycenaean/],
  ["Proto-Indo-European", /Indo-European/],
  ["Celtic", /Celtic|Irish|Welsh|Gaelic|Breton|Cornish|Manx|Gaulish|Brythonic|Brittonic|Goidelic/],
  ["Slavic & Baltic", /Slavic|Russian|Ukrainian|Belarusian|Polish|Czech|Slovak|Slovene|Serbo-Croatian|Bulgarian|Macedonian|Lithuanian|Latvian|Prussian|Sorbian|Kashubian|Rusyn|Baltic/],
  ["Indo-Iranian", /Sanskrit|Prakrit|Pali|Hindi|Urdu|Hindustani|Bengali|Punjabi|Gujarati|Marathi|Nepali|Sinhalese|Sindhi|Odia|Assamese|Konkani|Kashmiri|Persian|Avestan|Pashto|Tajik|Kurdish|Dhivehi|Romani|Indo-Iranian|Indo-Aryan|Iranian|Sogdian|Scythian|Ossetian/],
  ["Other Indo-European", /Armenian|Albanian|Hittite|Tocharian|Luwian|Lydian|Phrygian|Thracian|Illyrian|Anatolian/],
  ["Semitic & Afroasiatic", /Arabic|Hebrew|Aramaic|Syriac|Akkadian|Phoenician|Punic|Egyptian|Coptic|Amharic|Ge'ez|Semitic|Maltese|Hausa|Somali|Berber|Ugaritic|Mandaic/],
  ["East & Southeast Asian", /Chinese|Mandarin|Cantonese|Hokkien|Teochew|Hakka|Japanese|Korean|Ainu|Okinawan|Vietnamese|Thai|Lao|Khmer|Burmese|Tibetan|Dzongkha|Manchu|Mongol|Malay|Indonesian|Javanese|Tagalog|Filipino|Cebuano|Ilocano|Malagasy|Austronesian|Polynesian|Hawaiian|Maori|Māori|Samoan|Tongan|Tahitian|Fijian|Manipuri/],
  ["Uralic, Turkic & Caucasian", /Finnish|Estonian|Hungarian|Uralic|Finnic|Sami|Turkish|Turkic|Tatar|Kazakh|Kyrgyz|Uyghur|Uzbek|Azerbaijani|Chuvash|Bashkir|Georgian|Kartvelian|Basque|Etruscan|Sumerian|Elamite|Hurrian/],
  ["Dravidian", /Tamil|Telugu|Kannada|Malayalam|Tulu|Dravidian/],
  ["Americas", /Nahuatl|Quechua|Aymara|Guarani|Tupi|Nheengatu|Taino|Arawak|Carib|Maya|Cree|Ojibwe|Algonquian|Powhatan|Massachusett|Narragansett|Unami|Munsee|Abenaki|Dakota|Lakota|Navajo|Hopi|Inuktitut|Greenlandic|Aleut|Choctaw|Creek|Cherokee|Mohawk|Seneca|Ottawa|Menominee|Lenape|Mi'kmaq|Wampanoag|Mohegan|Halkomelem|Lushootseed|Yupik|Iñupiaq|Inupiaq|Chinook|Lokono/],
  ["African", /Swahili|Zulu|Xhosa|Yoruba|Igbo|Wolof|Akan|Twi|Kongo|Kimbundu|Tswana|Sotho|Shona|Bantu|Luganda|Kikuyu|Lingala|Ewe|Fula/],
  ["Australian & Pacific", /Dharug|Wiradjuri|Nyunga|Nyungar|Kaurna|Pitjantjatjara|Warlpiri|Yolŋu|Guugu|Tok Pisin|Bislama|Australian/],
  ["Other", /./],
];
const famIndex = (lang) => { for (let i = 0; i < FAMILIES.length; i++) if (FAMILIES[i][1].test(lang)) return i; return FAMILIES.length - 1; };

// ---- language → approximate year of the stage (for the radius) ---------------
const ERA = {
  "Proto-Indo-European": -4000, "Proto-Indo-Iranian": -2500, "Proto-Hellenic": -2000, "Proto-Italic": -1000,
  "Proto-Celtic": -800, "Proto-Germanic": -300, "Proto-West Germanic": 200, "Proto-Slavic": 500, "Proto-Balto-Slavic": -1000,
  "Proto-Semitic": -3500, "Proto-Iranian": -1500, "Proto-Brythonic": 300, "Proto-Turkic": -500, "Proto-Bantu": -1000,
  "Mycenaean Greek": -1400, "Ancient Greek": -450, "Doric Greek": -450, "Koine Greek": -100, "Hellenistic Greek": -100, "Byzantine Greek": 900, "Greek": 1900,
  "Old Latin": -300, "Latin": -50, "Vulgar Latin": 300, "Late Latin": 400, "Ecclesiastical Latin": 600, "Medieval Latin": 1000,
  "Early Medieval Latin": 700, "Renaissance Latin": 1500, "New Latin": 1650, "Anglo-Latin": 1200,
  "Old English": 850, "Middle English": 1300, "Early Modern English": 1600, "English": 2000, "Scots": 1700, "Middle Scots": 1500,
  "Old French": 1100, "Old Northern French": 1100, "Anglo-Norman": 1150, "Norman": 1300, "Middle French": 1450, "French": 1800,
  "Old Norse": 1000, "Old High German": 900, "Middle High German": 1200, "German": 1800, "Old Dutch": 900, "Middle Dutch": 1300,
  "Dutch": 1800, "Old Saxon": 850, "Middle Low German": 1300, "Low German": 1800, "Frankish": 500, "Old Frankish": 500, "Gothic": 350,
  "Old Frisian": 1200, "West Frisian": 1900,
  "Sanskrit": -1000, "Prakrit": 0, "Pali": -200, "Avestan": -800, "Old Persian": -500, "Middle Persian": 500, "Classical Persian": 1100, "Persian": 1850,
  "Arabic": 900, "Classical Syriac": 500, "Hebrew": -300, "Biblical Hebrew": -600, "Aramaic": -300, "Akkadian": -2000, "Sumerian": -2600,
  "Egyptian": -2000, "Coptic": 300, "Phoenician": -900, "Punic": -300, "Etruscan": -500,
  "Old Irish": 800, "Middle Irish": 1100, "Old Italian": 1300, "Old Spanish": 1200, "Old Occitan": 1150, "Old Portuguese": 1250,
  "Old East Slavic": 1100, "Old Church Slavonic": 900, "Middle Chinese": 700, "Old Chinese": -800, "Old Japanese": 750,
};
function eraOf(l) {
  if (ERA[l] !== undefined) return ERA[l];
  if (/^Proto-/.test(l)) return -1500;
  if (/^Pre-/.test(l)) return -1500;
  if (/^(?:Ancient|Classical|Biblical) /.test(l)) return -200;
  if (/^Old /.test(l)) return 1000;
  if (/^(?:Middle|Medieval) /.test(l)) return 1350;
  if (/^Late Middle /.test(l)) return 1450;
  if (/Latin$/.test(l)) return 800;
  return 1850; // modern languages, cited at their present form
}
// time → distance on a log scale of years-before-present (+300 so the last
// centuries aren't infinitely stretched): PIE→Latin, Latin→Middle English and
// Middle English→English each get about the same room.
const T = (y) => -Math.log(2400 - Math.min(y, 2000));

// ---- load nodes ------------------------------------------------------------------
const recs = new Map();
for (const f of fs.readdirSync(GDIR)) {
  const j = JSON.parse(fs.readFileSync(path.join(GDIR, f), "utf8"));
  for (const k in j) recs.set(k, j[k]);
}
const db = new DatabaseSync(path.join(ROOT, "rootwork.sqlite"), { readOnly: true });
for (const { word } of db.prepare("select word from words").all()) {
  const k = "English|" + word;
  if (!recs.has(k)) recs.set(k, { l: "English", t: word, hw: 1 });
}
const keys = [...recs.keys()];
const idx = new Map(keys.map((k, i) => [k, i]));
const N = keys.length;
const langs = []; const langId = new Map();
const lid = (l) => { if (!langId.has(l)) { langId.set(l, langs.length); langs.push(l); } return langId.get(l); };
lid("English");
const year = new Float64Array(N);
for (let i = 0; i < N; i++) year[i] = eraOf(recs.get(keys[i]).l);
process.stderr.write(`${N} nodes\n`);

// ---- primary parents ---------------------------------------------------------------
const KIND_W = { inh: 0, bor: 1, lbor: 1, der: 2, via: 2, cal: 3, cmp: 4, aff: 9 };
const parent = new Int32Array(N).fill(-1);
const cross = [];
for (let i = 0; i < N; i++) {
  const up = (recs.get(keys[i]).up || []).filter((u) => idx.has(u[0]));
  if (!up.length) continue;
  let best = 0;
  for (let j = 1; j < up.length; j++) if ((KIND_W[up[j][1]] ?? 5) < (KIND_W[up[best][1]] ?? 5)) best = j;
  parent[i] = idx.get(up[best][0]);
  for (let j = 0; j < up.length; j++) if (j !== best) cross.push(i, idx.get(up[j][0]));
}
for (let i = 0; i < N; i++) { // break cycles
  const seen = new Set([i]); let x = parent[i];
  while (x >= 0) { if (seen.has(x)) { parent[i] = -1; break; } seen.add(x); x = parent[x]; }
}
const kids = Array.from({ length: N }, () => []);
for (let i = 0; i < N; i++) if (parent[i] >= 0) kids[parent[i]].push(i);
const linked = new Uint8Array(N);
for (let i = 0; i < cross.length; i++) linked[cross[i]] = 1;

// ---- radial-in-time layout per tree -------------------------------------------------
const xy = new Float32Array(N * 2);
const leaves = new Float64Array(N);
const treeOf = new Int32Array(N).fill(-1);
const roots = [];
for (let i = 0; i < N; i++) if (parent[i] < 0) roots.push(i);
const SPACING = 1.0, MIN_GAP = 0.06;
const trees = [];
for (const r of roots) {
  const order = []; const st = [r];
  while (st.length) { const x = st.pop(); order.push(x); for (const c of kids[x]) st.push(c); }
  for (let k = order.length - 1; k >= 0; k--) { const x = order[k]; leaves[x] = kids[x].length ? kids[x].reduce((s, c) => s + leaves[c], 0) : 1; }
  const ti = trees.length;
  for (const x of order) treeOf[x] = ti;
  const fam = famIndex(recs.get(keys[r]).l);
  if (order.length === 1) { trees.push({ root: r, nodes: order, R: 0.6, fam, dust: !linked[r], scale: 0 }); continue; }
  // raw radius = elapsed time, monotonic outward along every path
  const raw = new Map([[r, 0]]);
  const t0 = T(year[r]);
  for (const x of order) {
    if (x === r) continue;
    const pr = raw.get(parent[x]);
    raw.set(x, Math.max(pr + MIN_GAP, T(year[x]) - t0));
  }
  let rim = 0; for (const v of raw.values()) rim = Math.max(rim, v);
  // enough rim circumference for every leaf, and not too sprawling for tiny trees
  const need = (leaves[r] * SPACING) / (2 * Math.PI);
  const scale = Math.max(need / Math.max(rim, 1e-6), 3.5, (0.8 * Math.sqrt(order.length)) / Math.max(rim, 1e-6));
  const a0 = new Map([[r, 0]]), span = new Map([[r, 2 * Math.PI]]);
  for (const x of order) {
    const ang = a0.get(x) + span.get(x) / 2;
    const rad = raw.get(x) * scale;
    xy[x * 2] = rad * Math.cos(ang); xy[x * 2 + 1] = rad * Math.sin(ang);
    let start = a0.get(x);
    const ks = kids[x].slice().sort((p, q) => leaves[q] - leaves[p]);
    for (const c of ks) { a0.set(c, start); const s = (span.get(x) * leaves[c]) / leaves[x]; span.set(c, s); start += s; }
  }
  trees.push({ root: r, nodes: order, R: rim * scale + 1.5, fam, scale, t0 });
}
process.stderr.write(`${trees.length} trees (${trees.filter((t) => t.nodes.length > 1).length} with 2+ nodes), ${cross.length / 2} cross-links\n`);

// ---- relational packing --------------------------------------------------------------
const tAdj = new Map();
for (let i = 0; i < cross.length; i += 2) {
  const a = treeOf[cross[i]], b = treeOf[cross[i + 1]];
  if (a === b || a < 0 || b < 0) continue;
  for (const [p, q] of [[a, b], [b, a]]) { let m = tAdj.get(p); if (!m) tAdj.set(p, (m = new Map())); m.set(q, (m.get(q) || 0) + 1); }
}
trees.forEach((t, i) => (t.id = i));
function packRegion(list) {
  // order: largest first, then over cross-link neighbours (strongest ties
  // first), each anchored at the weighted centroid of its placed neighbours,
  // so connected families land next to each other
  const inRegion = new Set(list.map((t) => t.id));
  const placed = new Set();
  const bySize = list.slice().sort((a, b) => b.R - a.R);
  const cell = 6;
  const grid = new Map();
  const put = (t) => {
    const x0 = Math.floor((t.x - t.R) / cell), x1 = Math.floor((t.x + t.R) / cell);
    const y0 = Math.floor((t.y - t.R) / cell), y1 = Math.floor((t.y + t.R) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const k = gx * 100003 + gy; let L = grid.get(k); if (!L) grid.set(k, (L = [])); L.push(t); }
  };
  const fits = (x, y, R) => {
    const x0 = Math.floor((x - R) / cell), x1 = Math.floor((x + R) / cell);
    const y0 = Math.floor((y - R) / cell), y1 = Math.floor((y + R) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const L = grid.get(gx * 100003 + gy); if (!L) continue;
      for (const o of L) { const dx = o.x - x, dy = o.y - y, m = o.R + R + 0.5; if (dx * dx + dy * dy < m * m) return false; }
    }
    return true;
  };
  // the global spiral resumes where it left off (unanchored trees fill outward)
  let spiralK = 0;
  const place = (t, ax, ay, anchored) => {
    for (let k = anchored ? 0 : Math.max(0, spiralK - 300); ; k++) {
      const step = anchored ? Math.max(0.6, Math.min(t.R, 8) * 0.35) : 0.9;
      const rad = Math.sqrt(k) * step, th = k * 2.399963;
      const x = ax + rad * Math.cos(th), y = ay + rad * Math.sin(th);
      if (fits(x, y, t.R)) { t.x = x; t.y = y; put(t); placed.add(t.id); if (!anchored) spiralK = k; return; }
    }
  };
  let si = 0;
  const frontier = [];
  while (placed.size < list.length) {
    let t = null;
    while (frontier.length && !t) {
      // pick the strongest tie (linear scan of a bounded frontier)
      let bi = 0; for (let j = 1; j < frontier.length; j++) if (frontier[j][0] > frontier[bi][0]) bi = j;
      const q = frontier[bi][1]; frontier[bi] = frontier[frontier.length - 1]; frontier.pop();
      if (!placed.has(q)) t = trees[q];
    }
    if (!t) { while (placed.has(bySize[si].id)) si++; t = bySize[si]; }
    let ax = 0, ay = 0, w = 0;
    const m = tAdj.get(t.id);
    if (m) for (const [q, c] of m) if (placed.has(q) && inRegion.has(q)) { ax += trees[q].x * c; ay += trees[q].y * c; w += c; }
    if (w) place(t, ax / w, ay / w, true); else place(t, 0, 0, false);
    if (m) for (const [q, c] of m) if (inRegion.has(q) && !placed.has(q) && frontier.length < 4000) frontier.push([c, q]);
  }
  let ext = 0; for (const t of list) ext = Math.max(ext, Math.hypot(t.x, t.y) + t.R);
  return ext;
}
const famGroups = FAMILIES.map(() => []);
const dust = [];
for (const t of trees) (t.dust ? dust : famGroups[t.fam]).push(t);
const regions = [];
famGroups.forEach((g, fi) => { if (g.length) regions.push({ fi, r: packRegion(g) + 6, trees: g }); });
const regTie = (a, b) => {
  let s = 0;
  for (const t of a.trees) { const m = tAdj.get(t.id); if (m) for (const [q, c] of m) if (!trees[q].dust && trees[q].fam === b.fi) s += c; }
  return s;
};
regions.sort((a, b) => b.r - a.r);
const placedR = [];
for (const R of regions) {
  if (!placedR.length) { R.x = 0; R.y = 0; placedR.push(R); continue; }
  let ax = 0, ay = 0, w = 0;
  for (const o of placedR) { const c = regTie(R, o); ax += o.x * c; ay += o.y * c; w += c; }
  ax = w ? ax / w : 0; ay = w ? ay / w : 0;
  for (let k = 0; ; k++) {
    const rad = Math.sqrt(k) * 6, th = k * 2.399963;
    const x = ax + rad * Math.cos(th), y = ay + rad * Math.sin(th);
    if (placedR.every((o) => Math.hypot(o.x - x, o.y - y) > o.r + R.r + 6)) { R.x = x; R.y = y; placedR.push(R); break; }
  }
}
let cxw = 0, cyw = 0, aw = 0;
for (const R of placedR) { const a = R.r * R.r; cxw += R.x * a; cyw += R.y * a; aw += a; }
cxw /= aw; cyw /= aw;
let outer = 0;
const treeOut = [];
for (const R of placedR) {
  R.x -= cxw; R.y -= cyw;
  outer = Math.max(outer, Math.hypot(R.x, R.y) + R.r);
  for (const t of R.trees) {
    const ox = R.x + t.x, oy = R.y + t.y;
    for (const n of t.nodes) { xy[n * 2] += ox; xy[n * 2 + 1] += oy; }
    if (t.nodes.length >= 12) treeOut.push([t.root, +ox.toFixed(2), +oy.toFixed(2), +t.scale.toFixed(4), +t.R.toFixed(1)]);
  }
}
dust.sort((a, b) => (keys[a.root] < keys[b.root] ? -1 : 1));
const ringIn = outer + 25, ringOut = Math.sqrt(ringIn * ringIn + (dust.length * 1.6) / Math.PI);
for (let i = 0; i < dust.length; i++) {
  const u = (i + 0.5) / dust.length, rr = ringIn + (ringOut - ringIn) * ((i * 0.6180339) % 1);
  const n = dust[i].root;
  xy[n * 2] = rr * Math.cos(u * 2 * Math.PI - Math.PI / 2); xy[n * 2 + 1] = rr * Math.sin(u * 2 * Math.PI - Math.PI / 2);
}

// ---- per-node arrays -------------------------------------------------------------------
const meta = new Uint8Array(N * 2), langArr = new Uint16Array(N);
const labels = new Array(N);
for (let i = 0; i < N; i++) {
  const r = recs.get(keys[i]);
  meta[i * 2] = famIndex(r.l);
  meta[i * 2 + 1] = Math.min(255, Math.round(Math.log2(1 + (r.ne || 0)) * 18) + (r.hw ? 0 : 6));
  langArr[i] = lid(r.l);
  labels[i] = r.t;
}
let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
for (let i = 0; i < N; i++) { const x = xy[i * 2], y = xy[i * 2 + 1]; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "n"), { recursive: true });
fs.writeFileSync(path.join(OUT, "labels.json"), JSON.stringify(labels));
fs.writeFileSync(path.join(OUT, "xy.bin"), Buffer.from(xy.buffer));
fs.writeFileSync(path.join(OUT, "meta.bin"), Buffer.from(meta.buffer));
fs.writeFileSync(path.join(OUT, "lang.bin"), Buffer.from(langArr.buffer));
fs.writeFileSync(path.join(OUT, "tree.bin"), Buffer.from(parent.buffer));
fs.writeFileSync(path.join(OUT, "links.bin"), Buffer.from(Int32Array.from(cross).buffer));
// starting points: common headwords with at least three generations of ancestry
const rankMap = new Map();
for (const line of fs.readFileSync(path.join(ROOT, "review", "ranks.tsv"), "utf8").split("\n").slice(1)) {
  const t = line.lastIndexOf("\t"); if (t > 0) rankMap.set(line.slice(0, t), Number(line.slice(t + 1)));
}
const starts = [];
for (let i = 0; i < N; i++) {
  const r = recs.get(keys[i]); if (!r.hw) continue;
  const w = r.t, rk = rankMap.get(w);
  if (rk == null || rk > 25000 || !/^[a-z]{4,}$/.test(w)) continue;
  let d = 0, x = parent[i]; while (x >= 0 && d < 9) { d++; x = parent[x]; }
  if (d >= 3) starts.push(i);
}
process.stderr.write(`${starts.length} starting words\n`);
fs.writeFileSync(path.join(OUT, "info.json"), JSON.stringify({
  starts,
  n: N, chunk: CHUNK, families: FAMILIES.map((f) => f[0]), langs, eras: langs.map(eraOf),
  bounds: [minx, miny, maxx, maxy],
  regions: placedR.map((R) => ({ name: FAMILIES[R.fi][0], x: +R.x.toFixed(1), y: +R.y.toFixed(1), r: +R.r.toFixed(1) })),
  dust: { inner: +ringIn.toFixed(1), outer: +ringOut.toFixed(1), n: dust.length },
  trees: treeOut, // [rootIndex, cx, cy, scale, R]; ring radius(year) = scale*(T(year)-T(rootYear)), T(y) = -ln(2400 - y)
}));
// first definition of each headword, for the map's close-range glosses
const firstDef = new Map();
for (const row of db.prepare("select word, gloss from senses where rowid in (select min(rowid) from senses group by word)").all()) {
  if (row.gloss && !firstDef.has(row.word)) firstDef.set(row.word, row.gloss.length > 90 ? row.gloss.slice(0, 88) + "…" : row.gloss);
}
const chunks = new Map();
for (let i = 0; i < N; i++) {
  const r = recs.get(keys[i]);
  const d = {};
  if (r.hw && firstDef.has(r.t)) d.sd = firstDef.get(r.t);
  if (r.g && !r.hw) d.g = r.g;
  if (r.tr && !r.hw) d.tr = r.tr;
  if (r.up) { const u = r.up.filter((x) => idx.has(x[0])).map((x) => (x[2] ? [idx.get(x[0]), x[1], 1] : [idx.get(x[0]), x[1]])); if (u.length) d.up = u; }
  if (r.en) { d.en = r.en; d.ne = r.ne; }
  if (r.dbl) d.dbl = r.dbl.map((x) => (x[1] && idx.has(x[1]) ? [x[0], idx.get(x[1])] : [x[0]]));
  if (r.cog) d.cog = r.cog;
  if (!Object.keys(d).length) continue;
  const c = Math.floor(i / CHUNK);
  let m = chunks.get(c); if (!m) chunks.set(c, (m = {}));
  m[i] = d;
}
for (const [c, m] of chunks) fs.writeFileSync(path.join(OUT, "n", c + ".json"), JSON.stringify(m));
// every doublet pair, by index: [a, b, via | -1] (for the doublets lens)
const pairs = []; const seenP = new Set();
for (let i = 0; i < N; i++) {
  const r = recs.get(keys[i]); if (!r.dbl) continue;
  for (const x of r.dbl) {
    const j = idx.get("English|" + x[0]); if (j == null) continue;
    const id = i < j ? i + "," + j : j + "," + i; if (seenP.has(id)) continue; seenP.add(id);
    pairs.push([i, j, x[1] && idx.has(x[1]) ? idx.get(x[1]) : -1]);
  }
}
fs.writeFileSync(path.join(OUT, "doublets.json"), JSON.stringify(pairs));
process.stderr.write(`${pairs.length} doublet pairs (${pairs.filter((p) => p[2] >= 0).length} with a split point)\n`);
let total = 0; const walk = (p) => { for (const f of fs.readdirSync(p)) { const q = path.join(p, f); const s = fs.statSync(q); if (s.isDirectory()) walk(q); else total += s.size; } };
walk(OUT);
process.stderr.write(`bounds ${minx.toFixed(0)},${miny.toFixed(0)} → ${maxx.toFixed(0)},${maxy.toFixed(0)}; ${chunks.size} detail chunks; graph/ = ${(total / 1048576).toFixed(1)} MB\n`);
