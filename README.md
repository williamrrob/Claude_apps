# Rootwork — visual etymology

Type a word and watch it break apart on a canvas: the whole word appears, then
splits into its **prefixes, root(s), and suffixes**, which spread out in space.
Each piece reveals where it comes from (its source language and original form)
and what it means — and then those pieces **fuse into the word's real, modern
meaning** from a dictionary.

It's a static web app — runs entirely in your browser, no server or accounts. It
installs to the Home Screen on iPhone & iPad and to the Dock on Mac.

## How it works

A curated dictionary of ~250 Latin and Greek roots, prefixes, and suffixes
(`data.js`) plus a scored segmentation search (`engine.js`) break the word down
instantly. It's strongest on classical/academic vocabulary — *biography,
incredible, democracy, photosynthesis, circumnavigate, manuscript*. Words of
Old-English/Germanic or very modern origin may only partly resolve; those pieces
are shown as a neutral "stem".

Because words rarely mean *exactly* the sum of their roots, the breakdown is
joined by **real definitions with example sentences, pronunciation (IPA + plain
respelling), etymology, and synonyms/antonyms/related terms**. This rich data is
vendored from **Wiktionary** (via Wiktextract) and the **CMU** pronouncing
dictionary, and is **loaded lazily, one shard at a time** — only a tiny index
loads up front, then the data for the searched word's shard is fetched on demand.

### Features

- **Animated reveal** — pieces pop in tight (reading as the whole word), then
  *split*: gaps open, dots and labels appear, and tiles rise for each morpheme.
- **Pronunciation** — IPA and a Merriam-Webster-style respelling.
- **Definitions with examples**, **etymology**, and **synonyms / antonyms /
  related** words, each in its own card.
- **Tap a morpheme tile** — it expands in place to list other words built on that
  piece (for common affixes, a sample of the most *and* least common); tap any to
  analyse it next.
- **Silent final “e”** is shown as its own morpheme (microscope = micro·scop·e).
- **Light & dark** following your system setting, with a corner toggle to override.
- **Search history** — recent words (in `localStorage`) sit above the bottom
  search bar.

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
`{ d:[{p,g,x?}], e:etymology, s:[syn], a:[ant], r:[related], i:ipa, rs:respelling }`.

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

Add entries to the arrays in `data.js`:

```js
{ id: "aqua", forms: ["aqua", "aque", "aqui"], origin: "Latin",
  source: "aqua", meaning: "water" }
```

`forms` lists every spelling the element can take in a real word (including
assimilated variants like `com/con/col`). Longer forms are matched first.
