#!/usr/bin/env node
/*
 * llm-verify-decomp.js — grind through check-decomp.js's SUSPECT backlog with
 * a local Ollama model, doing the same "read the real etymology, judge
 * whether the engine's split is genuinely supported or a coincidental false
 * match (the congee/exegete/solipsism/hyphen/Jacobin bug class)" triage a
 * human has been doing by hand, at full-dictionary scale, unattended.
 *
 * This is a TRIAGE tool, not a writer — it never touches words/*.json. A
 * small local model's etymological judgment isn't reliable enough to apply
 * blind; the value is turning "read ~2,900 etymologies myself" into "read a
 * pre-sorted shortlist of ~a few hundred likely-real bugs, each with a
 * one-line reason and a rough suggested root already drafted." Same
 * dry-run-first posture as dedupe.js / symmetrize-relations.js.
 *
 * Built to run for hours unattended:
 *   - Resumable: writes one JSON line per verdict to --out as it goes, and on
 *     startup skips any word already present in that file. Killing the
 *     process and re-running the same command continues where it left off.
 *   - Per-word errors (bad JSON from the model, a dropped connection) are
 *     logged and skipped, not fatal — one bad response shouldn't sink an
 *     hours-long run.
 *   - Progress ticks to stderr every 25 words.
 *
 * Usage:
 *   ollama pull qwen2.5:3b                     # once, if not already pulled
 *   node scripts/llm-verify-decomp.js [--limit N] [--shard xx] [--model NAME] [--out file.jsonl]
 *
 * Then: node scripts/llm-verify-decomp.js --report   # summarize an existing run
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORDS_DIR = path.join(ROOT, "words");
global.MORPHEMES = require(path.join(ROOT, "data.js")).MORPHEMES;
const engine = require(path.join(ROOT, "engine.js"));
const { classify } = require("./decomp-lib.js");

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf("--" + name); return i !== -1 ? argv[i + 1] : def; };
const MODEL = arg("model", "qwen2.5:3b");
const OUT = path.join(ROOT, arg("out", "llm-decomp-verify.jsonl"));
const LIMIT = arg("limit", null);
const ONLY_SHARD = arg("shard", null);
const REPORT_ONLY = argv.includes("--report");

function readShard(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

// ---- gather the SUSPECT backlog (same detection check-decomp.js uses) ----
function collectSuspects() {
  const files = fs.readdirSync(WORDS_DIR).filter((f) => f.endsWith(".json")).sort()
    .filter((f) => !ONLY_SHARD || f === ONLY_SHARD + ".json");
  const out = [];
  for (const f of files) {
    const obj = readShard(path.join(WORDS_DIR, f));
    for (const w of Object.keys(obj)) {
      if (obj[w].b) continue;
      if (/[\s-]/.test(w)) continue;
      const r = classify(w, obj[w], engine.decompose);
      if (r && r.verdict === "SUSPECT") out.push({ word: w, parts: r.parts, ety: obj[w].e || "" });
    }
  }
  return out;
}

// ---- resume support: load already-processed words from a prior run ----
function loadDone() {
  const done = new Set();
  if (!fs.existsSync(OUT)) return done;
  for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).word); } catch (e) {}
  }
  return done;
}

function buildPrompt(word, parts, ety) {
  return (
    "You are an etymology fact-checker. An algorithm split an English word into morpheme " +
    "pieces, but it can be coincidentally wrong.\n\n" +
    "BAD example: \"congee\" split into con- (\"with\") + \"ge\" (\"earth\") — nonsense, the " +
    "real word is from Latin commeatus, unrelated to earth or togetherness.\n" +
    "OK example: \"absolutist\" split into ab- + solut + -ist. The etymology just says " +
    "\"from absolute + -ist\" without spelling out absolute's own deeper roots — but ab- " +
    "(\"away\") + solut (\"loosen\", from solvere) IS the real, standard derivation one level " +
    "down. Don't flag WRONG just because the etymology stops at a word-level derivation " +
    "instead of spelling out every classical sub-root; only flag WRONG when the proposed " +
    "root's MEANING has no real relationship to the etymology at all, like the congee case.\n\n" +
    "Word: " + word + "\n" +
    "Algorithm's proposed split: " + parts + "\n" +
    "Word's real etymology: \"" + (ety || "(none on file)") + "\"\n\n" +
    "Reply with ONLY this JSON, nothing else:\n" +
    "{\"verdict\":\"OK\"}\n" +
    "{\"verdict\":\"WRONG\",\"reason\":\"<one short sentence>\",\"suggested_root\":\"<the real root word from the etymology, or null>\"}"
  );
}

async function askOllama(prompt) {
  const res = await fetch(OLLAMA + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: prompt, stream: false, format: "json", options: { temperature: 0 } }),
  });
  if (!res.ok) throw new Error("ollama " + res.status + ": " + (await res.text()));
  const json = await res.json();
  return JSON.parse(json.response);
}

function printReport() {
  if (!fs.existsSync(OUT)) { console.log("no results file at " + OUT + " yet"); return; }
  const rows = fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const wrong = rows.filter((r) => r.verdict === "WRONG");
  const ok = rows.filter((r) => r.verdict === "OK");
  const errors = rows.filter((r) => r.verdict === "ERROR");
  console.log("LLM DECOMP VERIFY — " + rows.length + " processed (" + wrong.length + " flagged WRONG, " + ok.length + " confirmed OK, " + errors.length + " errors)");
  console.log("=".repeat(60));
  for (const r of wrong) console.log(r.word + "  [" + r.parts + "]\n  reason: " + r.reason + "\n  suggested root: " + r.suggested_root);
}

async function main() {
  if (REPORT_ONLY) return printReport();

  const suspects = collectSuspects();
  const done = loadDone();
  let queue = suspects.filter((s) => !done.has(s.word));
  if (LIMIT) queue = queue.slice(0, Number(LIMIT));

  process.stderr.write("model: " + MODEL + " | backlog: " + suspects.length + " total, " + done.size + " already done, " + queue.length + " to process\n");
  if (!queue.length) return;

  const outStream = fs.createWriteStream(OUT, { flags: "a" });
  let n = 0, wrongCount = 0;
  const started = Date.now();
  for (const item of queue) {
    n++;
    let verdict;
    try {
      const resp = await askOllama(buildPrompt(item.word, item.parts, item.ety));
      verdict = Object.assign({ word: item.word, parts: item.parts }, resp);
    } catch (e) {
      verdict = { word: item.word, parts: item.parts, verdict: "ERROR", reason: e.message };
    }
    if (verdict.verdict === "WRONG") wrongCount++;
    outStream.write(JSON.stringify(verdict) + "\n");
    if (n % 25 === 0 || n === queue.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = n / elapsed;
      const etaMin = Math.round((queue.length - n) / rate / 60);
      process.stderr.write(n + "/" + queue.length + " (" + wrongCount + " flagged so far) — ~" + etaMin + " min remaining\n");
    }
  }
  outStream.end();
  process.stderr.write("done. run `node scripts/llm-verify-decomp.js --report` to see the flagged list.\n");
}

main().catch((e) => { process.stderr.write("llm-verify-decomp: " + e.message + "\n"); process.exit(1); });
