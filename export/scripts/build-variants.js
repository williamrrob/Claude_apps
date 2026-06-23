// Spelling-variant clusters — "one card per word, every spelling on it."
//
// Wiktionary marks variants in the gloss ("Alternative form of X", "British
// standard spelling of Y", "Misspelling of Z"). We turn each such word into a
// pointer (rel) at its canonical spelling, and list every alternative spelling
// ON the canonical card (vars), so the three spellings of one fish are one card.
//
// Progress is recorded in family/variants.json — the durable source of truth,
// just like the Latin family/<root>.json files. It carries provenance (by:
// user|assistant) and a status per cluster (auto | confirmed | rejected) so a
// human review survives re-runs: confirmed/rejected/user-added clusters are
// never clobbered by a fresh scan; only "auto" entries get refreshed.
//
//   node scripts/build-variants.js          dry run: scan + report, no writes
//   node scripts/build-variants.js --apply  write family/variants.json + shards
"use strict";
const fs = require("fs"); const path = require("path");
const ROOT = path.join(__dirname, ".."); const WORDS = path.join(ROOT, "words");
const REG = path.join(ROOT, "family", "variants.json");
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

const shards = {}; const shardOf = {}; const vocab = new Set();
for (const f of fs.readdirSync(WORDS)) {
  if (!f.endsWith(".json")) continue;
  shards[f] = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const w of Object.keys(shards[f])) { vocab.add(w); shardOf[w] = f; }
}

// whole gloss = "<modifiers> (spelling|form|misspelling) of <target>"
const RE = /^[\w,'’\- ]{0,46}?(spelling|form|misspelling) of ([a-z][a-z'’\-]+)\.?$/i;
function classify(gloss) {
  const m = gloss.match(RE); if (!m) return null;
  const target = m[2];
  let t = "variant of";
  if (/misspelling/i.test(m[1])) t = "misspelling of";
  else if (/\b(obsolete|archaic|dated|superseded)\b/i.test(gloss)) t = "older spelling of";
  return { t, l: target };
}
function detect(rec) {
  if (!rec || !rec.d) return null;
  for (const s of rec.d) { const r = classify(s.g || ""); if (r) return r; }
  return null;
}

// ---- 1) scan the dictionary for variant words ----
// Group by canonical spelling: canon -> { spellings:[{w,t}], misspellings:[w] }.
const scan = {};
for (const w of vocab) {
  const r = detect(shards[shardOf[w]][w]);
  if (!r) continue;
  if (r.l === w || !vocab.has(r.l)) continue;       // target must be a real, distinct entry
  const c = (scan[r.l] = scan[r.l] || { spellings: [], misspellings: [] });
  if (r.t === "misspelling of") c.misspellings.push(w);
  else c.spellings.push({ w, t: r.t });
}

// ---- 2) merge into the registry, preserving human review ----
let reg = { meta: {}, clusters: {} };
if (fs.existsSync(REG)) { try { reg = JSON.parse(fs.readFileSync(REG, "utf8")); } catch (e) {} }
reg.clusters = reg.clusters || {};
let added = 0, refreshed = 0, kept = 0;
for (const canon of Object.keys(scan)) {
  const found = scan[canon];
  const prev = reg.clusters[canon];
  if (prev && (prev.status === "confirmed" || prev.status === "rejected" || prev.by === "user")) {
    // Human-curated: never clobbered. Union any newly found spellings so the
    // record stays complete, but keep status/provenance/manual additions.
    const have = new Set((prev.spellings || []).map((s) => s.w));
    for (const s of found.spellings) if (!have.has(s.w)) prev.spellings.push(s);
    prev.misspellings = Array.from(new Set([...(prev.misspellings || []), ...found.misspellings])).sort();
    kept++; continue;
  }
  const spellings = found.spellings.slice().sort((a, b) => a.w.localeCompare(b.w));
  const entry = { spellings, misspellings: found.misspellings.sort(), by: "assistant", at: now, status: "auto" };
  if (prev) refreshed++; else added++;
  reg.clusters[canon] = entry;
}
reg.meta = {
  note: "Spelling-variant clusters. status: auto (engine-detected) | confirmed (human ok) | rejected. Human entries (status confirmed/rejected or by:user) survive re-runs.",
  updated: now,
  clusters: Object.keys(reg.clusters).length,
};

const totalSpell = Object.values(reg.clusters).reduce((n, c) => n + (c.spellings || []).length, 0);
const totalMis = Object.values(reg.clusters).reduce((n, c) => n + (c.misspellings || []).length, 0);
console.log("registry:", Object.keys(reg.clusters).length, "clusters |",
  totalSpell, "alt spellings,", totalMis, "misspellings | scan added", added, "refreshed", refreshed, "kept(human)", kept);
for (const c of ["capelin", "color", "behavior", "fetus"]) {
  if (reg.clusters[c]) console.log("  " + c + ":", reg.clusters[c].spellings.map((s) => s.w).join(", "),
    reg.clusters[c].misspellings.length ? "(misspell: " + reg.clusters[c].misspellings.join(", ") + ")" : "");
}

if (!apply) { console.log("\n(dry run — pass --apply to write registry + shards)"); return; }

// ---- 3) write the registry ----
fs.mkdirSync(path.dirname(REG), { recursive: true });
fs.writeFileSync(REG, JSON.stringify(reg, null, 2));

// ---- 4) apply the registry to the shards ----
// Each spelling/misspelling word gets a rel pointer; the canonical word gets a
// vars list of its real alternative spellings (misspellings are pointers only,
// not advertised on the canonical card). Never clobber a non-variant rel
// (inflection / family / curated) already on a word.
const touched = {};
function isVariantRel(r) { return r && /spelling|variant|form/i.test(r.t || ""); }
function setRel(w, t, l, by) {
  const f = shardOf[w]; if (!f) return;
  const rec = shards[f][w];
  if (rec.rel && !isVariantRel(rec.rel)) return;   // preserve inflection/family/curated
  rec.rel = { t, l, by: by || "assistant", at: now };
  touched[f] = true;
}
let relCount = 0, varCount = 0;
for (const canon of Object.keys(reg.clusters)) {
  const c = reg.clusters[canon];
  if (c.status === "rejected") continue;
  if (!shardOf[canon]) continue;
  for (const s of (c.spellings || [])) { setRel(s.w, s.t || "variant of", canon, c.by); relCount++; }
  for (const m of (c.misspellings || [])) { setRel(m, "misspelling of", canon, c.by); relCount++; }
  const list = Array.from(new Set((c.spellings || []).map((s) => s.w))).filter((x) => x !== canon).sort();
  if (list.length) { shards[shardOf[canon]][canon].vars = list; touched[shardOf[canon]] = true; varCount += list.length; }
}
for (const f of Object.keys(touched)) fs.writeFileSync(path.join(WORDS, f), JSON.stringify(shards[f]));
console.log("applied", relCount, "rels and", varCount, "vars across", Object.keys(touched).length, "shards");
