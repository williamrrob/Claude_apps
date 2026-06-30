"use strict";
/*
 * decomp-lib.js — shared heuristic for flagging a confidently-wrong engine
 * parse, used by check-decomp.js and add-root.js. See check-decomp.js's
 * header comment for the full explanation of what this catches and why.
 */

// A "clean" split: every letter accounted for by a real morpheme, no unknown
// debris, confidence high enough that chooseBreakdown() in app.js would show
// it as-is (it only falls back to whole-word display below this bar).
function isCleanSplit(d) {
  return !!(d && d.hasRoot && (d.confidence || 0) >= 0.6 &&
    d.parts.length > 1 && !d.parts.some(function (p) { return p.kind === "unknown"; }));
}

// Does anything about this root part show up in the word's own etymology text?
// Returns true/false, or null if there's no etymology text to check against.
function corroborated(part, etyText) {
  if (!etyText) return null;
  const ety = etyText.toLowerCase();
  const tokens = [part.id, part.source]
    .concat(String(part.meaning || "").split(/[,;\s]+/))
    .filter(function (t) { return t && t.length >= 3; })
    .map(function (t) { return t.toLowerCase(); });
  return tokens.some(function (t) { return ety.indexOf(t) !== -1; });
}

// classify(word, entry, decompose) -> null (not the dangerous shape) | { verdict, parts }
// verdict is "SUSPECT" (corroboration failed for at least one root), "UNVERIFIED"
// (no etymology text to check against), or "ok" (corroborated).
function classify(word, entry, decompose) {
  const d = decompose(word);
  if (!isCleanSplit(d)) return null;
  const roots = d.parts.filter(function (p) { return p.kind === "root"; });
  if (!roots.length) return null;
  const ety = entry && entry.e;
  const checks = roots.map(function (r) { return corroborated(r, ety); });
  const anyFalse = checks.some(function (c) { return c === false; });
  const allUnknown = checks.every(function (c) { return c === null; });
  const verdict = anyFalse ? "SUSPECT" : allUnknown ? "UNVERIFIED" : "ok";
  return { verdict: verdict, parts: d.parts.map(function (p) { return p.kind + ":" + p.surface; }).join(" + ") };
}

module.exports = { isCleanSplit: isCleanSplit, corroborated: corroborated, classify: classify };
