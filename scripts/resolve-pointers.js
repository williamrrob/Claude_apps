#!/usr/bin/env node
/*
 * resolve-pointers.js — turn redirect/pointer entries into real cards, with a
 * proper canonicalization layer. Deletes nothing.
 *
 * Two jobs:
 *  1) SPELLING-VARIANT clusters ("Alternative form of X", "British spelling of
 *     Y", "Misspelling of Z"): gather the cluster (even when the named canonical
 *     isn't a headword yet), choose ONE canonical by rule —
 *        real definition  >  hyphenless  >  US spelling  >  shortest
 *     — MATERIALIZE the canonical's definition from Kaikki if no member has one,
 *     and fold every other spelling into it (rel -> canonical, vars on canonical).
 *  2) SYNONYM / other pointers ("Synonym of X", "Initialism of X"): replace the
 *     bare pointer with X's real definition (from our dict, else Kaikki) and keep
 *     the word as its own card (with a rel note for context).
 *
 * Only PURE-pointer entries (every sense is a pointer) are touched; entries that
 * already carry a real sense are left alone. Dry-run by default.
 *
 *   node scripts/resolve-pointers.js <kaikki-en.jsonl> [--apply]
 */
"use strict";
const fs = require("fs"), path = require("path"), readline = require("readline");
const { stringifyShard } = require("./shard-format.js");

const EMPTY = "";
const SRC = process.argv[2];
const APPLY = process.argv.includes("--apply");
const WORDS = path.join(__dirname, "..", "words");
if (!SRC || SRC.startsWith("--") || !fs.existsSync(SRC)) {
  process.stderr.write("usage: node scripts/resolve-pointers.js <kaikki-en.jsonl> [--apply]\n");
  process.exit(1);
}

// ---- pointer classification ------------------------------------------------
function pointerOf(gloss) {
  const g = String(gloss || "").trim();
  let type = null;
  if (/^misspelling of\b/i.test(g)) type = "spelling";
  else if (/\bspelling of\b/i.test(g)) type = "spelling";
  else if (/^(alternative|obsolete|archaic|dated|nonstandard|informal|rare|standard|superseded|early[ -]modern|eye[- ]?dialect|common|formal|british|american|chiefly)\b.{0,30}\bform of\b/i.test(g)) type = "spelling";
  else if (/^(synonym|antonym) of\b/i.test(g)) type = "synonym";
  else if (/^(initialism|abbreviation|acronym|clipping|ellipsis|contraction|short for) of\b/i.test(g)) type = "abbrev";
  if (!type) return null;
  const m = g.match(/\bof\s+(.+)$/i); if (!m) return null;
  let t = m[1].replace(/\s*\(.*$/, EMPTY).replace(/[.,;:”"’']+$/, EMPTY).trim();
  if (!t) return null;
  return { type, target: t, targetLc: t.toLowerCase() };
}
const realSense = (e) => (e.d || []).some((s) => s.g && !pointerOf(s.g));
const pointerEntry = (e) => Array.isArray(e.d) && e.d.length > 0 && e.d.every((s) => pointerOf(s.g));

// ---- load dictionary -------------------------------------------------------
const shards = {}, shardOf = {}, entry = {};
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  shards[f] = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const w of Object.keys(shards[f])) { shardOf[w.toLowerCase()] = f; entry[w.toLowerCase()] = shards[f][w]; }
}
const hasDictDef = (w) => { const e = entry[w]; return !!(e && realSense(e)); };
const inDict = (w) => Object.prototype.hasOwnProperty.call(entry, w);

// ---- pass 1: collect pointer entries, build spelling clusters --------------
const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const link = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };

const syn = [];        // {w, target} synonym/abbrev pointers (pure entries)
const needKaikki = new Set();
for (const wl of Object.keys(entry)) {
  const e = entry[wl];
  if (!pointerEntry(e)) continue;
  const info = pointerOf(e.d[0].g);
  if (!info) continue;
  if (info.type === "spelling") {
    link(wl, info.targetLc);
    if (!hasDictDef(wl)) needKaikki.add(wl);
    if (!hasDictDef(info.targetLc)) needKaikki.add(info.targetLc);
  } else {
    syn.push({ w: wl, target: info.targetLc, type: info.type });
    if (!hasDictDef(info.targetLc)) needKaikki.add(info.targetLc);
  }
}
// cluster members
const clusters = new Map();
for (const x of parent.keys()) { const r = find(x); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(x); }

