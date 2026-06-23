# Rootwork Indexing Guide

This package contains the **Rootwork** dictionary database and everything needed to
continue its hand-curation ("indexing"). Rootwork is a visual-etymology dictionary:
every English word can be broken into morphemes, traced to its Latin/Greek source,
and explored as part of a *word family tree*.

Your job is to extend four kinds of curated data. They are independent — you can work
on any of them — but they share one principle: **the engine guesses, humans correct.**
Curated data always beats the heuristic engine, so accuracy matters more than volume.

---

## 0. What's in this package

```
words/              The database: 508 shard files, ~77,500 word entries.
                    Sharded by first two letters (e.g. "confer" -> words/co.json).
family/             Curated artifacts you will extend:
  cap.json dic.json duc.json fer.json mit.json scrib.json spec.json
                      -> the 7 Latin morpheme family trees
  collections.json    -> curated word sets (Latin abbreviations)
  variants.json       -> spelling-variant clusters (2,665 of them)
  candidates/         -> (generated) full engine membership per root
engine.js           The morpheme decomposition engine (decompose(word)).
data.js             Morpheme dictionary that engine.js depends on.
scripts/
  family-candidates.js   Lists every vocab word the engine assigns to a root.
  build-family.js        Validates a family file + writes rel/forms to word entries.
  build-variants.js      (Re)builds variant clusters; applies them to word entries.
INDEXING-GUIDE.md   This file.
WORKLIST.md         Current status of every artifact + what to do next.
```

Run anything with Node (no install needed):
```
node scripts/family-candidates.js cap     # full membership for the cap- root
node scripts/build-family.js cap          # validate cap.json against the database
```

Hand back: **edited JSON files in `family/`** (and, where noted, edited word entries
in `words/`). Keep the exact schemas below. Every field you add or change by hand must
carry `"by": "user"` so it survives automated re-runs (see §5).

---

## 1. The database: a word entry

Each shard is `{ "<word>": <entry>, ... }`. An entry:

```jsonc
{
  "d": [                       // definitions (required)
    { "p": "v.",               //   part of speech: n. v. adj. adv. abbr. phra. ...
      "g": "To grant; bestow.",//   gloss
      "x": "He conferred a degree." } // example (optional)
  ],
  "e": "From Latin cōnferō...",// etymology prose (optional)
  "i": "/kənˈfɜːr/",           // IPA (optional)
  "rs": "kuhn-FUR",            // respelling (optional)
  "r": ["cf","collate", ...],  // related words (optional)
  "b": [ {"s":"con","k":"prefix"}, ... ], // curated breakdown override (optional)
  "rel": { "t":"plural of", "l":"cactus" }, // this word descends from a base word
  "forms": ["confers","conferring"],        // inflections that fold into this lemma
  "vars": ["caplin","capelan"]              // alternative spellings of this word
}
```

Fields you'll touch most: `d` (fix a wrong/circular gloss), `b` (force a breakdown),
`rel`/`forms`/`vars` (usually written by the build scripts, not by hand).

`b` (curated breakdown) controls how the headword splits on its page:
- `[{"s":"<word>","k":"word"}]` — a single `word`-kind part means **do not decompose**
  (opaque stems, eponyms, trademarks, abbreviations).
- `[{"s":"con","k":"prefix"},{"s":"fer","k":"root"},{"s":"ence","k":"suffix"}]` — an
  explicit split. `k` is one of `prefix | root | suffix | word`. Use this only when the
  engine mis-splits; otherwise leave `b` absent and let the engine decide.

---

## 2. Family trees (`family/<root>.json`) — the main effort

A family file groups every word built on one Latin/Greek root into **regions** (areas
of meaning) and arranges them into a **descent tree** by `parent`. This is what powers
the "Open tree" view on each word's page.

### 2.1 Schema

```jsonc
{
  "_note": "Free-text notes for curators: scope, excluded false-positives, etc.",
  "root": "fer",                       // the root id (matches engine part ids)
  "rootLabel": "ferre",                // LATIN INFINITIVE, not the stem (see §2.3)
  "rootGloss": "Latin · to carry, bear",
  "regions": [
    { "id": "conferring-referring",    // stable slug
      "label": "Bringing to mind",     // human label (a place in meaning-space)
      "gloss": "carry a thought to bear — infer, refer, prefer, confer",
      "by": "assistant", "at": "2026-06-23T05:28:10.421Z" }
  ],
  "placements": [
    { "w": "confer",                   // the word (must exist in words/)
      "s": null,                       // sense index, almost always null
      "region": "conferring-referring",// which region it lives in
      "parent": "conferre",            // descends from this node (or null = top of region)
      "by": "assistant", "at": "..." },

    // A "source" node is a label, not a dictionary entry — e.g. the Latin lemma
    // the English words descend from. It does not navigate; it just groups.
    { "w": "conferre", "region": "conferring-referring", "parent": null,
      "kind": "source", "lang": "la",
      "gloss": "Latin · to bring together; compare",
      "by": "user", "at": "..." },

    // An abbreviation member can carry a tag (links it to a collection, see §4).
    { "w": "cf", "region": "conferring-referring", "parent": "conferre",
      "tag": "latin-abbr", "gloss": "abbreviation of Latin confer — “compare”",
      "by": "user", "at": "..." }
  ],
  "collapse": {                        // inflections folded into their lemma
    "described": { "l": "describe", "t": "past tense of", "by":"assistant", "at":"..." }
  },
  "meta": { "version": 1, "updated": "..." }
}
```

