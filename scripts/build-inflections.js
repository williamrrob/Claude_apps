#!/usr/bin/env node
/*
 * build-inflections.js — collapse inflected/derived forms under their base lemma.
 *
 * Each form gets a rel {t,l} pointing at its base ("adverb of", "plural of",
 * "past tense of", ...); the base gets a `forms` list of the forms that fold into
 * it (rendered on its card). Conservative on purpose — only:
 *   - "-ly" adverbs whose base is a known ADJECTIVE   (absentmindedly -> absentminded)
 *   - inflections Wiktionary marks explicitly via sense.form_of (plural/past/
 *     participle/comparative/superlative/third-person), base must be a headword.
 * Derivations that make a genuinely distinct lexeme (-ness, -ity, ...) are left
 * as their own cards.
 *
 * Never clobbers a non-inflection rel already on a word (variant/family/curated).
 * Dry-run by default.
 *
 *   node scripts/build-inflections.js [kaikki-en.jsonl] [--apply]
 */
"use strict";
const fs = require("fs"), path = require("path"), readline = require("readline");
const { stringifyShard } = require("./shard-format.js");
const EMPTY = "";
const WORDS = path.join(__dirname, "..", "words");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SRC = args.find((a) => !a.startsWith("--") && fs.existsSync(a)) || null;

const shards = {}, shardOf = {}, entry = {};
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  shards[f] = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const w of Object.keys(shards[f])) { shardOf[w.toLowerCase()] = f; entry[w.toLowerCase()] = shards[f][w]; }
}
const isAdj = (w) => { const e = entry[w]; return !!(e && (e.d || []).some((s) => /^adj/.test(s.p || EMPTY))); };
const isVariantRel = (r) => r && /spelling|variant|form|misspelling/i.test(r.t || EMPTY);

// form -> { l: base, t: relation }
const map = new Map();
function add(form, base, t) {
  form = form.toLowerCase(); base = base.toLowerCase();
  if (form === base || !entry[form] || !entry[base]) return;
  if (map.has(form)) return;                       // first rule wins
  map.set(form, { l: base, t });
}

// ---- rule: -ly adverbs off an adjective base -------------------------------
for (const w of Object.keys(entry)) {
  if (!w.endsWith("ly") || w.length < 5) continue;
  const cands = [];
  if (w.endsWith("ily")) cands.push(w.slice(0, -3) + "y");
  cands.push(w.slice(0, -2));
  for (const b of cands) if (isAdj(b)) { add(w, b, "adverb of"); break; }
}

// ---- Kaikki explicit inflections (form_of) ---------------------------------
function inflType(tags) {
  const t = new Set((tags || []).map((x) => x.toLowerCase()));
  if (t.has("plural")) return "plural of";
  if (t.has("comparative")) return "comparative of";
  if (t.has("superlative")) return "superlative of";
  if (t.has("past") && t.has("participle")) return "past participle of";
  if (t.has("present") && t.has("participle")) return "present participle of";
  if (t.has("gerund")) return "gerund of";
  if (t.has("past")) return "past tense of";
  if (t.has("participle")) return "participle of";
  if (t.has("third-person") || t.has("third-person-singular")) return "third-person singular of";
  return null;
}

(async function () {
  if (SRC) {
    const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.lang_code && o.lang_code !== "en") continue;
      const w = (o.word || EMPTY).toLowerCase();
      if (!entry[w] || map.has(w)) continue;
      for (const s of (o.senses || [])) {
        const fo = (s.form_of && s.form_of[0] && s.form_of[0].word) ||
          ((s.glosses || []).slice(-1)[0] || EMPTY).match(/\bof\s+([a-z][a-z'-]+)\b/i)?.[1];
        const t = inflType(s.tags);
        if (fo && t) { add(w, fo, t); break; }
      }
    }
  }
  finish();
})();

function finish() {
  let linked = 0; const byType = {}; const ex = [];
  const baseForms = new Map();
  for (const [form, { l, t }] of map) {
    const r = entry[form].rel;
    if (r && !isVariantRel(r)) continue;            // keep curated/family rel
    linked++; byType[t] = (byType[t] || 0) + 1;
    if (!baseForms.has(l)) baseForms.set(l, []);
    baseForms.get(l).push(form);
    if (t === "adverb of" && ex.length < 12) ex.push("[" + form + "] " + t + " " + l);
    if (APPLY) { entry[form].rel = { t, l, by: "assistant", at: NOW }; touched(shardOf[form]); }
  }
  if (APPLY) {
    for (const [base, forms] of baseForms) {
      const e = entry[base];
      e.forms = Array.from(new Set([...(e.forms || []), ...forms])).sort();
      touched(shardOf[base]);
    }
    for (const f of Object.keys(TOUCH)) fs.writeFileSync(path.join(WORDS, f), stringifyShard(shards[f]));
  }
  const L = [];
  L.push("BUILD-INFLECTIONS " + (APPLY ? "APPLIED" : "DRY RUN") + (SRC ? " (+Kaikki form_of)" : " (-ly rule only)"));
  L.push("=".repeat(56));
  L.push("forms collapsed under a base: " + linked);
  for (const t of Object.keys(byType).sort()) L.push("  " + t + ": " + byType[t]);
  L.push("bases gaining a forms list: " + baseForms.size);
  L.push("");
  L.push("---- adverb examples ----"); for (const e of ex) L.push("  " + e);
  const out = path.join(__dirname, "..", "build-inflections-" + (APPLY ? "applied" : "dryrun") + ".txt");
  fs.writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write(L.join("\n") + "\n");
  process.stderr.write("\nreport at " + out + "\n");
}
const NOW = new Date().toISOString();
const TOUCH = {};
function touched(f) { if (f) TOUCH[f] = true; }
