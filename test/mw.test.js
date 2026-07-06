// Merriam-Webster integration test.
//
// Two layers:
//  A) mw-map.js mapMwResponse against real saved MW fixtures (test/fixtures/) —
//     the mapping logic: homograph split, one-to-one thesaurus assignment,
//     phrase collapse, markup stripping, stems.
//  B) the browser render path: with MW keys in localStorage and a mocked MW
//     fetch, searching a word auto-pulls _mw and renders per-homograph cards;
//     the result is cached so a second search doesn't re-fetch.

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const fixture = (f) => JSON.parse(read("test/fixtures/" + f));

// ---------- Layer A: the pure mapper ----------
const MWMap = require("../mw-map.js");
function testMapper() {
  const dict = fixture("mw-desert-dict.json");
  const thes = fixture("mw-desert-thes.json");
  const mw = MWMap.mapMwResponse(dict, thes, "desert");

  assert.strictEqual(mw.length, 4, "desert maps to 4 homographs (noun/adj/verb/noun), got " + mw.length);
  assert.deepStrictEqual(mw.map((h) => h.fl), ["noun", "adjective", "verb", "noun"], "parts of speech in order");

  // The core bug this fixes: MW numbers homographs independently across its
  // dictionary and thesaurus, so a naive hom-number join misassigns synonyms.
  // The two nouns must get DIFFERENT synonym sets matched by gloss.
  const aridNoun = mw[0], desertsNoun = mw[3];
  assert.ok(/arid land/i.test(aridNoun.shortdef[0]), "hom1 is the arid-land noun");
  assert.ok(aridNoun.s.includes("wasteland"), "arid noun gets geographic synonyms, got: " + aridNoun.s);
  assert.ok(/reward or punishment/i.test(desertsNoun.shortdef[0]), "hom4 is the just-deserts noun");
  assert.ok(desertsNoun.s.includes("punishment"), "deserts noun gets punishment synonyms, got: " + desertsNoun.s);
  assert.ok(!desertsNoun.s.includes("wasteland"), "deserts noun must NOT inherit the arid noun's synonyms");

  // verb gets its own synonyms + antonyms
  assert.ok(mw[2].s.some((w) => /abandon|forsake/.test(w)), "verb synonyms include abandon/forsake");

  // markup stripping: etymology prose has no leftover {tokens} and no dangling xref
  mw.forEach((h) => {
    assert.ok(!/\{[a-z_]/.test(h.et || ""), "etymology has no MW tokens: " + h.et);
    assert.ok(!/\b[a-z]+:\d+\s*$/i.test(h.et || ""), "etymology has no dangling homograph xref: " + h.et);
  });

  // phrase collapse: the 12 "get her/his/one's just deserts" variants → one canonical
  assert.deepStrictEqual(desertsNoun.phrases, ["get one's just deserts"], "just-deserts phrases collapse to one canonical form, got: " + JSON.stringify(desertsNoun.phrases));
  assert.deepStrictEqual(mw[1].phrases, ["desert island"], "adjective phrase is 'desert island'");

  // stems (single-word inflections) captured, headword excluded
  assert.ok(mw[2].stems.includes("deserted") && mw[2].stems.includes("deserting"), "verb stems include inflections");

  // a not-found / suggestion response maps to nothing
  assert.deepStrictEqual(MWMap.mapMwResponse(["dessert", "desert"], [], "zxqv"), [], "suggestion-string response → []");
  console.log("ok - mapper: 4 homographs, gloss-matched thesaurus, clean etymology, collapsed phrases");
}

// ---------- Layer B: the browser render + auto-fetch path ----------
function makeDom() {
  const listeners = new WeakMap();
  function el(tag) {
    const node = {
      tagName: tag, children: [], dataset: {}, style: { setProperty() {} },
      _class: "", _html: "", textContent: "", hidden: false, value: "", returnValue: "",
      get className() { return this._class; }, set className(v) { this._class = v; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
      classList: { _set: new Set(), add(...c) { c.forEach((x) => this._set.add(x)); }, remove(...c) { c.forEach((x) => this._set.delete(x)); }, contains(x) { return this._set.has(x); } },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      showModal() {}, close() {},
      addEventListener(t, fn) { const m = listeners.get(node) || {}; (m[t] = m[t] || []).push(fn); listeners.set(node, m); },
      dispatch(t, ev) { const m = listeners.get(node) || {}; (m[t] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {}, key: "" })); },
      querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, blur() {}, scrollIntoView() {},
    };
    return node;
  }
  const ids = {};
  ["searchForm", "wordInput", "hint", "entry", "miniHead", "note", "ipaKey", "cards", "browse", "alpha",
   "suggest", "recent", "content", "themeToggle", "navHome", "navBack", "navFwd", "nextSibling",
   "settingsBtn", "settingsDialog", "mwDictKey", "mwThesKey", "mwKeysSave"]
    .forEach((id) => { ids[id] = el(id === "searchForm" ? "form" : "div"); });
  ids.searchForm.querySelector = () => el("button");
  const document = {
    documentElement: el("html"), getElementById: (id) => ids[id] || null,
    createElement: (tag) => el(tag), querySelector: () => el("div"),
    querySelectorAll: (sel) => (sel === ".example" ? [] : []),
  };
  return { ids, document };
}
const hasClass = (cls) => (n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls);
function findAll(node, pred, out = []) {
  if (!node || !node.children) return out;
  for (const c of node.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}
function deepText(n) { if (!n) return ""; let s = (n.textContent || "") + " " + (n._html || ""); if (n.children) for (const c of n.children) s += " " + deepText(c); return s; }

function loadApp(fetchImpl, seedStore) {
  const { ids, document } = makeDom();
  const sandbox = {}; sandbox.window = sandbox; sandbox.document = document;
  sandbox.location = { hash: "" }; sandbox.setTimeout = setTimeout;
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.matchMedia = (q) => ({ matches: /reduce/.test(q) });
  sandbox.fetch = fetchImpl;
  const mem = Object.assign({}, seedStore || {});
  sandbox.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("data.js"), ctx, { filename: "data.js" });
  vm.runInContext(read("engine.js"), ctx, { filename: "engine.js" });
  vm.runInContext(read("mw-map.js"), ctx, { filename: "mw-map.js" });
  vm.runInContext(read("app.js"), ctx, { filename: "app.js" });
  return { sandbox, ids, mem };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 120) { for (let i = 0; i < n; i++) await tick(); }

