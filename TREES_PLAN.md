# Ancestry trees — design plan (v2)

_Status: planning (2026-07-02, revised after owner feedback). Data groundwork
shipped: `trees/<xx>.json` per-word paths, `vendor-data/etym.sqlite`. Nothing
below is built yet._

## Goal

Every entry shows where it sits on the shared etymological tree — its path up
to the deepest ancestor (usually PIE), pivots sideways to cousins at any
node, tap-through to real entries, and a full-forest "massive tree" view that
renders on a phone.

## Trust model — SOURCES FIRST (v2 inversion)

**No edge exists unless a database asserts it. Curation annotates or
suppresses with a stated reason; it never invents structure.**

- The parsed databases are the evidence: etymology-db, Kaikki etymon trees,
  per-language Kaikki dumps, EtymDB. They differ in reliability but they all
  trace to Wiktionary's sourced scholarship.
- `family/*.json` and `scripts/curated-breakdowns.json` were bulk-authored by
  earlier, smaller models → **demoted and slated for reset**: families get
  REGENERATED from the graph (family = descendants of a shared node, or
  morpheme co-membership); the old hand-authored lists become review
  candidates to diff against, not inputs.
- Curation layer = marks on nodes/edges: `verified`, `suppressed:<reason>`
  (e.g. known parser error), `note:<text>`. Applied by the owner or a
  large-model session citing evidence; stored append-only like decisions.log.

## Contested etymologies are content, not noise

Where sources disagree on a word's parent, SHOW ALL ROUTES:

- Every edge ships with source attribution (edb / ket / klx / etydb) and an
  agreement count.
- A node with disagreeing parents gets a **contested badge**; all putative
  parent edges render, marked, with a UI affordance making clear it is one
  word with multiple proposed routes (not duplicate nodes).
- Layout nuance: the renderer needs ONE primary edge to position a node in
  space — chosen by source-agreement count — but the losing routes still
  draw as marked cross-links. Precedence decides position, never visibility.
- Source filter in the UI: view the graph as any single source sees it.
- The conflicts list doubles as a curation queue, but curation OUTPUT is a
  mark ("verified route A", "suppressed route B: parser artifact"), and
  genuinely contested cases keep both routes with a `contested` mark.

## Canonical graph

- **Node** = normalized `(language, term)`: fold case/diacritics/asterisks
  for identity, display the scholarly form (dīcō). Lang labels normalized via
  a mapping table (etymology-db uses names, EtymDB ISO-ish codes, kaikki
  both `lang`/`lang_code`).
- **Node ↔ entry integration**: build-time resolution pass links any node to
  a headword we carry (and vice versa). Tree nodes with entries are
  tap-throughs to the full entry; every entry's tree card knows its node.
  Non-headword ancestors show gloss/pos from the lemma table inline.
- Same-spelling homographs within a language (Latin sol "sun" vs sōlus) are
  the false-merge hazard: flag nodes with wildly divergent incoming glosses
  into the review queue.

### Sources (all ingested; trust affects only primary-edge choice)

- **etymology-db** — edge backbone, best English coverage.
- **Kaikki etymon trees** (English dump `etymology_templates`; wiktextract
  mangles outer JSON — salvage sub-blobs, see `scripts/build-trees.js`).
- **Per-language Kaikki dumps** (ALL languages) — node attributes (gloss,
  pos) and downward chain extensions (Latin december's own etymology
  continues below where English-side sources stop).
- **EtymDB 2.1** — supplemental proto-form edges; map lexeme ids to
  (lang, term) via etymdb_values.

## Shipped artifacts (four zoom levels)

1. **Per-word path** — `trees/<xx>.json` (DONE): instant entry card.
2. **Reverse descendants index** — ancestor node → English descendant words
   (~10,306 shared nodes measured; filter blank-term noise like `Latin ""`).
3. **Massive-tree view** — per component, BUILD-TIME layout writes final
   (x, y) per node; output = spatially tiled chunks fetched on pan/zoom.
   Client = dumb canvas: viewport culling, level-of-detail (dots → labels →
   glosses+edge kinds). Entry cards deep-link ("see this word on the big
   tree" → fly to node).
4. **Forest overview** — the entry screen: components as a wordless
   bubble/treemap, sized by node count with a toggle for "sized by our
   headword count", colored by language family/era. Relative tree sizes at a
   glance — the PIE supercontinent vs the borrowing archipelagos — before a
   single word is shown. Tap a bubble to enter that tree.

## Order of work

1. `build-etymgraph.js`: canonical nodes, ALL edges with per-source
   attribution, node↔headword resolution, contested detection, conflicts
   review file. (Extends build-etymdb.js; adds lang normalization +
   all-language kaikki ingestion.)
2. Reverse descendants index + entry tree card (first visible feature:
   renders trees/<xx>.json path, tappable ancestors, contested badges,
   entry tap-throughs).
3. Family reset: regenerate family/*.json from the graph; diff against the
   old hand-authored lists; old data → review candidates only.
4. Layout pass + tiled chunks + canvas renderer (massive view), then the
   forest-overview bubble map.
5. Curation marks flow (append-only, decisions.log pattern) fed by the
   conflicts/homograph review files.
