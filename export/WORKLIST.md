# Rootwork Worklist — current status & what to do next

Snapshot generated 2026-06-23. Regenerate the family numbers any time with:
```
node scripts/family-candidates.js <root>     # full engine membership for a root
node scripts/build-family.js <root>          # validation report for a family file
```

Database: **77,509 word entries** across `words/*.json`.

---

## A. Family trees — the priority

"Engine raw" = words the decomposition engine assigns to the root id. It **over-counts**
(unrelated Latin roots lumped under one id + noise), so 100% coverage is neither possible
nor desired — the target is "every *real* member placed or collapsed, false positives
excluded." Use the coverage column only to spot which families are still thin.

| root  | label    | engine raw | placed | collapsed | coverage  | status |
|-------|----------|-----------:|-------:|----------:|-----------|--------|
| scrib | scribere | 72         | 52     | 10        | ~86% raw  | **complete** |
| fer   | ferre    | 311        | 127    | 0         | ~41% raw  | **complete — GOLD EXAMPLE** |
| duc   | dūcere   | 181        | 55     | 6         | ~34% raw  | partial |
| spec  | specere  | 192        | 45     | 14        | ~31% raw  | partial |
| dic   | dīcere   | 264        | 43     | 2         | ~17% raw  | partial |
| mit   | mittere  | 305        | 35     | 5         | ~13% raw  | **very partial** |
| cap   | capere   | 484        | 47     | 10        | ~12% raw  | **very partial (biggest root)** |

### Why fer's "41%" is complete but cap's "12%" is not
`fer` was hand-filtered from 311 raw down to its real membership (127 placed): the rest
are false positives (fern, ferry, buffer, ferret, fervent, feral, interfere, names) that
were deliberately excluded and documented in `fer.json`'s `_note`. `cap` has had no such
pass — most of its 484 raw matches are real `capere` words still unplaced (capture,
captive, accept, except, receive, conceive, perceive, deceive, anticipate, participate,
principal, municipal, occupy, recover, …).

### Recommended order
1. **cap (capere)** — biggest impact, most real members missing. Needs several
   meaning-regions (taking/seizing, receiving, holding a post, conceiving an idea, …).
2. **mit (mittere)** — send: admit, commit, emit, omit, permit, submit, transmit,
   remit, mission, message, missile, dismiss, promise, compromise, …
3. **dic (dīcere)** — say: dictate, predict, contradict, verdict, indicate, dedicate,
   index, judge/judicial (via -dic-), addict, edict, …
4. **duc (dūcere)** — lead: conduct, deduce, induce, produce, reduce, seduce, educate,
   abduct, introduce, duke/duct, …
5. **spec (specere)** — look: inspect, respect, suspect, prospect, spectacle, species,
   special, conspicuous, perspective, despise, …

For each: follow **INDEXING-GUIDE.md §2.4**. Match `fer.json`'s structure exactly —
Latin-infinitive label, meaning-space regions, Latin compound-verb `source` nodes where
they clarify descent, collapse map for inflections, documented exclusions in `_note`.

### New roots (optional, after the seven above)
High-value Latin/Greek roots not yet started, if you want to expand the set:
`port` (portare, carry), `tract` (trahere, pull), `vert/vers` (vertere, turn),
`pon/pos` (ponere, place), `tend/tens` (tendere, stretch), `graph/gram` (write),
`log` (logos, word/study), `phon` (sound), `scope` (look). Each needs a new
`family/<root>.json` plus, ideally, a curated breakdown sanity-check.

---

## B. Collections — `family/collections.json`

| id          | members | status |
|-------------|--------:|--------|
| latin-abbr  | 15      | seeded; verify parents & senses |

To do:
- Verify each member's `parent` (the English word it abbreviates) and `sense` reading.
  Members with `parent: null` (ie, viz, et al, nb, qv, ibid, op cit, sc, ad lib, ps)
  have no clean English parent — confirm that's right or supply one.
- Ensure every member has a real word entry (pos `"abbr."`, Latin gloss). Create any
  that are missing.
- Optionally add new collections (other conventional sets) per INDEXING-GUIDE §4.

---

## C. Spelling-variant clusters — `family/variants.json`

| metric            | count |
|-------------------|------:|
| clusters total    | 2,665 |
| status: auto      | 2,664 |
| status: confirmed | 1     |
| status: rejected  | 0     |

Almost everything is still `auto` (engine-detected, unreviewed). To do:
- Review `auto` clusters; set `status:"confirmed"` + `by:"user"` on the good ones and
  `status:"rejected"` + `by:"user"` on the wrong ones (both survive re-runs).
- **Add** real variant pairs the engine missed — pairs whose entries both have full
  independent definitions so the "variant/alternative form of" detector skips them
  (e.g. capelin/capelan, already added by hand as the worked example).
- After edits, run `node scripts/build-variants.js` to apply clusters to word entries,
  then hand back `variants.json` plus any changed `words/` shards.

See INDEXING-GUIDE §5 for the schema and the survive-re-runs rules.

---

## D. Definition of done (per artifact)

- **Family**: every real member placed/collapsed; false positives excluded & noted;
  `build-family.js <root>` clean; reads as well-organized as `fer.json`.
- **Collection**: every member has a real entry, a `parent` (or justified null), and a
  `sense`.
- **Variants**: reviewed clusters carry `status` + `by:"user"`; missed pairs added;
  `build-variants.js` applied.
