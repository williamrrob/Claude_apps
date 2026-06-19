// Integration test for Rootwork.
//
// Because the app is plain (uncompiled) JavaScript loaded as separate <script>
// tags, the things that break are runtime wiring problems the browser only
// discovers when the page runs — e.g. a top-level `const` that never reaches
// `window`, so engine.js can't see the data and the UI reports "the dictionary
// didn't load".
//
// This test reproduces the browser's loading model with Node's `vm` module:
// data.js, engine.js and app.js are each run as a separate program sharing one
// `window` global, on top of a minimal DOM shim plus stubbed fetch/localStorage.
// It then drives the real user flows — search a word, read its meaning, open a
// card's related words, follow one to a new analysis, and check history.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---------- a minimal DOM shim ----------
function makeDom() {
  const listeners = new WeakMap();

  function el(tag) {
    const node = {
      tagName: tag,
      children: [],
      dataset: {},
      style: { setProperty() {} },
      _class: "",
      _html: "",
      textContent: "",
      hidden: false,
      value: "",
      get className() { return this._class; },
      set className(v) { this._class = v; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
      classList: {
        _set: new Set(),
        add(...c) { c.forEach((x) => this._set.add(x)); },
        remove(...c) { c.forEach((x) => this._set.delete(x)); },
        contains(x) { return this._set.has(x); },
      },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute() {},
      addEventListener(type, fn) {
        const map = listeners.get(node) || {};
        (map[type] = map[type] || []).push(fn);
        listeners.set(node, map);
      },
      dispatch(type, evt) {
        const map = listeners.get(node) || {};
        (map[type] || []).forEach((fn) => fn(evt || { preventDefault() {}, key: "" }));
      },
      querySelector() { return el("div"); },
      querySelectorAll() { return []; },
      focus() {},
      blur() {},
    };
    return node;
  }

  const ids = {};
  ["searchForm", "wordInput", "hint", "history", "wordLine", "cards", "related", "definition", "legend"]
    .forEach((id) => { ids[id] = el(id === "searchForm" ? "form" : "div"); });

  const examples = ["biography", "incredible", "democracy"].map((w) => {
    const b = el("button"); b.dataset.word = w; return b;
  });

  const document = {
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => el(tag),
    querySelector: () => el("div"),
    querySelectorAll: (sel) => (sel === ".example" ? examples : []),
  };

  return { ids, examples, document };
}

// Depth-first search of the shim tree.
function find(node, pred) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    if (pred(c)) return c;
    const deep = find(c, pred);
    if (deep) return deep;
  }
  return null;
}
function findAll(node, pred, out = []) {
  if (!node || !node.children) return out;
  for (const c of node.children) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}
const hasClass = (cls) => (n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls);

function loadApp() {
  const { ids, examples, document } = makeDom();
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.document = document;
  sandbox.location = { hash: "" };
  sandbox.setTimeout = setTimeout;
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.matchMedia = () => ({ matches: true }); // reduced motion: zero delays

  // Stub fetch to serve the vendored data files from disk.
  sandbox.fetch = (url) => {
    const file = String(url).split("?")[0];
    try {
      const body = read(file);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(body)) });
    } catch {
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    }
  };

  // In-memory localStorage.
  const mem = {};
  sandbox.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("data.js"), ctx, { filename: "data.js" });
  vm.runInContext(read("engine.js"), ctx, { filename: "engine.js" });
  vm.runInContext(read("app.js"), ctx, { filename: "app.js" });

  return { sandbox, ids, examples };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 60) { for (let i = 0; i < n; i++) await tick(); }

async function main() {
  // --- Layer 1: the exact condition app.js checks before giving up. ---
  const { sandbox, ids, examples } = loadApp();
  assert.ok(sandbox.MORPHEMES, "window.MORPHEMES must be exposed by data.js");
  assert.ok(
    sandbox.EtymologyEngine && typeof sandbox.EtymologyEngine.decompose === "function",
    "window.EtymologyEngine.decompose must exist — else the app shows 'the dictionary didn't load'"
  );

  // --- Layer 2: the engine produces a sane decomposition. ---
  const bio = sandbox.EtymologyEngine.decompose("biography");
  assert.ok(bio && bio.parts.some((p) => p.kind === "root"), "biography decomposes with a root");

  // --- Layer 3: search a word; morphemes render, real meaning fills in. ---
  examples[0].dispatch("click"); // "biography"
  await settle();

  const errorBanner = find(ids.wordLine, hasClass("error"));
  assert.ok(!errorBanner, "no error banner after a search");

  const morphs = findAll(ids.wordLine, hasClass("morph")).map((c) => c.textContent);
  assert.deepStrictEqual(morphs, ["bio", "graph", "y"], "renders morphemes bio · graph · y");

  const meaning = find(ids.definition, hasClass("def-meaning"));
  assert.ok(meaning, "definition has a Meaning slot");
  assert.ok(
    /account of the series of events|life/i.test(meaning.innerHTML),
    "Meaning slot is filled from the WordNet dictionary, got: " + meaning.innerHTML
  );

  // --- Layer 4: tapping a card reveals other words sharing that morpheme. ---
  const rootCard = find(ids.cards, (c) => c.dataset && c.dataset.kind === "root");
  assert.ok(rootCard, "a root card exists");
  rootCard.dispatch("click");
  await settle();

  assert.strictEqual(ids.related.hidden, false, "related tray is shown");
  const chips = findAll(ids.related, hasClass("related-chip"));
  assert.ok(chips.length > 0, "related tray lists words sharing the morpheme");
  const chipWords = chips.map((c) => c.textContent);
  assert.ok(!chipWords.includes("biography"), "the current word is excluded from related words");

  // --- Layer 5: following a related word runs a fresh analysis. ---
  const next = chips[0];
  next.dispatch("click");
  await settle();
  assert.strictEqual(sandbox.window.document.getElementById("wordInput").value, next.textContent,
    "clicking a related word loads it into the search box");
  const newMorphs = findAll(ids.wordLine, hasClass("morph")).map((c) => c.textContent).join("");
  assert.ok(newMorphs.length > 0 && !find(ids.wordLine, hasClass("error")),
    "the followed word re-renders with no error");

  // --- Layer 6: searches are remembered. ---
  const history = JSON.parse(sandbox.localStorage.getItem("rootwork.history"));
  assert.ok(history.includes("biography") && history.includes(next.textContent),
    "history records both searches, got: " + JSON.stringify(history));
  const histChips = findAll(ids.history, hasClass("history-chip"));
  assert.ok(histChips.length >= 2, "history row renders recent chips");

  console.log("ok - dictionary exposed to window");
  console.log("ok - engine decomposes 'biography' with a root");
  console.log("ok - search renders morphemes and fills the real meaning");
  console.log("ok - tapping a card shows words sharing the morpheme");
  console.log("ok - following a related word runs a fresh analysis");
  console.log("ok - searches are saved to history");
  console.log("\nAll integration tests passed.");
}

main().catch((err) => {
  console.error("\nIntegration test FAILED:\n" + (err && err.stack || err));
  process.exit(1);
});
