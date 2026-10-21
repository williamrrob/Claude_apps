# Rootwork — assistant playbook

Static, no-build web app (three `<script>` tags, JSON data files, GitHub
Pages). **Main branch: `claude/visual-etymology-app-093c1d`** — pushing to it
deploys to https://williamrrob.github.io/Claude_apps/. Session work happens on
per-session branches merged into main.

## Current shape (update when it drifts)

**The app is a map.** `graph.js` draws every entry and every ancestor form
named in its Wiktionary etymology as one point (WebGL + a collision-checked
label canvas). An entry is one point: arriving shows a callout pinned to the
dot; tapping it or pinching in opens the entry sheet. Geometry: radius from a
family's centre = time (log years-before-present), adjacency = relation,
dot size = number of English descendants.

**One source: Wiktionary.** Everything etymological comes from it:
- `vendor-data/` (gitignored, regenerable): `kaikki-en.jsonl.gz` (English dump),
  `raw-wiktextract-data.jsonl.gz` (all languages), and the extracts below.
- `scripts/import-kaikki-etym.js` → `vendor-data/kaikki-etym.jsonl`: per English
  headword, the template chain (inh/bor/der… with connectors `+` component,
  `&` parallel source), surface parts, doublets, cognates, sense-linked synonyms.
- `scripts/import-kaikki-ancestors.js` → `vendor-data/kaikki-ancestors.jsonl`:
  the ancestor forms' own entries (gloss + their own chain), so lines of
  descent continue past where the English entry stops.
- `scripts/apply-kaikki-etym.js --apply` writes onto the shards: `e` (only where
  the stored text was clipped/blob), `wp` (Wiktionary surface parts), `ss`
  (synonym → the gloss of this word's sense it belongs to).
- `etym-parse.js` (browser + Node) parses etymology prose: the fallback for words
  the dumps don't cover, and the display cleaner for `e`.
- `scripts/build-etym-graph.js` → `g/` (gitignored intermediate) → 
  `scripts/build-graph-layout.js` → `graph/` (served: labels, xy/meta/lang/tree/links
  binaries, `n/<chunk>.json` node details, `doublets.json`, `info.json`).
  Rebuild: `npm run build:sqlite && node scripts/build-etym-graph.js && node scripts/build-graph-layout.js`,
  then bump `V` in graph.js.

Also: `words/<xx>.json` — 581 shards, ~222,600 entries (definitions, IPA,
etymology text, synonyms; fields documented in `scripts/word.js`).
Breakdown tiles: Wiktionary parts (`wp`, else parsed prose) → MorphoLex `b` →
heuristic engine (`engine.js` + `data.js`) as last resort.
`doublets.json` (repo root) = the doublet-hunt pool. Merriam-Webster, the
multi-source `trees/`, hand-authored `family/<root>.json` files and the curator
editor were retired (Oct 2026) — don't reintroduce parallel sources.

## Iron rules

1. **Never open a `words/*.json` shard directly** (some are ~2MB). Use
   `scripts/word.js` for all reads/writes; it self-validates and auto-bumps
   the client cache version (DATA_V) on write.
2. **Don't author dictionary content Wiktionary already has.** Draft
   mechanically, then review:
   `node scripts/word.js draft <word>` (prints entry; `--apply` writes it).
3. Etymology follows `ETYMOLOGY_PRINCIPLES.md` (trace to deepest ancestor,
   one entry per PIE root, curated `b` beats the engine, `src`/`o`/`g`
   overrides for homographs).
4. After changing app.js/styles.css/engine.js/data.js by hand, bump the right
   version: `node scripts/bump-version.js styles|app|engine|data|datav`
   (word.js writes bump `datav` automatically).
5. Run `npm test` before committing (or enable the hook once:
   `git config core.hooksPath .githooks`).

## Cheap workflows

- **Read one field**: `node scripts/word.js get <word> [field]`
- **Batch existence check**: `node scripts/word.js missing <w1> <w2> …`
- **Write many entries in one call**: `word.js bulk-set` / `bulk-field` (JSON
  on stdin).
- **Query the whole corpus**: `npm run build:sqlite` (~15s) then `npm run find
  root|prefix|meaning|rel|missing|stats|q` — never grep shards.
- **Fix engine misparses in bulk**: `node scripts/triage-queue.js` clusters
  review/QUEUE.tsv by shared misfire signature; `--emit <sig> --whole | node
  scripts/word.js bulk-field b` resolves a whole group in one write. Record
  judgments in `review/decisions.log`
  (`{"w":"word","st":"ok"|"fixed","note":"…"}` per line).
- **New engine morpheme**: `node scripts/add-root.js` (includes collision scan).
- **Backfill pronunciation**: `node scripts/backfill-pronunciation.js --apply`.

## Heavy (local-compute) workflows

Fine on a dev Mac; avoid re-deriving in token-metered sessions:

- Full Wiktionary dump import: `curl -s https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl`
  → `scripts/import-kaikki.js` / `build-rich.js` / `build-inflections.js` /
  `resolve-pointers.js` (all dry-run by default).
- `vendor-data/` (gitignored, keep between sessions) — downloaded etymology
  source dumps: etymology-db `etymology.csv` (4.2M typed relations parsed from
  Wiktionary; github.com/droher/etymology-db), its extracted English
  morphological-structure TSV, EtymDB 2.1 (github.com/clefourrier/EtymDB), and
  per-language Kaikki dumps (`kaikki-<Lang>.jsonl.gz`: Latin, Ancient Greek,
  Middle/Old English, Old French, Proto-Indo-European, Proto-Germanic) for
  ancestor lemmas, and the full English dump (`kaikki-en.jsonl.gz`, ~3GB raw —
  `gunzip -k` before running the backfill scripts against it). Re-download
  URLs are in each build script's header. `etym.sqlite` is derived — rebuild
  with `node scripts/build-etymdb.js`.
- Semantic dedup/search: `npm run embed build` (local Ollama,
  nomic-embed-text) then `npm run find similar <word>`.
- Cloud-session note: Node fetch behind the agent proxy needs
  `NODE_USE_ENV_PROXY=1` (word.js draft, etc.).

## Verifying UI changes

`npm test` covers wiring. For visuals: `python3 -m http.server 8099` and
screenshot with Playwright; check BOTH color schemes (the app and editor.html
follow `prefers-color-scheme`).
