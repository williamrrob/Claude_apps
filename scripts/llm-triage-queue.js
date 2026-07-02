#!/usr/bin/env node
/*
 * llm-triage-queue.js — pre-triage review/QUEUE.tsv with a local Ollama model,
 * so the human review pass starts from three sorted piles instead of 4,000
 * undifferentiated suspects:
 *
 *   confident-wrong — the engine's split is a coincidental letter match
 *                     (the congee/bigos bug class) → candidate for forcing
 *                     whole-word display via `word.js bulk-field b`
 *   confident-ok    — the split reflects the word's real derivation (e.g.
 *                     effect·s flagged only for its stray single-letter "s")
 *   needs-human     — the model is unsure, or the word/etymology is obscure
 *
 * The model VOTES on splits; it never authors etymology content, and nothing
 * here writes to words/*.json. Applying the verdicts is a separate, reviewed
 * step (see `emit-wrong` / `emit-decisions` below), with spot-checks in
 * between. Same triage-not-writer posture as llm-verify-decomp.js, but driven
 * by the review queue + misfire signatures (triage-queue.js) instead of the
 * decomp-lib SUSPECT scan, and with per-piece glosses in the prompt so the
 * model can see WHAT the engine claims each fragment means.
 *
 * Built to run unattended for hours:
 *   - Resumable: appends one JSON line per verdict to review/llm-triage.jsonl
 *     (gitignored, like all review/*.jsonl) and skips already-done words on
 *     restart.
 *   - Per-word errors are recorded as verdict ERROR and skipped, not fatal.
 *   - Progress ticks to stderr every 25 words.
 *
 * Usage:
 *   node scripts/llm-triage-queue.js run [--model qwen2.5:14b] [--limit N]
 *   node scripts/llm-triage-queue.js report            # pile sizes + samples
 *   node scripts/llm-triage-queue.js emit-wrong        # {"word":[{s,k:"word"}]…} for the
 *                                                      #   confident-wrong pile → word.js bulk-field b
 *   node scripts/llm-triage-queue.js emit-decisions    # decisions.log lines for both piles
 *   node scripts/llm-triage-queue.js sample <pile> <n> # random sample for spot-checking
 * Flags for emit/sample/report commands: --exclude-rank-below N (keep common words
 * out of the auto-apply piles; they go to needs-human instead).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const REVIEW = path.join(ROOT, "review");
const WORDS = path.join(ROOT, "words");

global.MORPHEMES = require(path.join(ROOT, "data.js")).MORPHEMES;
const engine = require(path.join(ROOT, "engine.js"));

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const argv = process.argv.slice(2);
const CMD = argv[0] || "report";
const arg = (name, def) => { const i = argv.indexOf("--" + name); return i !== -1 ? argv[i + 1] : def; };
const MODEL = arg("model", "qwen2.5:14b");
const LIMIT = Number(arg("limit", 0)) || 0;
const OUT = path.join(REVIEW, arg("out", "llm-triage.jsonl"));
// Words at least this common stay needs-human no matter what the model says —
// a wrong whole-forcing on a common word is the costliest mistake available here.
const RANK_GUARD = Number(arg("exclude-rank-below", 60000));

// Optional second opinion: a TSV of etymology-db English structure rows
// (word \t reltype \t related_term — has_prefix/has_suffix/compound_of/…).
// If Wiktionary's parsed etymology graph says a word IS morphologically
// complex, a COINCIDENTAL vote is not trusted enough to force it whole; the
// word is bumped to needs-human instead.
const ETYMDB = arg("etymdb", null);
let etymdbStructured = null;
if (ETYMDB) {
  etymdbStructured = new Set();
  for (const line of fs.readFileSync(ETYMDB, "utf8").split("\n")) {
    const w = line.slice(0, line.indexOf("\t"));
    if (w) { etymdbStructured.add(w); etymdbStructured.add(w.toLowerCase()); }
  }
}

// ---- queue ----
function loadQueue() {
  const p = path.join(REVIEW, "QUEUE.tsv");
  return fs.readFileSync(p, "utf8").split("\n").slice(1).filter((l) => l.trim()).map((l) => {
    const [word, rank, flags, b] = l.split("\t");
    return { word, rank: rank === "-" ? Infinity : Number(rank), flags, b };
  });
}

// same signature algorithm as triage-queue.js, so --emit interoperates
function signature(word) {
  let r;
  try { r = engine.decompose(word); } catch (e) { return "engine-error"; }
  const parts = r.parts || [];
  const sig = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.id) continue;
    let tag = p.kind + ":" + p.id;
    if (p.kind === "suffix" && i === 0) tag += "@0";
    if (p.kind === "prefix" && i === parts.length - 1) tag += "@end";
    sig.push(tag);
  }
  return sig.join(" + ") || "(no known parts)";
}

// human-readable split with the engine's claimed glosses:  bi(Greek bios "life") + go(?) + s(-s "plural")
function describeParts(word) {
  let r;
  try { r = engine.decompose(word); } catch (e) { return null; }
  return (r.parts || []).map((p) => {
    if (!p.id) return p.surface + "(unmatched stem)";
    const bits = [p.origin, p.source && p.source !== p.surface ? p.source : null].filter(Boolean).join(" ");
    return p.surface + " (" + p.kind + (bits ? ", " + bits : "") + ' = "' + (p.meaning || "?") + '")';
  }).join("  +  ");
}

// etymology lookup straight from the shards (bulk, in-process — cheaper than
// 4,000 word.js subprocesses; read-only, so the iron rule's concern doesn't apply)
const shardCache = new Map();
function getEty(word) {
  const key = word.slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(key)) return "";
  if (!shardCache.has(key)) {
    const p = path.join(WORDS, key + ".json");
    shardCache.set(key, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {});
  }
  const shard = shardCache.get(key);
  const rec = shard[word] || shard[word.toLowerCase()];
  return rec && rec.e ? String(rec.e).replace(/\s+/g, " ").slice(0, 380) : "";
}

function buildPrompt(item) {
  const others = item.groupmates && item.groupmates.length
    ? "\nOther words the algorithm split the same way (same pattern, judged separately): " + item.groupmates.slice(0, 6).join(", ")
    : "";
  return (
    "You are an etymology fact-checker. A pattern-matching algorithm split an English " +
    "dictionary headword into morpheme pieces. Letter patterns often match by pure " +
    "coincidence, so the split can be nonsense.\n\n" +
    "COINCIDENTAL example: \"bigos\" (a Polish stew, borrowed from Polish) split as " +
    "bi (Greek bios \"life\") + go + s (plural). The word has nothing to do with Greek " +
    "\"life\" or an English plural — the letters just line up. Proper names, loanwords, " +
    "and Germanic words \"matching\" Latin/Greek roots are the classic cases.\n" +
    "REAL example: \"effects\" split as effect + s (plural) — the -s really is the " +
    "English plural suffix. A split is REAL when every MATCHED piece genuinely plays " +
    "that role in the word's actual derivation, even if an unmatched stem is left over, " +
    "and even if the etymology text only gives a word-level derivation (\"absolute + " +
    "-ist\") whose deeper classical roots the split correctly names.\n\n" +
    "Word: " + item.word + "\n" +
    "Algorithm's split: " + item.partsDesc + "\n" +
    "Dictionary etymology on file: " + (item.ety ? '"' + item.ety + '"' : "(none)") + others + "\n\n" +
    "Judge only whether the matched pieces are etymologically real for THIS word. " +
    "If you do not recognize the word and there is no etymology to check against, say UNSURE. " +
    "Reply with ONLY one JSON object:\n" +
    '{"verdict":"REAL"|"COINCIDENTAL"|"UNSURE","reason":"<one short sentence>"}'
  );
}

async function askOllama(prompt) {
  const res = await fetch(OLLAMA + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, prompt, stream: false, format: "json", keep_alive: "30m",
      options: { temperature: 0, num_predict: 160 },
    }),
  });
  if (!res.ok) throw new Error("ollama " + res.status + ": " + (await res.text()).slice(0, 200));
  const json = await res.json();
  return JSON.parse(json.response);
}

function loadResults() {
  if (!fs.existsSync(OUT)) return [];
  return fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// pile assignment for one verdict row (rank guard applied here, so report/emit
// stay consistent with each other)
function pileOf(r) {
  if (r.verdict === "COINCIDENTAL" && r.rank < RANK_GUARD) return "needs-human";
  if (r.verdict === "COINCIDENTAL" && etymdbStructured &&
      (etymdbStructured.has(r.word) || etymdbStructured.has(r.word.toLowerCase()))) return "needs-human";
  if (r.verdict === "COINCIDENTAL") return "confident-wrong";
  if (r.verdict === "REAL") return "confident-ok";
  return "needs-human";
}

async function run() {
  const queue = loadQueue();
  const done = new Set(loadResults().map((r) => r.word));
  // group by signature so groupmates give the model pattern context, and so
  // bigger (more damaging) misfire families get judged first
  const groups = new Map();
  for (const q of queue) {
    const sig = signature(q.word);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(q);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  let todo = [];
  for (const [sig, items] of ordered) {
    const words = items.map((i) => i.word);
    for (const q of items) {
      if (done.has(q.word)) continue;
      todo.push(Object.assign({ sig, groupmates: words.filter((w) => w !== q.word) }, q));
    }
  }
  if (LIMIT) todo = todo.slice(0, LIMIT);
  process.stderr.write("model: " + MODEL + " | queue: " + queue.length + " | already judged: " + done.size + " | to process: " + todo.length + "\n");
  if (!todo.length) return;

  const outStream = fs.createWriteStream(OUT, { flags: "a" });
  let n = 0; const tally = { REAL: 0, COINCIDENTAL: 0, UNSURE: 0, ERROR: 0 };
  const started = Date.now();
  for (const item of todo) {
    n++;
    item.partsDesc = describeParts(item.word) || item.b;
    item.ety = getEty(item.word);
    let row;
    try {
      const resp = await askOllama(buildPrompt(item));
      const v = ["REAL", "COINCIDENTAL", "UNSURE"].includes(resp.verdict) ? resp.verdict : "UNSURE";
      row = { word: item.word, sig: item.sig, rank: item.rank === Infinity ? null : item.rank,
        parts: item.b, ety: !!item.ety, verdict: v, reason: String(resp.reason || "").slice(0, 200), model: MODEL };
    } catch (e) {
      row = { word: item.word, sig: item.sig, rank: item.rank === Infinity ? null : item.rank,
        parts: item.b, ety: !!item.ety, verdict: "ERROR", reason: e.message.slice(0, 200), model: MODEL };
    }
    tally[row.verdict] = (tally[row.verdict] || 0) + 1;
    outStream.write(JSON.stringify(row) + "\n");
    if (n % 25 === 0 || n === todo.length) {
      const rate = n / ((Date.now() - started) / 1000);
      process.stderr.write(n + "/" + todo.length +
        "  REAL:" + tally.REAL + " COINC:" + tally.COINCIDENTAL + " UNSURE:" + tally.UNSURE + " ERR:" + tally.ERROR +
        "  ~" + Math.round((todo.length - n) / rate / 60) + " min left\n");
    }
  }
  outStream.end();
  process.stderr.write("run complete.\n");
}

function withRank(rows) {
  // rows already carry rank; normalize nulls
  return rows.map((r) => Object.assign({}, r, { rank: r.rank == null ? Infinity : r.rank }));
}

function report() {
  const rows = withRank(loadResults());
  if (!rows.length) { console.log("no results yet at " + OUT); return; }
  const piles = { "confident-wrong": [], "confident-ok": [], "needs-human": [] };
  for (const r of rows) piles[pileOf(r)].push(r);
  console.log("LLM TRIAGE — " + rows.length + " judged (model " + (rows[rows.length - 1].model || "?") + ", rank guard <" + RANK_GUARD + " → needs-human)");
  for (const [name, list] of Object.entries(piles)) {
    console.log("\n== " + name + ": " + list.length);
    for (const r of list.slice(0, 12)) {
      console.log("   " + r.word + "  [" + r.parts + "]" + (r.ety ? "" : "  (no ety)") + "\n      " + r.verdict + ": " + r.reason);
    }
    if (list.length > 12) console.log("   … " + (list.length - 12) + " more");
  }
  // signature-group coherence: groups where votes disagree are worth eyes
  const bySig = new Map();
  for (const r of rows) { if (!bySig.has(r.sig)) bySig.set(r.sig, new Set()); bySig.get(r.sig).add(pileOf(r)); }
  const mixed = [...bySig.entries()].filter(([, s]) => s.has("confident-wrong") && s.has("confident-ok"));
  console.log("\nsignature groups with MIXED wrong/ok votes (fine — words differ within a pattern): " + mixed.length);
}

function emitWrong() {
  const rows = withRank(loadResults());
  const out = {};
  for (const r of rows) if (pileOf(r) === "confident-wrong") out[r.word] = [{ s: r.word, k: "word" }];
  process.stdout.write(JSON.stringify(out) + "\n");
  process.stderr.write(Object.keys(out).length + " word(s) — after spot-checking, pipe into: node scripts/word.js bulk-field b\n");
}

function emitDecisions() {
  const rows = withRank(loadResults());
  const lines = [];
  for (const r of rows) {
    const pile = pileOf(r);
    if (pile === "confident-wrong") lines.push(JSON.stringify({ w: r.word, st: "fixed", note: "llm-triage(" + (r.model || MODEL) + "): coincidental split " + r.parts + " — forced whole; " + r.reason }));
    else if (pile === "confident-ok") lines.push(JSON.stringify({ w: r.word, st: "ok", note: "llm-triage(" + (r.model || MODEL) + "): split confirmed; " + r.reason }));
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.stderr.write(lines.length + " decision line(s) — append to review/decisions.log AFTER applying the b writes\n");
}

function sample() {
  const pile = argv[1], n = Number(argv[2]) || 20;
  const rows = withRank(loadResults()).filter((r) => pileOf(r) === pile);
  // deterministic shuffle so repeated calls show the same sample
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const picked = rows.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, r]) => r);
  for (const r of picked) {
    console.log(r.word + "  [" + r.parts + "]  rank:" + (r.rank === Infinity ? "-" : r.rank));
    console.log("   ety: " + (r.ety ? "(on file)" : "(none)") + " | " + r.verdict + ": " + r.reason);
  }
}

if (CMD === "run") run().catch((e) => { process.stderr.write("llm-triage-queue: " + e.message + "\n"); process.exit(1); });
else if (CMD === "report") report();
else if (CMD === "emit-wrong") emitWrong();
else if (CMD === "emit-decisions") emitDecisions();
else if (CMD === "sample") sample();
else { process.stderr.write("unknown command " + CMD + " (run|report|emit-wrong|emit-decisions|sample)\n"); process.exit(1); }
