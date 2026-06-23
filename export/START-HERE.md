# START HERE

You are picking up the hand-curation ("indexing") of **Rootwork**, a visual-etymology
dictionary. This package is self-contained: the full word database, the curated data so
far, the engine + tooling, and complete instructions.

## Read in this order
1. **INDEXING-GUIDE.md** — the playbook. Schemas, conventions, and the step-by-step
   process for each of the four artifact types. This is the spec; follow it exactly.
2. **WORKLIST.md** — current status of everything and what to do next, with live numbers.

## The four things you can extend
1. **Family trees** (`family/<root>.json`) — group every word built on a Latin/Greek
   root into meaning-regions and a descent tree. *This is the main, highest-value work.*
2. **Collections** (`family/collections.json`) — curated word sets (e.g. Latin
   abbreviations).
3. **Spelling-variant clusters** (`family/variants.json`) — fold alternative spellings
   into one canonical card.
4. **Word entries** (`words/*.json`) — fix glosses / force breakdowns where needed.

## The one rule that matters most
The engine guesses; **you correct**. Curated data overrides the engine, and the build
scripts preserve anything marked `"by": "user"`. So: be accurate, exclude false
positives, and stamp every hand decision with `by:"user"` (and `status` for variants).

## Verify your work
```
node scripts/family-candidates.js <root>   # full membership for a root (e.g. cap)
node scripts/build-family.js <root>         # validate a family file
node scripts/build-variants.js              # apply variant clusters to word entries
```
(Node only, no install.)

## Hand back
Edited JSON files in `family/` — and any `words/` shards you changed. Keep the schemas
exactly as in INDEXING-GUIDE.md. The gold-standard reference for "what good looks like"
is **`family/fer.json`**.

## Suggested first task
Reindex **`cap` (capere)** to full membership — it's the biggest and most incomplete
family. See WORKLIST.md §A.
