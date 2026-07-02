#!/usr/bin/env node
/*
 * build-etymgraph.js — build the CANONICAL etymology graph from all sources
 * (TREES_PLAN.md v2): one node per normalized (language, term), every edge
 * carrying source attribution. Sources are the evidence; nothing here is
 * authored. Output: vendor-data/etymgraph.sqlite (derived, gitignored).
 *
 *   node(id, lang, term, norm UNIQUE, gloss, pos, headword)
 *   edge(child, parent, kind, src)  UNIQUE(child,parent,src)
 *     kind: inh | bor | der | aff | cmp | root
 *     src:  edb (etymology-db) | ket (kaikki etymon tree) | etydb (EtymDB 2.1)
 *
 * Sources read (all in vendor-data/):
 *   etymology.csv.gz         — ancestry rows per term are CHAINED in listed
 *                              order (term→hop1→hop2…), matching how the CSV
 *                              records whole chains flat on one term.
 *                              Structure rows become aff/cmp/root edges.
 *                              Lateral rows (cognate/doublet/related/group_*)
 *                              are skipped — not ancestry.
 *   kaikki-en.jsonl.gz + kaikki-<Lang>.jsonl.gz — `etymon` template blobs
 *                              (salvaged sub-blobs; wiktextract mangles the
 *                              outer object). Blob nesting = child→ancestors,
 *                              properly hierarchical, branches at compounds.
 *                              The per-language dumps extend chains DOWNWARD
 *                              (Latin december's own tree) and supply
 *                              gloss/pos for ancestor nodes.
 *   etymdb-2.1/data/split_etymdb — der/inh/bor links (lexeme ids → (lang,
 *                              term) via values; only confidently mapped
 *                              language codes are ingested).
 *
 * Post-passes: node↔headword resolution (English nodes → words/ keys),
 * contested-node detection v1 (≥2 mutually-unconnected ancestry parents on a
 * non-compound node → contested=1, sample to etymgraph-conflicts.tsv).
 *
 *   node scripts/build-etymgraph.js        (~10 min, safe to re-run)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor-data");
const WORDS = path.join(ROOT, "words");
const DB = path.join(VENDOR, "etymgraph.sqlite");

// ---------- normalization ----------
const foldTerm = (t) => String(t || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\*/g, "").trim();
// etymology-db/kaikki use language NAMES; EtymDB uses codes → map the common ones.
const CODE2NAME = {
  en: "English", enm: "Middle English", ang: "Old English", la: "Latin", "la-lat": "Latin",
  grc: "Ancient Greek", el: "Greek", fr: "French", fro: "Old French", frm: "Middle French",
  it: "Italian", es: "Spanish", pt: "Portuguese", de: "German", nl: "Dutch", non: "Old Norse",
  got: "Gothic", ar: "Arabic", he: "Hebrew", sa: "Sanskrit", ru: "Russian", pl: "Polish",
  ja: "Japanese", zh: "Chinese", tr: "Turkish", fa: "Persian", hi: "Hindi", ga: "Irish",
  cy: "Welsh", gd: "Scottish Gaelic", sv: "Swedish", da: "Danish", no: "Norwegian",
  "ine-pro": "Proto-Indo-European", "gem-pro": "Proto-Germanic", "gmw-pro": "Proto-West Germanic",
  "itc-pro": "Proto-Italic", "grk-pro": "Proto-Hellenic", "cel-pro": "Proto-Celtic",
  "sla-pro": "Proto-Slavic", "iir-pro": "Proto-Indo-Iranian", "sem-pro": "Proto-Semitic",
  "LL.": "Late Latin", "ML.": "Medieval Latin", "NL.": "New Latin", "VL.": "Vulgar Latin",
  goh: "Old High German", gmh: "Middle High German", odt: "Old Dutch", dum: "Middle Dutch",
  osx: "Old Saxon", ofs: "Old Frisian", sco: "Scots", mul: "Translingual",
};
const foldLang = (l) => String(l || "").trim();

