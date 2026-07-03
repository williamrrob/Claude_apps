#!/usr/bin/env node
/*
 * qwen-classify.js — independent second opinion on the mechanical classifier.
 * Feeds each sampled word + its gloss to qwen2.5:14b and asks for one of the
 * five types, so we can see where qwen agrees/disagrees per category before
 * trusting the mechanical labels on the whole corpus. Report only.
 *
 *   node scripts/qwen-classify.js   # reads review/class-sample-*.txt, writes review/qwen-class.tsv
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const REVIEW = path.join(ROOT, "review");
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = "qwen2.5:14b";

const PROMPT = (w, g) =>
  "Classify this dictionary headword into exactly one category.\n\n" +
  "Categories:\n" +
  "- established: a real English word (any era/register, including rare, archaic, technical, slang, or nonce words that aren't tied to a specific fan community)\n" +
  "- phrase: a multi-word expression or idiom that is not a person/place name\n" +
  "- inflection: an inflected form or spelling variant of another word (plural, past tense, alternative spelling)\n" +
  "- name: a proper noun — a person's name, surname, given name, or a place\n" +
  "- coinage: a fandom or pop-culture artifact — a ship name (romantic pairing of characters/celebrities), a franchise fandom term, a stan/fanfic/fursona coinage. NARROW: only pop-culture/fandom, not general slang.\n\n" +
  "Headword: " + w + "\nDefinition: " + (g || "(none)") + "\n\n" +
  'Reply with ONLY JSON: {"type":"established|phrase|inflection|name|coinage"}';

async function ask(w, g) {
  const res = await fetch(OLLAMA + "/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: PROMPT(w, g), stream: false, format: "json", keep_alive: "30m", options: { temperature: 0, num_predict: 40 } }),
  });
  if (!res.ok) throw new Error("ollama " + res.status);
  const j = JSON.parse((await res.json()).response);
  return ["established", "phrase", "inflection", "name", "coinage"].includes(j.type) ? j.type : "?";
}

async function main() {
  const rows = [];
  for (const mechType of ["established", "phrase", "inflection", "name", "coinage"]) {
    const p = path.join(REVIEW, "class-sample-" + mechType + ".txt");
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const [w, g] = line.split("\t");
      let qt; try { qt = await ask(w, g); } catch (e) { qt = "ERR"; }
      rows.push({ w, g: g || "", mech: mechType, qwen: qt });
      process.stderr.write(mechType[0] + (qt === mechType ? "." : "!"));
    }
    process.stderr.write("\n");
  }
  fs.writeFileSync(path.join(REVIEW, "qwen-class.tsv"),
    "word\tmech\tqwen\tgloss\n" + rows.map((r) => [r.w, r.mech, r.qwen, r.g].join("\t")).join("\n") + "\n");

  // agreement matrix
  const agree = {}, disagree = [];
  for (const r of rows) {
    agree[r.mech] = agree[r.mech] || { ok: 0, n: 0 };
    agree[r.mech].n++;
    if (r.qwen === r.mech) agree[r.mech].ok++; else disagree.push(r);
  }
  console.log("\nAGREEMENT (mechanical vs qwen):");
  for (const [t, a] of Object.entries(agree)) console.log("  " + t + ": " + a.ok + "/" + a.n);
  console.log("\nDISAGREEMENTS:");
  for (const r of disagree) console.log("  " + r.w + "  mech=" + r.mech + " qwen=" + r.qwen + "  | " + r.g.slice(0, 60));
}
main().catch((e) => { process.stderr.write("qwen-classify: " + e.message + "\n"); process.exit(1); });