// ---- pass 2: stream Kaikki for the definitions we need ----------------------
const kdef = {}; // lc word -> {g, p}
(async function () {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.lang_code && o.lang_code !== "en") continue;
    const w = (o.word || EMPTY).toLowerCase();
    if (!needKaikki.has(w) || kdef[w]) continue;
    for (const s of (o.senses || [])) {
      const g = (s.glosses || []).slice(-1)[0];
      if (g && !pointerOf(g)) { kdef[w] = { g: g.trim(), p: o.pos }; break; }
    }
  }
  finish();
})();

// ---- canonical selection rule ----------------------------------------------
const POS = { noun: "n.", verb: "v.", adj: "adj.", adv: "adv.", name: "n.", phrase: "phrase" };
function usScore(f) {
  let s = 0;
  if (/ize\b|izing\b|ization\b|yze\b/.test(f)) s++; if (/ise\b|ising\b|isation\b|yse\b/.test(f)) s--;
  if (/[^ ]or\b|[^ ]ors\b/.test(f) && !/our\b|ours\b/.test(f)) s++; if (/our\b|ours\b/.test(f)) s--;
  if (/og\b/.test(f)) s++; if (/ogue\b/.test(f)) s--;
  if (/ense\b/.test(f)) s++; if (/ence\b/.test(f) && /(def|off|pret)ence/.test(f)) s--;
  if (/eled\b|eling\b|eler\b/.test(f)) s++; if (/elled\b|elling\b|eller\b/.test(f)) s--;
  return s;
}
function defRank(w) { return hasDictDef(w) ? 0 : (kdef[w] ? 1 : 2); }
// hyphenless preferred (modern: email/today/online): closed best, then hyphenated, then spaced
function hyRank(f) { return (!f.includes("-") && !/\s/.test(f)) ? 0 : (f.includes("-") ? 1 : 2); }
// Rule: HYPHENLESS wins outright; the definition is moved onto it. Among equally
// hyphenated forms, prefer one that already has a def, then US, then shortest.
function pickCanonical(members) {
  return members.slice().sort((a, b) => {
    return hyRank(a) - hyRank(b) || defRank(a) - defRank(b) ||
      usScore(b) - usScore(a) || a.length - b.length || a.localeCompare(b);
  })[0];
}
// the real definition to put on the canonical: from any cluster member that has one
function donorDef(members, canon) {
  for (const m of [canon, ...members]) {
    if (hasDictDef(m)) { const s = firstReal(entry[m]); return { g: s.g, p: s.p }; }
    if (kdef[m]) return { g: kdef[m].g, p: POS[kdef[m].p] || (kdef[m].p ? kdef[m].p + "." : EMPTY) };
  }
  return null;
}

