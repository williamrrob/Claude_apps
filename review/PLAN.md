# Full-dictionary breakdown review — plan & resume protocol

Goal: carefully verify the morpheme breakdown of **every** word in the
vocabulary (~77,477 words), correcting the ones the heuristic engine gets wrong.
This spans many sessions, so progress is persisted in this `review/` directory
and survives container resets (it's committed to git).

## How the work is bucketed (see STATUS.md for live counts)

Not all 77k need equal effort:

1. **Trusted dataset breakdowns** (~23k) — come from MorphoLex / the medical list
   / hand-curated overrides. Presumed correct; only **spot-checked**.
2. **Shown whole** (~44k) — not decomposed at all, so they can't be a *wrong*
   split. Low priority (only checked for *under*-decomposition later).
3. **Engine multi-part, suspicious** (~7-8k) — the engine split them and the
   split has tell-tale garbage signs (stray single letters, low confidence,
   unknown fragments). **These are reviewed first.**
4. **Engine multi-part, clean-looking** (~2.5k) — lower priority.

## The persistent ledger

- `review/<letter>.jsonl` — one row per word:
  `{w, r:freqRank, src, b:currentBreakdown, flags, st:status, note?}`
  - `st`: `auto-data` / `auto-whole` (machine-classified) · `todo` / `todo-low`
    (needs human review) · `ok` (reviewed, correct) · `fixed` (reviewed,
    corrected).
  - Frequency ranks are baked in, so we always review common words first.
- `review/QUEUE.tsv` — the next ~4000 `todo` words, highest priority first.
- `review/STATUS.md` — live progress counts (auto-generated).

`scripts/build-review-ledger.js` regenerates the ledger but **preserves** every
`ok`/`fixed` status, so re-running after data changes never loses human work.

## Per-session loop

1. `node scripts/build-review-ledger.js` (refresh; preserves decisions).
2. Open `review/QUEUE.tsv`, take the top N words.
3. For each, decide the correct breakdown by cross-referencing the morpheme DB,
   MorphoLex, and Wiktionary etymology — not by guessing. Then either:
   - it's already correct → mark `st:ok` in the word's `review/<letter>.jsonl` row;
   - it's wrong → fix it at the right level and mark `st:fixed`:
     - **general rule** (engine/data.js) when the error is a class
       (e.g. an affix gloss, an allomorph) — preferred, fixes many at once;
     - **curated override** (`scripts/curated-breakdowns.json`) when the
       boundary can't be expressed as a general rule (verified to tile).
4. Re-run the relevant build script(s), bump `DATA_V`, run `npm test`.
5. Commit. The updated ledger = saved progress.

## Efficiency notes

- Many priority items are the same *category* (Germanic words forced into
  classical pieces → should be whole; `-ing`/`-ed`/`-s` inflections; `-ity`
  stems). Fix by category/rule, not one word at a time.
- Prefer general fixes; reserve curated overrides for true one-offs.
- "Shown whole" is an acceptable answer — under-decomposing is far less harmful
  than a confidently wrong split.
