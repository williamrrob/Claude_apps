// Full family membership for a root: every vocab word whose engine decomposition
// contains that root id (not the 60-capped morpheme-index). For comprehensive,
// hand-classified families. Writes family/candidates/<root>.json (gitignored use).
//
//   node scripts/family-candidates.js fer
"use strict";
const fs = require("fs"); const path = require("path");
const ROOT = path.join(__dirname, ".."); const WORDS = path.join(ROOT, "words");
const E = require(path.join(ROOT, "engine.js"));
const rootId = process.argv[2]; if (!rootId) { console.error("usage: family-candidates.js <rootId>"); process.exit(1); }

const vocab = [];
for (const f of fs.readdirSync(WORDS)) { if (f.endsWith(".json")) vocab.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8")))); }
const hits = [];
for (const w of vocab.sort()) {
  let r; try { r = E.decompose(w); } catch (e) { continue; }
  if (r.parts.some((p) => p.kind === "root" && p.id === rootId)) {
    hits.push({ w: w, parse: r.parts.map((p) => p.surface + (p.kind === "root" ? "*" : "")).join("·") });
  }
}
hits.sort((a, b) => a.w.length - b.w.length || a.w.localeCompare(b.w));
fs.mkdirSync(path.join(ROOT, "family", "candidates"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "family", "candidates", rootId + ".json"), JSON.stringify(hits.map((h) => h.w)));
console.log(rootId + ": " + hits.length + " engine-matched words");
console.log(hits.map((h) => h.w).join(", "));
