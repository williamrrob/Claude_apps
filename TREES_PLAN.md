# Ancestry trees — design plan

_Status: planning (2026-07-02). Data groundwork shipped: `trees/<xx>.json`
per-word paths, `vendor-data/etym.sqlite`. Nothing below is built yet._

## Goal

Every entry shows where it sits on the shared etymological tree — its path up
to the deepest ancestor (usually PIE), pivots sideways to cousins at any
node, and a full-forest "massive tree" view you can fly around on a phone.

## Canonical graph

- **Node** = normalized `(language, term)`: fold case/diacritics/asterisks
  for identity, display the scholarly form (dīcō). Lang labels normalized via
  a mapping table (etymology-db uses names, EtymDB uses ISO-ish codes,
  kaikki has both `lang`/`lang_code`).
- **Edge** = parent→child with kind (inh/der/bor/…), plus source + weight.

### Source merge (precedence order)

1. **Curated** (`family/*.json`, curated `b`, future explicit pins) — wins
   all conflicts; family membership asserts a shared ancestor node.
2. **etymology-db** (`vendor-data/etymology.csv.gz`) — the edge backbone.
3. **Kaikki etymon trees** (English dump `etymology_templates`, embedded
   JSON; wiktextract mangles outer objects — salvage sub-blobs, see
   `scripts/build-trees.js`) — branching compound structure to PIE.
4. **Per-language Kaikki dumps** (vendor-data, ALL of them — each language's
   entries have their own etymon templates) — node attributes (gloss, pos)
   AND downward chain extensions below where English-side sources stop.
5. **EtymDB 2.1** — supplemental edges for proto-forms; map its lexeme ids
   to (lang, term) via `etymdb_values`.

Edges dedupe by (parent, child). **Conflicting parents are not merged — they
are emitted to a conflicts file** that doubles as the curation queue.
Same-spelling homographs within a language (Latin sol "sun" vs sōlus family)
are the known false-merge hazard: flag nodes whose incoming glosses diverge.

## Shipped artifacts (three zoom levels)

1. **Per-word path** — `trees/<xx>.json` (DONE): instant entry card.
2. **Reverse descendants index** — ancestor node → English descendant words,
   for the ~10,306 nodes shared by 2+ of our words (measured). Same pattern
   as `morpheme-index.json` / `family/*.json`, one level deeper. Filter
   blank-term noise (161 phantom descendants of `Latin ""`).
3. **Massive-tree view** — per connected component, a BUILD-TIME layout pass
   (radial/layered, proto-roots central) writes final (x, y) per node;
   output = spatially tiled chunks fetched on pan/zoom. Client is a dumb
   canvas: viewport culling, level-of-detail (dots+major labels zoomed out,
   full labels+glosses+edge kinds zoomed in). Entry cards deep-link ("see
   this word on the big tree" → fly to node). It is a FOREST, not one tree:
   PIE is the supercontinent; borrowing families (Semitic, Japanese, …) are
   islands — give the UI a component picker rather than pretending unity.

## Order of work

1. `build-etymgraph.js`: canonical nodes + merged edges + conflicts file
   (extends build-etymdb.js; adds lang normalization + all-language kaikki
   ingestion for node glosses and downward chains).
2. Reverse descendants index + wire into the entry tree card (first visible
   feature; card renders trees/<xx>.json path + tappable ancestors).
3. Layout pass + tiled chunks + canvas renderer for the massive view.
4. Feed the conflicts file into the curation flow (decisions.log pattern).
