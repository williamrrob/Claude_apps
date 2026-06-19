# Rootwork — visual etymology

Type a word and watch it break apart on a canvas: the whole word appears, then
splits into its **prefixes, root(s), and suffixes**, which spread out in space.
Each piece reveals where it comes from (its source language and original form)
and what it means — and those meanings assemble into a literal reading of the
whole word.

It's a single static web app (no build step, no server required) that runs in
Safari/Chrome and installs to the Home Screen on iPhone & iPad and to the Dock
on Mac.

## How it works

- **Offline engine (default).** A curated dictionary of ~250 Latin and Greek
  roots, prefixes, and suffixes (`data.js`) plus a scored segmentation search
  (`engine.js`) break the word down instantly, with no network needed. It's
  strongest on classical/academic vocabulary — *biography, incredible,
  democracy, photosynthesis, circumnavigate*.
- **AI mode (optional).** For words the offline engine doesn't recognize
  (modern coinages, Germanic/Old-English words, names), turn on AI mode in
  **Settings** and paste your own Anthropic API key. The word is sent to Claude,
  which returns the same kind of breakdown. The engine also falls back to Claude
  automatically when it can't find a root and a key is present.

Your API key is stored only in your browser's `localStorage` and is sent only to
Anthropic's API.

## Getting it on your iPhone / iPad / Mac

You need to serve these files over HTTPS (or `localhost`). Two easy options:

### Option A — GitHub Pages (free, recommended)
1. Push this branch to GitHub (already done if you're reading this there).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, pick this branch and the root folder, **Save**.
3. After a minute, open the published URL on each device.
4. **iPhone/iPad:** open it in Safari → Share → *Add to Home Screen*.
   **Mac:** open in Safari → File → *Add to Dock* (or Chrome → Install).

### Option B — run locally
```bash
cd Claude_apps
python3 -m http.server 8099
# then open http://localhost:8099 (or http://<your-computer-ip>:8099 from your phone on the same Wi-Fi)
```

> Note: AI mode calls `api.anthropic.com` directly from the browser. That works
> on `https://` and `localhost`. For a personal single-user tool this is fine;
> if you ever make the site public, proxy the key through a small backend
> instead of shipping it to the browser.

## Files

| file | purpose |
|------|---------|
| `index.html` | markup, settings sheet, PWA tags |
| `styles.css` | dark, mobile-first styling and animations |
| `data.js` | the morpheme dictionary (roots, prefixes, suffixes) |
| `engine.js` | offline decomposition + literal-meaning synthesis |
| `ai.js` | optional Claude API analysis |
| `app.js` | UI controller and the reveal animation |
| `manifest.webmanifest`, `icon.svg` | installable-app metadata |

## Extending the dictionary

Add entries to the arrays in `data.js`. Each looks like:

```js
{ id: "aqua", forms: ["aqua", "aque", "aqui"], origin: "Latin",
  source: "aqua", meaning: "water" }
```

`forms` lists every spelling the element can take in a real word (including
assimilated variants like `com/con/col`). Longer forms are matched first.