// fetch stub: MW endpoints serve fixtures; same-origin paths read from disk.
// `dropWord` (e.g. "desert") is deleted from its shard so getWord() misses it —
// used to exercise the MW fallback-dictionary path for a word "not in our corpus".
function makeFetch(counters, dropWord) {
  const dropKey = dropWord ? String(dropWord).slice(0, 2).toLowerCase() : null;
  return function (url) {
    const u = String(url);
    if (u.indexOf("dictionaryapi.com") >= 0) {
      counters.mw = (counters.mw || 0) + 1;
      const isThes = u.indexOf("/thesaurus/") >= 0;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fixture(isThes ? "mw-desert-thes.json" : "mw-desert-dict.json")) });
    }
    const file = u.split("?")[0];
    try {
      const obj = JSON.parse(read(file));
      if (dropKey && file === "words/" + dropKey + ".json") delete obj[dropWord];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });
    }
    catch { return Promise.resolve({ ok: false, json: () => Promise.resolve(null) }); }
  };
}

async function testRenderAndAutoFetch() {
  const counters = {};
  // Seed: MW keys present, and a plain (non-_mw) dictionary entry for "desert"
  // via the localStorage override getWord() consults first — so the search
  // resolves without depending on the real shard, and _mw must come from fetch.
  const seed = {
    "rootwork.mwDictKey": "test-dict-key",
    "rootwork.mwThesKey": "test-thes-key",
    "rootwork.overrides": JSON.stringify({ desert: { d: [{ p: "n.", g: "arid land" }], e: "old etymology" } }),
  };
  const { ids, mem } = loadApp(makeFetch(counters), seed);
  await settle(10); // let init settle

  // drive a search for "desert"
  ids.wordInput.value = "desert";
  ids.searchForm.dispatch("submit", { preventDefault() {}, stopPropagation() {} });
  await settle();

  const mwCards = findAll(ids.cards, hasClass("mw-card"));
  assert.strictEqual(mwCards.length, 4, "four per-homograph MW cards render, got " + mwCards.length);
  const posLabels = findAll(ids.cards, hasClass("mw-pos")).map((n) => deepText(n).trim());
  assert.ok(posLabels.some((l) => /noun/.test(l)) && posLabels.some((l) => /verb/.test(l)) && posLabels.some((l) => /adjective/.test(l)),
    "cards are labelled by part of speech, got: " + JSON.stringify(posLabels));
  // etymology present inside a homograph card (not a separate Word-history card)
  assert.ok(findAll(ids.cards, hasClass("hist")).some((n) => /middle english|french|latin/i.test(deepText(n))),
    "etymology renders inside the homograph cards");
  // the just-deserts phrase line rendered
  assert.ok(findAll(ids.cards, hasClass("mw-phrase-list")).some((n) => /just deserts/i.test(deepText(n))),
    "phrases line renders 'just deserts'");
  // it was cached to localStorage
  assert.ok(mem["rootwork.mwCache"] && /just deserts/.test(mem["rootwork.mwCache"]), "MW result cached in localStorage");
  const afterFirst = counters.mw;
  assert.ok(afterFirst >= 2, "first search hit both MW endpoints, got " + afterFirst);

  // second search of the same word must serve from cache (no new MW fetches)
  ids.wordInput.value = "desert";
  ids.searchForm.dispatch("submit", { preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.strictEqual(counters.mw, afterFirst, "second search served from cache — no extra MW fetches");
  console.log("ok - search auto-fetches MW, renders 4 homograph cards, caches, and reuses the cache");
}

async function testFallbackDictionary() {
  const counters = {};
  // MW keys set, NO override entry, and "desert" removed from its shard so
  // getWord() misses — the word is effectively "not in our corpus". MW must
  // then supply the whole entry.
  const seed = { "rootwork.mwDictKey": "test-dict-key", "rootwork.mwThesKey": "test-thes-key" };
  const { ids } = loadApp(makeFetch(counters, "desert"), seed);
  await settle(10);

  ids.wordInput.value = "desert";
  ids.searchForm.dispatch("submit", { preventDefault() {}, stopPropagation() {} });
  await settle();

  // no "isn't in the dictionary" note — MW filled it
  assert.ok(!/isn.t in the dictionary/i.test(deepText(ids.note)), "no 'not in dictionary' note when MW has a fallback entry");
  // headword rendered + per-homograph MW cards
  const word = findAll(ids.entry, hasClass("entry-word"))[0];
  assert.ok(word && /desert/i.test(deepText(word)), "headword renders for the fallback word");
  assert.strictEqual(findAll(ids.cards, hasClass("mw-card")).length, 4, "fallback renders 4 homograph cards");
  assert.ok(findAll(ids.cards, hasClass("hist")).some((n) => /middle english|latin|french/i.test(deepText(n))),
    "fallback shows MW etymology");
  console.log("ok - fallback dictionary: a word absent from the corpus renders entirely from MW");
}

async function main() {
  testMapper();
  await testRenderAndAutoFetch();
  await testFallbackDictionary();
  console.log("\nAll MW tests passed.");
}
main().catch((err) => { console.error("\nMW test FAILED:\n" + (err && err.stack || err)); process.exit(1); });
