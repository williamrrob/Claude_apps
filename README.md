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
construction then fuses into the **actual definition**, looked up from a vendored
**WordNet** dictionary (`dictionary.json`, ~77k words). The dictionary loads
asynchronously — the breakdown shows instantly and the meaning fills in a moment
later (and is cached after first load).

### Features

- **Animated reveal** — the word fades in, splits into coloured morphemes, detail
  cards rise one by one, then the pieces fuse downward into the meaning.
- **Tap a card** to see other words that share that root/prefix/suffix; tap any
  of those to analyse it in turn.
- **Search history** — recent words are remembered (in `localStorage`) as quick
  chips under the search bar.

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
| `styles.css` | dark, mobile-first styling and animations |
| `data.js` | the morpheme dictionary (roots, prefixes, suffixes) |
| `engine.js` | offline decomposition + literal-meaning synthesis |
| `app.js` | UI controller, reveal animation, related words, history |
| `dictionary.json` | vendored WordNet definitions (~77k words) |
| `morpheme-index.json` | morpheme → related words (built from the engine) |
| `scripts/build-data.js` | regenerates the two data files (`npm run build:data`) |
| `manifest.webmanifest`, `icon.svg` | installable-app metadata |
| `test/integration.test.js` | browser-style integration test (run via `npm test`) |
| `.githooks/pre-commit` | runs the test before each commit |
| `.github/workflows/deploy-pages.yml` | GitHub Pages auto-deploy |

## Regenerating the dictionary

`dictionary.json` and `morpheme-index.json` are generated, not hand-written. The
definitions come from the [`wordnet`](https://www.npmjs.com/package/wordnet) npm
package (a dev dependency); the morpheme index is built by running this project's
own engine over that vocabulary. To rebuild:

```bash
npm install        # pulls in the wordnet dev dependency
npm run build:data
```

## Extending the dictionary

Add entries to the arrays in `data.js`:

```js
{ id: "aqua", forms: ["aqua", "aque", "aqui"], origin: "Latin",
  source: "aqua", meaning: "water" }
```

`forms` lists every spelling the element can take in a real word (including
assimilated variants like `com/con/col`). Longer forms are matched first.
