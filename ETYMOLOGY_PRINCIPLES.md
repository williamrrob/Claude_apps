# Rootwork — Etymology Analysis Principles

These are the standing rules for how to analyze and encode word etymologies in this app.

---

## 1. Always trace roots to their deepest known ancestor

When identifying a root, go as far back as the evidence allows:
- Proto-Indo-European (PIE) is the goal when reconstruction exists
- If PIE is unavailable, use Proto-Germanic, Proto-West Germanic, Proto-Italic, etc.
- Only stop at Latin, Old French, Old Norse, etc. if no deeper reconstruction is available
- Never stop at Modern or Middle English

**Example:** `marine`, `morass`, `moor`, `marsh`, `mere` → all traced to PIE `*móri` (body of water), not stopped at Latin `mare` or Dutch `moer`.

---

## 2. Cognates from the same root share one MORPHEMES entry

If multiple English surface forms descend from the same ultimate ancestor, they belong in a **single root entry** in `data.js` with all forms listed.

**Example:**
```js
{ id: "mori", forms: ["mar","mare","mari","marin","mor","moor","mere"],
  origin: "Proto-Indo-European", source: "*móri",
  meaning: "body of water — sea, lake, marsh" }
```

This means `marine`, `mariner`, `morass`, `moor`, `moorland`, and `mere` (the noun) all point to the same entry and show the same PIE source.

Do **not** create separate entries for `mar` (Latin), `mor` (Dutch), and `moor` (PGmc) if they are the same ultimate root.

---

## 3. Different PIE roots stay separate, even if semantically similar

Words that share meaning but come from different PIE roots must have separate entries:

| Root | PIE source | Words |
|------|-----------|-------|
| `mori` | `*móri` | sea, lake, marsh | marine, moor, morass, mere |
| `mire-on` | `*meug-` | damp, slimy | mire, quagmire |
| `fen-oe` | `*pen-` | bog | fen |
| `bog-gael` | Irish/Gaelic | soft | bog |
| `quag` | OE `*cwabbe` | boggy, trembling | quag, quagmire |

---

## 4. Cover all source languages, not just Latin and Greek

English draws from many languages. All are valid and should be represented:
- Old English / Proto-Germanic / Proto-Indo-European
- Old Norse / Old Saxon / Proto-West Germanic
- Old French / Norman French (not via Latin)
- Arabic, Persian, Hindi, Sanskrit
- Irish / Scottish Gaelic
- Dutch, Low German, Spanish, Italian, Portuguese
- Hebrew, Turkic, etc.

When adding a new morpheme, identify its actual origin language — do not default to Latin/Greek just because it's convenient.

---

## 5. Curated `b` breakdowns are authoritative over the engine

Every word entry in `words/*.json` can have a `b` (breakdown) field. This is the correct, hand-verified split:

- If `b` has 1 part with `k:"word"` → the word is treated as an unanalyzable whole
- If `b` has 2+ parts → those parts are shown (engine is bypassed)
- If `b` is `null` or missing → the engine's algorithmic parse is used

Always add a curated `b` rather than relying on the engine for words with real etymological structure.

---

## 6. Use explicit `src`/`o`/`g` fields to override MORPHEMES for specific parts

When a word shard part needs etymology that differs from its MORPHEMES entry, use:
- `src`: the source word in the original language (overrides MORPHEMES source)
- `o`: the origin language (overrides MORPHEMES origin)
- `g`: the gloss/meaning (overrides MORPHEMES meaning)

If `src` is set, `hybridPart()` uses these fields exclusively (no MORPHEMES lookup).

**Example — distinguishing homographs:**
```json
{"s":"mere","k":"root","src":"merus","o":"Latin","g":"pure, alone, only"}
```
This protects `merely` from inheriting the OE `mere` (lake) meaning from the unified `mori` entry.

---

## 7. Non-productive endings can be shown as suffixes with explicit data

Old French place suffixes, fossilized Latin endings, etc. can still be shown as `k:"suffix"` parts with explicit src/o/g, even if they're not in the global suffix index:

```json
{"s":"ass","k":"suffix","src":"-ais","o":"Old French","g":"place suffix (cognate with English -ish)"}
```

---

## 8. Word family cross-links

When adding a word, note its doublets and cognates. The `e` (etymology) field should mention related English words (e.g., *morass*, *marsh*, *mere*, *moor* are all doublets of each other via PIE `*móri`).

---

## Branch

Main branch (deploys to `williamrrob.github.io/Claude_apps` on push):
`claude/visual-etymology-app-093c1d`. Session work happens on per-session
branches merged into main.
