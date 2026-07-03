// etym-evidence.js — the grounding standard. Given a word, return the real
// parsed derivation from the canonical graph (vendor-data/etymgraph.sqlite) as
// a compact evidence string to paste into an LLM prompt, so the model READS
// the etymology instead of guessing from memory. Pair with the etymologist
// model (scripts/etymologist.Modelfile): baked rules + live evidence.
//
//   const { evidenceFor, openEvidence } = require("./etym-evidence.js");
//   const ev = openEvidence();            // opens the db once
//   ev.evidenceFor("December");           // → "December: inherited from Middle English December; from Old French decembre; from Latin december (\"of December\"); …"
//   ev.close();
"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DBP = path.join(__dirname, "..", "vendor-data", "etymgraph.sqlite");
const fold = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\*/g, "").trim();
const KIND = { inh: "inherited from", bor: "borrowed from", der: "from", aff: "affix", cmp: "compound of", root: "root" };

function openEvidence() {
  if (!fs.existsSync(DBP)) return { evidenceFor: () => "", close: () => {} };
  const db = new DatabaseSync(DBP, { readOnly: true });
  const qNode = db.prepare("SELECT id, contested FROM node WHERE norm = ?");
  const qEdges = db.prepare(
    "SELECT e.kind, e.src, p.lang, p.term, p.gloss, p.contested FROM edge e JOIN node p ON p.id = e.parent WHERE e.child = ? ORDER BY (e.kind='inh') DESC, e.rowid LIMIT 8");

  function evidenceFor(word) {
    const n = qNode.get("English|" + fold(word)) ||
      qNode.get("English|" + fold(word[0].toUpperCase() + word.slice(1)));
    if (!n) return "";
    const all = qEdges.all(n.id);
    if (!all.length) return "";
    // collapse identical hops asserted by multiple sources (December's ME hop
    // from etymology-db AND EtymDB is one fact, not two)
    const seen = new Set(), rows = [];
    for (const r of all) { const k = r.kind + "|" + r.lang + "|" + r.term; if (!seen.has(k)) { seen.add(k); rows.push(r); } }
    const parts = rows.map((r) => {
      let s = (KIND[r.kind] || r.kind) + " " + r.lang + " " + r.term;
      if (r.gloss) s += " (“" + String(r.gloss).split(/[;,(]/)[0].trim().slice(0, 40) + "”)";
      if (r.contested) s += " [contested]";
      return s;
    });
    // source coverage note so the model can weight the evidence
    const srcs = [...new Set(rows.map((r) => ({ edb: "etymology-db", ket: "Wiktionary tree", etydb: "EtymDB" }[r.src] || r.src)))];
    return word + ": " + parts.join("; ") + ". (parsed from " + srcs.join(" + ") + ")";
  }
  return { evidenceFor, close: () => db.close() };
}

// CLI: node scripts/etym-evidence.js <word> [<word> …]
if (require.main === module) {
  const ev = openEvidence();
  for (const w of process.argv.slice(2)) console.log(ev.evidenceFor(w) || "(no graph evidence for " + w + ")");
  ev.close();
}

module.exports = { openEvidence };
