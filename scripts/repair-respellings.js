#!/usr/bin/env node
/*
 * repair-respellings.js — REPORTER ONLY. Flags entries whose plain respelling
 * (rs, CMU-derived) claims a consonant sound their Wiktionary IPA (i) lacks,
 * into review/respelling-flags.tsv.
 *
 * FINDING (2026-07-03, do not "fix" this mechanically): of 45,573 entries
 * with both fields, 799 carry such an insertion — but sampling shows the
 * majority are NOT errors: UK (non-rhotic) IPA vs US respelling (adornment),
 * elision variants (abruptly /əˈbɹʌp.li/), or places where CMU is right and
 * the Wiktionary IPA is loose (acts /æks/). The true spelling-driven phantom
 * class (brougham's g from CMU "B R UW1 G AH0 M") is real but rare and not
 * separable at acceptable precision — those get fixed per-word from the
 * review file, never in bulk.
 *
 *   node scripts/repair-respellings.js       # writes review/respelling-flags.tsv
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const WORDS = path.join(ROOT, "words");
const { stringifyShard } = require("./shard-format.js");

const APPLY = process.argv.includes("--apply");

// ---- IPA → respelling ----
// longest-match tokenization; chunks mirror arpabet.js RES so the two
// generators produce the same style.
const MAP = [
  ["d͡ʒ","j"],["t͡ʃ","ch"],["d͡ʒ","j"],["t͡ʃ","ch"],
  ["dʒ","j"],["tʃ","ch"],["aʊ","ow"],["aɪ","y"],["eɪ","ay"],["ɔɪ","oy"],
  ["oʊ","oh"],["əʊ","oh"],["ɪə","ee-uh"],["eə","air"],["ʊə","oo-uh"],
  ["iː","ee"],["uː","oo"],["ɑː","ah"],["ɔː","aw"],["ɜː","ur"],["ɜ","ur"],
  ["ɝ","ur"],["ɚ","ur"],["ɑ","ah"],["æ","a"],["ʌ","uh"],["ə","uh"],["ɛ","eh"],
  ["ɪ","i"],["i","ee"],["ɒ","ah"],["ɔ","aw"],["ʊ","uu"],["u","oo"],["e","eh"],
  ["a","a"],["o","oh"],["y","ee"],
  ["ʃ","sh"],["ʒ","zh"],["θ","th"],["ð","th"],["ŋ","ng"],["ɡ","g"],["g","g"],
  ["ɹ","r"],["ɾ","t"],["ʁ","r"],["r","r"],["ɫ","l"],["l","l"],["j","y"],
  ["ʔ",""],["x","kh"],["ç","h"],
  ["b","b"],["d","d"],["f","f"],["h","h"],["k","k"],["m","m"],["n","n"],
  ["p","p"],["s","s"],["t","t"],["v","v"],["w","w"],["z","z"],
];
const VOWEL_CHUNKS = new Set(["ow","y","ay","oy","oh","ee","oo","ah","aw","ur","a","uh","eh","i","uu","air","ee-uh","oo-uh"]);

function ipaToResp(ipa) {
  // strip slashes/brackets, length marks handled in MAP, split on syllable
  // markers: ˈ ˌ . (keep stress info)
  let s = String(ipa).replace(/^\/|\/$/g, "").replace(/[\[\]()]/g, "").trim();
  if (!s || /[⁓~;,]| /.test(s)) return null; // multi-pron strings: skip
  const sylls = [];
  let cur = { stress: 0, out: [] };
  const flush = () => { if (cur.out.length) sylls.push(cur); };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "ˈ" || c === "ˌ" || c === ".") { flush(); cur = { stress: c === "ˈ" ? 1 : c === "ˌ" ? 2 : 0, out: [] }; i++; continue; }
    if (/[̀-ͯ̃ʰʲʷ˞ːˑ‿ᵊ]/.test(c)) { i++; continue; } // diacritics/length: drop
    let hit = null;
    for (const [k, v] of MAP) { if (s.startsWith(k, i)) { hit = [k, v]; break; } }
    if (!hit) return null; // unknown symbol — don't guess
    let out = hit[1];
    // syllabic consonant (l̩ n̩ m̩): speak a schwa before it (AY-buhl, not AY-bl)
    if (s[i + hit[0].length] === "̩") out = out && "uh" + out;
    if (out) cur.out.push(out);
    i += hit[0].length;
  }
  flush();
  if (!sylls.length) return null;
  const multi = sylls.length > 1;
  return sylls.map((sy) => {
    const text = sy.out.join("");
    return multi && sy.stress === 1 ? text.toUpperCase() : text;
  }).filter(Boolean).join("-") || null;
}

// consonant multiset for comparison — parse the respelling through the SAME
// chunk grammar (vowel chunks like "uh"/"oh"/"aw" contain h/w LETTERS that
// are not consonant SOUNDS; naive letter-scanning flags 9k false positives)
const CHUNKS = ["ee-uh","oo-uh","air","ow","oy","oh","ee","oo","ah","aw","ur","uh","eh","uu","ay",
  "ch","sh","th","zh","ng","kh","a","i","y","b","d","f","g","h","j","k","l","m","n","p","r","s","t","v","w","z"];
const CONS_SET = new Set(["ch","sh","th","zh","ng","kh","b","d","f","g","h","j","k","l","m","n","p","r","s","t","v","w","z"]);
// voicing pairs count as the same sound (absorbed: CMU z vs Wiktionary s is
// dialect/source variation, not an error)
const CLASS = { z: "s", v: "f", j: "ch", zh: "sh" };
function consMultiset(resp) {
  const counts = {};
  const s = String(resp).toLowerCase().replace(/[^a-z]/g, "");
  for (let i = 0; i < s.length; ) {
    let hit = null;
    for (const k of CHUNKS) { if (s.startsWith(k, i)) { hit = k; break; } }
    if (!hit) { i++; continue; }
    if (CONS_SET.has(hit)) { const c = CLASS[hit] || hit; counts[c] = (counts[c] || 0) + 1; }
    i += hit.length;
  }
  return counts;
}
// flag only INSERTIONS: rs claims a consonant sound the IPA simply doesn't
// have (brougham's phantom g) — substitutions/omissions are left alone
function insertedCons(rsCounts, ipaCounts) {
  const extra = [];
  for (const [c, n] of Object.entries(rsCounts)) if (n > (ipaCounts[c] || 0)) extra.push(c);
  return extra;
}

let checked = 0, flagged = 0, repaired = 0, unparsable = 0, touched = 0;
const samples = [];
const flags = [];
for (const f of fs.readdirSync(WORDS).filter((x) => x.endsWith(".json"))) {
  const p = path.join(WORDS, f);
  const sh = JSON.parse(fs.readFileSync(p, "utf8"));
  let dirty = false;
  for (const [w, rec] of Object.entries(sh)) {
    if (!rec.i || !rec.rs) continue;
    checked++;
    const ipaResp = ipaToResp(rec.i);
    if (ipaResp == null) { unparsable++; continue; }
    const extra = insertedCons(consMultiset(rec.rs), consMultiset(ipaResp));
    if (!extra.length) continue;
    flagged++;
    flags.push([w, rec.i, rec.rs, extra.join(","), ipaResp].join("\t"));
  }
}

fs.writeFileSync(path.join(ROOT, "review", "respelling-flags.tsv"),
  "word\tipa\trs\textra_consonants\tipa_derived_resp\n" + flags.join("\n") + "\n");
console.log("REPAIR-RESPELLINGS — report only (see header for why no bulk apply)");
console.log("entries with both i+rs: " + checked + " | flagged insertions: " + flagged +
  " | IPA unparsable: " + unparsable + " → review/respelling-flags.tsv");