function finish() {
  const report = [];
  let foldRel = 0, materialized = 0, synResolved = 0, unresolved = 0;
  const exVar = [], exSyn = [], exUn = [];

  // ---- spelling clusters: hyphenless canonical, definition moved onto it ----
  const shardable = (w) => /^[a-z][a-z]/.test(w);
  const shardFileOf = (w) => w.slice(0, 2) + ".json";
  for (const [, members] of clusters) {
    if (members.length < 2) continue;
    const sh = members.filter(shardable);
    if (sh.length < 2) { unresolved++; continue; }
    const canon = pickCanonical(sh);
    let rec = entry[canon];
    // If the canonical is already collapsed as an inflection (e.g. "adverb of
    // absentminded"), keep that — fold its spellings but don't materialize a
    // redundant definition card; its meaning rides on the base.
    const canonInfl = rec && rec.rel && !/spelling|variant|form|misspelling/i.test(rec.rel.t || EMPTY);
    if (!hasDictDef(canon) && !canonInfl) {
      const donor = donorDef(sh, canon);
      if (!donor) { unresolved++; if (exUn.length < 10) exUn.push("[" + sh.join("/") + "] no def anywhere"); continue; }
      if (!rec) rec = { d: [] };
      rec.d = [{ p: donor.p || EMPTY, g: donor.g }].concat((rec.d || []).filter((s) => !pointerOf(s.g)));
      materialized++;
      if (exVar.length < 14) exVar.push("[" + canon + "] (hyphenless canonical) " + donor.g.slice(0, 48) + "  <= " + sh.filter((m) => m !== canon).join(", "));
    } else if (exVar.length < 14) {
      exVar.push("[" + canon + "]" + (canonInfl ? " (inflection)" : " (canonical)") + " <= " + sh.filter((m) => m !== canon).join(", "));
    }
    if (!rec) rec = entry[canon] || { d: [] };
    // fold the rest (creating a searchable redirect for any spelling not yet a headword)
    const vars = [];
    for (const m of sh) {
      if (m === canon) continue;
      vars.push(m); foldRel++;
      if (!APPLY) continue;
      let mr = entry[m];
      if (!mr) { mr = { d: [{ p: EMPTY, g: "Variant of " + canon + "." }] }; const mf = shardFileOf(m); shardOf[m] = mf; shards[mf] = shards[mf] || {}; shards[mf][m] = mr; entry[m] = mr; }
      if (!mr.rel || /spelling|variant|form|misspelling/i.test(mr.rel.t || EMPTY)) mr.rel = { t: "variant of", l: canon, by: "assistant", at: NOW };
      touched(shardOf[m]);
    }
    if (APPLY) {
      rec.vars = Array.from(new Set([...(rec.vars || []), ...vars])).sort();
      if (!entry[canon]) { const cf = shardFileOf(canon); shardOf[canon] = cf; shards[cf] = shards[cf] || {}; shards[cf][canon] = rec; entry[canon] = rec; }
      touched(shardOf[canon]);
    }
  }

  // ---- synonym / abbrev pointers ----
  for (const { w, target, type } of syn) {
    const def = hasDictDef(target) ? firstReal(entry[target]) : (kdef[target] ? kdef[target] : null);
    if (!def) { unresolved++; if (exUn.length < 10) exUn.push("[" + w + "] -> " + target + " (unresolvable)"); continue; }
    synResolved++;
    if (exSyn.length < 12) exSyn.push("[" + w + "] " + type + " of " + target + "  =>  " + def.g.slice(0, 60));
    if (APPLY) {
      const r = entry[w];
      r.d = [{ p: (def.p ? (POS[def.p] || def.p) : (r.d[0] && r.d[0].p) || EMPTY), g: def.g }];
      r.rel = { t: type + " of", l: target, by: "assistant", at: NOW };
      touched(shardOf[w]);
    }
  }

  if (APPLY) for (const f of Object.keys(TOUCH)) fs.writeFileSync(path.join(WORDS, f), stringifyShard(shards[f]));

  report.push("RESOLVE-POINTERS " + (APPLY ? "APPLIED" : "DRY RUN") + " — rule: real-def > hyphenless > US > shortest");
  report.push("=".repeat(64));
  report.push("spelling clusters folded:        " + clusters.size + " clusters, " + foldRel + " variants -> canonical");
  report.push("  canonicals materialized from Kaikki: " + materialized);
  report.push("synonym/abbrev pointers resolved: " + synResolved);
  report.push("unresolvable (left untouched):    " + unresolved);
  report.push("");
  report.push("---- spelling examples ----"); for (const e of exVar) report.push("  " + e);
  report.push("\n---- synonym examples (pointer => real def) ----"); for (const e of exSyn) report.push("  " + e);
  report.push("\n---- unresolvable (kept as-is, NOT deleted) ----"); for (const e of exUn) report.push("  " + e);
  const out = path.join(__dirname, "..", "resolve-pointers-" + (APPLY ? "applied" : "dryrun") + ".txt");
  fs.writeFileSync(out, report.join("\n") + "\n");
  process.stdout.write(report.join("\n") + "\n");
  process.stderr.write("\nreport at " + out + "\n");
}
function firstReal(e) { for (const s of (e.d || [])) if (s.g && !pointerOf(s.g)) return s; return null; }

const NOW = new Date().toISOString();
const TOUCH = {};
function touched(f) { if (f) TOUCH[f] = true; }
