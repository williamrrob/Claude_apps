// ety-clean.js — turn a raw Kaikki etymology_text into displayable prose.
//
// Wiktextract sometimes prepends an ancestor-"tree" dump: an "Etymology tree"
// (or "PIE word …") header followed by one line per ancestor node
// ("Proto-Germanic *ana-", "Latin diphthongusbor."), with the real prose —
// if any — as the trailing lines. Node lines are short noun phrases; prose
// lines are sentence-shaped (long, commas, "from …"). Working line-by-line on
// the RAW text (newlines intact) is what makes the two distinguishable.
//
// Returns "" when no usable prose exists (caller should skip, not ship a dump).
"use strict";

const TREE_HEAD = /^(Etymology tree|PIE word)\b/;

function isProseLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (TREE_HEAD.test(t)) return false;
  const words = t.split(/\s+/).length;
  return t.length > 60 || /[,;:]/.test(t) || (/\bfrom\b/i.test(t) && words > 5) || words > 8;
}

function cleanEtymology(raw, budget) {
  const BUDGET = budget || 400;
  let s = String(raw == null ? "" : raw);
  if (!s.trim()) return "";
  if (TREE_HEAD.test(s.trim()) || /▲/.test(s)) {
    const lines = s.split("\n");
    const start = lines.findIndex(isProseLine);
    if (start === -1) return "";
    s = lines.slice(start).join(" ");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= BUDGET) return s;
  const cut = s.slice(0, BUDGET);
  // last REAL sentence end within budget: period/!/? not belonging to a known
  // abbreviation, followed by space+capital/quote/paren or end of text
  const ABBR = /(?:\b(?:cf|e\.g|i\.e|etc|ca?|lit|viz|vs|fl|no|St|Mt|Dr|Jr|Sr)|\p{Lu})$/u;
  let best = -1;
  const re = /[.!?](?=$|\s+[\p{Lu}“"(])/gu;
  let m;
  while ((m = re.exec(cut))) {
    if (ABBR.test(cut.slice(0, m.index))) continue;
    best = m.index;
  }
  if (best > 60) return cut.slice(0, best + 1).trim();
  return cut.slice(0, Math.min(BUDGET, 400)).trimEnd() + " …";
}

module.exports = { cleanEtymology };