Placement fields:
- `w` — the word. **Must be a real entry in `words/`** unless it's a `source` node.
- `region` — which region it belongs to.
- `parent` — the word it descends from (must also be placed in the same region), or
  `null` to sit at the top of the region. The tree nests by `parent`.
- `kind` — omit for normal entries; `"source"` for a Latin/Greek lemma label node.
- `lang` — language code for source nodes (`"la"` Latin, `"gr"` Greek). Shows as a tag.
- `gloss` — for `source` nodes and abbreviations: the meaning shown inline.
- `tag` — links a member to a collection id (see §4).

### 2.2 The collapse map

Inflections (plurals, past tenses, -ing/-ed forms, comparatives) should **not** get
their own tree node. Put them in `collapse`, pointing at their lemma:
```jsonc
"conferred": { "l": "confer", "t": "past tense of" }
```
`t` is the relation phrase: `plural of`, `past tense of`, `present participle of`,
`comparative of`, `superlative of`, `alternative form of`, `derived from`.
`build-family.js` reads this and writes `rel`/`forms` onto the word entries.

### 2.3 Conventions (these are the house style — follow them)

1. **Label families by the Latin/Greek infinitive, not the stem.** `rootLabel` is
   `ferre` (not `fer`), `scribere` (not `scrib`), `dūcere`, `dīcere`, `capere`,
   `mittere`. This is the canonical lemma the English words descend from.

