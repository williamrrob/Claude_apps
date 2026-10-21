# Rootwork — visual etymology

A map of where English words come from. Every dictionary entry, and every
older form its etymology names (Latin *hospitālis*, Old French *hostel*, PIE
*\*gʰóstis*), is a point; lines are lines of descent. Search for a word and
the map traces its lineage from the oldest ancestor down to it, then pins a
card to the dot; pinch in (or tap) and the card opens into the full entry:
definitions, pronunciation, history, doublets, sense neighbours, usage.

**Reading the map.** Each family is drawn around its deepest known ancestor;
distance from that centre is time (PIE at the core, today's English on the
rim), so long branches are long histories. Families that share compounds sit
next to each other. Dot size is how many English words descend from a point.

**Views.** *Descent* (where a word came from and what came from it), *Sense*
(its synonyms, wherever their own histories put them), *Doublets* (one source
that reached English twice: hospital / hostel / hotel). The step-out button
pulls back from a word to its family, its language group, then the whole map.
**Doublet hunt** is a game played on the map.

All of it comes from one source, Wiktionary (via the Kaikki/wiktextract
dumps), so the map, the lineage and the etymology text never disagree.

## Getting it on your iPhone / iPad / Mac

The site auto-publishes to GitHub Pages via the workflow in
`.github/workflows/deploy-pages.yml`. To turn it on (one time):

1. On GitHub, make the repo **public** (Settings → General → Danger Zone →
   Change visibility). Free GitHub Pages only serves public repos. There's
   nothing private in this code.
2. Settings → **Pages** → **Build and deployment** → **Source: GitHub Actions**.
3. The workflow deploys automatically (and re-deploys on every push). Your URL:
   **https://williamrrob.github.io/Claude_apps/**
4. Open that URL and tap the **Add to Home Screen** button in the app — or:
   - **iPhone/iPad (Safari):** Share → *Add to Home Screen*.
   - **Mac (Safari):** File → *Add to Dock*. (Chrome/Edge show an install icon.)

### Run locally instead
```bash
cd Claude_apps
python3 -m http.server 8099
# open http://localhost:8099  (or http://<your-computer-ip>:8099 from a phone on the same Wi-Fi)
```

## Tests

The app is uncompiled JavaScript loaded as three `<script>` tags, so the bugs
that bite are runtime wiring problems the browser only finds when the page runs
(e.g. a top-level `const` in `data.js` that never reaches `window`, leaving the
engine without its data and the UI saying *"the dictionary didn't load"*).

`test/integration.test.js` guards against exactly that: using Node's `vm`, it
loads `data.js`, `engine.js`, and `app.js` the same way a browser does (separate
scripts sharing one `window`, on a tiny DOM shim), then simulates clicking a
word and asserts real morphemes render with no error banner. No dependencies.

```bash
npm test          # or: node test/integration.test.js
```