// ---------- db ----------
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = new DatabaseSync(DB);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;
  CREATE TABLE node(id INTEGER PRIMARY KEY, lang TEXT, term TEXT, norm TEXT UNIQUE, gloss TEXT, pos TEXT, headword TEXT, contested INT DEFAULT 0);
  CREATE TABLE edge(child INT, parent INT, kind TEXT, src TEXT, UNIQUE(child,parent,src));`);

const insNode = db.prepare("INSERT OR IGNORE INTO node(lang,term,norm) VALUES(?,?,?)");
const getNode = db.prepare("SELECT id FROM node WHERE norm = ?");
const insEdge = db.prepare("INSERT OR IGNORE INTO edge(child,parent,kind,src) VALUES(?,?,?,?)");
const nodeCache = new Map(); // norm -> id

function nodeId(lang, term) {
  lang = foldLang(lang);
  term = String(term || "").trim();
  if (!lang || !term) return null;
  const norm = lang + "|" + foldTerm(term);
  if (foldTerm(term) === "") return null;
  let id = nodeCache.get(norm);
  if (id) return id;
  insNode.run(lang, term, norm);
  id = getNode.get(norm).id;
  nodeCache.set(norm, id);
  nodeLang.set(id, lang);
  return id;
}
// Language-era tiers: an ancestry edge must never point from an older-tier
// language to a strictly younger one (Latin cannot derive from Old
// Portuguese; PIE cannot borrow from Japanese). Groups in etymology-db are
// sometimes mention-lists rather than linear chains — this rejects the
// anti-chronological stitches those produce, from ANY source.
//   0 Proto-*   1 ancient   2 medieval   3 modern
function tierOf(lang) {
  if (/^Proto-/.test(lang)) return 0;
  if (/^(Latin|Ancient |Classical |Koine |Old English|Old Norse|Old High German|Old Saxon|Old Frisian|Old Church Slavonic|Gothic|Sanskrit|Aramaic|Hebrew|Biblical |Akkadian|Phoenician|Pictish)/.test(lang)) return 1;
  if (/^(Middle |Medieval |Late Latin|Vulgar Latin|New Latin|Old |Byzantine |Anglo-Norman)/.test(lang)) return 2;
  return 3;
}
const nodeLang = new Map(); // id -> lang (for the tier check)
const ANCESTRY_KINDS = new Set(["inh", "bor", "der"]);
const addEdge = (child, parent, kind, src) => {
  if (!child || !parent || child === parent) return;
  if (ANCESTRY_KINDS.has(kind)) {
    const cl = nodeLang.get(child), pl = nodeLang.get(parent);
    if (cl !== pl && tierOf(pl) > tierOf(cl)) return; // parent strictly younger — artifact
  }
  insEdge.run(child, parent, kind, src);
};

// ---------- source 1: etymology-db ----------
const ANCESTRY = new Map([
  ["inherited_from", "inh"], ["derived_from", "der"], ["borrowed_from", "bor"],
  ["learned_borrowing_from", "bor"], ["unadapted_borrowing_from", "bor"],
  ["orthographic_borrowing_from", "bor"], ["semi_learned_borrowing_from", "bor"],
  ["back-formation_from", "der"], ["clipping_of", "der"], ["calque_of", "der"],
]);
const STRUCTURE = new Map([
  ["has_prefix", "aff"], ["has_suffix", "aff"], ["has_affix", "aff"], ["has_confix", "aff"],
  ["compound_of", "cmp"], ["blend_of", "cmp"], ["has_prefix_with_root", "der"], ["has_root", "root"],
]);

function csvFields(line) {
  if (!line.includes('"')) return line.split(",");
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

async function loadEdb() {
  const p = path.join(VENDOR, "etymology.csv.gz");
  const rl = readline.createInterface({ input: fs.createReadStream(p).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let n = 0, cur = null, curRows = [];
  db.exec("BEGIN");
  const flush = () => {
    if (!cur || !curRows.length) return;
    const selfId = nodeId(cur.lang, cur.term);
    if (!selfId) return;
    // Ancestry rows chain in listed order WITHIN a group (self → hop1 →
    // hop2 → …); each group_tag starts a fresh chain from the headword —
    // stitching across groups fabricates edges (December→ME→OF→Latin is one
    // group; a second group restarts at December, not at Latin).
    let prev = selfId, lastGroup;
    for (const r of curRows) {
      const anc = ANCESTRY.get(r.reltype);
      if (anc) {
        if (r.group !== lastGroup) { prev = selfId; lastGroup = r.group; }
        const pid = nodeId(r.relLang, r.relTerm);
        if (pid) { addEdge(prev, pid, anc, "edb"); prev = pid; }
        continue;
      }
      const st = STRUCTURE.get(r.reltype);
      if (st) {
        const pid = nodeId(r.relLang, r.relTerm);
        addEdge(selfId, pid, st, "edb");
      }
    }
  };
  for await (const line of rl) {
    n++; if (n === 1) continue;
    const f = csvFields(line);
    if (f.length < 8) continue;
    const key = f[1] + "|" + f[2];
    if (!cur || key !== cur.key) { flush(); cur = { key, lang: f[1], term: f[2] }; curRows = []; }
    const relTerm = (f[6] || "").trim();
    if (!relTerm) continue;
    // member rows carry their group id in parent_tag (f[9]); the group_tag
    // column (f[8]) is only set on group HEADER rows (which have no rel_term
    // and are filtered above by the empty-relTerm skip)
    curRows.push({ reltype: f[3], relLang: f[5], relTerm, group: f[9] || f[8] || "" });
    if (n % 500000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); process.stderr.write("  edb " + n + " rows\n"); }
  }
  flush();
  db.exec("COMMIT");
  process.stderr.write("edb done (" + (n - 1) + " rows)\n");
}

// ---------- source 2: kaikki etymon blobs ----------
function jsonBlobs(s) {
  const out = [];
  let i = s.indexOf("{");
  while (i !== -1 && out.length < 24) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    const blob = s.slice(i, end + 1).replace(/\n/g, " ");
    let parsed = null;
    try { parsed = JSON.parse(blob); } catch (e) {}
    if (parsed) { out.push(parsed); i = s.indexOf("{", end + 1); }
    else i = s.indexOf("{", i + 1);
  }
  return out;
}
const KET_KIND = { inherited: "inh", derived: "der", borrowed: "bor" };

function walkBlob(node, depth) {
  if (!node || depth > 14) return null;
  const id = nodeId(node.lang_name, node.term);
  for (const c of node.children || []) {
    const kind = KET_KIND[c.keyword] || "der";
    for (const tm of c.terms || []) {
      const pid = walkBlob(tm, depth + 1);
      if (id && pid) addEdge(id, pid, kind, "ket");
    }
  }
  return id;
}

async function loadKet(file) {
  const p = path.join(VENDOR, file);
  if (!fs.existsSync(p)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(p).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let blobs = 0;
  db.exec("BEGIN");
  for await (const line of rl) {
    if (!line.includes('"etymon"')) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    for (const t of o.etymology_templates || []) {
      if (t.name !== "etymon" || !t.expansion) continue;
      for (const blob of jsonBlobs(t.expansion)) { walkBlob(blob, 0); blobs++; }
    }
  }
  db.exec("COMMIT");
  process.stderr.write("ket " + file + ": " + blobs + " blobs\n");
}

// ---------- source 3: EtymDB ----------
function loadEtymdb() {
  const vals = path.join(VENDOR, "etymdb-2.1", "data", "split_etymdb", "etymdb_values.csv");
  const links = path.join(VENDOR, "etymdb-2.1", "data", "split_etymdb", "etymdb_links_info.csv");
  if (!fs.existsSync(vals) || !fs.existsSync(links)) { process.stderr.write("SKIP etymdb (files missing)\n"); return; }
  const lex = new Map(); // id -> [langName, lexeme, meaning]
  for (const line of fs.readFileSync(vals, "utf8").split("\n")) {
    const f = line.split("\t");
    if (f.length < 4) continue;
    const name = CODE2NAME[f[1]];
    if (!name || !f[3]) continue;
    lex.set(f[0], [name, f[3], f[4] || ""]);
  }
  const KIND = { inh: "inh", der: "der", bor: "bor" };
  let added = 0;
  db.exec("BEGIN");
  for (const line of fs.readFileSync(links, "utf8").split("\n")) {
    const f = line.split("\t");
    const kind = KIND[f[0]];
    if (!kind || f.length < 3) continue;
    const a = lex.get(f[1]), b = lex.get(f[2]);
    if (!a || !b) continue;
    // EtymDB link direction verified against known pairs (terrado→terra,
    // Bengali ডিকশনারী→dictionary): (type, child_id, parent_id)
    const childId = nodeId(a[0], a[1]);
    const parentId = nodeId(b[0], b[1]);
    if (childId && parentId) { addEdge(childId, parentId, kind, "etydb"); added++; }
  }
  db.exec("COMMIT");
  process.stderr.write("etydb: " + lex.size + " mapped lexemes, " + added + " edges\n");
}

// ---------- attrs + headwords + contested ----------
function attrsAndHeadwords() {
  // glosses/pos from etym.sqlite lemma table (ancestor languages)
  const src = path.join(VENDOR, "etym.sqlite");
  if (fs.existsSync(src)) {
    const d2 = new DatabaseSync(src, { readOnly: true });
    const upd = db.prepare("UPDATE node SET gloss=?, pos=? WHERE norm=? AND gloss IS NULL");
    db.exec("BEGIN");
    for (const r of d2.prepare("SELECT lang, word, pos, gloss FROM lemma WHERE gloss != ''").all()) {
      upd.run(r.gloss.slice(0, 120), r.pos, foldLang(r.lang) + "|" + foldTerm(r.word));
    }
    db.exec("COMMIT");
    d2.close();
  }
  // headword resolution + English glosses from our own shards
  const updH = db.prepare("UPDATE node SET headword=?, gloss=COALESCE(gloss,?) WHERE norm=?");
  db.exec("BEGIN");
  for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
    const shard = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
    for (const [w, rec] of Object.entries(shard)) {
      const g = Array.isArray(rec.d) && rec.d[0] && rec.d[0].g ? String(rec.d[0].g).slice(0, 120) : null;
      updH.run(w, g, "English|" + foldTerm(w));
    }
  }
  db.exec("COMMIT");
}

function contested() {
  // v1: a node with 2+ ancestry parents, no cmp/aff edges of its own, where
  // some parent pair is mutually unconnected → contested (different routes).
  db.exec(`CREATE TEMP TABLE anc AS
    SELECT DISTINCT child, parent FROM edge WHERE kind IN ('inh','bor','der');`);
  db.exec(`CREATE INDEX temp.i_anc ON anc(child); CREATE INDEX temp.i_anc_p ON anc(parent);`);
  const rows = db.prepare(`
    SELECT a.child c, a.parent p1, b.parent p2 FROM anc a JOIN anc b
      ON a.child=b.child AND a.parent < b.parent
    JOIN node n1 ON n1.id=a.parent JOIN node n2 ON n2.id=b.parent
    WHERE n1.lang = n2.lang
      -- different-language unconnected parents are usually the SAME lineage
      -- recorded at different depths (etymology-db stores complementary
      -- "groups" per page without bridging them: December → ME December and
      -- December → OF decembre are one route). Same-language alternatives
      -- (ἐγκυκλοπαιδεία vs ἐγκύκλιος παιδεία) are the real contested class.
      AND n1.term NOT LIKE '-%' AND n1.term NOT LIKE '%-'
      AND n2.term NOT LIKE '-%' AND n2.term NOT LIKE '%-'
      AND NOT EXISTS (SELECT 1 FROM edge e WHERE (e.child=a.parent AND e.parent=b.parent) OR (e.child=b.parent AND e.parent=a.parent))
      AND NOT EXISTS (SELECT 1 FROM anc m1 JOIN anc m2 ON m1.parent=m2.parent
                      WHERE (m1.child=a.parent AND m2.child=b.parent))
      AND NOT EXISTS (SELECT 1 FROM anc h1 JOIN anc h2 ON h1.child=h2.parent
                      WHERE (h1.parent=a.parent AND h2.child=b.parent) OR (h1.parent=b.parent AND h2.child=a.parent))
      AND NOT EXISTS (SELECT 1 FROM edge x WHERE x.child=a.child AND x.kind IN ('cmp','aff'))`).all();
  const ids = new Set(rows.map((r) => r.c));
  db.exec("BEGIN");
  const upd = db.prepare("UPDATE node SET contested=1 WHERE id=?");
  for (const id of ids) upd.run(id);
  db.exec("COMMIT");
  // sample file for curation
  const q = db.prepare("SELECT lang, term FROM node WHERE id=?");
  const out = [];
  for (const r of rows.slice(0, 4000)) {
    const c = q.get(r.c), p1 = q.get(r.p1), p2 = q.get(r.p2);
    out.push([c.lang + " " + c.term, p1.lang + " " + p1.term, p2.lang + " " + p2.term].join("\t"));
  }
  fs.writeFileSync(path.join(VENDOR, "etymgraph-conflicts.tsv"), "child\troute_1\troute_2\n" + out.join("\n") + "\n");
  process.stderr.write("contested nodes: " + ids.size + " (sample pairs → vendor-data/etymgraph-conflicts.tsv)\n");
}

async function main() {
  await loadEdb();
  await loadKet("kaikki-en.jsonl.gz");
  for (const f of fs.readdirSync(VENDOR).filter((x) => /^kaikki-(?!en\b).*\.jsonl\.gz$/.test(x))) await loadKet(f);
  loadEtymdb();
  // Sanity: a proto-language cannot inherit/borrow from an attested language —
  // such edges are extraction artifacts on reconstruction pages (PIE *swé
  // "borrowed_from" Japanese 蘇, "derived_from" Old Norse samr: both are its
  // DESCENDANTS listed on its own page).
  const del = db.prepare(`DELETE FROM edge WHERE rowid IN (
    SELECT e.rowid FROM edge e JOIN node c ON c.id=e.child JOIN node p ON p.id=e.parent
    WHERE c.lang LIKE 'Proto-%' AND p.lang NOT LIKE 'Proto-%')`);
  del.run();
  process.stderr.write("removed proto→attested artifact edges: " + db.prepare("SELECT changes() c").get().c + "\n");
  attrsAndHeadwords();
  process.stderr.write("indexing…\n");
  db.exec(`CREATE INDEX i_edge_child ON edge(child); CREATE INDEX i_edge_parent ON edge(parent);
           CREATE INDEX i_node_hw ON node(headword) WHERE headword IS NOT NULL;`);
  contested();
  const s = (q) => db.prepare(q).get().c;
  process.stderr.write("nodes: " + s("SELECT count(*) c FROM node") +
    " | edges: " + s("SELECT count(*) c FROM edge") +
    " | headword-linked: " + s("SELECT count(*) c FROM node WHERE headword IS NOT NULL") +
    " | contested: " + s("SELECT count(*) c FROM node WHERE contested=1") + "\n");
  db.close();
  process.stderr.write("done → " + DB + "\n");
}

main().catch((e) => { process.stderr.write("build-etymgraph: " + e.stack + "\n"); process.exit(1); });
