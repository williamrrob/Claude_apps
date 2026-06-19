# Rootwork — visual etymology

Type a word and watch it break apart on a canvas: the whole word appears, then
splits into its **prefixes, root(s), and suffixes**, which spread out in space.
Each piece reveals where it comes from (its source language and original form)
and what it means — and those meanings assemble into a literal reading of the
whole word.

It's a single static web app — **no build step, no server, no network, no
accounts, nothing sensitive**. Everything runs in your browser. It installs to
the Home Screen on iPhone & iPad and to the Dock on Mac.

## How it works

A curated dictionary of ~250 Latin and Greek roots, prefixes, and suffixes
(`data.js`) plus a scored segmentation search (`engine.js`) break the word down
instantly, entirely offline. It's strongest on classical/academic vocabulary —
*biography, incredible, democracy, photosynthesis, circumnavigate, manuscript*.
Words of Old-English/Germanic or very modern origin may only partly resolve;
those pieces are shown as a neutral "stem".

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

## Files

| file | purpose |
|------|---------|
| `index.html` | markup, install prompt, PWA tags |
| `styles.css` | dark, mobile-first styling and animations |
| `data.js` | the morpheme dictionary (roots, prefixes, suffixes) |
| `engine.js` | offline decomposition + literal-meaning synthesis |
| `app.js` | UI controller and the reveal animation |
| `manifest.webmanifest`, `icon.svg` | installable-app metadata |
| `.github/workflows/deploy-pages.yml` | GitHub Pages auto-deploy |

## Extending the dictionary

Add entries to the arrays in `data.js`:

```js
{ id: "aqua", forms: ["aqua", "aque", "aqui"], origin: "Latin",
  source: "aqua", meaning: "water" }
```

`forms` lists every spelling the element can take in a real word (including
assimilated variants like `com/con/col`). Longer forms are matched first.