The test runs automatically before every commit via a git hook. **Enable it
once per clone** (hooks aren't shared by git itself):

```bash
git config core.hooksPath .githooks
```

## Files

| file | purpose |
|------|---------|
| `index.html` | markup, install prompt, PWA tags |
| `styles.css` | mobile-first styling, light/dark themes, animations |
| `data.js` | the morpheme dictionary (roots, prefixes, suffixes) |
| `engine.js` | offline decomposition + literal-meaning synthesis |
| `app.js` | UI controller, reveal animation, lazy data, tile expansion, theme |
| `morpheme-index.json` | morpheme → related words (built from the engine); loaded up front |
| `words/<xx>.json` | rich per-word data, sharded by first two letters; loaded on demand |
| `scripts/build-data.js` | builds `morpheme-index.json` (+ dictionary/thesaurus inputs) |
| `scripts/build-rich.js` | streams Wiktextract → `words/` shards (`npm run build:rich`) |
| `scripts/arpabet.js` | ARPAbet → IPA + respelling converter |
| `manifest.webmanifest`, `icon.svg` | installable-app metadata |
| `test/integration.test.js` | browser-style integration test (run via `npm test`) |
| `.githooks/pre-commit` | runs the test before each commit |
| `.github/workflows/deploy-pages.yml` | GitHub Pages auto-deploy |

Each `words/<xx>.json` maps a word to
`{ d:[{p,g,x?,dom?}], e:etymology, s:[syn], a:[ant], r:[related], i:ipa, rs:respelling, b:curated breakdown, cl:clusters }`
(full field docs in the header of `scripts/word.js`). The shards now hold
**~222,600 entries** (the original rich build plus Kaikki imports and folded
inflections).

There's also `CLAUDE.md` — the assistant playbook: current counts, iron rules
(never open a shard by hand), and the cheap/heavy workflow index.

## Regenerating the data

The shipped data (`morpheme-index.json`, `words/`) is generated, not
hand-written. `dictionary.json` / `thesaurus.json` are build intermediates (from
WordNet) used as fallbacks and are git-ignored. Two steps:

```bash
npm install        # dev dependencies: wordnet, cmu-pronouncing-dictionary

# 1) WordNet base + morpheme index (writes dictionary.json, thesaurus.json, morpheme-index.json)
npm run build:data

# 2) rich per-word shards from Wiktionary (definitions, examples, etymology, relations)
curl -s https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl | npm run build:rich
```

Pronunciation respellings come from
[`cmu-pronouncing-dictionary`](https://www.npmjs.com/package/cmu-pronouncing-dictionary);
definitions / etymology / relations from
[Wiktextract / kaikki.org](https://kaikki.org/dictionary/English/index.html);
WordNet ([`wordnet`](https://www.npmjs.com/package/wordnet)) is the fallback.

> Some etymologies arrive as ancestor "trees" rather than prose — cleaning those
> up is a planned refinement.

## Extending the dictionary

Engine morphemes live in `data.js` under `MORPHEMES = {prefixes, roots,
suffixes}` (~300 entries):

```js
{ id: "aqua", forms: ["aqua", "aque", "aqui"], origin: "Latin",
  source: "aqua", meaning: "water" }
```

`forms` lists every spelling the element can take in a real word (including
assimilated variants like `com/con/col`). Longer forms are matched first.
Use `node scripts/add-root.js` to add one — it scans the whole dictionary for
collisions (words a new short form would suddenly mis-split) before writing.

## Editing word entries (`scripts/word.js`)

The per-word data lives in `words/<xx>.json`, sharded by first two letters. The
common shards are large (`co.json` ≈ 1.8 MB), so **don't open a shard by hand to
change one word** — use the CLI, which edits the file in a subprocess and touches
only the one entry:

```bash
node scripts/word.js get concord          # print one entry
node scripts/word.js get concord e        # print ONE field (cheap read)
node scripts/word.js draft petrichor      # build an entry from Wiktionary (kaikki.org)
node scripts/word.js draft petrichor --apply   # …and write it (new words only)
node scripts/word.js set concord  < entry.json    # create/replace whole entry (JSON on stdin)
node scripts/word.js field concord s <<'JSON'     # set ONE field (here, synonyms)
["accord","agreement","harmony"]
JSON
node scripts/word.js rmfield concord x    # delete a field
node scripts/word.js rm concord           # delete the entry
node scripts/word.js list co              # list the words in a shard
```

Fields: `d` definitions (`p` part-of-speech, `g` gloss, `x` example), `e`
etymology, `s` synonyms, `a` antonyms, `r` related, `i` IPA, `rs` respelling.
Shards are stored one word per line (canonical format in `scripts/shard-format.js`;
re-normalize with `node scripts/normalize-shards.js`), so editing a single word
is a one-line diff.

## Querying the dictionary (`scripts/build-sqlite.js` + `find.js`)

To answer questions across all ~222k words — *which words share a root, mention a
meaning, or are missing a field* — compile the shards into a single SQLite file
and query it. The DB is a derived artifact (gitignored); rebuild it any time:

```bash
npm run build:sqlite        # shards → rootwork.sqlite (words, senses, relations,
                            #   engine morphemes, FTS over glosses+etymology) ~10s

npm run find root scrib                 # words built on a root
npm run find prefix pre                 # words with a prefix
npm run find meaning "written order"    # full-text over glosses + etymology
npm run find rel prescription           # a word's synonyms/antonyms/related
npm run find missing syn --root scrib   # scrib words lacking synonyms (enrichment gaps)
npm run find stats                      # row counts
npm run find q "SELECT ..."             # raw SQL escape hatch
```

This makes building out richer entries cheap: a query returns just the matching
words, so you can find candidates, related terms, and gaps without scanning
shards. Morpheme breakdowns come from `engine.js` and are heuristic — good for
discovery, not authoritative.
