// Integration test for Rootwork.
//
// The app is plain (uncompiled) JS loaded as separate <script> tags, so the
// failures that bite are runtime wiring problems the browser only finds when the
// page runs (e.g. a top-level `const` that never reaches `window`). This test
// reproduces the browser's loading model with Node's `vm`: data.js, engine.js
// and app.js each run as a separate program sharing one `window`, over a minimal
// DOM shim plus stubbed fetch/localStorage. It then drives the real user flows.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeDom() {
  const listeners = new WeakMap();
  function el(tag) {
    const node = {
      tagName: tag, children: [], dataset: {}, style: { setProperty() {} },
      _class: "", _html: "", textContent: "", hidden: false, value: "",
      get className() { return this._class; }, set className(v) { this._class = v; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
      classList: {
        _set: new Set(),
        add(...c) { c.forEach((x) => this._set.add(x)); },
        remove(...c) { c.forEach((x) => this._set.delete(x)); },
        contains(x) { return this._set.has(x); },
      },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      remove() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      addEventListener(t, fn) { const m = listeners.get(node) || {}; (m[t] = m[t] || []).push(fn); listeners.set(node, m); },
      dispatch(t, ev) { const m = listeners.get(node) || {}; (m[t] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {}, key: "" })); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      focus() {}, blur() {}, scrollIntoView() {},
    };
    return node;
  }
  const ids = {};
  ["searchForm", "wordInput", "hint", "wordLine", "pron", "note", "tiles", "panels", "related", "recent", "content", "themeToggle"]
    .forEach((id) => { ids[id] = el(id === "searchForm" ? "form" : "div"); });
  ids.searchForm.querySelector = () => el("button"); // .search-btn lookup
  const examples = ["biography", "incredible", "democracy"].map((w) => { const b = el("button"); b.dataset.word = w; return b; });
  const document = {
    documentElement: el("html"),
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => el(tag),
    querySelector: () => el("div"),
    querySelectorAll: (sel) => (sel === ".example" ? examples : []),
  };
  return { ids, examples, document };
}

function find(node, pred) {
  if (!node || !node.children) return null;
  for (const c of node.children) { if (pred(c)) return c; const d = find(c, pred); if (d) return d; }
  return null;
}
function findAll(node, pred, out = []) {
  if (!node || !node.children) return out;
  for (const c of node.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}
const hasClass = (cls) => (n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls);
// Concatenate text + raw innerHTML across the subtree (the shim stores innerHTML
// as a string rather than parsing it into nodes).
function deepText(n) {
  if (!n) return "";
  let s = (n.textContent || "") + " " + (n._html || "");
  if (n.children) for (const c of n.children) s += " " + deepText(c);
  return s;
}

function loadApp() {
  const { ids, examples, document } = makeDom();
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.document = document;
  sandbox.location = { hash: "" };
  sandbox.setTimeout = setTimeout;
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.matchMedia = (q) => ({ matches: /reduce/.test(q) }); // reduced motion → zero delays
  sandbox.fetch = (url) => {
    const file = String(url).split("?")[0];
    try { const body = read(file); return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(body)) }); }
    catch { return Promise.resolve({ ok: false, json: () => Promise.resolve(null) }); }
  };
  const mem = {};
  sandbox.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("data.js"), ctx, { filename: "data.js" });
  vm.runInContext(read("engine.js"), ctx, { filename: "engine.js" });
  vm.runInContext(read("app.js"), ctx, { filename: "app.js" });
  return { sandbox, ids, examples };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 80) { for (let i = 0; i < n; i++) await tick(); }

async function main() {
  // --- Layer 1: the condition app.js checks before giving up. ---
  const { sandbox, ids, examples } = loadApp();
  assert.ok(sandbox.MORPHEMES, "window.MORPHEMES must be exposed by data.js");
  assert.ok(sandbox.EtymologyEngine && typeof sandbox.EtymologyEngine.decompose === "function",
    "window.EtymologyEngine.decompose must exist — else the app says 'the dictionary didn't load'");

  // --- Layer 2: engine basics + silent-e is its own morpheme. ---
  const bio = sandbox.EtymologyEngine.decompose("biography");
  assert.ok(bio.parts.some((p) => p.kind === "root"), "biography decomposes with a root");
  const micro = sandbox.EtymologyEngine.decompose("microscope");
  const last = micro.parts[micro.parts.length - 1];
  assert.ok(last.kind === "suffix" && last.surface === "e" && last.silentE,
    "the final 'e' in microscope is its own (suffix) morpheme");

  // --- Layer 3: search renders morphemes, pronunciation and meaning. ---
  examples[0].dispatch("click"); // biography
  await settle();
  assert.ok(!find(ids.wordLine, hasClass("error")), "no error banner after a search");
  const morphs = findAll(ids.wordLine, hasClass("mw")).map((c) => c.textContent);
  assert.deepStrictEqual(morphs, ["bio", "graph", "y"], "renders morphemes bio · graph · y");
  assert.ok(find(ids.pron, hasClass("resp")), "pronunciation respelling is shown");
  const meaning = find(ids.panels, hasClass("def-meaning"));
  assert.ok(meaning && /account of the series of events|life/i.test(deepText(meaning)),
    "meaning is filled from WordNet, got: " + (meaning && deepText(meaning)));

  // --- Layer 4: tapping a card drops down words sharing the piece, in the card. ---
  const rootTile = find(ids.tiles, (c) => c.dataset && c.dataset.kind === "root");
  assert.ok(rootTile, "a root tile exists");
  rootTile.dispatch("click");
  await settle();
  assert.ok(rootTile.classList.contains("expanded"), "tapped card expands");
  const chips = findAll(rootTile, hasClass("related-chip"));
  assert.ok(chips.length > 0, "expanded card lists words sharing the morpheme");
  assert.ok(!chips.map((c) => c.textContent).includes("biography"), "current word excluded from related words");

  // --- Layer 5: following a related word runs a fresh analysis. ---
  const next = chips[0];
  next.dispatch("click");
  await settle();
  assert.strictEqual(ids.wordInput.value, next.textContent, "clicking a related word loads it");
  assert.ok(findAll(ids.wordLine, hasClass("morph")).length > 0 && !find(ids.wordLine, hasClass("error")),
    "followed word re-renders cleanly");

  // --- Layer 6: searches are remembered. ---
  const history = JSON.parse(sandbox.localStorage.getItem("rootwork.history"));
  assert.ok(history.includes("biography") && history.includes(next.textContent),
    "history records both searches, got: " + JSON.stringify(history));
  assert.ok(findAll(ids.recent, hasClass("history-chip")).length >= 2, "recent row renders chips");

  console.log("ok - dictionary exposed to window");
  console.log("ok - engine decomposes with a root; silent 'e' is its own morpheme");
  console.log("ok - search renders morphemes, pronunciation and meaning");
  console.log("ok - tapping a tile expands it with related words");
  console.log("ok - following a related word runs a fresh analysis");
  console.log("ok - searches are saved to history");
  console.log("\nAll integration tests passed.");
}

main().catch((err) => { console.error("\nIntegration test FAILED:\n" + (err && err.stack || err)); process.exit(1); });