2. **Regions are *places in meaning-space*, not lists of members.** A good region
   label describes the shared sense ("Bringing to mind", "Setting apart", "Bearing
   toward & under"), not the words in it ("confer & refer"). The `gloss` may then name
   a few examples.

3. **Group a sub-family under its own Latin compound verb as a `source` node** when it
   reads well. Example: under the *Bringing to mind* region, the Latin `conferre`
   source node parents `confer` and all its derivatives (`conference`, `conferee`, …)
   plus the abbreviation `cf`. This makes the descent explicit. Do this when a cluster
   of English words clearly shares one compound verb (con-, in-, re-, prae- + the root).

4. **Flatten derivatives as siblings** under their source/parent when they're all direct
   products of the same base (e.g. `conference`, `conferment`, `conferee` are siblings
   under `conferre`, not nested under `confer`). Nest only when there's a real
   derivational step (`teleconference` from `conference`).

5. **Exclude false positives.** The engine over-matches: it lumps unrelated Latin roots
   under one id. `fer` collects `ferre` 'carry' **and** `ferus` 'wild' (feral),
   `fervēre` 'boil' (fervent), `ferīre` 'strike' (interfere), plus noise (fern, ferry,
   buffer, ferret, names). **Do not place these.** Record what you excluded and why in
   `_note`, and fix the mis-IDs via curated breakdowns (`b`) on the word entries if they
   should point at a different root.

6. **Provenance.** Anything you decide by hand gets `"by": "user"`. Engine/automated
   output is `"by": "assistant"`. The build scripts preserve `by:user`.

### 2.4 Process for indexing (or reindexing) a family

```
1. node scripts/family-candidates.js <root>
     -> prints every vocab word the engine assigns to <root>, shortest first,
        and writes family/candidates/<root>.json
2. Read down the list. For each word, decide:
     - real member of THIS root?  -> place it (region + parent), or
     - inflection of a member?    -> add to collapse, or
     - false positive / other root? -> exclude (note it; fix its `b` if needed).
3. Design regions from the meanings you see. Reuse existing region ids where you can.
4. Add source nodes for Latin compound verbs where they clarify descent (§2.3.3).
5. node scripts/build-family.js <root>
     -> validates: every placed/collapsed word exists; tree + collapse cover the
        family; no dangling references. Fix anything it flags.
6. Hand back the edited family/<root>.json.
```

A family is "complete" when every *real* member of the root (not false positives) is
either placed or collapsed, and `build-family.js` reports no gaps.

---

## 3. (Re)indexing the truncated families — priority work

The first six families were built before the "full membership" pass and are **partial**.
`WORKLIST.md` has the live numbers; the short version:

| root  | label    | placed/collapsed | status                 |
|-------|----------|------------------|------------------------|
| scrib | scribere | ~62/72           | essentially complete   |
| fer   | ferre    | 128 (full)       | complete (gold example) |
| duc   | dūcere   | ~61              | partial                |
| spec  | specere  | ~59              | partial                |
| cap   | capere   | ~57              | **very partial** (huge root) |
| dic   | dīcere   | ~45              | partial                |
| mit   | mittere  | ~40              | **very partial**       |

Use `fer.json` as the **gold-standard example** of a complete, well-organized family
(meaning-space regions, Latin source nodes, collapse map, documented exclusions). Bring
`cap`, `mit`, `dic`, `duc`, `spec` up to the same standard via the §2.4 process.

`capere` (cap/cept/ceive/cip — take, seize) is the biggest: capture, captive, accept,
except, receive, conceive, perceive, deceive, anticipate, participate, principal,
municipal, occupy, recover… It will need several well-chosen regions.

---

## 4. Collections (`family/collections.json`)

Curated word sets that belong together by convention rather than morphology. Currently
one set: **Latin abbreviations**.

```jsonc
{
  "latin-abbr": {
    "label": "Latin abbreviation",
    "gloss": "Short forms of Latin phrases used in English prose.",
    "members": [
      { "w": "cf",  "latin": "confer",         "sense": "compare",      "parent": "confer" },
      { "w": "eg",  "latin": "exempli gratia", "sense": "for example",  "parent": "exemplify" },
      { "w": "ie",  "latin": "id est",         "sense": "that is",      "parent": null }
    ]
  }
}
```

Member fields:
- `w` — the abbreviation (must be a word entry; create one if missing, pos `"abbr."`).
- `latin` — the full Latin phrase it abbreviates.
- `sense` — the plain-English reading ("read as" on the card).
- `parent` — the English word this abbreviates, **or `null`** if there's no single
  English parent. The app *redirects* an abbreviation to its parent's page and shows it
  inline there ("Abbreviated as cf"), so set `parent` whenever a clean one exists.

How the app uses it: a word in a collection shows a tappable tag; the word card of an
abbreviation's `parent` shows the abbreviation inline (with its own usage chart). For an
abbreviation entry itself, the breakdown is skipped and the pronunciation slot shows
"read as: <sense>".

You can add **new collections** (other conventional sets) by adding another top-level
key with the same shape. Keep `members[].w` pointing at real word entries.

---

## 5. Spelling-variant clusters (`family/variants.json`)

Folds alternative spellings and misspellings into **one canonical card**. The canonical
word keeps the full entry; each variant becomes a thin entry that points back.

```jsonc
{
  "meta": { "note": "...", "updated": "...", "clusters": 2665 },
  "clusters": {
    "color": {                            // the canonical spelling (key)
      "spellings":    [ { "w": "colour", "t": "variant of" } ],
      "misspellings": [ { "w": "collor", "t": "misspelling of" } ],
      "by": "assistant", "at": "...",
      "status": "auto"                    // auto | confirmed | rejected
    }
  }
}
```

- `spellings` — legitimate alternative spellings (British/American, ligatures: foetus
  /fetus, -ise/-ize). `misspellings` — common errors that should still resolve.
- `status` — `auto` (engine-detected, may be wrong), `confirmed` (a human checked it),
  `rejected` (a human said no — keep the record so it isn't re-added).
- **`status: confirmed`/`rejected` and any `by: "user"` cluster survive re-runs.**
  `auto` clusters are regenerated each time `build-variants.js` runs. So: to lock in a
  decision, set `status` and `by:"user"`.

Your job here: review `auto` clusters for correctness, set `status:"confirmed"` (or
`"rejected"`) and `by:"user"`, and **add** clusters the engine missed. The engine only
catches variants whose Wiktionary gloss literally says "variant/alternative form of X";
genuine pairs with full independent definitions (e.g. capelin/capelan) must be added by
hand.

`build-variants.js` applies clusters to the word entries (writes `vars` on the canonical
and a `rel` on each variant). Run it after editing, then hand back both
`family/variants.json` and any changed `words/` shards.

---

## 6. Hand-back checklist

- [ ] Edited `family/*.json` keep the exact schemas above.
- [ ] Every hand decision carries `"by": "user"` (and `status` where it applies).
- [ ] Every referenced word exists in `words/` (or is a `source` node).
- [ ] `node scripts/build-family.js <root>` passes for any family you touched.
- [ ] False positives are excluded and explained in `_note`, not silently placed.
- [ ] Family labels use the Latin/Greek infinitive; regions name meanings, not members.
- [ ] If you changed word entries (glosses, `b`, created abbreviation entries), include
      the changed `words/` shards too.

When in doubt, match `fer.json` — it is the reference implementation of everything here.
