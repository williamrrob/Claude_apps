# Rootwork — assistant playbook

Static, no-build web app (three `<script>` tags, JSON data files, GitHub
Pages). **Main branch: `claude/visual-etymology-app-093c1d`** — pushing to it
deploys to https://williamrrob.github.io/Claude_apps/. Session work happens on
per-session branches merged into main.

## Current shape (update when it drifts)

- `words/<xx>.json` — 581 shards, **~222,600 entries**, one word per line
  (canonical format: `scripts/shard-format.js`). ~36k have curated `b`
  breakdowns. This is the app's dictionary AND the source of truth.
- `data.js` — 308 engine morphemes (`MORPHEMES = {prefixes, roots, suffixes}`).
- `roots.json` (~1MB), `morpheme-index.json`, `eras.json`, `quiz-pool.json`,
  `usage/`, `family/*.json` — generated/curated side data fetched by app.js.
- `review/` — breakdown-audit ledger. `decisions.log` (append-only) and
  `ranks.tsv` are the authoritative/tracked parts; `*.jsonl` are derived
  (regenerate: `node scripts/build-review-ledger.js`).
- Entry shape: `{ d:[{p,g,x?,dom?,cl?}], e, s, a, r, i, rs, b, cl, vars, forms, rel, _at }`
  — full docs in the header of `scripts/word.js`.

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
- Semantic dedup/search: `npm run embed build` (local Ollama,
  nomic-embed-text) then `npm run find similar <word>`.
- Cloud-session note: Node fetch behind the agent proxy needs
  `NODE_USE_ENV_PROXY=1` (word.js draft, etc.).

## Verifying UI changes

`npm test` covers wiring. For visuals: `python3 -m http.server 8099` and
screenshot with Playwright; check BOTH color schemes (the app and editor.html
follow `prefers-color-scheme`).
