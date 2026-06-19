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

Because words rarely mean *exactly* the sum of their roots, the literal
construction then fuses into the **actual definition**, plus **pronunciation**
(IPA + a plain respelling), **synonyms/antonyms**, and an **origin** line — all
from vendored, offline data. It loads asynchronously: the breakdown shows
instantly and the rest fills in a moment later (cached after first load).

### Features

- **Animated reveal** — the word fades in with dots between parts, a tile rises
  for each morpheme, then panels resolve the meaning, thesaurus, and origin.
- **Pronunciation** — IPA and a Merriam-Webster-style respelling.
- **Tap a morpheme tile** — it expands in place to list other words built on that
  piece (for common affixes, a sample of the most *and* least common); tap any to
  analyse it next.
- **Synonyms & antonyms** in their own card.
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
| `app.js` | UI controller, reveal animation, tile expansion, history, theme |
| `dictionary.json` | vendored WordNet definitions (~77k words) |
| `morpheme-index.json` | morpheme → related words (built from the engine) |
| `pronunciation.json` | IPA + respelling (from the CMU dictionary) |
| `thesaurus.json` | synonyms & antonyms (from WordNet) |
| `scripts/build-data.js` | regenerates the four data files (`npm run build:data`) |
| `scripts/arpabet.js` | ARPAbet → IPA + respelling converter |
| `manifest.webmanifest`, `icon.svg` | installable-app metadata |
| `test/integration.test.js` | browser-style integration test (run via `npm test`) |
| `.githooks/pre-commit` | runs the test before each commit |
| `.github/workflows/deploy-pages.yml` | GitHub Pages auto-deploy |

## Regenerating the data

`dictionary.json`, `morpheme-index.json`, `pronunciation.json`, and
`thesaurus.json` are generated, not hand-written. Definitions and the thesaurus
come from [`wordnet`](https://www.npmjs.com/package/wordnet); pronunciations from
[`cmu-pronouncing-dictionary`](https://www.npmjs.com/package/cmu-pronouncing-dictionary)
(both dev dependencies). The morpheme index is built by running this project's own
engine over that vocabulary. To rebuild:

```bash
npm install        # pulls in the dev dependencies
npm run build:data
```

> The “Origin” card is currently derived from the roots we already have (no dates
> yet). First-recorded dates / fuller etymologies from Wiktionary are a planned
> follow-up.

## Extending the dictionary

Add entries to the arrays in `data.js`:

```js
{ id: "aqua", forms: ["aqua", "aque", "aqui"], origin: "Latin",
  source: "aqua", meaning: "water" }
```

`forms` lists every spelling the element can take in a real word (including
assimilated variants like `com/con/col`). Longer forms are matched first.
