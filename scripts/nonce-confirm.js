#!/usr/bin/env node
/*
 * nonce-confirm.js — run the etymologist over the confluence suspect pool and
 * record its established/nonce verdict per word. The confluence score
 * (review/junk-scores.tsv) is the SAFETY GATE: rich real words never enter
 * the pool, so the LLM only ever judges low-currency suspects. Report only —
 * writes review/nonce-verdicts.jsonl; no entry is deleted here.
 *
 * Resumable: appends one JSON line per word, skips words already recorded on
 * restart. Safe to kill and re-run. Progress to stderr every 25.
 *
 *   node scripts/nonce-confirm.js [--min 7] [--model etymologist]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const MIN = Number(arg("min", 7));
const MODEL = arg("model", "etymologist");
const OUT = path.join(ROOT, "review", "nonce-verdicts.jsonl");

const glossCache = {};
function gloss(w) {
  const k = w.slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(k)) return "";
  if (!glossCache[k]) { try { glossCache[k] = JSON.parse(fs.readFileSync(path.join(ROOT, "words", k + ".json"), "utf8")); } catch (e) { glossCache[k] = {}; } }
  const r = glossCache[k][w] || glossCache[k][w.toLowerCase()];
  return (r && r.d && r.d[0] && r.d[0].g) || "";
}

// turn the confluence signal flags into a plain-English currency line, so the
// model weighs actual currency (the spamference fix) not surface plausibility
const SIG = { "no-usage": "no recorded usage", "no-rank": "not in the frequency list",
  "no-wiki/attest": "no dictionary attestation or Wikipedia entry", "isolated": "no synonyms or related words",
  register: "tagged slang/humorous/neologism", "no-pron": "no pronunciation on record" };
function currencyLine(flags) {
  const parts = String(flags || "").split(",").map((f) => SIG[f]).filter(Boolean);
  return parts.length ? "\nCurrency signals: " + parts.join("; ") + "." : "";
}

async function classify(w, g, flags) {
  const res = await fetch(OLLAMA + "/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: "Classify this headword into one of: established, phrase, inflection, name, nonce.\nHeadword: " + w + "\nDefinition: " + g + currencyLine(flags), stream: false, format: "json", keep_alive: "30m", options: { temperature: 0, num_predict: 30 } }),
  });
  if (!res.ok) throw new Error("ollama " + res.status);
  const t = JSON.parse((await res.json()).response).type;
  return ["established", "phrase", "inflection", "name", "nonce"].includes(t) ? t : "?";
}

async function main() {
  const suspects = [];
  for (const l of fs.readFileSync(path.join(ROOT, "review", "junk-scores.tsv"), "utf8").split("\n").slice(1)) {
    const f = l.split("\t"); if (f[0] && Number(f[1]) >= MIN) suspects.push({ w: f[0], score: Number(f[1]), flags: f[2] });
  }
  suspects.sort((a, b) => b.score - a.score); // highest-junk first, so the best finds land early
  const done = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n")) { if (l.trim()) try { done.add(JSON.parse(l).w); } catch (e) {} }
  const todo = suspects.filter((s) => !done.has(s.w));
  process.stderr.write("pool score>=" + MIN + ": " + suspects.length + " | done: " + done.size + " | to judge: " + todo.length + " (model " + MODEL + ")\n");

  const out = fs.createWriteStream(OUT, { flags: "a" });
  let n = 0, nonce = 0; const started = Date.now();
  for (const s of todo) {
    n++;
    let t; try { t = await classify(s.w, gloss(s.w), s.flags); } catch (e) { t = "ERR"; }
    if (t === "nonce") nonce++;
    out.write(JSON.stringify({ w: s.w, score: s.score, verdict: t }) + "\n");
    if (n % 25 === 0 || n === todo.length) {
      const rate = n / ((Date.now() - started) / 1000);
      process.stderr.write(n + "/" + todo.length + "  nonce:" + nonce + "  ~" + Math.round((todo.length - n) / rate / 60) + " min left\n");
    }
  }
  out.end();
  process.stderr.write("done. nonce verdicts: " + nonce + " this run.\n");
}
main().catch((e) => { process.stderr.write("nonce-confirm: " + e.message + "\n"); process.exit(1); });
