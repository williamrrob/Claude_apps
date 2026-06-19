// Integration test for Rootwork.
//
// Because the app is plain (uncompiled) JavaScript loaded as three separate
// <script> tags, the things that break are runtime wiring problems the browser
// only discovers when the page runs — e.g. a top-level `const` that never
// reaches `window`, so engine.js can't see the data and the UI reports
// "the dictionary didn't load".
//
// This test reproduces the browser's loading model with Node's `vm` module:
// data.js, engine.js and app.js are each run as a separate program sharing one
// `window` global, on top of a minimal DOM shim. It then simulates a user
// clicking a word and asserts that real morphemes are rendered and no error
// banner appears. No external dependencies — runs anywhere Node runs.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---------- a minimal DOM shim ----------
// Just enough of the DOM for app.js to wire up and run end to end.
function makeDom() {
  const listeners = new WeakMap();

  function el(tag) {
    const node = {
      tagName: tag,
      children: [],
      dataset: {},
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
      addEventListener(type, fn) {
        const map = listeners.get(node) || {};
        (map[type] = map[type] || []).push(fn);
        listeners.set(node, map);
      },
      dispatch(type, evt) {
        const map = listeners.get(node) || {};
        (map[type] || []).forEach((fn) => fn(evt || { preventDefault() {} }));
      },
      querySelector() { return el("div"); },
      querySelectorAll() { return []; },
      focus() {},
      blur() {},
    };
    return node;
  }

  const ids = {};
  ["searchForm", "wordInput", "hint", "wordLine", "cards", "definition", "legend"]
    .forEach((id) => { ids[id] = el(id === "searchForm" ? "form" : "div"); });

  // The example word chips the user clicks.
  const examples = ["biography", "incredible", "democracy"].map((w) => {
    const b = el("button");
    b.dataset.word = w;
    return b;
  });

  const document = {
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => el(tag),
    querySelector: () => el("div"),
    querySelectorAll: (sel) => (sel === ".example" ? examples : []),
  };

  return { ids, examples, document };
}

function loadApp() {
  const { ids, examples, document } = makeDom();
  const sandbox = {};
  sandbox.window = sandbox; // window === global, as in a browser
  sandbox.document = document;
  sandbox.location = { hash: "" };
  sandbox.setTimeout = setTimeout;
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  // Force reduced-motion so the reveal runs with zero delays.
  sandbox.matchMedia = () => ({ matches: true });

  const ctx = vm.createContext(sandbox);
  // Each <script> is a separate program in the shared global context.
  vm.runInContext(read("data.js"), ctx, { filename: "data.js" });
  vm.runInContext(read("engine.js"), ctx, { filename: "engine.js" });
  vm.runInContext(read("app.js"), ctx, { filename: "app.js" });

  return { sandbox, ids, examples };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // --- Layer 1: the exact condition app.js checks before giving up. ---
  const { sandbox, ids, examples } = loadApp();
  assert.ok(sandbox.MORPHEMES, "window.MORPHEMES must be exposed by data.js");
  assert.ok(
    sandbox.EtymologyEngine && typeof sandbox.EtymologyEngine.decompose === "function",
    "window.EtymologyEngine.decompose must exist — otherwise the app shows 'the dictionary didn't load'"
  );

  // --- Layer 2: the engine produces a sane decomposition. ---
  const bio = sandbox.EtymologyEngine.decompose("biography");
  assert.ok(bio && bio.parts.length, "decompose('biography') returns parts");
  assert.ok(bio.parts.some((p) => p.kind === "root"), "biography has a root");

  // --- Layer 3: end to end — simulate clicking a word chip. ---
  examples[0].dispatch("click"); // "biography"
  for (let i = 0; i < 30; i++) await tick(); // let the async reveal finish

  const wordLine = ids.wordLine;
  const errorBanner = wordLine.children.find(
    (c) => typeof c.className === "string" && c.className.indexOf("error") !== -1
  );
  assert.ok(!errorBanner, "no error banner after clicking a word: " + (errorBanner && errorBanner.innerHTML));

  const morphs = wordLine.children
    .filter((c) => c.className && c.className.indexOf("morph") !== -1)
    .map((c) => c.textContent);
  assert.deepStrictEqual(morphs, ["bio", "graph", "y"], "renders morphemes bio · graph · y");

  console.log("ok - dictionary exposed to window");
  console.log("ok - engine decomposes 'biography' with a root");
  console.log("ok - clicking a word renders morphemes with no error banner");
  console.log("\nAll integration tests passed.");
}

main().catch((err) => {
  console.error("\nIntegration test FAILED:\n" + (err && err.stack || err));
  process.exit(1);
});
