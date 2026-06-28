"use strict";
/*
 * Canonical word-shard formatting, shared by word.js, dedupe.js and
 * normalize-shards.js so every shard stays consistent.
 *
 * Format: valid JSON, but ONE WORD PER LINE with a compact value, e.g.
 *   {
 *   "biannual":{"d":[...],"e":"...","s":[...]},
 *   "bias":{"d":[...]}
 *   }
 * One line per word means editing a single word is a one-line diff (cheap to
 * review), while staying small (no per-field whitespace) and parse-identical to
 * any other JSON the app loads.
 */
function stringifyShard(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return "{}\n";
  return "{\n" + keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(obj[k])).join(",\n") + "\n}\n";
}
module.exports = { stringifyShard };
