// Rootwork UI controller: takes a word, runs the offline etymology engine, and
// choreographs the reveal — a pinned headword, a Breakdown card whose pieces pop
// in split then slide into a left-justified acrostic and unfold their etymology,
// then Definition / Word history / Thesaurus cards. Plus typeahead, browse-by-
// letter (the right-edge tabs), and Safari-style back/forward over viewed words.

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const themeToggle = $("themeToggle");
  const contentEl = $("content");
  const hint = $("hint");
  const entryEl = $("entry");
  const miniHead = $("miniHead");
  const noteEl = $("note");
  const ipaKeyEl = $("ipaKey");
  const cardsEl = $("cards");
  const browseEl = $("browse");
  const treeEl = $("tree");
  const suggestEl = $("suggest");
  const recentEl = $("recent");
  const navHome = $("navHome");
  const navBack = $("navBack");
  const navFwd = $("navFwd");
  const form = $("searchForm");
  const input = $("wordInput");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = reduceMotion ? 0 : 1;
  let runToken = 0;
  let currentWord = "";
  let pronEl = null;

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms * step); }); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // a text node (falls back to a span where the DOM is a test shim)
  function txtNode(t) { return typeof document.createTextNode === "function" ? document.createTextNode(t) : el("span", null, t); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function firstSense(m) { return m.split(",")[0].trim(); }
  function kindLabel(k) {
    return { prefix: "prefix", root: "root", suffix: "suffix", linker: "link", unknown: "stem", word: "word" }[k] || k;
  }

  // ---------- theme ----------
  function storedTheme() { try { return localStorage.getItem("rootwork.theme"); } catch (e) { return null; } }
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  applyTheme(storedTheme());
  themeToggle.addEventListener("click", function () {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const effective = storedTheme() || (prefersDark ? "dark" : "light");
    const next = effective === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("rootwork.theme", next); } catch (e) {}
  });

  // ---------- vendored data (loaded lazily, sharded by first two letters) ----------
  const DATA_V = "151";
  let MORPH = null, dataPromise = null;
  function loadData() {
    if (dataPromise) return dataPromise;
    if (typeof fetch !== "function") { dataPromise = Promise.resolve(); MORPH = {}; return dataPromise; }
    dataPromise = fetch("morpheme-index.json?v=" + DATA_V)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (m) { MORPH = m || {}; });
    return dataPromise;
  }

  const shardCache = {};
  function fetchShard(key) {
    key = String(key || "").toLowerCase();
    if (!/^[a-z]{2}$/.test(key) || typeof fetch !== "function") return Promise.resolve(null);
    if (!shardCache[key]) {
      shardCache[key] = fetch("words/" + key + ".json?v=" + DATA_V)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return shardCache[key];
  }
  function getWord(word) {
    // Check localStorage overrides first (written when GitHub token is absent)
    try {
      const ov = JSON.parse(localStorage.getItem("rootwork.overrides") || "{}");
      if (ov[word]) return Promise.resolve(ov[word]);
    } catch (e) {}
    const key = String(word || "").slice(0, 2).toLowerCase();
    return fetchShard(key).then(function (sh) {
      if (!sh) return null;
      if (Object.prototype.hasOwnProperty.call(sh, word)) return sh[word];
      // Exact-case match failed — fall back to a case-insensitive scan of
      // this one shard (a few hundred to a few thousand keys, cheap). Proper
      // nouns and initialisms ("AC/DC", "Adélie Land") are stored with their
      // real casing; a user typing "ac/dc" should still find them.
      const target = String(word || "").toLowerCase();
      for (const k in sh) {
        if (k.toLowerCase() === target) {
          // Stash the real stored key so callers can correct a mistyped-case
          // lookup ("ac/dc") back to the dictionary's actual casing ("AC/DC")
          // for display/history/nav, instead of showing what was typed.
          if (sh[k] && typeof sh[k] === "object") sh[k]._resolvedKey = k;
          return sh[k];
        }
      }
      return null;
    });
  }

  // ---------- usage history (built-in quarter-century buckets, 1500–2025) ----------
  const usageCache = {};
  function fetchUsageShard(key) {
    key = String(key || "").toLowerCase();
    if (!/^[a-z]{2}$/.test(key) || typeof fetch !== "function") return Promise.resolve(null);
    if (!usageCache[key]) {
      usageCache[key] = fetch("usage/" + key + ".json?v=" + DATA_V)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return usageCache[key];
  }
  function getUsage(word) {
    return fetchUsageShard(String(word || "").slice(0, 2)).then(function (sh) { return sh ? (sh[word] || null) : null; });
  }

  // ---------- source words: Latin / Greek / PIE roots English is built on ----------
  // roots.json is generated from data (scripts/build-roots.js): the English-
  // relevant lemmas with a gloss and the English words built on each. Keyed by an
  // ASCII fold of the lemma (and its romanization), so "scribo", "bios" resolve.
  let ROOTS = null, rootsPromise = null;
  function loadRoots() {
    if (rootsPromise) return rootsPromise;
    if (typeof fetch !== "function") { ROOTS = {}; return (rootsPromise = Promise.resolve()); }
    rootsPromise = fetch("roots.json?v=" + DATA_V)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (m) { ROOTS = m || {}; return ROOTS; });
    return rootsPromise;
  }
  function foldKey(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }
  // (Merriam-Webster enrichment removed: Wiktionary is the single source.)
  function fetchMw() { return Promise.resolve(null); }

  // ---------- Wikipedia: a lead image, and proper-noun detection ----------
  // The Wikidata short description tells common nouns ("Genus of flowering
  // plants") from proper nouns ("Capital of France", "German composer"), which we
  // can't recover from our lower-cased data. CORS-enabled; cached; times out.
  const wikiCache = {};
  function isProperDesc(desc) {
    if (!desc) return false;
    if (/^(genus|species|type|kind|family|group|class|order|unit|si unit|style|movement|colou?r|number|letter|chemical|musical instrument|dance|language|disease|condition|branch|field|study|form of|part of|process)\b/i.test(desc)) return false;
    // a bare year only counts as a birth/death-style date when it's part of a
    // span ("1803–1882"); a lone year ("2017 video game") is a release date,
    // not biography, and shouldn't be mistaken for one.
    return /\d{3,4}\s*[-–]\s*\d{3,4}/.test(desc)
      || /\b(born|died|politician|philosopher|mathematician|physicist|chemist|scientist|writer|author|poet|dramatist|playwright|novelist|composer|painter|sculptor|artist|architect|king|queen|emperor|empress|prince|princess|saint|pope|actor|actress|singer|musician|general|president|monarch|leader|deity|god|goddess|hero)\b/i.test(desc)
      || /^(capital|city|town|municipality|village|commune|river|mountain|lake|island|countr|state|province|region|county|district|nation|kingdom|empire|sea|ocean|continent|settlement|locality|peninsula)\b/i.test(desc);
  }
  // Wikipedia often resolves a plain word to an unrelated film/game/album that
  // happens to share its spelling ("absolver" → a 2017 video game) — these are
  // never what a dictionary photo should show, regardless of how the rest of
  // the description reads.
  function isMediaWorkDesc(desc) {
    if (!desc) return false;
    return /\b(video game|film|movie|tv series|television series|novel|album|song|book|manga|anime|webcomic|podcast|magazine|comic( book)?|musical|opera|play)\b/i.test(desc);
  }
  // A picture only earns its place for things you'd want to *see* — a concrete,
  // picturable animal/plant/object, or a person/place (already proper-noun-vetted
  // above) — not abstract nouns, actions, or expressions ("guffaw" → "Laughter").
  function isPhysicalDesc(desc) {
    if (!desc) return false;
    if (/\b(species|genus|breed|cultivar|variety|subspecies)\b/i.test(desc)) return true;
    if (/\b(animal|mammal|bird|fish|reptile|amphibian|insect|arthropod|mollusk|crustacean|whale|dolphin|shark|snake|lizard|frog|spider|butterfly|moth|beetle)\b/i.test(desc)) return true;
    if (/\b(plant|tree|shrub|flower|herb|fern|moss|fungus|fungi|mushroom|seaweed|alga)\b/i.test(desc)) return true;
    if (/\b(device|tool|instrument|weapon|firearm|vehicle|aircraft|ship|boat|garment|clothing|fabric|textile|furniture|vessel|container|utensil|machine|appliance|structure|building)\b/i.test(desc)) return true;
    if (/\b(mineral|gemstone|rock|metal|alloy)\b/i.test(desc)) return true;
    if (/\b(food|dish|fruit|vegetable|grain|spice|beverage|cheese|bread)\b/i.test(desc)) return true;
    return isProperDesc(desc);
  }
  // Even a picturable thing doesn't need illustrating if the word itself is
  // everyday-common (breadth maxes out across nearly every era bucket) — "gun"
  // and "tree" don't need a photo the way "narwhal" or "tepal" do.
  function isUbiquitousWord(series) {
    if (!series) return false; // no usage data — don't block on it
    let nz = 0;
    for (let i = 0; i < series.length; i++) if (series[i] > 0) nz++;
    return nz > 18;
  }
  function fetchWiki(word) {
    const w = String(word || "").trim();
    if (typeof fetch !== "function" || !/^[a-z][a-z .'-]{1,40}$/i.test(w)) return Promise.resolve(null);
    if (w in wikiCache) return Promise.resolve(wikiCache[w]);
    const url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(w);
    const timeout = new Promise(function (r) { setTimeout(function () { r(null); }, 4500); });
    const req = fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.type) return null;
      return {
        title: j.title || w, type: j.type, desc: j.description || "",
        thumb: j.thumbnail && j.thumbnail.source, orig: j.originalimage && j.originalimage.source,
        url: j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page,
        proper: isProperDesc(j.description || ""),
      };
    }).catch(function () { return null; });
    return Promise.race([req, timeout]).then(function (res) { wikiCache[w] = res; return res; });
  }
  // Add the image (and capitalize a proper-noun headword) once Wikipedia answers.
  function addWikiInfo(word, token) {
    fetchWiki(word).then(function (wp) {
      if (token !== runToken || !wp) return;
      if (wp.proper) capitalizeHeadword(word);
      return; // the map is the picture: no lead photos (proper-noun capitalization above stays)
      if (isMediaWorkDesc(wp.desc) || !isPhysicalDesc(wp.desc)) return;
      getUsage(word).then(function (series) {
        if (token !== runToken || isUbiquitousWord(series)) return;
        const card = buildImageCard(wp);
        cardsEl.appendChild(card); // at the end of the word card, after the other sections
        requestAnimationFrame(function () { card.classList.add("in"); });
      });
    });
  }
  function capitalizeHeadword(word) {
    const cap = word.charAt(0).toUpperCase() + word.slice(1);
    if (cap === word) return;
    const parts = entryEl.querySelectorAll(".entry-word .ew-part");
    if (parts.length === 1) parts[0].textContent = cap; // proper nouns aren't split
    const mh = miniHead.querySelectorAll(".mh-part");
    if (mh.length === 1) mh[0].textContent = cap;
  }
  // The whole card is the photo, with a glass shimmer over it and the label in a
  // liquid-glass bubble in the corner. Full image (no crop) so it's the source's framing.
  function buildImageCard(wp) {
    const card = el("div", "card img-card");
    const img = document.createElement("img");
    img.className = "wiki-img"; img.src = wp.thumb; img.alt = wp.title;
    img.setAttribute("loading", "lazy");
    card.appendChild(img);
    card.appendChild(el("div", "img-sheen")); // liquid-glass shimmer over the picture
    const bubble = document.createElement(wp.url ? "a" : "div");
    bubble.className = "img-bubble";
    if (wp.url) { bubble.setAttribute("href", wp.url); bubble.setAttribute("target", "_blank"); bubble.setAttribute("rel", "noopener"); }
    bubble.appendChild(el("span", "img-bubble-t", wp.title));
    if (wp.desc) bubble.appendChild(el("span", "img-bubble-d", wp.desc));
    card.appendChild(bubble);
    return card;
  }

  // ---------- hybrid breakdown ----------
  let MFK = null;
  function morphFind(s, kind) {
    if (!MFK) {
      MFK = { prefix: {}, root: {}, suffix: {} };
      const M = window.MORPHEMES || {};
      [["prefixes", "prefix"], ["roots", "root"], ["suffixes", "suffix"]].forEach(function (pair) {
        (M[pair[0]] || []).forEach(function (e) {
          (e.forms || []).forEach(function (f) { if (!MFK[pair[1]][f]) MFK[pair[1]][f] = e; });
        });
      });
    }
    const t = s.replace(/^-|-$/g, "");
    if (kind && MFK[kind]) return MFK[kind][s] || MFK[kind][t] || null; // a suffix part only matches suffixes, etc.
    return MFK.root[s] || MFK.prefix[s] || MFK.suffix[s] || MFK.root[t] || MFK.prefix[t] || MFK.suffix[t] || null;
  }
  let MBYID = null;
  function morphById(id) {
    if (!MBYID) {
      MBYID = {};
      const M = window.MORPHEMES || {};
      ["prefixes", "roots", "suffixes"].forEach(function (cat) {
        (M[cat] || []).forEach(function (e) { if (e.id && !MBYID[e.id]) MBYID[e.id] = e; });
      });
    }
    return MBYID[id] || null;
  }
  function hybridPart(x) {
    // a curated part with an explicit source (src) is self-contained: it asserts its
    // own root (e.g. feral's "fer" = ferus 'wild') and must NOT bind to a coincidental
    // morpheme of the same spelling (ferre) or get that morpheme's id/tree button.
    if (x.src) return { kind: x.k, surface: x.s, disp: x.disp || null, origin: x.o || null, source: x.src, meaning: x.g || null, id: null, forms: null };
    // a curated part may bind to a morpheme by explicit id when its surface isn't a
    // registered form (e.g. suspect → sus·pect, with pect bound to the spec root).
    const e = morphFind(x.s, x.k) || (x.id && morphById(x.id));
    if (e) return { kind: x.k, surface: x.s, disp: x.disp || null, origin: x.o || e.origin, source: e.source, meaning: x.g || e.meaning, id: e.id, forms: e.forms };
    return { kind: x.k, surface: x.s, disp: x.disp || null, origin: x.o || null, source: null, meaning: x.g || null, id: x.id || null, forms: null };
  }
  function wholePart(word) {
    return [{ kind: "word", surface: word, origin: null, source: null, meaning: null, id: null, forms: null, whole: true }];
  }
  // Wiktionary's own surface analysis ("From un- + heard", "equivalent to
  // in- + credible"), read by etym-parse.js from the etymology this page
  // prints. Used only when the parts spell the word: exact concatenation, or
  // the ordinary English joins (silent-e drop, y→i, consonant doubling,
  // assimilated Latin prefixes).
  const ASSIM = { in: ["il", "im", "ir", "i"], con: ["col", "com", "cor", "co"], com: ["con", "col", "cor", "co"], ad: ["ac", "af", "ag", "al", "an", "ap", "ar", "as", "at", "a"],
    ob: ["oc", "of", "op", "o"], sub: ["suc", "suf", "sug", "sup", "sus"], ex: ["ef", "e"], dis: ["dif", "di"], syn: ["sym", "syl", "sy"], en: ["em"] };
  function alignParts(word, parts) {
    const W = word.toLowerCase();
    const bare = parts.map(function (p) { return p.t.replace(/^-|-$/g, "").toLowerCase(); });
    const variants = function (k) {
      const b = bare[k], last = k === bare.length - 1, v = [b];
      if (/-$/.test(parts[k].t) && ASSIM[b]) v.push.apply(v, ASSIM[b]);
      if (!last) {
        if (/e$/.test(b)) v.push(b.slice(0, -1));
        if (/y$/.test(b)) { v.push(b.slice(0, -1) + "i"); v.push(b.slice(0, -1)); }
        if (/[bcdfgklmnprstvz]$/.test(b)) v.push(b + b.slice(-1));
        if (/le$/.test(b)) v.push(b.slice(0, -2) + "il");
      }
      if (k > 0 && /^-/.test(parts[k].t) && /^[aeiou]/.test(b) === false && b.length > 2) v.push(b.slice(1)); // -ation after a stem ending in the same vowel
      return v;
    };
    const out = [];
    const go = function (k, pos) {
      if (k === bare.length) return pos === W.length;
      const vs = variants(k);
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (v && W.substr(pos, v.length) === v) { out[k] = word.substr(pos, v.length); if (go(k + 1, pos + v.length)) return true; }
        // a space or hyphen between parts in the headword ("personal attacker")
        if (v && pos < W.length && /[ -]/.test(W[pos]) && W.substr(pos + 1, v.length) === v) {
          out[k] = word.substr(pos + 1, v.length);
          if (go(k + 1, pos + 1 + v.length)) return true;
        }
      }
      return false;
    };
    return go(0, 0) ? out.slice() : null;
  }
  function wiktParts(word, rec) {
    if (!rec) return null;
    // structured parts from Wiktionary's own templates (rec.wp), else the prose
    let parts = Array.isArray(rec.wp) && rec.wp.length >= 2 ? rec.wp : null;
    if (!parts && rec.e && window.EtymParse) parts = window.EtymParse.parse(word, rec.e).parts;
    if (!parts || parts.length < 2) return null;
    const o = { parts: parts };
    const surf = alignParts(word, o.parts);
    if (!surf) return null;
    return o.parts.map(function (p, i) {
      const pre = /-$/.test(p.t) && !/^-/.test(p.t), suf = /^-/.test(p.t);
      const kind = pre ? "prefix" : suf ? "suffix" : "root";
      const m = (pre || suf) ? morphFind(p.t.replace(/^-|-$/g, ""), kind) : null;
      return { kind: kind, surface: surf[i], disp: null, origin: m ? m.origin : null, source: p.t,
        meaning: p.g || (m && m.meaning) || null, id: null, forms: m ? m.forms : null,
        wikt: true, partWord: p.t, kindText: pre || suf ? null : "word" };
    });
  }
  function chooseBreakdown(result, rec) {
    // Wiktionary's own split wins: it is the analysis the etymology under the
    // breakdown states, so the tiles can't contradict the text.
    const wk = wiktParts(result.word, rec);
    if (wk) return wk;
    // A curated breakdown (MorphoLex / Wiktionary, in rec.b) is authoritative — it
    // beats the heuristic engine even when the engine is confident, because the
    // engine confidently mis-splits opaque stems (demister → demos·ist·er). A
    // single "word"-kind part means the lexicon says don't decompose at all (demo).
    const b = rec && rec.b;
    if (b && b.length) {
      if (b.length === 1) return b[0].k === "word" ? wholePart(result.word) : result.parts;
      return b.map(hybridPart);
    }
    // Eponyms / place names aren't built from roots — "davenport" is a surname,
    // not a·ven·port. When the etymology says so, present the word whole instead
    // of force-splitting it.
    const ety = (rec && rec.e) || "";
    const eponym = /named after|\bsurname\b|\beponym|place name|toponym|genericized trademark/i.test(ety);
    if (eponym) return wholePart(result.word);
    // No curated breakdown: a split with no real root, or one carrying a big
    // unknown chunk (e.g. colpomicroscope → col·pomicr·o·scop·e), is worse than
    // showing the word whole.
    const bad = !result.hasRoot ||
      result.parts.some(function (p) { return p.kind === "unknown"; }) ||
      (result.confidence || 0) < 0.6;
    const bigUnknown = result.parts.some(function (p) { return p.kind === "unknown" && p.surface.length >= 4; });
    if (bad && (!result.hasRoot || bigUnknown)) return wholePart(result.word);
    return result.parts;
  }

  // ---------- search history ----------
  const HKEY = "rootwork.history";
  function store() { try { return localStorage; } catch (e) { return null; } }
  function loadHistory() { const s = store(); if (!s) return []; try { return JSON.parse(s.getItem(HKEY)) || []; } catch (e) { return []; } }
  function saveHistory(h) { const s = store(); if (s) try { s.setItem(HKEY, JSON.stringify(h)); } catch (e) {} }
  function pushHistory(w) { let h = loadHistory().filter(function (x) { return x !== w; }); h.unshift(w); saveHistory(h.slice(0, 20)); renderHistory(); }
  // The recent row is built here but stays hidden until the user taps an empty
  // search bar (showRecent); a search or typing dismisses it.
  function renderHistory() {
    const h = loadHistory();
    recentEl.innerHTML = "";
    if (!h.length) { recentEl.hidden = true; return; }
    recentEl.appendChild(el("span", "recent-label", "Recent"));
    h.forEach(function (w) {
      const b = el("button", "history-chip", w);
      // pointerdown fires before the input's blur-hide so the tap isn't lost
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); hideRecent(); run(w); });
      b.addEventListener("click", function () { hideRecent(); run(w); });
      recentEl.appendChild(b);
    });
    const clr = el("button", "history-clear", "Clear");
    clr.addEventListener("click", function () { saveHistory([]); renderHistory(); hideRecent(); });
    recentEl.appendChild(clr);
  }
  function showRecent() { if (loadHistory().length) { hideSuggest(); recentEl.hidden = false; } }
  function hideRecent() { recentEl.hidden = true; }

  // ---------- back / forward navigation ----------
  let navStack = [], navIndex = -1, navigating = false;
  function updateNav() {
    if (navBack) navBack.disabled = navIndex <= 0;
    if (navFwd) navFwd.disabled = navIndex >= navStack.length - 1;
  }
  function pushNav(word) {
    if (navigating) { updateNav(); return; }
    if (navStack[navIndex] === word) { updateNav(); return; }
    navStack = navStack.slice(0, navIndex + 1);
    navStack.push(word);
    navIndex = navStack.length - 1;
    updateNav();
  }
  function goBack() {
    if (treeReturn && treeRoot) { returnToTree(); return; } // came from a tree → back into it
    if (navIndex <= 0) return;
    navIndex--; navigating = true; updateNav();
    Promise.resolve(run(navStack[navIndex])).then(function () { navigating = false; });
  }
  function goFwd() {
    if (navIndex >= navStack.length - 1) return;
    navIndex++; navigating = true; updateNav();
    Promise.resolve(run(navStack[navIndex])).then(function () { navigating = false; });
  }
  // exit the current word back to the splash (history/nav are kept).
  function goHome() {
    runToken++;
    clearStage();
    hideSuggest();
    hideRecent();
    if (!browseEl.hidden) closeBrowse();
    if (treeEl && !treeEl.hidden) closeTree();
    currentWord = "";
    input.value = "";
    hint.hidden = false;
    if (themeToggle) themeToggle.hidden = false; // toggle returns on the home screen
    if (savedWordsBtn) savedWordsBtn.hidden = false; // saved-words icon lives on the home screen only
    renderHomeChips(); // re-randomize the example words every time home is revisited
    mapWord = null;
    calloutFor = -1;
    setSheet("home");
    if (window.RootMap && RootMap.loaded()) { RootMap.setGlobal(null); RootMap.overview(); if (lensName === "doublets") applyLens(); }
    if (contentEl) contentEl.scrollTop = 0;
    if (dockEl) dockEl.classList.remove("dock-hide");
    if (contentEl) contentEl.classList.remove("dock-hidden");
  }

  // ---------- stage ----------
  function clearStage() {
    entryEl.className = "entry"; entryEl.innerHTML = "";
    noteEl.hidden = true; noteEl.textContent = "";
    ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = "";
    cardsEl.innerHTML = "";
    miniHead.classList.remove("show"); miniHead.innerHTML = "";
    pronEl = null;
  }
  function showStatus(html, isError) {
    clearStage(); hint.hidden = true;
    if (sheetState === "hidden") setSheet("peek");
    const d = el("div", "status" + (isError ? " error" : "")); d.innerHTML = html;
    entryEl.appendChild(d);
  }

  async function run(rawWord, sourcePart) {
    const word = String(rawWord || "").trim();
    if (!word) return;
    arrivedFrom = currentWord && currentWord.toLowerCase() !== word.toLowerCase() && !navigating ? currentWord : null;
    stepLevel = 0;
    if (/^@\d+$/.test(word)) return openNode(Number(word.slice(1)));
    if (/^-|-$/.test(word) && window.RootMap && RootMap.loaded() && RootMap.find(word) >= 0) return openNode(RootMap.find(word), true);
    treeReturn = openingFromTree; openingFromTree = false; // came from a tree?
    const token = ++runToken;
    input.value = word;
    input.blur(); // dismiss the keyboard so the dock returns to the bottom
    hideSuggest();
    hideRecent();
    if (!browseEl.hidden) closeBrowse();
    if (treeEl && !treeEl.hidden) closeTree();
    hint.hidden = true;
    // the map flies to the word first; the sheet rises once it lands
    const quizPeeking = !!(document.querySelector && document.querySelector(".app.quiz-peek"));
    const flying = !quizPeeking && mapCanFly(word);
    if (flying) lowerForFlight(); else if (!quizPeeking && sheetState !== "full") setSheet("peek");
    loadData();
    if (contentEl) contentEl.scrollTop = 0;
    if (dockEl) dockEl.classList.remove("dock-hide");
    if (contentEl) contentEl.classList.remove("dock-hidden");
    try {
      if (!window.EtymologyEngine || typeof window.EtymologyEngine.decompose !== "function") {
        showStatus("The dictionary didn’t load. Pull down to refresh the page.", true);
        return;
      }
      const result = window.EtymologyEngine.decompose(word);
      if (!result || !result.parts || !result.parts.length) {
        showStatus("Hmm, nothing to break down there. Try another word.", true);
        return;
      }
      fetchUsageShard(result.word.slice(0, 2)); // warm the usage shard in parallel
      // If we have neither a dictionary definition nor a Wiktionary etymology,
      // there's nothing trustworthy to show — don't invent a breakdown.
      const rec0 = await getWord(result.word);
      if (token !== runToken) return;
      // A case-insensitive fallback match (getWord) resolves to the record but
      // typed/clicked casing may not match how it's actually stored ("ac/dc"
      // found "AC/DC") — correct result.word so the rest of this function
      // (display, history, nav, family/collection lookups) all use the real key.
      if (rec0 && rec0._resolvedKey && rec0._resolvedKey !== result.word) result.word = rec0._resolvedKey;
      if (!rec0 || (!(rec0.d && rec0.d.length) && !rec0.e)) {
        // Not a dictionary entry but a point on the map (e.g. a part named in
        // another word's etymology): stand on it.
        if (window.RootMap && RootMap.loaded() && RootMap.find(result.word) >= 0) { openNode(RootMap.find(result.word), true); return; }
        // Not an English headword — maybe it's a source word (a Latin/Greek/PIE
        // root). Try the built-in lexicon first, then a quick live lookup.
        await loadRoots();
        if (token !== runToken) return;
        const rk = foldKey(result.word);
        if (ROOTS && ROOTS[rk]) { pushHistory(result.word); pushNav(result.word); renderSource(ROOTS[rk], token); return; }
        // Came from a morpheme's "Explore the source word" arrow: the source is a
        // classical citation form (capere, skopein) that isn't keyed in roots.json.
        // Wiktionary either 404s the romanization (skopein) or returns a useless
        // "form-of" stub with no word family (scribere → "…future passive of
        // scrībō"), so prefer the morpheme we already decoded — it carries the real
        // gloss and, via the index, the English words built on the root.
        if (sourcePart && sourcePart.source) {
          pushHistory(result.word); pushNav(result.word);
          await renderSourceFromPart(sourcePart, token);
          return;
        }
        showStatus("Looking up “" + escapeHtml(result.word) + "” …", false);
        const online = await lookupOnline(result.word);
        if (token !== runToken) return;
        if (online) { pushHistory(result.word); pushNav(result.word); renderSource(online, token); return; }
        showStatus("“" + escapeHtml(result.word) + "” isn’t in the dictionary.", true);
        return;
      }
      // A pure spelling/form pointer ("Alternative spelling of X") is a whole
      // card that says nothing but "go look at X" — redirect straight to the
      // canonical word instead of rendering a near-empty card for it. (Done
      // here, before pushHistory/pushNav, so only the canonical word lands on
      // the nav stack — redirecting from inside reveal(), as the abbreviation
      // case below does, would double-push and trap the back button.) Multi-
      // sense entries are excluded: those carry real content of their own
      // even when also tagged with a `rel` pointer (e.g. "above-board").
      if (rec0.rel && rec0.rel.l && rec0.d.length === 1 && VARIANT_RE.test(rec0.d[0].g || "")) {
        return run(rec0.rel.l, sourcePart);
      }
      currentWord = result.word;
      pushHistory(result.word);
      pushNav(result.word);
      if (flying) {
        await mapShow(result.word, navigating);
        if (token !== runToken) return;
        const st = takeNextSheet();
        if (st === "callout") showWordCallout(result.word, rec0);
        setSheet(st);
      }
      else mapShow(result.word);
      await reveal(result, token);
    } catch (err) {
      showStatus("Something went wrong: " + escapeHtml(String(err && err.message || err)), true);
    } finally {
      if (sheetState === "hidden" && token === runToken) setSheet("peek");
    }
  }

  // Render a source word (Latin/Greek/PIE root): the lemma, its language and
  // gloss, then the English words built on it (or a Wiktionary link if live).
  function renderSource(r, token) {
    if (token !== runToken) return;
    clearStage(); hint.hidden = true;
    currentWord = r.l;
    const ew = el("div", "entry-word"); ew.textContent = r.l;
    entryEl.appendChild(ew);
    const pron = el("div", "pron");
    pron.appendChild(el("span", "src-lang", r.lang + (r.online ? " · live" : "")));
    if (r.rom && foldKey(r.rom) !== foldKey(r.l)) pron.appendChild(el("span", "resp", r.rom));
    entryEl.appendChild(pron);
    if (r.g) entryEl.appendChild(el("div", "entry-gloss", r.g));
    requestAnimationFrame(function () { entryEl.classList.add("in"); });
    miniHead.innerHTML = ""; miniHead.appendChild(el("span", "minihead-word", r.l));

    const card = el("div", "card");
    card.appendChild(el("div", "cap", "Source word"));
    // language: name + era + one-line description (same info the morphemes show)
    if (LANGS[r.lang]) {
      const head = el("div", "bpw-origin-head");
      head.appendChild(el("span", "bpw-origin-lang", r.lang));
      head.appendChild(el("span", "bpw-origin-era", LANGS[r.lang].era));
      card.appendChild(head);
      if (LANGS[r.lang].desc) card.appendChild(el("div", "bpw-origin-desc", LANGS[r.lang].desc));
    } else {
      card.appendChild(el("div", "src-note", "A source word English vocabulary is built on."));
    }
    if (r.online) card.appendChild(el("div", "src-note", "Looked up live from Wiktionary."));
    cardsEl.appendChild(card);
    requestAnimationFrame(function () { card.classList.add("in"); });

    if (r.en && r.en.length) {
      const fam = el("div", "card");
      fam.appendChild(el("div", "cap", "English words from this root"));
      const list = el("div", "related-list");
      r.en.forEach(function (w, i) {
        const c = el("button", "related-chip", w); c.dataset.kind = "root";
        c.style.setProperty("--i", i);
        c.addEventListener("click", function () { run(w); });
        list.appendChild(c);
      });
      fam.appendChild(list);
      cardsEl.appendChild(fam);
      requestAnimationFrame(function () { fam.classList.add("in"); });
    }
    if (r.online) {
      const link = el("div", "card");
      const a = document.createElement("a"); a.className = "src-wiki";
      a.textContent = "View full entry on Wiktionary →";
      a.setAttribute("href", "https://en.wiktionary.org/wiki/" + encodeURIComponent(r.l));
      a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
      link.appendChild(a);
      cardsEl.appendChild(link);
      requestAnimationFrame(function () { link.classList.add("in"); });
    }
  }

  // Build a source-word page from a morpheme we already decoded, used when the
  // source's citation form (e.g. Greek "skopein", Latin "capere") isn't in
  // roots.json and Wiktionary can't resolve the romanization. The English
  // derivatives come from the morpheme index (validated so each chip lands on a
  // real entry), so the page is just as rich — and works fully offline.
  async function renderSourceFromPart(p, token) {
    const lang = p.origin === "Greek" ? "Ancient Greek" : (p.origin || "");
    await loadData();
    if (token !== runToken) return;
    const family = (MORPH && MORPH[p.id]) ? MORPH[p.id].slice() : [];
    const en = await validateWords(family, 48);
    if (token !== runToken) return;
    renderSource({ l: p.source, lang: lang, g: p.meaning || "", en: en }, token);
  }

  // FLIP (translate only): run `mutate`, then glide each element from its old box
  // to its new one — used to slide the split pieces into the stacked acrostic.
  function flipMove(els, mutate) {
    if (reduceMotion) { mutate(); return; }
    const first = els.map(function (e) { return e.getBoundingClientRect(); });
    mutate();
    const last = els.map(function (e) { return e.getBoundingClientRect(); });
    els.forEach(function (e, i) {
      const dx = first[i].left - last[i].left, dy = first[i].top - last[i].top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      e.style.transition = "none";
      e.style.transform = "translate(" + dx + "px," + dy + "px)";
    });
    requestAnimationFrame(function () {
      els.forEach(function (e) {
        if (!e.style.transform) return;
        e.style.transition = "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)";
        e.style.transform = "";
        const done = function () { e.style.transition = ""; e.removeEventListener("transitionend", done); };
        e.addEventListener("transitionend", done);
      });
    });
  }

  function shortGloss(g) {
    let s = String(g).split(/;| — /)[0].trim();
    if (s.length > 90) s = s.slice(0, 88).trim() + "…";
    return s;
  }

  // shrink a headword until it fits on one line (unless it's absurdly long)
  function fitLine(elx, max, min) {
    if (!elx || typeof requestAnimationFrame !== "function") return;
    elx.style.fontSize = max + "px";
    requestAnimationFrame(function () {
      let s = max;
      while (s > min && elx.scrollWidth > elx.clientWidth + 1) { s -= 2; elx.style.fontSize = s + "px"; }
    });
  }
  // a chart's coordinates for a word: its family (deepest ancestor's group),
  // the language it reached English from, and when it is first recorded
  function wordCoords(word, rec) {
    const bits = [];
    if (window.RootMap && RootMap.loaded()) {
      const i = RootMap.find(word);
      if (i >= 0) {
        const lin = RootMap.lineage(i);
        if (lin.length) {
          const root = RootMap.info(lin[lin.length - 1]);
          bits.push({ t: root.family, fam: root.fam });
          const from = lin.map(function (x) { return RootMap.info(x).lang; }).find(function (l) { return !/English$/.test(l); });
          if (from) bits.push({ t: "via " + from });
        }
      }
    }
    const yr = rec && rec.e ? extractYear(rec.e) : null;
    if (yr) bits.push({ t: yr });
    return bits;
  }

  function buildEntry(word, rec, parts) {
    entryEl.className = "entry"; entryEl.innerHTML = "";
    const coordRow = el("div", "entry-coords");
    wordCoords(word, rec).forEach(function (b, k) {
      if (k) coordRow.appendChild(el("span", "ec-sep", "·"));
      const sp = el("span", "ec-bit", b.t);
      if (b.fam != null) { const dot = el("i", "ec-dot"); dot.style.background = RootMap.colorOf(b.fam); sp.insertBefore(dot, sp.firstChild); }
      coordRow.appendChild(sp);
    });
    coordRow.appendChild(el("span", "ec-gap"));
    const pos = rec && rec.d && rec.d[0] && rec.d[0].p;
    if (pos) coordRow.appendChild(el("span", "entry-pos", pos));
    const savedNow = isSaved(word);
    const starBtn = el("button", "save-btn" + (savedNow ? " saved" : ""), savedNow ? "★" : "☆");
    starBtn.type = "button";
    starBtn.setAttribute("aria-label", savedNow ? "Remove from saved" : "Save");
    starBtn.addEventListener("click", function () {
      const on = toggleSaved(word);
      starBtn.textContent = on ? "★" : "☆";
      starBtn.className = "save-btn" + (on ? " saved" : "");
      starBtn.setAttribute("aria-label", on ? "Remove from saved" : "Save");
    });
    coordRow.appendChild(starBtn);
    const headWrap = el("div", "entry-head");
    headWrap.appendChild(coordRow);
    // the headword plain, on one line; the split lives in the Breakdown card
    const wordEl = el("div", "entry-word");
    // Ortelius letters what is large in spaced capitals, with V for U, as the plate does
    wordEl.appendChild(el("span", "ew-part", lookName === "ortelius" ? word.toUpperCase().replace(/U/g, "V") : word));
    headWrap.appendChild(wordEl);
    entryEl.appendChild(headWrap);
    fitLine(wordEl, 52, 30);

    pronEl = el("div", "pron");
    entryEl.appendChild(pronEl);
    const isAbbr = rec && rec.d && rec.d[0] && rec.d[0].p === "abbr.";
    const gloss = rec && rec.d && rec.d[0] && rec.d[0].g;
    if (gloss && !isAbbr) entryEl.appendChild(el("div", "entry-gloss", shortGloss(gloss)));
    miniHead.innerHTML = "";
    miniHead.appendChild(el("span", "minihead-word", word));
    if (pos) miniHead.appendChild(el("span", "minihead-pos", pos));
  }

  async function reveal(result, token, preRec) {
    clearStage();
    // `preRec` is a synthesized MW-fallback entry (word not in our corpus); use
    // it directly rather than re-reading the dictionary, which would miss.
    const recP = preRec ? Promise.resolve(preRec) : getWord(result.word);
    const rec = await recP;
    if (token !== runToken) return;
    // Kick off Merriam-Webster enrichment now (if not already baked into the
    // entry) so the network call overlaps the headword + breakdown animation;
    // we only await it when we reach the definition section below.
    const isAbbr = rec && rec.d && rec.d[0] && rec.d[0].p === "abbr.";
    // If this word is a member of a collection that names a parent English word,
    // redirect to that parent — abbreviations live on the parent's card, not alone.
    if (isAbbr) {
      const col = await loadCollections();
      if (token !== runToken) return;
      const ids = col.byWord[result.word];
      if (ids && ids.length) {
        const member = (col.defs[ids[0]].members || []).find(function (m) { return m.w === result.word; });
        if (member && member.parent) { run(member.parent); return; }
      }
    }
    // Abbreviations (abbr.) don't have meaningful morpheme breakdowns — show whole.
    const parts = isAbbr ? wholePart(result.word) : chooseBreakdown(result, rec);
    const isWhole = parts.length === 1 && parts[0].whole;

    if ((!rec || !rec.d || !rec.d.length) && !(rec && rec._mw && rec._mw.length)) {
      noteEl.textContent = isWhole
        ? "“" + result.word + "” isn’t in the dictionary."
        : "“" + result.word + "” isn’t in the dictionary — here’s how its parts would break down.";
      noteEl.hidden = false;
    }

    // 1) headword
    buildEntry(result.word, rec, parts);
    // Inflected / derived form: present it as descending from a base word
    // ("plural of cactus", "past tense of run", "derived from psychology") and
    // point at that base, rather than as a standalone word.
    if (rec && rec.rel && rec.rel.l) {
      const rel = el("div", "entry-rel");
      rel.appendChild(txtNode((rec.rel.t || "from") + " "));
      const lk = el("button", "rel-link", rec.rel.l);
      lk.type = "button";
      lk.addEventListener("click", function () { run(rec.rel.l); });
      rel.appendChild(lk);
      entryEl.appendChild(rel);
    }
    // Canonical card carries the whole family of spellings: "also spelled
    // caplin, capelan". Each is tappable and lands back on this same card.
    if (rec && rec.vars && rec.vars.length) {
      const av = el("div", "entry-vars");
      av.appendChild(txtNode("also spelled "));
      rec.vars.forEach(function (v, i) {
        if (i) av.appendChild(txtNode(", "));
        const lk = el("button", "rel-link", v);
        lk.type = "button";
        lk.addEventListener("click", function () { run(v); });
        av.appendChild(lk);
      });
      entryEl.appendChild(av);
    }
    // Derived/inflected forms that fold into this base word ("adverb of",
    // "plural of", ...). Each is tappable and lands on its own card.
    if (rec && rec.forms && rec.forms.length) {
      const fr = el("div", "entry-forms");
      fr.appendChild(txtNode("forms: "));
      rec.forms.forEach(function (v, i) {
        if (i) fr.appendChild(txtNode(", "));
        const lk = el("button", "rel-link", v);
        lk.type = "button";
        lk.addEventListener("click", function () { run(v); });
        fr.appendChild(lk);
      });
      entryEl.appendChild(fr);
    }
    requestAnimationFrame(function () { entryEl.classList.add("in"); });
    await delay(28); if (token !== runToken) return;
    fillPron(recP, result.word, token, isAbbr ? rec : null);
    addWikiInfo(result.word, token); // lead image + proper-noun capitalization

    // 2) Breakdown — skipped for abbreviations (cf, e.g., i.e.) since the letters
    // are initials, not morphemes. The "read as" line in the pron slot carries the meaning.
    await delay(30); if (token !== runToken) return;
    if (isAbbr) { await delay(30); }
    const shown = isWhole ? parts : parts.filter(function (p) { return !(p.kind === "unknown" && p.surface.length < 3); });
    if (!isAbbr && !isWhole) {
      const bdCard = el("div", "card bd-card");
      bdCard.appendChild(el("div", "cap", "Breakdown"));
      const bd = el("div", "bd");
      const bpEls = [];
      shown.forEach(function (p, i) {
        if (i) bd.appendChild(el("span", "bd-dot", "·"));
        const bp = buildBP(p, rec);
        bd.appendChild(bp);
        bpEls.push(bp);
      });
      bdCard.appendChild(bd);
      cardsEl.appendChild(bdCard);
      requestAnimationFrame(function () { bdCard.classList.add("in"); });

    // 1) assemble — pieces pop in tight so they read as the whole word
    for (let i = 0; i < bpEls.length; i++) { if (token !== runToken) return; bpEls[i].classList.add("in"); await delay(navigating ? 0 : 55); }

    // Skip the animation for single-unit words ("ism"), reduced-motion users,
    // when revisiting via the back/forward buttons (it's not a fresh
    // discovery), and for bWhole entries (congee/conge) — the elaborate
    // "pieces chase together to form the headword" sequence doesn't make
    // sense when the headword title isn't assembling from those pieces to
    // begin with, and skipping it also avoids the card taking noticeably
    // longer to settle than an async lead image, which could otherwise pop
    // in while the (thematically irrelevant, for bWhole) animation is
    // still mid-flight.
    if (reduceMotion || navigating || treeReturn || bpEls.length <= 1 || (rec && rec.bWhole)) {
      bd.classList.add("split"); bd.classList.add("stacked");
      bpEls.forEach(function (bp) { swapToSource(bp); bp.classList.add("open"); });
    } else {
      // 2) breathe out: gaps open and the dots grow in between the pieces
      await delay(130); if (token !== runToken) return;
      bd.classList.add("split");
      await delay(260); if (token !== runToken) return;
      // 3) breathe in: pieces draw back together and the dots fade away
      bd.classList.remove("split");
      await delay(210); if (token !== runToken) return;
      // 4) chase out toward the card's inner-left edge, leftmost first — each
      //    piece darts after the one before it
      for (let i = 0; i < bpEls.length; i++) { if (token !== runToken) return; bpEls[i].classList.add("exit"); await delay(75); }
      await delay(155); if (token !== runToken) return;
      // 5) restack, then float each piece back in from the inner-left edge, top
      //    first, growing the card a row at a time
      bd.classList.add("stacked");
      void bd.offsetWidth;
      for (let i = 0; i < bpEls.length; i++) {
        if (token !== runToken) return;
        const bp = bpEls[i];
        bp.classList.remove("exit");
        swapToSource(bp); // surface → Greek/Latin source word as it lands
        bp.style.transition = "none";
        bp.style.transform = "translateX(-40px)";
        void bp.offsetWidth;
        bp.style.transition = "";
        bp.classList.add("open");
        bp.style.transform = "";
        await delay(68);
      }
    }
    } // end !isAbbr breakdown block

    // 3) Definition (+ etymology + thesaurus, grouped per homograph when we have
    // Merriam-Webster data — either baked into the entry or fetched live above).
    // `useMw` swaps the section-grouped Definition/Word-history/Thesaurus cards
    // for one card per homograph.
    await delay(30); if (token !== runToken) return;
    const useMw = false;
    let anchorCard;
    if (useMw) {
      const mwCards = [];
      mwCards.forEach(function (c) { cardsEl.appendChild(c); requestAnimationFrame(function () { c.classList.add("in"); }); });
      anchorCard = mwCards[mwCards.length - 1];
    } else {
      anchorCard = buildDefinitionCard(recP, token);
      cardsEl.appendChild(anchorCard);
      requestAnimationFrame(function () { anchorCard.classList.add("in"); });
    }

    // 3.6) Collection tag (e.g. Latin abbreviations) — tappable to see the set.
    buildCollectionCard(result.word, token).then(function (colCard) {
      if (colCard && token === runToken) {
        cardsEl.appendChild(colCard);
        requestAnimationFrame(function () { colCard.classList.add("in"); });
      }
    });
    // "Abbreviated as" card: inline abbreviation sub-cards (with usage charts)
    // on the canonical word's page instead of separate pages per abbreviation.
    buildAbbrCard(result.word, token).then(function (abbrCard) {
      if (abbrCard && token === runToken) {
        cardsEl.appendChild(abbrCard);
        requestAnimationFrame(function () { abbrCard.classList.add("in"); });
      }
    });

    // 4) divider + Word history — skipped under MW (etymology already lives
    // inside each homograph card above).
    let histAnchor = anchorCard;
    if (!useMw) {
      const divider = fleuron();
      const histCard = buildHistoryCard(recP, parts, token, divider, result.word);
      cardsEl.appendChild(divider);
      cardsEl.appendChild(histCard);
      requestAnimationFrame(function () { divider.classList.add("in"); histCard.classList.add("in"); });
      histAnchor = histCard;
    }

    // 4.5) Ancestry — the word's position on the etymology graph (trees/),
    // ancestors tappable: entries open, shared roots pivot to descendants.
    buildLineageCards(result.word, token).then(function (cards) {
      if (!cards || token !== runToken) return;
      let after = histAnchor;
      cards.forEach(function (c) {
        if (after && after.nextSibling) cardsEl.insertBefore(c, after.nextSibling); else cardsEl.appendChild(c);
        after = c;
        requestAnimationFrame(function () { c.classList.add("in"); });
      });
    });

    // 5) Usage over time
    const useCard = buildUsageCard(result.word, token);
    cardsEl.appendChild(useCard);
    requestAnimationFrame(function () { useCard.classList.add("in"); });

    // 6) Thesaurus — skipped under MW (synonyms already live inside each
    // homograph card above).
    if (!useMw) {
      const thesCard = buildThesaurusCard(recP, token);
      cardsEl.appendChild(thesCard);
      requestAnimationFrame(function () { thesCard.classList.add("in"); });
    }
  }

  // Usage-over-time histogram: 21 quarter-century buckets (1500–2025), each 0–100
  // of the word's own peak. Built from Google Books Ngrams (scripts/build-usage.js).
  function buildUsageCard(word, token) {
    const card = el("div", "card");
    card.appendChild(el("div", "cap", "Usage over time"));
    const holder = el("div", "usage-holder");
    card.appendChild(holder);
    getUsage(word).then(function (series) {
      if (token !== runToken) return;
      if (!series || !series.length || !series.some(function (v) { return v > 0; })) { card.remove(); return; }
      let peak = 0;
      for (let i = 1; i < series.length; i++) if (series[i] > series[peak]) peak = i;
      const bars = el("div", "usage-bars");
      const eraPanel = el("div", "era-panel"); eraPanel.hidden = true;
      let openEra = -1;
      series.forEach(function (v, i) {
        const col = el("div", "usage-col" + (i === peak ? " peak" : ""));
        col.setAttribute("role", "button"); col.setAttribute("tabindex", "0");
        const bar = el("div", "usage-bar");
        bar.style.height = Math.max(2, v) + "%";
        const y = 1500 + i * 25;
        col.setAttribute("title", "Words that peaked in " + y + "–" + (y + 24));
        col.appendChild(bar);
        const openIt = function () { showEra(i, col); };
        col.addEventListener("click", openIt);
        col.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } });
        bars.appendChild(col);
      });
      holder.appendChild(bars);
      const axis = el("div", "usage-axis");
      [1500, 1600, 1700, 1800, 1900, 2000].forEach(function (y) { axis.appendChild(el("span", "usage-tick", String(y))); });
      holder.appendChild(axis);
      holder.appendChild(el("div", "usage-note", "Most used in the " + (1500 + peak * 25) + "s, by printed-book frequency. Tap a bar for that era's words."));
      holder.appendChild(eraPanel);

      function markSel(i) {
        const cols = bars.children;
        for (let k = 0; k < cols.length; k++) cols[k].classList.toggle("sel", k === i);
      }
      function showEra(i, col) {
        if (openEra === i) { openEra = -1; eraPanel.hidden = true; markSel(-1); return; }
        openEra = i; markSel(i);
        const y = 1500 + i * 25;
        eraPanel.hidden = false; eraPanel.innerHTML = "";
        eraPanel.appendChild(el("div", "lab", "Words that peaked in " + y + "–" + (y + 24)));
        eraPanel.appendChild(el("div", "era-sub", "Words whose own usage crested in this quarter-century — not the era's most common words."));
        const listBox = el("div", "related-list");
        listBox.appendChild(el("div", "related-empty", "loading…"));
        eraPanel.appendChild(listBox);
        const tk = runToken;
        loadEras().then(function (eras) {
          if (tk !== runToken || openEra !== i) return;
          listBox.innerHTML = "";
          const words = (eras && eras[i]) ? eras[i].filter(function (w) { return w !== currentWord; }).slice(0, 60) : [];
          if (!words.length) { listBox.appendChild(el("div", "related-empty", "No standout words for this era.")); return; }
          words.forEach(function (w, j) {
            const c = el("button", "related-chip", w); c.dataset.kind = "root";
            c.style.setProperty("--i", j);
            c.addEventListener("click", function () { run(w); });
            listBox.appendChild(c);
          });
        });
      }
    });
    return card;
  }
  let ERAS = null, erasPromise = null;
  function loadEras() {
    if (erasPromise) return erasPromise;
    if (typeof fetch !== "function") { ERAS = {}; return (erasPromise = Promise.resolve(ERAS)); }
    erasPromise = fetch("eras.json?v=" + DATA_V)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (m) { ERAS = m || {}; return ERAS; });
    return erasPromise;
  }

  function defaultGloss(p) {
    if (p.silentE) return "silent final “e” — a spelling marker that lengthens the preceding vowel; not itself pronounced";
    if (p.kind === "linker") return "connecting vowel — joins the roots";
    return null;
  }

  function buildBP(p, rec) {
    const bp = el("div", "bp");
    bp.dataset.kind = p.kind;
    const inner = el("div", "bp-inner"); // wrapper so the row height can animate
    const main = el("div", "bp-main");
    main.appendChild(el("span", "bp-vline")); // vertical accent to the left
    const col = el("div", "bp-col");

    let g = p.meaning ? firstSense(p.meaning) : defaultGloss(p);
    let origin = p.origin, source = p.source;
    if ((!origin || !source) && p.whole && rec && rec.e) {
      const s = extractSource(cleanProse(rec.e));
      if (s) { origin = s.lang; source = s.word + (s.translit ? " (" + s.translit + ")" : ""); if (!g && s.gloss) g = s.gloss; }
    }
    bp.dataset.src = source || "";

    // Two rows: row 1 is the source word + its meaning (right-justified); row 2
    // is "Latin · root" + "shows up as …" (right-justified). The .mw fragment
    // spells the word during the animation, then swaps to the source (swapToSource).
    const r1 = el("div", "bp-r1");
    r1.appendChild(el("span", "mw", p.disp || p.surface));
    if (g) r1.appendChild(el("span", "gl", g));
    col.appendChild(r1);

    const info = el("span", "bp-info");
    const kind = p.whole ? null : (p.kindText || kindLabel(p.kind));
    const sub = [origin, kind].filter(Boolean).join(" · "); // e.g. "Latin · root"
    if (sub) info.appendChild(el("span", "bp-origin", sub));
    if (source) {
      const forms = [p.surface].concat((p.forms || []).filter(function (f) { return f !== p.surface; }));
      info.appendChild(el("span", "appears", "shows up as: " + forms.join(", ")));
    }
    col.appendChild(info);
    main.appendChild(col);
    // Tree access is via the Word family card below, not a per-chip button.
    inner.appendChild(main);
    bp.appendChild(inner);

    // a Wiktionary part is a point on the map: tap to go stand on it
    if (p.wikt && p.partWord) {
      bp.classList.add("tappable");
      bp.setAttribute("role", "button");
      bp.setAttribute("tabindex", "0");
      const go = function () { run(p.partWord); };
      bp.addEventListener("click", go);
      bp.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    } else if (p.id) {
    // tap a morpheme to hear the root and see other words built on it
      bp.classList.add("tappable");
      bp.setAttribute("role", "button");
      bp.setAttribute("tabindex", "0");
      const open = function () { togglePartWords(p, bp); };
      bp.addEventListener("click", open);
      bp.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
    return bp;
  }
  function swapToSource(bp) {
    const s = bp.dataset && bp.dataset.src;
    if (s) { const m = bp.querySelector(".mw"); if (m) m.textContent = s; }
  }

  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  function togglePartWords(p, bp) {
    if (bp.classList.contains("expanded")) {
      bp.classList.remove("expanded");
      const box = bp.querySelector(".bp-words"); if (box) box.remove();
      return;
    }
    const box = el("div", "bp-words");
    const say = p.source || p.surface;
    if (canSpeak && say) {
      const sayRow = el("div", "card-say");
      const btn = el("button", "spk", "▶"); btn.type = "button";
      btn.setAttribute("aria-label", "Pronounce " + say);
      btn.addEventListener("click", function (e) { e.stopPropagation(); speak(say); });
      sayRow.appendChild(btn);
      sayRow.appendChild(el("span", "card-say-word", say));
      box.appendChild(sayRow);
    }
    // fuller meaning (all senses), when richer than the one-line gloss above
    if (p.meaning && /[,;]/.test(p.meaning)) {
      box.appendChild(el("div", "bpw-mean", "“" + p.meaning + "”"));
    }
    // where it comes from — language + era only; the full language blurb
    // lives in the Word-history timeline (tap a stage), not on every tile
    const olang = p.origin === "Greek" ? "Ancient Greek" : p.origin;
    if (olang && LANGS[olang]) {
      const o = el("div", "bpw-origin");
      const h = el("div", "bpw-origin-head");
      h.appendChild(el("span", "bpw-origin-lang", olang));
      h.appendChild(el("span", "bpw-origin-era", LANGS[olang].era));
      o.appendChild(h);
      box.appendChild(o);
    }
    // deep-link to the full source-word entry (its derivatives + Wiktionary)
    if (p.source && /^[a-zà-ɏ'-]{2,}$/i.test(p.source) && foldKey(p.source) !== foldKey(currentWord)) {
      const link = el("button", "bpw-source"); link.type = "button";
      link.textContent = "Explore the source word: " + p.source + " →";
      link.addEventListener("click", function (e) { e.stopPropagation(); run(p.source, p); });
      box.appendChild(link);
    }
    // Related words used to be listed here per morpheme; the per-root tree button
    // now gives a far richer family view, so the card just shows the morpheme's
    // pronunciation, meaning, origin, and a link to its source word.
    bp.classList.add("expanded");
    // into .bp-col so it lines up under the morpheme text, not the accent rule
    (bp.querySelector(".bp-col") || bp.querySelector(".bp-inner") || bp).appendChild(box);
  }
  // Keep only candidate words that actually have a dictionary entry, so tapping
  // one never lands on a blank page.
  async function validateWords(words, cap) {
    const byKey = {};
    words.forEach(function (w) { const k = w.slice(0, 2).toLowerCase(); if (/^[a-z]{2}$/.test(k)) (byKey[k] = byKey[k] || []).push(w); });
    const out = [];
    const keys = Object.keys(byKey);
    for (let i = 0; i < keys.length && out.length < cap; i++) {
      const sh = await fetchShard(keys[i]);
      if (sh) byKey[keys[i]].forEach(function (w) { if (sh[w] && sh[w].d && sh[w].d.length) out.push(w); });
    }
    return out.slice(0, cap);
  }

  // ---------- speech ----------
  function speak(word) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = "en-US"; u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // real Wiktionary recordings (entry field `au`, a path under the commons
  // transcode host — see scripts/backfill-audio.js); TTS is the fallback
  const AUDIO_BASE = "https://upload.wikimedia.org/wikipedia/commons/transcoded/";
  let audioEl = null;
  function playAudio(path, fallbackWord) {
    try {
      if (!audioEl) audioEl = new Audio();
      audioEl.src = AUDIO_BASE + path;
      const p = audioEl.play();
      if (p && p.catch) p.catch(function () { if (canSpeak) speak(fallbackWord); });
    } catch (e) { if (canSpeak) speak(fallbackWord); }
  }

  // ---------- IPA pronunciation key ----------
  const IPA_KEY = {
    "ˈ": "primary stress — say this syllable loudest",
    "ˌ": "secondary stress — a lighter beat",
    "ɑ": "broad “ah”, as in father", "æ": "short “a”, as in cat",
    "ʌ": "short “u”, as in cup", "ɔ": "open “aw”, as in thought",
    "aʊ": "“ow”, as in now", "aɪ": "long “i”, as in price",
    "ɛ": "short “e”, as in dress", "ɝ": "“ur” (r-colored), as in nurse", "ɚ": "“er” (r-colored), as in letter",
    "eɪ": "long “a”, as in face", "ɪ": "short “i”, as in kit", "i": "long “e”, as in fleece",
    "oʊ": "long “o”, as in goat", "ɔɪ": "“oy”, as in choice",
    "ʊ": "short “oo”, as in foot", "u": "long “oo”, as in goose", "ə": "the neutral “uh”, as in about",
    "tʃ": "“ch”, as in church", "dʒ": "“j”, as in judge", "ð": "voiced “th”, as in this", "θ": "voiceless “th”, as in thin",
    "ʃ": "“sh”, as in ship", "ʒ": "“zh”, as in measure", "ŋ": "“ng”, as in sing", "j": "“y”, as in yes",
    "ɹ": "“r”, as in red", "r": "“r”, as in red", "ɡ": "hard “g”, as in go", "g": "hard “g”, as in go",
    "b": "“b”, as in bat", "d": "“d”, as in dog", "f": "“f”, as in fan", "h": "“h”, as in hat", "k": "“k”, as in cat",
    "l": "“l”, as in let", "m": "“m”, as in man", "n": "“n”, as in net", "p": "“p”, as in pen", "s": "“s”, as in sun",
    "t": "“t”, as in top", "v": "“v”, as in van", "w": "“w”, as in win", "z": "“z”, as in zoo",
    // long-vowel units (length mark folded in) — matched before the bare vowel
    "iː": "long “ee”, as in fleece", "uː": "long “oo”, as in goose", "ɑː": "broad “ah”, as in father",
    "ɔː": "open “aw”, as in thought", "ɜː": "“ur” (British), as in nurse", "ɛː": "long “e”, as in square",
    // vowels the key was missing
    "ɒ": "rounded “o”, as in British lot", "ɜ": "“ur”, as in nurse", "ɐ": "a short “uh”, as in about",
    "ʉ": "“oo” with the lips forward, as in Scottish goose", "ɨ": "a tight “i”, between “ee” and “uh”",
    "ᵻ": "a reduced “i”, between “ih” and “uh”", "ɵ": "a rounded “uh”",
    // consonants the key was missing
    "ɾ": "a quick tapped “r” (the “tt” in American butter)", "ɫ": "a dark “l”, as in full",
    "ʔ": "glottal stop — the catch in “uh-oh”", "ʍ": "a breathy “wh”, as in which",
    "x": "“ch”, as in Scottish loch", "ç": "a soft “h”, as in hue", "ʁ": "a throaty French “r”",
    // the length mark on its own, as a fallback
    "ː": "makes the vowel before it long",
  };
  const IPA_NAME = {
    "ə": "schwa", "ɚ": "r-colored schwa", "ɝ": "r-colored vowel",
    "æ": "ash", "ð": "eth", "θ": "theta", "ʃ": "esh", "ʒ": "ezh", "ŋ": "eng",
    "ɪ": "small capital I", "ʊ": "upsilon", "ɔ": "open o", "ɑ": "script a",
    "ɡ": "script g", "ɹ": "turned r", "tʃ": "ch-affricate", "dʒ": "j-affricate",
    "aɪ": "diphthong", "aʊ": "diphthong", "eɪ": "diphthong", "oʊ": "diphthong", "ɔɪ": "diphthong",
    "ˈ": "stress mark", "ˌ": "stress mark",
  };
  function tokenizeIPA(ipa) {
    // strip delimiters, stress/tone marks, and combining diacritics that have
    // no key row of their own (tie bar, syllabic/non-syllabic, nasal, dental,
    // aspiration…) so t͡ʃ folds to tʃ and stray marks don't break tokenizing
    const s = ipa.replace(/[\/\[\].‿]/g, "")
      .replace(/[̀-ͯʰʲˠˤ˥-˩ˑ]/g, "");
    const out = [], seen = {};
    for (let i = 0; i < s.length;) {
      let sym = null;
      if (IPA_KEY[s.substr(i, 2)]) { sym = s.substr(i, 2); i += 2; }
      else { if (IPA_KEY[s[i]]) sym = s[i]; i += 1; }
      if (sym && !seen[sym]) { seen[sym] = 1; out.push(sym); }
    }
    return out;
  }
  let ipaBtnRef = null;
  function closeIpaKey() {
    if (ipaKeyEl.hidden) return;
    ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = ""; ipaBtnRef = null;
    document.removeEventListener("click", onDocTapCloseIpa, true);
  }
  function onDocTapCloseIpa(e) {
    // the dismissing tap ONLY closes the key — swallow it so it never
    // activates whatever is underneath (a word chip, a button, the IPA itself)
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    closeIpaKey();
  }
  function toggleIpaKey(ipa, ib) {
    if (!ipaKeyEl.hidden) { closeIpaKey(); return; }
    ipaBtnRef = ib || null;
    ipaKeyEl.innerHTML = "";
    ipaKeyEl.appendChild(el("div", "lab", "Pronunciation key"));
    const list = el("div", "ipa-key-list");
    tokenizeIPA(ipa).forEach(function (sym) {
      const row = el("div", "ipa-key-row");
      row.appendChild(el("span", "ipa-sym", sym));
      // name (italic) + explanation share one flush-left column, no hang
      const def = el("span", "ipa-def");
      if (IPA_NAME[sym]) def.appendChild(el("span", "ipa-name", IPA_NAME[sym] + " "));
      def.appendChild(txtNode(IPA_KEY[sym]));
      row.appendChild(def);
      list.appendChild(row);
    });
    ipaKeyEl.appendChild(list);
    // Live INSIDE #content, absolute-positioned, so the peek scrolls glued to
    // the pronunciation it opened under. (#content's mask that used to kill
    // backdrop-filter is gone, so the frost works here now.)
    const content = document.getElementById("content");
    if (ipaKeyEl.parentNode !== content) content.appendChild(ipaKeyEl);
    ipaKeyEl.hidden = false;
    if (ib) {
      const ibr = ib.getBoundingClientRect(), cr = content.getBoundingClientRect();
      ipaKeyEl.style.top = (ibr.bottom - cr.top + content.scrollTop + 6) + "px";
      ipaKeyEl.style.left = Math.max(0, ibr.left - cr.left) + "px";
    }
    // arm tap-anywhere-to-close after this opening click settles
    setTimeout(function () { document.addEventListener("click", onDocTapCloseIpa, true); }, 0);
  }

  // Rough IPA → plain-English respelling, used when we have no CMU respelling.
  // Clean where the IPA has syllable boundaries; a single blob otherwise — which
  // is still more useful than showing nothing.
  const IPA_RESP = [
    ["tʃ", "ch"], ["dʒ", "j"], ["aʊ", "ow"], ["aɪ", "y"], ["eɪ", "ay"], ["oʊ", "oh"], ["əʊ", "oh"],
    ["ɔɪ", "oy"], ["ɪə", "eer"], ["eə", "air"], ["ɛə", "air"], ["ʊə", "oor"],
    ["ʃ", "sh"], ["ʒ", "zh"], ["θ", "th"], ["ð", "th"], ["ŋ", "ng"], ["ɡ", "g"], ["ɹ", "r"],
    ["ɚ", "ur"], ["ɝ", "ur"], ["ɜ", "ur"], ["ʔ", ""],
    ["ɑ", "ah"], ["æ", "a"], ["ʌ", "uh"], ["ɔ", "aw"], ["ɒ", "o"], ["ɛ", "eh"], ["ɪ", "ih"],
    ["i", "ee"], ["ʊ", "uu"], ["u", "oo"], ["ə", "uh"], ["y", "ee"],
    ["a", "ah"], ["e", "eh"], ["o", "oh"],
    ["p", "p"], ["b", "b"], ["t", "t"], ["d", "d"], ["k", "k"], ["g", "g"], ["f", "f"], ["v", "v"],
    ["s", "s"], ["z", "z"], ["h", "h"], ["m", "m"], ["n", "n"], ["l", "l"], ["r", "r"], ["w", "w"],
    ["j", "y"], ["x", "kh"], ["c", "k"], ["q", "k"],
  ];
  function ipaConv(ph) {
    let out = "";
    for (let i = 0; i < ph.length;) {
      let hit = false;
      for (let k = 0; k < IPA_RESP.length; k++) {
        if (ph.startsWith(IPA_RESP[k][0], i)) { out += IPA_RESP[k][1]; i += IPA_RESP[k][0].length; hit = true; break; }
      }
      if (!hit) i++;
    }
    return out;
  }
  function respellFromIPA(ipa) {
    if (!ipa) return "";
    let s = String(ipa).split(",")[0].trim();
    const m = s.match(/[\/\[]([^\/\]]+)[\/\]]/); if (m) s = m[1];
    s = s.replace(/[()]/g, "").replace(/\u02d0/g, ""); // drop parens and the length mark
    // Split into syllables at stress marks and dots, noting primary stress.
    const sy = []; let cur = "", stress = 0, primary = -1;
    function flush() { if (cur) { const i = sy.length; sy.push(cur); if (stress === 2 && primary < 0) primary = i; cur = ""; } }
    for (const ch of s) {
      if (ch === "\u02c8") { flush(); stress = 2; }
      else if (ch === "\u02cc") { flush(); stress = 1; }
      else if (ch === ".") { flush(); stress = 0; }
      else cur += ch;
    }
    flush();
    if (!sy.length) return "";
    if (primary < 0) primary = 0;
    return sy.map(function (ph, idx) { const r = ipaConv(ph); return idx === primary ? r.toUpperCase() : r; })
      .filter(Boolean).join("-");
  }

  // Extract the human-readable reading from an abbreviation gloss.
  // "Abbreviation of Latin confer — "compare"." → "compare"
  // "Abbreviation of Latin exempli gratia — "for example"." → "for example"
  function abbrReading(gloss) {
    const m = String(gloss || "").match(/[“”""]([^"""“”]+)["""“”]/);
    if (m) return m[1];
    const d = String(gloss || "").match(/—\s*(.+?)\.?\s*$/);
    if (d) return d[1].replace(/^[""]|["".]$/g, "").trim();
    return null;
  }
  function fillPron(recP, word, token, abbrRec) {
    const pe = pronEl; // capture: a later search may null/replace pronEl
    // For abbreviations show "read as: compare" instead of IPA.
    if (abbrRec) {
      const g = abbrRec.d && abbrRec.d[0] && abbrRec.d[0].g;
      const reading = abbrReading(g);
      if (reading) {
        pe.appendChild(el("span", "abbr-read-label", "read as"));
        pe.appendChild(el("span", "abbr-read-val", reading));
        requestAnimationFrame(function () { if (token === runToken) pe.classList.add("in"); });
      }
      return;
    }
    recP.then(function (rec) {
      if (token !== runToken || !pe) return;
      pe.innerHTML = "";
      ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = "";
      const ipa = rec && rec.i, resp = (rec && rec.rs) || respellFromIPA(ipa);
      if (ipa) {
        const ib = el("button", "ipa", ipa);
        ib.type = "button";
        ib.setAttribute("aria-label", "Show pronunciation key");
        ib.addEventListener("click", function () { toggleIpaKey(ipa, ib); });
        pe.appendChild(ib);
      }
      const au = rec && rec.au;
      if (canSpeak || au) {
        if (ipa) pe.appendChild(el("span", "pdot", "•"));
        const rb = el("button", "resp speakable", resp || word);
        rb.type = "button";
        rb.setAttribute("aria-label", "Pronounce " + word);
        // real Wiktionary recording when we have one; TTS as fallback
        rb.addEventListener("click", function () { au ? playAudio(au, word) : speak(word); });
        pe.appendChild(rb);
      } else if (resp) {
        if (ipa) pe.appendChild(el("span", "pdot", "•"));
        pe.appendChild(el("span", "resp", resp));
      }
      if (pe.children.length) requestAnimationFrame(function () { if (token === runToken) pe.classList.add("in"); });
    });
  }

  // ---------- definition ----------
  function buildDefinitionCard(recP, token) {
    const card = el("div", "card def-card");
    card.appendChild(el("div", "cap", "Definition"));
    const slot = el("div", "def-meaning");
    slot.innerHTML = '<span class="def-loading">looking it up…</span>';
    card.appendChild(slot);
    recP.then(function (rec) {
      if (token !== runToken) return;
      const senses = rec && rec.d;
      if (senses && senses.length) {
        slot.innerHTML = "";
        const fromRe = arrivedFrom ? wordRe(arrivedFrom) : null;
        // the sense that links this word to the one you came from: Wiktionary's
        // own sense-level synonym record (rec.ss) when it has one, else a
        // definition that literally names that word
        const exact = arrivedFrom && rec.ss && rec.ss[arrivedFrom] ? rec.ss[arrivedFrom] : null;
        const isLink = function (s) { return exact ? (s.g || "") === exact : !!(fromRe && fromRe.test(s.g || "")); };
        senses.forEach(function (s, i) {
          const row = el("div", "sense" + (isLink(s) ? " sense-linked" : ""));
          if (isLink(s)) row.title = "This is the sense that connects it to “" + arrivedFrom + "”";
          row.appendChild(el("span", "num", String(i + 1)));
          const body = el("span");
          let html = '<span class="pos">' + escapeHtml(s.p) + "</span>";
          if (s.dom) html += '<span class="sense-dom">' + escapeHtml(s.dom.replace(/-/g, " ")) + "</span>";
          html += escapeHtml(s.g);
          if (s.x) html += '<span class="sense-ex">“' + escapeHtml(s.x) + "”</span>";
          body.innerHTML = html;
          row.appendChild(body);
          slot.appendChild(row);
        });
      } else {
        // no dictionary entry — the note up top already explains; drop the card.
        card.remove();
      }
    });
    return card;
  }

  // ---------- sense (was: thesaurus) ----------
  // Saussure's associative series by sense: synonyms grouped by the lineage
  // family the map puts them in, each with the gloss that links it back to
  // this word when one of its definitions actually names it (otherwise no
  // claim is made). Opposites and related forms follow.
  function wordRe(w) {
    const b = String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/e$/, "");
    return new RegExp("\\b" + b + "(?:e|s|es|ed|d|ing|er|ers|ly)?\\b", "i");
  }
  function buildThesaurusCard(recP, token) {
    const card = el("div", "card thes-card sense-card");
    card.appendChild(el("div", "cap", "Sense"));
    recP.then(async function (rec) {
      if (token !== runToken) return;
      const word = currentWord;
      const s = await validateWords(rec && rec.s || [], 14);
      const a = await validateWords(rec && rec.a || [], 8);
      const r = await validateWords(rec && rec.r || [], 12);
      if (token !== runToken) return;
      if (!s.length && !a.length && !r.length) { card.remove(); return; }
      if (s.length) {
        card.appendChild(el("div", "lin-note", "Near-synonyms, grouped by the family their own histories put them in:"));
        const re = wordRe(word);
        const groups = {}, order = [];
        const recs = await Promise.all(s.map(function (w) { return getWord(w); }));
        if (token !== runToken) return;
        s.forEach(function (w, k) {
          let fam = "Unplaced", famIdx = -1;
          if (window.RootMap && RootMap.loaded()) {
            const i = RootMap.find(w);
            if (i >= 0) { let x = i, n = 0; while (RootMap.info(x).parent >= 0 && n++ < 40) x = RootMap.info(x).parent; fam = RootMap.info(x).family; famIdx = RootMap.info(x).fam; }
          }
          if (!groups[fam]) { groups[fam] = { famIdx: famIdx, items: [] }; order.push(fam); }
          // which of THIS word's senses the synonym belongs to (Wiktionary's
          // sense-level record), else the synonym's own definition naming this word
          const mine = rec && rec.ss && rec.ss[w] ? rec.ss[w] : null;
          const sense = mine ? null : ((recs[k] && recs[k].d) || []).find(function (d) { return re.test(d.g || ""); });
          groups[fam].items.push({ w: w, link: mine ? "in the sense “" + mine + "”" : sense ? sense.g : null });
        });
        order.forEach(function (f) {
          const g = groups[f];
          const head = el("div", "sense-fam");
          if (g.famIdx >= 0) { const dot = el("span", "fam-dot"); dot.style.background = RootMap.colorOf(g.famIdx); head.appendChild(dot); }
          head.appendChild(txtNode(f));
          card.appendChild(head);
          g.items.forEach(function (it) {
            const row = el("div", "sense-item");
            const b = el("button", "dbl-word", it.w); b.type = "button";
            b.addEventListener("click", function () { run(it.w); });
            row.appendChild(b);
            if (it.link) row.appendChild(el("span", "sense-link", it.link.length > 90 ? it.link.slice(0, 88) + "…" : it.link));
            card.appendChild(row);
          });
        });
      }
      function group(label, words, cls) {
        if (!words || !words.length) return;
        const row = el("div", "thes-group");
        row.appendChild(el("span", "thes-label", label));
        words.forEach(function (w, i) {
          const c = el("button", "related-chip thes-" + cls, w);
          c.style.setProperty("--i", i);
          c.addEventListener("click", function () { run(w); });
          row.appendChild(c);
        });
        card.appendChild(row);
      }
      group("Opposites", a, "ant");
      group("Related", r, "rel");
    });
    return card;
  }

  // ---------- etymology / word history ----------
  function looksLikeTree(e) {
    return /(Proto-|-der\.)/.test(e) && !/\bfrom\b/i.test(e);
  }

  // Languages we can place on a timeline, with a rough chronological rank, the
  // period the language was in use (modern ones show when they began; BC/AD), and
  // a one-line description shown when you tap that stage.
  const LANGS = {
    "Proto-Indo-European": { rank: -4500, short: "PIE", era: "c. 4500 BC", desc: "The reconstructed common ancestor of most European and South-Asian languages, spoken by a preliterate steppe people. Unattested — known only by comparing its descendants." },
    "Proto-Hellenic": { rank: -2000, era: "c. 2000 BC", desc: "The reconstructed ancestor of the Greek dialects, before the earliest written Greek." },
    "Proto-Italic": { rank: -1500, era: "c. 1500 BC", desc: "The reconstructed ancestor of Latin and the other early Italic languages of the Italian peninsula." },
    "Proto-Germanic": { rank: -500, era: "c. 500 BC", desc: "The reconstructed ancestor of the Germanic languages — English, German, Dutch and the Scandinavian tongues." },
    "Proto-West Germanic": { rank: -100, era: "c. 1 AD", desc: "The branch of Germanic that gave rise to English, Dutch and German." },
    "Ancient Greek": { rank: -800, era: "c. 800 BC–300 AD", desc: "The language of classical Greece — Homer, the philosophers, the city-states — and a deep source of scientific and technical vocabulary." },
    "Hellenistic Greek": { rank: -300, era: "c. 300 BC", desc: "Greek of the Hellenistic age, spread across the Mediterranean and Near East by Alexander's conquests." },
    "Koine Greek": { rank: -200, era: "c. 300 BC–300 AD", desc: "The 'common' Greek of the Hellenistic and Roman world — the language of the New Testament." },
    "Byzantine Greek": { rank: 600, era: "4th–15th c.", desc: "The medieval Greek of the Eastern Roman (Byzantine) Empire." },
    "Greek": { rank: 1700, era: "from c. 1500", desc: "Modern Greek." },
    "Latin": { rank: -75, era: "c. 75 BC–200 AD", desc: "The language of ancient Rome and its empire, and for centuries afterward the language of European scholarship, law and the Church." },
    "Classical Latin": { rank: -75, era: "c. 75 BC–200 AD", desc: "The polished literary Latin of the late Republic and early Empire — Cicero, Virgil, Caesar." },
    "Vulgar Latin": { rank: 200, era: "1st–7th c.", desc: "The everyday spoken Latin of ordinary Romans, from which the Romance languages descend." },
    "Late Latin": { rank: 300, era: "3rd–6th c.", desc: "The Latin of late antiquity, as the written and spoken forms drifted apart." },
    "Ecclesiastical Latin": { rank: 400, era: "4th c.+", desc: "The Latin of the Western Church, still in liturgical use today." },
    "Medieval Latin": { rank: 900, era: "9th–15th c.", desc: "The Latin of the Middle Ages — scholarship, charters and the Church across Europe." },
    "New Latin": { rank: 1550, era: "from c. 1500", desc: "Post-medieval Latin used by scientists and scholars to coin technical terms — much of modern taxonomy, anatomy and botany." },
    "Old English": { rank: 700, era: "5th–11th c.", desc: "The Germanic language of the Anglo-Saxons — the tongue of Beowulf — before the Norman Conquest." },
    "Middle English": { rank: 1200, era: "1150–1500", desc: "English after the Norman Conquest, heavily borrowing from French — the language of Chaucer." },
    "Old French": { rank: 1000, era: "9th–14th c.", desc: "Medieval French; the Norman variety brought to England became a major source of English vocabulary." },
    "Anglo-Norman": { rank: 1100, era: "11th–14th c.", desc: "The variety of Old French spoken by the Norman ruling class in England." },
    "Middle French": { rank: 1450, era: "14th–17th c.", desc: "French of the Renaissance, between the medieval and modern stages." },
    "French": { rank: 1700, era: "from c. 1600", desc: "Modern French, a continuing source of English loanwords." },
    "Old Norse": { rank: 800, era: "8th–14th c.", desc: "The language of the Vikings, which left a deep mark on English through Scandinavian settlement." },
    "Italian": { rank: 1400, era: "from c. 1400", desc: "A Romance language descended from Latin; source of many musical and artistic terms." },
    "Spanish": { rank: 1400, era: "from c. 1400", desc: "A Romance language descended from Latin." },
    "Portuguese": { rank: 1400, era: "from c. 1400", desc: "A Romance language descended from Latin." },
    "Dutch": { rank: 1500, era: "from c. 1500", desc: "A West Germanic language, a close relative of English." },
    "German": { rank: 1500, era: "from c. 1500", desc: "A West Germanic language, a close relative of English." },
    "Arabic": { rank: 600, era: "7th c.+", desc: "Source of many scientific, mathematical and trade terms that entered Europe in the Middle Ages." },
    "Sanskrit": { rank: -1500, era: "c. 1500 BC", desc: "The classical language of ancient India and its sacred texts; one of the earliest-attested Indo-European languages." },
    "Hebrew": { rank: -900, era: "c. 900 BC", desc: "The classical language of the Hebrew Bible; source of many religious terms." },
    "Persian": { rank: 800, era: "medieval+", desc: "An Indo-European language of Iran; source of various words reaching English via Arabic and Turkish." },
    "English": { rank: 1500, era: "from c. 1500", desc: "Modern English." },
  };

  function cleanProse(e) {
    const m = e.match(/(Borrowed from|Inherited from|Calque of|Univerbation of|Back-formation of|Clipping of|Abbreviation of|Blend of|Derived from|From)\b/);
    let s = (m && m.index > 0) ? e.slice(m.index) : e;
    s = s.replace(/\b(der|bor|inh|cog|cal|abbr|clip)\.\s*\??/g, " ")
         .replace(/\*[^\s,;()]+/g, "")
         .replace(/\s{2,}/g, " ")
         .replace(/\s+([,;.])/g, "$1")
         .trim();
    return s;
  }

  const SRC_LANGS = "Ancient Greek|Hellenistic Greek|Koine Greek|Byzantine Greek|Greek|Late Latin|Medieval Latin|New Latin|Vulgar Latin|Latin|Old French|Anglo-Norman|Middle French|French|Middle English|Old English|Proto-Indo-European|Proto-Germanic|Sanskrit|Arabic|Hebrew|Old Norse|Italian|Spanish|Portuguese|German|Persian";
  function extractSource(e) {
    const re = new RegExp("\\b(" + SRC_LANGS + ")\\s+(\\S+?)\\s*\\(([^)]+)\\)");
    const m = e.match(re);
    if (!m) return null;
    // Inside the parens, a transliteration (if any) is the unquoted text before
    // the first quote; the quoted text is the gloss. So βίος (bíos, “life”) →
    // translit "bíos", gloss "life"; but nacelle (“rowing boat, …”) → no
    // translit, gloss only (don't mistake the quoted gloss for a transliteration).
    const inner = m[3];
    const qi = inner.search(/[“"]/);
    let translit = "", gloss = "";
    if (qi >= 0) {
      translit = inner.slice(0, qi).replace(/[,;]\s*$/, "").trim();
      gloss = inner.slice(qi).replace(/[“”"]/g, "").trim();
      // the outer regex stops at the first ")", which can truncate a nested
      // parenthetical — drop any dangling, unbalanced "(" tail it left behind.
      if ((gloss.match(/\(/g) || []).length > (gloss.match(/\)/g) || []).length) {
        gloss = gloss.replace(/\s*\([^()]*$/, "").trim();
      }
    } else {
      translit = inner.split(",")[0].trim();
    }
    return { lang: m[1], word: m[2], translit: translit, gloss: gloss };
  }

  function extractYear(e) {
    let m = e.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
    if (m) return "c. " + m[1];
    m = e.match(/\b\d{1,2}(?:st|nd|rd|th)\s+century\b/i);
    return m ? m[0] : null;
  }

  // History: the line of descent read off the map (lineage rail), then the
  // Wiktionary etymology it was read from, then the first-recorded date. One
  // card, one source, so the rail and the text can't disagree.
  function buildHistoryCard(recP, parts, token, divider, word) {
    const card = el("div", "card hist-card");
    card.appendChild(el("div", "cap", "History"));
    const rail = el("div", "lin-holder");
    card.appendChild(rail);
    recP.then(async function (rec) {
      if (token !== runToken) return;
      const e = rec && rec.e;
      const prose = e && window.EtymParse ? window.EtymParse.display(word || currentWord, e) : (e && !looksLikeTree(e) ? cleanProse(e) : null);
      let rows = null;
      if (window.RootMap) {
        await RootMap.ready;
        const i = RootMap.find(word || currentWord);
        if (i >= 0) rows = await lineageRows(i, token);
      }
      if (token !== runToken) return;
      if (!rows && !prose) { card.remove(); if (divider) divider.remove(); return; }
      if (rows) rows.forEach(function (r) { rail.appendChild(r); });
      if (prose) {
        const h = el("div", "hist" + (rows ? " hist-src" : ""), prose);
        card.appendChild(h);
      }
      const yr = e ? extractYear(e) : null;
      if (yr) {
        const fr = el("div", "first-rec");
        fr.innerHTML = '<span class="sub">First recorded</span> ' + escapeHtml(yr);
        card.appendChild(fr);
      }
    });
    return card;
  }

  function fleuron() {
    const d = el("div", "divider");
    d.appendChild(el("span", "dln"));
    d.appendChild(el("span", "orn", "❧"));
    d.appendChild(el("span", "dln"));
    return d;
  }

  // ---------- browse-by-letter (A–Z strip on the home screen) ----------
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function buildAlpha() {
    const alphaEl = document.getElementById("alpha");
    if (!alphaEl) return;
    alphaEl.innerHTML = "";
    ALPHA.split("").forEach(function (c) {
      const b = el("button", "alpha-tab", c); b.type = "button"; b.dataset.letter = c;
      b.addEventListener("click", function () { browseLetter(c); });
      alphaEl.appendChild(b);
    });
  }

  let browseToken = 0;
  function openBrowse(letter) {
    browseEl.hidden = false; browseEl.innerHTML = "";
    const head = el("div", "browse-head");
    const title = el("div", "browse-title");
    title.innerHTML = "Words · <b>" + escapeHtml(letter) + "</b>";
    head.appendChild(title);
    const close = el("button", "browse-close", "✕"); close.type = "button";
    close.addEventListener("click", closeBrowse);
    head.appendChild(close);
    browseEl.appendChild(head);
    const list = el("div", "browse-list");
    list.appendChild(el("div", "browse-note", "Loading…"));
    browseEl.appendChild(list);
    return list;
  }
  function closeBrowse() { browseEl.hidden = true; browseEl.innerHTML = ""; browseToken++; }
  function openSavedWords() {
    browseEl.hidden = false; browseEl.innerHTML = "";
    const head = el("div", "browse-head");
    head.appendChild(el("div", "browse-title", "Saved words"));
    const close = el("button", "browse-close", "✕"); close.type = "button";
    close.addEventListener("click", closeBrowse);
    head.appendChild(close);
    browseEl.appendChild(head);
    const list = el("div", "browse-list");
    const words = getSaved();
    if (!words.length) {
      list.appendChild(el("div", "browse-empty", "No saved words yet — tap the star on a word card to save it."));
    } else {
      words.forEach(function (w) {
        const b = el("button", "browse-word", w); b.type = "button";
        b.addEventListener("click", function () { closeBrowse(); run(w); });
        list.appendChild(b);
      });
    }
    browseEl.appendChild(list);
  }
  async function browseLetter(letter) {
    const L = letter.toUpperCase(), lc = letter.toLowerCase();
    const token = ++browseToken;
    const list = openBrowse(L);
    const cap = 600;
    const words = [];
    const seconds = "abcdefghijklmnopqrstuvwxyz".split("");
    for (let i = 0; i < seconds.length; i++) {
      if (words.length >= cap) break;
      const sh = await fetchShard(lc + seconds[i]);
      if (token !== browseToken) return;
      // only list words we actually know (definition or etymology)
      if (sh) for (const w in sh) { const r = sh[w]; if (r && ((r.d && r.d.length) || r.e)) words.push(w); }
    }
    if (token !== browseToken) return;
    words.sort();
    list.innerHTML = "";
    if (!words.length) { list.appendChild(el("div", "browse-empty", "No words found for " + L + ".")); return; }
    const show = words.slice(0, cap);
    show.forEach(function (w) {
      const b = el("button", "browse-word", w); b.type = "button";
      b.addEventListener("click", function () { closeBrowse(); run(w); });
      list.appendChild(b);
    });
    if (words.length > cap) list.appendChild(el("div", "browse-note", "Showing the first " + cap + " of " + words.length + " words."));
  }

  // ---------- (retired) word-family tree ----------
  // The separate family-tree screen was retired: the map is the family tree.
  // Morpheme tiles now fly to their node instead. Stubs keep old call sites safe.
  let treeReturn = false, openingFromTree = false, treeRoot = null;
  function closeTree() { if (treeEl) { treeEl.hidden = true; treeEl.innerHTML = ""; } }
  function returnToTree() {}

  // Curated collections (family/collections.json) — sets of words that belong
  // together by convention rather than morphology, e.g. Latin abbreviations
  // (cf., e.g., i.e., et al.). Indexed word -> [collectionId] so a card can show
  // a tag and open the rest of the set.
  let collPromise = null;
  function loadCollections() {
    if (collPromise) return collPromise;
    collPromise = fetch("family/collections.json?v=" + DATA_V)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        // byWord: abbreviation → [collectionId]
        // byParent: parent English word → [{member, collId}]
        const byWord = {}, byParent = {};
        Object.keys(data || {}).forEach(function (id) {
          (data[id].members || []).forEach(function (m) {
            (byWord[m.w] = byWord[m.w] || []).push(id);
            if (m.parent) (byParent[m.parent] = byParent[m.parent] || []).push({ m: m, id: id });
          });
        });
        return { defs: data || {}, byWord: byWord, byParent: byParent };
      }).catch(function () { return { defs: {}, byWord: {}, byParent: {} }; });
    return collPromise;
  }

  // Build a mini inline usage chart for an abbreviation, shown within its parent card.
  function buildAbbrUsageSlot(abbr) {
    const slot = el("div", "abbr-usage");
    slot.hidden = true;
    getUsage(abbr).then(function (series) {
      if (!series || !series.length || !series.some(function (v) { return v > 0; })) return;
      let peak = 0;
      for (let i = 1; i < series.length; i++) if (series[i] > series[peak]) peak = i;
      const bars = el("div", "usage-bars abbr-bars");
      series.forEach(function (v, i) {
        const col = el("div", "usage-col" + (i === peak ? " peak" : ""));
        const bar = el("div", "usage-bar");
        bar.style.height = Math.max(2, v) + "%";
        col.appendChild(bar); bars.appendChild(col);
      });
      slot.appendChild(bars);
      slot.appendChild(el("div", "usage-note", "Peak: " + (1500 + peak * 25) + "s"));
    });
    return slot;
  }

  // "Abbreviated as" card: on a parent word's page, show inline expandable entries
  // for any abbreviations that abbreviate this word. Each row expands to show its
  // usage history inline rather than navigating to a separate page.
  async function buildAbbrCard(word, token) {
    const col = await loadCollections();
    if (token !== runToken) return null;
    const entries = col.byParent[word]; if (!entries || !entries.length) return null;
    const card = el("div", "card coll-card");
    card.appendChild(el("div", "cap", "Abbreviated as"));
    const list = el("div", "coll-list");
    entries.forEach(function (e, i) {
      const m = e.m;
      const row = el("div", "coll-item abbr-row"); // not a button: has internal expand
      row.style.setProperty("--i", i);
      const head = el("button", "abbr-head"); head.type = "button";
      head.appendChild(el("span", "coll-w", m.w));
      const desc = m.latin ? (m.latin + (m.sense ? " — " + m.sense : "")) : (m.sense || "");
      head.appendChild(el("span", "coll-g", desc));
      head.appendChild(el("span", "abbr-chevron", "›"));
      const usage = buildAbbrUsageSlot(m.w);
      let open = false;
      head.addEventListener("click", function () {
        open = !open; usage.hidden = !open;
        head.querySelector(".abbr-chevron").style.transform = open ? "rotate(90deg)" : "";
      });
      row.appendChild(head); row.appendChild(usage);
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
  }

  // "Latin abbreviation" tag: for abbreviations that have no parent (i.e. they are
  // standalone entries, not redirected) show a tag + the full set collapsible.
  async function buildCollectionCard(word, token) {
    const col = await loadCollections();
    if (token !== runToken) return null;
    const ids = col.byWord[word]; if (!ids || !ids.length) return null;
    const id = ids[0]; const def = col.defs[id]; if (!def) return null;
    // If this member has a parent, its page is the parent — show nothing here.
    const member = (def.members || []).find(function (m) { return m.w === word; });
    if (member && member.parent) return null;
    const card = el("div", "card coll-card");
    const tag = el("button", "coll-tag", def.label); tag.type = "button";
    const sub = el("div", "coll-sub", def.gloss || "");
    const list = el("div", "coll-list"); list.hidden = true;
    (def.members || []).forEach(function (m, i) {
      if (m.w === word) return;
      const row = el("button", "coll-item"); row.type = "button";
      row.style.setProperty("--i", i);
      row.appendChild(el("span", "coll-w", m.w));
      row.appendChild(el("span", "coll-g", m.latin ? (m.latin + (m.sense ? " — " + m.sense : "")) : (m.sense || "")));
      row.addEventListener("click", function () { run(m.w); });
      list.appendChild(row);
    });
    tag.addEventListener("click", function () {
      const show = list.hidden; list.hidden = !show; tag.classList.toggle("open", show);
    });
    card.appendChild(tag); card.appendChild(sub); card.appendChild(list);
    return card;
  }
  // ---------- typeahead ----------
  let suggestToken = 0;
  function hideSuggest() {
    suggestToken++; // a fetch still in flight must not reopen the list after a search
    suggestEl.hidden = true; suggestEl.innerHTML = "";
    if (window.RootMap && RootMap.ping) RootMap.ping(-1);
    if (window.RootMap && RootMap.setMarks) RootMap.setMarks(null);
    const qc = $("qCap"); if (qc) qc.textContent = "";
  }
  function onType() {
    const v = input.value.trim().toLowerCase();
    if (!v) { hideSuggest(); showRecent(); return; } // empty bar → recent words
    hideRecent();
    const key = v.slice(0, 2);
    if (v.length < 2 || !/^[a-z]{2}$/.test(key)) { hideSuggest(); return; }
    const token = ++suggestToken;
    // Suggestions render as soon as the (small) shard arrives — they are NOT
    // blocked on roots.json (≈1 MB). Latin/Greek source words are folded in only
    // if ROOTS is already warm (prefetched in the background after load); the
    // first keystroke still shows headword suggestions instantly.
    fetchShard(key).then(function (sh) {
      if (token !== suggestToken || !sh) return;
      if (input.value.trim().toLowerCase() !== v) return;
      // English headwords we have a definition for…
      const seen = {};
      const items = Object.keys(sh)
        .filter(function (w) { return w.indexOf(v) === 0 && w !== v && sh[w] && sh[w].d && sh[w].d.length; })
        .sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
        .slice(0, 8)
        .map(function (w) { seen[w] = 1; return { w: w }; });
      // …plus a few Latin/Greek source words (searchable by romanization).
      if (ROOTS) {
        Object.keys(ROOTS)
          .filter(function (k) { return k.indexOf(v) === 0 && !seen[k]; })
          .sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
          .slice(0, 4)
          .forEach(function (k) { items.push({ w: k, lang: ROOTS[k].lang }); });
      }
      renderSuggest(items, v);
    });
  }
  function renderSuggest(items, q) {
    suggestEl.innerHTML = "";
    if (!items.length) { hideSuggest(); return; }
    items.forEach(function (it) {
      const w = it.w;
      const li = document.createElement("li");
      const b = el("button", "suggest-item"); b.type = "button";
      let html = '<span class="hl">' + escapeHtml(w.slice(0, q.length)) + "</span>" + escapeHtml(w.slice(q.length));
      if (it.lang) html += '<span class="sug-lang">' + escapeHtml(it.lang) + "</span>";
      b.innerHTML = html;
      // where it lives on the map: its family's colour (and a pulse for the top one)
      const mi = window.RootMap && RootMap.loaded() ? RootMap.find(w) : -1;
      if (mi >= 0) {
        const inf = RootMap.info(mi);
        let r = mi, n = 0; while (RootMap.info(r).parent >= 0 && n++ < 40) r = RootMap.info(r).parent;
        const root = RootMap.info(r);
        const dot = el("span", "sug-dot"); dot.style.background = RootMap.colorOf(root.fam);
        dot.title = root.family;
        b.insertBefore(dot, b.firstChild);
        b.addEventListener("pointerenter", function () { RootMap.ping(mi); });
        b.addEventListener("focus", function () { RootMap.ping(mi); });
      }
      // pointerdown fires before the input's blur-hide, so the tap always lands
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); hideSuggest(); run(w); });
      b.addEventListener("click", function () { hideSuggest(); run(w); });
      li.appendChild(b);
      suggestEl.appendChild(li);
    });
    suggestEl.hidden = false;
    if (typeof noteMatches === "function") noteMatches(items.map(function (it) { return it.w; }));
  }

  // ---------- events ----------
  function submit() { input.blur(); hideSuggest(); if (appShell && appShell.dataset) appShell.dataset.dock = "compact"; run(input.value); }
  form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  form.querySelector(".search-btn").addEventListener("click", function (e) {
    e.preventDefault();
    // over a card the search is a circle: the first tap opens the bar
    if (appShell && appShell.dataset && appShell.dataset.dock === "compact") { appShell.dataset.dock = "open"; input.value = ""; input.focus(); return; }
    submit();
  });
  // While focused (typing), fold the ⌂ ‹ › nav buttons away so the search bar
  // expands to the full dock width; restore them on blur.
  const dockRow = document.querySelector(".dock-row");
  function setTyping(on) { if (dockRow && dockRow.classList) dockRow.classList[on ? "add" : "remove"]("typing"); }
  input.addEventListener("input", onType);
  input.addEventListener("focus", function () { setTyping(true); if (!input.value.trim()) showRecent(); });
  input.addEventListener("blur", function () { setTimeout(function () {
    setTyping(false); hideSuggest(); hideRecent();
    // fold back into a circle if a card is up
    if (appShell && appShell.dataset && appShell.dataset.dock === "open") appShell.dataset.dock = "compact";
    const qs = $("qShow"); if (qs) qs.textContent = "";
  }, 150); });
  if (navHome) navHome.addEventListener("click", function () { stepOut(); });
  if (navBack) navBack.addEventListener("click", goBack);
  if (navFwd) navFwd.addEventListener("click", goFwd);
  document.querySelectorAll(".example").forEach(function (btn) {
    btn.addEventListener("click", function () { run(btn.dataset.word); });
  });
  // Home chips: a curated pool of words that decompose beautifully — the
  // first-tap demo. Rendered SYNCHRONOUSLY (no quiz-pool fetch) so there's no
  // async swap/flash on load, and every word is hand-picked, so no taxonomic
  // or nonce discovery words ("bombus", "gallinula", "verbify") slip in. Six
  // are drawn at random each home visit for variety.
  const SHOWCASE = [
    "biography", "incredible", "democracy", "prescription", "philosophy",
    "microscope", "circumnavigate", "photosynthesis", "manuscript", "telephone",
    "geography", "autograph", "chronology", "benevolent", "transcribe",
    "hypothesis", "metamorphosis", "symbiosis", "chlorophyll", "thermometer",
    "astronaut", "bibliography", "contradict", "malevolent", "omnivore",
    "subterranean", "telegram", "verdict", "peninsula", "constellation",
    "dinosaur", "encyclopedia", "hippopotamus", "paragraph", "sympathy"];
  function renderHomeChips() {
    const chipsEl = document.querySelector(".chips");
    if (!chipsEl) return; // (home no longer shows starter words: it opens somewhere on the map)
    const words = qShuffle(SHOWCASE).slice(0, 6);
    chipsEl.innerHTML = "";
    words.forEach(function (w) {
      const b = el("button", "example", w);
      b.type = "button"; b.dataset.word = w;
      b.addEventListener("click", function () { run(w); });
      chipsEl.appendChild(b);
    });
  }
  // deferred to a microtask: getEraPool() below closes over `eraPoolPromise`,
  // a `let` declared further down this same scope — calling it synchronously
  // up here hits the temporal dead zone before that line has run.
  setTimeout(renderHomeChips, 0);

  buildAlpha();
  loadData();
  renderHistory();
  updateNav();

  // Warm roots.json (≈1 MB) in the background once the page is idle, so source-
  // word lookups and root suggestions are ready without ever blocking first
  // paint or the first keystroke. Skipped where requestIdleCallback is absent
  // (e.g. the test harness); there roots load lazily on a non-headword search.
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(function () { loadRoots(); }, { timeout: 5000 });
  }

  // A short word page (one sense, no extra cards) can fit entirely within the
  // viewport — nothing to scroll to. The bottom fade mask on .content (see
  // styles.css) doesn't know that, and fades the last 96px of whatever IS
  // there regardless, making a fully-visible last card look cut off. Cards
  // load in asynchronously over time, so recompute on every mutation. Uses
  // setTimeout rather than requestAnimationFrame — rAF is suspended entirely
  // while the page/tab isn't visible (e.g. backgrounded mid-load), which
  // would leave this never resolving; a plain timeout still fires.
  if (contentEl && typeof MutationObserver === "function") {
    let fitSyncScheduled = false;
    const syncContentFit = function () {
      // Comparing scrollHeight to clientHeight can't answer the real question
      // here: the dock floats as an absolutely-positioned overlay, so
      // .content's own box already extends "underneath" it, and padding-
      // bottom only ever affects the SCROLLABLE range (relevant once you
      // scroll), never where content initially renders at rest. A short page
      // can therefore have its last card's bottom edge sitting geometrically
      // behind the dock's fixed on-screen position even though scrollHeight
      // barely exceeds clientHeight — measure the actual overlap instead.
      const dock = document.querySelector(".dock");
      const lastEl = (cardsEl && cardsEl.lastElementChild) || entryEl;
      if (!dock || !lastEl) { contentEl.classList.remove("no-overflow"); return; }
      const overflows = lastEl.getBoundingClientRect().bottom > dock.getBoundingClientRect().top - 12;
      contentEl.classList.toggle("no-overflow", !overflows);
    };
    const scheduleFitSync = function () {
      if (fitSyncScheduled) return;
      fitSyncScheduled = true;
      setTimeout(function () {
        fitSyncScheduled = false;
        syncContentFit();
        // DOM mutations (cards being appended) settle almost immediately, but
        // card entrance transitions and web-font swaps can still shift layout
        // a beat later without firing another mutation — recheck a couple more
        // times to catch that instead of getting stuck on a transient reading.
        setTimeout(syncContentFit, 300);
        setTimeout(syncContentFit, 1000);
      }, 0);
    };
    new MutationObserver(scheduleFitSync).observe(contentEl, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleFitSync);
    scheduleFitSync();
  }

  // Pin the word to the top: the compact header is a non-layout overlay toggled
  // purely from scroll position (with hysteresis), so it can't feed back into
  // the layout and flicker the way an IntersectionObserver did.
  const dockEl = document.querySelector(".dock");
  if (contentEl && typeof contentEl.addEventListener === "function") {
    let miniShown = false;
    let lastScrollY = 0, dockHidden = false;
    contentEl.addEventListener("scroll", function () {
      const y = contentEl.scrollTop || 0;
      if (currentWord && !miniShown && y > 72) { miniHead.classList.add("show"); miniShown = true; }
      else if (miniShown && (!currentWord || y < 40)) { miniHead.classList.remove("show"); miniShown = false; }

      // on a word card, the dock tucks away while scrolling down to give the
      // entry more room, and slides back the moment the user scrolls up.
      if (dockEl) {
        if (!currentWord) {
          if (dockHidden) { dockEl.classList.remove("dock-hide"); contentEl.classList.remove("dock-hidden"); dockHidden = false; }
        } else {
          const maxScroll = contentEl.scrollHeight - contentEl.clientHeight;
          const nearBottom = maxScroll - y < 40;
          const delta = y - lastScrollY;
          // small bounce/jitter (momentum scrolling, rubber-banding) shouldn't
          // toggle the dock; only react once the scroll has moved a real amount.
          if (y < 24 || nearBottom || delta < -6) {
            if (dockHidden) { dockEl.classList.remove("dock-hide"); contentEl.classList.remove("dock-hidden"); dockHidden = false; }
          } else if (delta > 6) {
            // the bottom fade mask exists to blend content into the dock; with
            // the dock tucked away there's nothing to blend into, so drop it too.
            if (!dockHidden) { dockEl.classList.add("dock-hide"); contentEl.classList.add("dock-hidden"); dockHidden = true; }
          }
        }
      }
      lastScrollY = y;
    });
  }

  // deferred so the whole controller (incl. the map section below) is set up first
  const m = location.hash.match(/word=([^&]+)/);
  if (m) setTimeout(function () { run(decodeURIComponent(m[1])); }, 0);

  // ---------- the map (graph.js): the app is the map; an entry is one point on it ----------
  var holdSheetUntil = 0;
  var sheetState = "home"; // var: run() may fire (from a #word= link) before this section executes
  var appShell = document.querySelector(".app");
  const mapEl = $("map");
  const sheetGrip = $("sheetGrip");
  const MAP_TOP = 72; // the top bar, kept clear when framing a node
  let lensName = "descent";
  let mapWord = null;

  function sheetHeight(st) {
    const H = window.innerHeight || 800;
    if (st === "hidden") return 0;
    if (st === "home") return 132;
    if (st === "mini") return 236;
    if (st === "callout") return 0;
    if (st === "peek") return Math.round(H * 0.5);
    return Math.round(H * 0.93);
  }
  function setSheet(st) {
    sheetState = st;
    if (appShell && appShell.dataset) appShell.dataset.sheet = st;
    const h = sheetHeight(st);
    if (contentEl && contentEl.style && contentEl.style.setProperty) contentEl.style.setProperty("--sheet-h", h + "px");
    // the card sits at the bottom: frame the dot in the space above it
    const cardH = calloutEl && !calloutEl.hidden ? calloutEl.offsetHeight : 260;
    const bottomInset = st === "full" ? 0 : st === "callout" ? cardH + 24 : h;
    // the dock is a full search bar only on the open map; over any card it folds into circles
    if (appShell && appShell.dataset && appShell.dataset.dock !== "open") appShell.dataset.dock = "compact";
    if (window.RootMap && RootMap.setInsets) RootMap.setInsets({ top: MAP_TOP, bottom: bottomInset });
    if (calloutEl) {
      const show = st === "callout" && calloutFor >= 0;
      calloutEl.hidden = !show;
      if (show) {
        placeCallout();
        if (window.RootMap && RootMap.setInsets) RootMap.setInsets({ top: MAP_TOP, bottom: calloutEl.offsetHeight + 24 });
      }
      // the planisphere's window sits above whatever is open below it: the card, or the turned-over sheet
      if (typeof placePlate === "function") {
        if (show) placePlate(calloutEl.offsetHeight || 300);
        else if (st === "peek" || st === "mini") placePlate(h - 30);
        else if (st !== "callout" && st !== "hidden" && window.RootMap && RootMap.setPlate) RootMap.setPlate(null);
      }
    }
  }
  setSheet(currentWord ? "peek" : "home");
  if (typeof window.addEventListener === "function") window.addEventListener("resize", function () { setSheet(sheetState); });

  // grip: tap toggles half ↔ full; drag snaps to the nearest of small / half / full
  if (sheetGrip && typeof sheetGrip.addEventListener === "function") {
    let y0 = null, h0 = 0, moved = false;
    sheetGrip.addEventListener("pointerdown", function (e) {
      y0 = e.clientY; h0 = contentEl.getBoundingClientRect().height; moved = false;
      try { sheetGrip.setPointerCapture(e.pointerId); } catch (err) {}
      contentEl.style.transition = "none";
    });
    sheetGrip.addEventListener("pointermove", function (e) {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 4) moved = true;
      contentEl.style.setProperty("--sheet-h", Math.max(90, Math.min(window.innerHeight * 0.95, h0 - dy)) + "px");
    });
    const end = function () {
      if (y0 == null) return;
      contentEl.style.transition = "";
      const h = contentEl.getBoundingClientRect().height;
      y0 = null;
      if (!moved) { setSheet(sheetState === "full" ? "peek" : "full"); return; }
      if (h < sheetHeight("mini") * 0.8 && calloutFor >= 0) { setSheet("callout"); return; }
      let best = "mini", bd = Infinity;
      ["mini", "peek", "full"].forEach(function (st) { const d = Math.abs(sheetHeight(st) - h); if (d < bd) { bd = d; best = st; } });
      setSheet(best);
    };
    sheetGrip.addEventListener("pointerup", end);
    sheetGrip.addEventListener("pointercancel", end);
  }
  // reading on: scrolling the half sheet opens it fully; a small sheet opens on tap
  if (contentEl && typeof contentEl.addEventListener === "function") {
    contentEl.addEventListener("scroll", function () {
      if (sheetState === "peek" && contentEl.scrollTop > 40 && Date.now() > holdSheetUntil && !document.querySelector(".app.quiz-peek")) setSheet("full");
    });
    contentEl.addEventListener("click", function (e) {
      if (sheetState === "mini" && !e.target.closest("button")) setSheet("peek");
    });
  }

  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; }
  function inkRgb() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (document.documentElement.getAttribute("data-theme") !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    return dark ? [0.96, 0.9, 0.78] : [0.25, 0.18, 0.08];
  }
  function langEra(l) { return (LANGS[l] && LANGS[l].era) || ""; }

  function onMapTap(i) {
    const inf = RootMap.info(i);
    if (!inf) return;
    if (inf.isWord) run(inf.label); else run("@" + i);
  }
  if (mapEl && window.RootMap && typeof mapEl.appendChild === "function") {
    RootMap.init(mapEl, { onTap: onMapTap, onDraw: function () { onMapDraw(); }, onInteract: function (on) { exploring(on); } });
    RootMap.ready.then(function () { setSheet(sheetState); applyLens(); });
  }

  // Before an entry opens, the sheet drops out of the way and the map flies
  // from wherever it was to the word; the entry rises once the camera lands.
  function mapCanFly(word) { return !!(window.RootMap && RootMap.loaded() && RootMap.find(word) >= 0); }
  function lowerForFlight() {
    sheetState = "hidden";
    if (appShell && appShell.dataset) appShell.dataset.sheet = "hidden";
    if (window.RootMap) RootMap.setInsets({ top: MAP_TOP, bottom: sheetHeight("peek") }); // frame for where the sheet will be
    if (nextSheet === "callout" || !nextSheet) placePlate(300); // the planisphere's window, for the flight to frame
  }
  // this session's walk across the map, drawn as a faint trail
  const walk = [];
  function noteWalk(i) {
    if (i < 0 || walk[walk.length - 1] === i) return;
    walk.push(i);
    if (walk.length > 60) walk.shift();
    if (RootMap.setTrail) RootMap.setTrail(walk);
  }
  function mapShow(word, retrace) {
    mapWord = word;
    if (!window.RootMap) return Promise.resolve();
    const flight = RootMap.ready.then(function () {
      if (mapWord !== word) return;
      const i = RootMap.find(word);
      if (i < 0) { RootMap.clearFocus(); return; }
      noteWalk(i);
      // back/forward fly straight back along your walk; new searches trace the lineage
      const f = (retrace ? RootMap.focus(i, { fly: true, dur: 900 }) : RootMap.trace(i)).then(function () { if (mapWord === word) applyLens(); });
      return f;
    });
    // never hold an entry hostage to a slow first load or a long flight
    return Promise.race([flight, new Promise(function (r) { setTimeout(r, 4200); })]);
  }

  // ---- the callout: arriving at a point shows its card pinned to the dot;
  // tapping it, or pinching in on the dot, opens the full entry ----
  var calloutEl = $("callout");
  var calloutFor = -1;
  var arrivalScale = 0;
  const leaderLine = $("leaderLine"), leaderDot = $("leaderDot");
  function placeCallout() {
    if (!calloutEl || calloutEl.hidden || calloutFor < 0 || !window.RootMap || !leaderLine) return;
    const p = RootMap.screenOf(calloutFor);
    if (!p) return;
    const top = (window.innerHeight || 800) - calloutEl.offsetHeight;
    const r = calloutEl.getBoundingClientRect();
    const x2 = Math.max(r.left + 24, Math.min(r.right - 24, p[0]));
    const vis = p[1] < top - 14 && p[1] > MAP_TOP - 10 && p[0] > -10 && p[0] < (window.innerWidth || 400) + 10;
    leaderLine.setAttribute("x1", p[0]); leaderLine.setAttribute("y1", p[1] + 10);
    leaderLine.setAttribute("x2", x2); leaderLine.setAttribute("y2", top);
    leaderDot.setAttribute("cx", x2); leaderDot.setAttribute("cy", top);
    leaderLine.style.display = leaderDot.style.display = vis ? "" : "none";
  }
  function calloutChain(i) {
    let chain = [i].concat(RootMap.lineage(i)).slice(0, 7).reverse();
    // the same spelling at successive stages (Old French hostel → Middle English
    // hostel → hostel) reads as a stutter; keep the oldest of a run, plus the word itself
    chain = chain.filter(function (c, k) {
      if (k === chain.length - 1 || k === 0) return true;
      return RootMap.info(c).label.toLowerCase() !== RootMap.info(chain[k - 1]).label.toLowerCase();
    });
    if (chain.length > 1 && RootMap.info(chain[chain.length - 2]).label.toLowerCase() === RootMap.info(i).label.toLowerCase()) chain.splice(chain.length - 2, 1);
    if (chain.length < 2) return null;
    const box = el("div", "co-chain");
    chain.forEach(function (c, k) {
      if (k) box.appendChild(el("span", "arr", "→"));
      const inf = RootMap.info(c);
      const t = el(inf.isWord && k === chain.length - 1 ? "b" : "i", null, inf.label);
      t.style.color = inf.isWord && k === chain.length - 1 ? "" : RootMap.colorOf(inf.fam);
      if (t.style.setProperty) t.style.setProperty("--fam", RootMap.colorOf(inf.fam));
      t.title = inf.lang;
      box.appendChild(t);
    });
    return box;
  }
  function calloutActs(i, d, lensable) {
    const acts = el("div", "co-acts");
    const read = el("button", "co-act primary", lookUI().open); read.type = "button";
    read.addEventListener("click", function (e) { e.stopPropagation(); setSheet("peek"); });
    acts.appendChild(read);
    if (lookName === "netscape" && lensable && currentWord) {
      const bm = el("button", "co-act", isSaved(currentWord) ? "Bookmarked" : "Add Bookmark"); bm.type = "button";
      bm.addEventListener("click", function (e) { e.stopPropagation(); toggleSaved(currentWord); bm.textContent = isSaved(currentWord) ? "Bookmarked" : "Add Bookmark"; });
      acts.appendChild(bm);
    }
    if (lensable && d && d.dbl && d.dbl.length) {
      const b = el("button", "co-act", d.dbl.length + (d.dbl.length > 1 ? " doublets" : " doublet")); b.type = "button";
      b.addEventListener("click", function (e) { e.stopPropagation(); const lb = document.querySelector('.lens-btn[data-lens="doublets"]'); if (lb) lb.click(); });
      acts.appendChild(b);
    }
    return acts;
  }
  function openCallout(i, nodes) {
    calloutFor = i;
    calloutEl.innerHTML = "";
    calloutEl.appendChild(el("span", "callout-tip"));
    nodes.forEach(function (n) { if (n) calloutEl.appendChild(n); });

    arrivalScale = window.RootMap ? RootMap.scale() : 0;
  }
  async function showWordCallout(word, rec) {
    if (!calloutEl || !window.RootMap) return;
    const i = RootMap.find(word);
    if (i < 0) { calloutFor = -1; return; }
    lastRec = rec;
    const d = await RootMap.details(i);
    const coords = el("div", "co-coords");
    wordCoords(word, rec).forEach(function (b, k) {
      if (k) coords.appendChild(el("span", "ec-sep", "·"));
      const sp = el("span", "ec-bit", b.t);
      if (b.fam != null) { const dot = el("i", "ec-dot"); dot.style.background = RootMap.colorOf(b.fam); sp.insertBefore(dot, sp.firstChild); }
      coords.appendChild(sp);
    });
    const head = el("div", "co-head");
    const cw = el("span", "co-word", word);
    head.appendChild(cw);
    const p0 = rec && rec.d && rec.d[0];
    if (p0 && p0.p) head.appendChild(el("span", "co-pos", p0.p));
    const def = p0 ? el("div", "co-def", p0.g) : null;
    openCallout(i, [coords, head, def, calloutChain(i), calloutActs(i, d, true)]);
    fitLine(cw, 30, 20);
    if (sheetState === "callout") setSheet("callout");
  }
  function showNodeCallout(i, d) {
    if (!calloutEl) return;
    const inf = RootMap.info(i);
    const lang = el("div", "co-lang", inf.lang);
    const head = el("div", "co-head");
    head.appendChild(el("span", "co-word anc", inf.label));
    const def = d.g ? el("div", "co-def", "“" + d.g + "”") : null;
    const en = d.ne ? el("div", "co-rs", d.ne + " English word" + (d.ne === 1 ? "" : "s") + " come from this form") : null;
    openCallout(i, [lang, head, def, en, calloutChain(i), calloutActs(i, d, false)]);
  }
  if (calloutEl && typeof calloutEl.addEventListener === "function") {
    calloutEl.addEventListener("click", function () { setSheet("peek"); });
  }
  // zooming is reading: pinch in on the dot you're standing on and the entry opens;
  // pinch back out and it folds back into the callout
  function onMapDraw() {
    placeCallout();
    if (!window.RootMap || RootMap.moving() || calloutFor < 0 || !arrivalScale) return;
    const s = RootMap.scale();
    if (sheetState === "callout" && s > arrivalScale * 1.9) { setSheet("peek"); arrivalScale = s; }
    else if (sheetState === "peek" && s < arrivalScale * 0.55) { setSheet("callout"); arrivalScale = s * 1.2; }
  }

  // ---- arriving somewhere: launch and "Somewhere else" open a random common
  // word with a real lineage, in a small sheet so the map stays the scene ----
  var nextSheet = null;
  var arrivedFrom = null;
  function takeNextSheet() { const s = nextSheet || "callout"; nextSheet = null; return s; }
  let lastStart = -1;
  function randomStart() {
    if (!window.RootMap) return;
    RootMap.ready.then(function () {
      const pool = RootMap.starts();
      if (!pool.length) return;
      let i = pool[Math.floor(Math.random() * pool.length)];
      if (i === lastStart && pool.length > 1) i = pool[(pool.indexOf(i) + 1) % pool.length];
      lastStart = i;
      nextSheet = "callout";
      run(RootMap.info(i).label);
    });
  }
  const randomBtn = $("randomBtn");
  if (randomBtn && typeof randomBtn.addEventListener === "function") randomBtn.addEventListener("click", randomStart);
  if (window.RootMap && !/word=/.test(location.hash || "") && typeof mapEl.appendChild === "function") {
    // first open: a beat on the whole map, then fly somewhere real
    RootMap.ready.then(function () { setTimeout(function () { if (!currentWord && !mapWord) randomStart(); }, 900); });
  }


  // ---------- looks: five interfaces, each traced to one real source ----------
  // The map side of each look lives in graph.js (RootMap.setLook); this is the chrome:
  // the orb, its action panel, the words each source would use, search, and the plate.
  var LOOK_UI = {
    priestley: { name: "Priestley", sub: "A New Chart of History, 1769", theme: "light", meta: "#f1e8d3", open: "The description",
      head: "Explanation", acts: [["Search", "Search the index", "find a word"], ["Wander", "Wander", "a neighbour"], ["Step out", "Step out", "the family"], ["Back", "Back", "the last word"], ["Menu", "Contents", "and settings"]],
      found: function (n, m) { return "An index of " + n + " name" + (n === 1 ? "" : "s") + " · " + m + " upon this chart"; }, q: function (t) { return t.toUpperCase(); } },
    ortelius: { name: "Ortelius", sub: "Typus Orbis Terrarum, 1570", theme: "light", meta: "#ecdfbf", open: "Read the text",
      acts: [["Search", "Search"], ["Wander", "Wander"], ["Step out", "Step out"], ["Back", "Back"], ["Menu", "Contents"]],
      found: function (n, m) { return n + " place" + (n === 1 ? "" : "s") + " so called; " + m + " upon this land"; }, q: function (t) { return t.toUpperCase().replace(/U/g, "V"); } },
    blueprint: { name: "Blueprint", sub: "Clydebank shipyard, 1930s", theme: "dark", meta: "#14457f", open: "Open drawing →",
      acts: [["Search", "Search", "S"], ["Wander", "Wander", "W"], ["Step out", "Step out", "O"], ["Back", "Back", "B"], ["Menu", "Menu", "C"]],
      found: function (n, m) { return "Found " + n + " · " + m + " on this sheet"; }, q: function (t) { return t.toUpperCase(); } },
    planisphere: { name: "Planisphere", sub: "Philip's, 32 Fleet Street", theme: "dark", meta: "#1c2541", open: "Turn it over",
      acts: [["Search", "Search"], ["Wander", "Wander"], ["Step out", "Step out"], ["Back", "Back"], ["Menu", "Contents"]],
      found: function (n, m) { return n + " star" + (n === 1 ? "" : "s") + " of that name · " + m + " in the window"; }, q: function (t) { return t; } },
    netscape: { name: "Netscape", sub: "Navigator 1.1, 1995", theme: "light", meta: "#c0c0c0", open: "Open Entry",
      acts: [["Back", "Back"], ["Step out", "Home"], ["Search", "Find"], ["Wander", "What's Cool!"], ["Menu", "Options"]],
      found: function (n, m) { return n + " document" + (n === 1 ? "" : "s") + " found · " + m + " on this map"; }, q: function (t) { return t; } },
  };
  var LOOK_ORDER = ["priestley", "ortelius", "blueprint", "planisphere", "netscape"];
  var lookName = "planisphere";
  try { var storedLook = localStorage.getItem("rootwork.look"); if (LOOK_UI[storedLook]) lookName = storedLook; } catch (e) {}
  function lookUI() { return LOOK_UI[lookName]; }
  const orbEl = $("orb"), actsEl = $("acts"), nsMsg = $("nsMsg"), nsTitle = $("nsTitle"), noteBar = $("wanderNote");
  const qShow = $("qShow"), qCap = $("qCap");
  const ORB_ART = {
    priestley: '<span class="orb-hand">☞</span>',
    ortelius: '<svg viewBox="-2 -1 64 62" width="60" height="58" aria-hidden="true"><g class="orb-cloud">' +
      [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(function (a) { var t = a * Math.PI / 180; return '<circle cx="' + (30 + 25 * Math.cos(t)).toFixed(1) + '" cy="' + (30 + 19 * Math.sin(t)).toFixed(1) + '" r="6"/>'; }).join("") +
      '</g><ellipse class="orb-sea" cx="30" cy="30" rx="22" ry="16"/><path class="orb-land" d="M21 32 q4 -8 10 -4 t8 -2 q2 8 -6 10 t-12 -4z"/></svg>',
    blueprint: '<svg viewBox="0 0 56 56" width="58" height="58" aria-hidden="true"><circle cx="28" cy="28" r="25" class="bb"/><line x1="5" y1="28" x2="51" y2="28"/><text x="28" y="22" class="bt">A</text><text x="28" y="43" class="bn">5</text></svg>',
    planisphere: "",
    netscape: '<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"><rect width="44" height="44" fill="#000"/><path d="M4 8 L18 16" stroke="#fff"/><path d="M26 36 L40 30" stroke="#99ccff"/><rect x="17" y="15" width="2" height="2" fill="#fff"/><rect x="39" y="29" width="2" height="2" fill="#fff"/><text x="22" y="31" text-anchor="middle" font-family="Tinos, Times New Roman, serif" font-weight="700" font-size="24" fill="#fff">R</text><path d="M8 40 h28" stroke="#3399cc"/></svg>',
  };
  const NS_ICON = { Back: "M14 4 L6 11 L14 18 Z", Forward: "M8 4 L16 11 L8 18 Z", "Step out": "M3 11 L11 4 L19 11 M5 10 V19 H17 V10",
    Search: "M5 5 H13 V13 H5 Z M12 12 L18 18", Wander: "M11 2 L13 8 H19 L14 12 L16 18 L11 14 L6 18 L8 12 L3 8 H9 Z", Menu: "M4 6 H18 M4 11 H18 M4 16 H18" };
  function buildActs() {
    if (!actsEl) return;
    const ui = lookUI();
    actsEl.innerHTML = "";
    actsEl.className = "acts acts-" + lookName;
    if (ui.head) actsEl.appendChild(el("div", "acts-head", ui.head));
    ui.acts.forEach(function (a) {
      const b = el("button", "act"); b.type = "button"; b.dataset.act = a[0];
      if (lookName === "blueprint") b.innerHTML = '<span class="act-name">' + escapeHtml(a[1]) + '</span><svg viewBox="0 0 56 56" width="50" height="50" aria-hidden="true"><circle cx="28" cy="28" r="25" class="bb"/><line x1="5" y1="28" x2="51" y2="28"/><text x="28" y="22" class="bt">' + a[2] + '</text><text x="28" y="43" class="bn">' + (ui.acts.indexOf(a) + 1) + "</text></svg>";
      else if (lookName === "netscape") b.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22" shape-rendering="crispEdges" aria-hidden="true"><path d="' + NS_ICON[a[0]] + '"/></svg><span>' + escapeHtml(a[1]) + "</span>";
      else { b.appendChild(el("span", "act-name", a[1])); if (a[2]) b.appendChild(el("i", "act-note", a[2])); }
      actsEl.appendChild(b);
    });
  }
  function applyLook(name, save) {
    if (!LOOK_UI[name]) return;
    lookName = name;
    const ui = lookUI();
    document.documentElement.setAttribute("data-look", name);
    document.documentElement.setAttribute("data-theme", ui.theme);
    const tc = document.querySelector && document.querySelector('meta[name="theme-color"]');
    if (tc && tc.setAttribute) tc.setAttribute("content", ui.meta);
    if (orbEl) orbEl.innerHTML = ORB_ART[name];
    buildActs();
    if (window.RootMap && RootMap.setLook) RootMap.setLook(name);
    if (save) { try { localStorage.setItem("rootwork.look", name); } catch (e) {} }
    if (qShow) qShow.textContent = ui.q(input.value || "");
    if (qShow && qShow.dataset) qShow.dataset.ph = name === "blueprint" ? "" : name === "netscape" ? "" : "";
    if (typeof window.dispatchEvent === "function" && typeof Event === "function") window.dispatchEvent(new Event("resize")); // the map's frame differs by look
    if (calloutFor >= 0 && currentWord) showWordCallout(currentWord, lastRec);
    setSheet(sheetState);
  }
  var lastRec = null;

  // the orb: tap to open its panel, or press, slide to an action and let go
  function actsOpen(on) {
    if (!actsEl) return;
    actsEl.hidden = !on;
    if (orbEl && orbEl.classList) orbEl.classList.toggle("on", on);
    if (appShell && appShell.classList) appShell.classList.toggle("acts-open", on);
    if (on) say(lookName === "netscape" ? "" : null);
  }
  function doAct(name) {
    actsOpen(false);
    if (name === "Search") openSearch();
    else if (name === "Wander") wander();
    else if (name === "Step out") stepOut();
    else if (name === "Back") goBack();
    else if (name === "Menu") { const kb = $("mapKeyBtn"); if (kb) kb.click(); }
  }
  if (orbEl && typeof orbEl.addEventListener === "function") {
    let press = null;
    orbEl.addEventListener("pointerdown", function (e) {
      press = { x: e.clientX, y: e.clientY, was: actsEl && !actsEl.hidden, moved: false };
      try { orbEl.setPointerCapture(e.pointerId); } catch (err) {}
      if (!press.was) actsOpen(true);
    });
    orbEl.addEventListener("pointermove", function (e) {
      if (!press) return;
      if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 10) press.moved = true;
      const t = document.elementFromPoint(e.clientX, e.clientY), b = t && t.closest && t.closest(".act");
      actsEl.querySelectorAll(".act").forEach(function (x) { x.classList.toggle("hot", x === b); });
    });
    const up = function (e) {
      if (!press) return;
      const p = press; press = null;
      if (p.moved) {
        const t = document.elementFromPoint(e.clientX, e.clientY), b = t && t.closest && t.closest(".act");
        if (b) { doAct(b.dataset.act); return; }
        actsOpen(false); return;
      }
      if (p.was) actsOpen(false); // a tap on an open orb closes it
    };
    orbEl.addEventListener("pointerup", up);
    orbEl.addEventListener("pointercancel", function () { press = null; });
  }
  if (actsEl && typeof actsEl.addEventListener === "function") {
    actsEl.addEventListener("click", function (e) { const b = e.target.closest(".act"); if (b) doAct(b.dataset.act); });
    document.addEventListener("pointerdown", function (e) { if (!actsEl.hidden && !e.target.closest("#acts, #orb")) actsOpen(false); });
  }
  // a line of news in the look's own voice (Netscape's status bar; elsewhere a quiet banner)
  let sayT = 0;
  function say(msg) {
    if (lookName === "netscape") { if (nsMsg) nsMsg.textContent = msg || "Document: Done"; return; }
    if (!noteBar) return;
    clearTimeout(sayT);
    if (!msg) { noteBar.hidden = true; return; }
    noteBar.textContent = msg; noteBar.hidden = false;
    sayT = setTimeout(function () { noteBar.hidden = true; }, 4200);
  }

  // search: what you type is lettered in place, and the matches light up where they live
  function openSearch() {
    if (appShell && appShell.dataset) appShell.dataset.dock = "open";
    input.value = ""; if (qShow) qShow.textContent = ""; if (qCap) qCap.textContent = "";
    input.focus();
  }
  if (input && typeof input.addEventListener === "function") {
    input.addEventListener("input", function () { if (qShow) qShow.textContent = lookUI().q(input.value); if (!input.value && qCap) qCap.textContent = ""; });
  }
  function noteMatches(list) {
    if (!window.RootMap || !RootMap.loaded()) return;
    const idx = list.map(function (w) { return RootMap.find(w); }).filter(function (i) { return i >= 0; });
    RootMap.setMarks(idx);
    const Wd = window.innerWidth || 400, Hd = (window.innerHeight || 800) * 0.62;
    const inView = idx.filter(function (i) { const p = RootMap.screenOf(i); return p && p[0] > 0 && p[0] < Wd && p[1] > MAP_TOP && p[1] < Hd; }).length;
    if (qCap) qCap.textContent = list.length ? lookUI().found(list.length, inView) : "";
    if (lookName === "netscape" && nsMsg) nsMsg.textContent = list.length ? "rootwork://" + list[0] : "Document: Done";
  }

  // wander: one meaningful hop — a word that shares an ancestor with this one, and why
  function wander() {
    if (!window.RootMap || !RootMap.loaded() || !mapWord) { randomStart(); return; }
    const i = mapWord[0] === "@" ? Number(mapWord.slice(1)) : RootMap.find(mapWord);
    if (i < 0) { randomStart(); return; }
    const here = RootMap.info(i).label.toLowerCase();
    const anc = RootMap.lineage(i).slice(0, 4);
    for (let k = 0; k < anc.length; k++) {
      const seen = {}, pool = [];
      (function walk(n, depth) {
        RootMap.children(n).forEach(function (c) {
          if (seen[c]) return; seen[c] = 1;
          const inf = RootMap.info(c);
          if (inf.isWord && inf.label.toLowerCase() !== here && c !== i) pool.push(c);
          else if (depth < 2) walk(c, depth + 1);
        });
      })(anc[k], 0);
      if (pool.length) {
        const pick = pool[Math.floor(Math.random() * pool.length)], a = RootMap.info(anc[k]);
        const msg = RootMap.info(pick).label + " also comes from " + a.lang + " " + a.label;
        nextSheet = "callout";
        run(RootMap.info(pick).label);
        setTimeout(function () { say(lookName === "netscape" ? "What's Cool!: " + msg : msg); }, 400);
        return;
      }
    }
    randomStart();
  }

  // while you pan and pinch, everything that isn't the map steps aside
  var exploreT = 0;
  function exploring(on) {
    clearTimeout(exploreT);
    if (on) {
      if (appShell && appShell.classList) appShell.classList.add("exploring");
      actsOpen(false);
      if (window.RootMap && RootMap.showPlate) RootMap.showPlate(false);
    } else {
      exploreT = setTimeout(function () {
        if (appShell && appShell.classList) appShell.classList.remove("exploring");
        if (window.RootMap && RootMap.showPlate) RootMap.showPlate(/^(callout|peek|mini)$/.test(sheetState) && lookName === "planisphere");
      }, 900);
    }
  }

  // the planisphere's window sits between the top bar and the card
  function placePlate(cardH) {
    if (!window.RootMap || !RootMap.setPlate) return;
    if (lookName !== "planisphere") { RootMap.setPlate(null); return; }
    const Wd = window.innerWidth || 390, Hd = window.innerHeight || 800;
    const top = MAP_TOP + 24, bottom = Hd - cardH - 30;
    const ry = Math.max(80, (bottom - top) / 2), rx = Math.max(80, Math.min(Wd / 2 - 34, ry * 1.08));
    let sat = 0, sab = 0;
    try { const cs = getComputedStyle(document.documentElement); sat = parseFloat(cs.getPropertyValue("--sat")) || 0; sab = parseFloat(cs.getPropertyValue("--sab")) || 0; } catch (e) {}
    RootMap.setPlate({ x: Wd / 2, y: top + ry, rx: rx, ry: ry, top: sat, bottom: sab });
  }
  applyLook(lookName, false);

  // ---- the doublet hunt: one source reached English twice; find the other road ----
  // Played in the sheet with the map above it: answering flies the fork.
  let huntPoolP = null;
  const hunt = { streak: 0, best: 0, recent: [] };
  try { hunt.best = Number(localStorage.getItem("rootwork.huntBest")) || 0; } catch (e) {}
  function loadHunt() {
    if (!huntPoolP) huntPoolP = fetch("doublets.json?v=1").then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return huntPoolP;
  }
  async function openHunt() {
    if (!window.RootMap) return;
    const token = ++runToken;
    await RootMap.ready;
    const pool = (await loadHunt()).filter(function (p) { return RootMap.find(p[0]) >= 0 && RootMap.find(p[1]) >= 0; });
    const pairs = await loadDblPairs();
    if (token !== runToken || pool.length < 4) return;
    let pick = null;
    for (let tries = 0; tries < 30 && !pick; tries++) {
      const p = pool[Math.floor(Math.random() * Math.min(pool.length, 260))];
      if (hunt.recent.indexOf(p[0] + p[1]) < 0) pick = p;
    }
    pick = pick || pool[0];
    hunt.recent.push(pick[0] + pick[1]); if (hunt.recent.length > 40) hunt.recent.shift();
    const flip = Math.random() < 0.5;
    const prompt = flip ? pick[1] : pick[0], answer = flip ? pick[0] : pick[1];
    const pi = RootMap.find(prompt), ai = RootMap.find(answer);
    const pr = pairs.find(function (q) { return (q[0] === pi && q[1] === ai) || (q[0] === ai && q[1] === pi); });
    const via = pr && pr[2] >= 0 ? pr[2] : -1;
    // distractors: other hunt words, never the prompt's own doublets
    const own = new Set([prompt, answer]);
    pairs.forEach(function (q) { if (q[0] === pi) own.add(RootMap.info(q[1]).label); if (q[1] === pi) own.add(RootMap.info(q[0]).label); });
    // near-miss wrong answers: a cousin (same root, different word), a
    // sense-alike (a synonym), a look-alike (similar spelling)
    const opts = [answer];
    const why = {};
    const ok = function (w) { return w && !own.has(w) && opts.indexOf(w) < 0 && /^[a-z]{3,}$/.test(w) && RootMap.find(w) >= 0; };
    const anc = RootMap.lineage(pi).slice(0, 5);
    for (const a of anc) {
      const d = await RootMap.details(a);
      const c = (d.en || []).filter(ok);
      if (c.length) { const w = c[Math.floor(Math.random() * Math.min(c.length, 8))]; opts.push(w); why[w] = { kind: "cousin", via: a }; break; }
    }
    const prec = await getWord(prompt);
    const syn = ((prec && prec.s) || []).filter(ok);
    if (syn.length && opts.length < 4) { const w = syn[0]; opts.push(w); why[w] = { kind: "sense" }; }
    const sh = await fetchShard(prompt.slice(0, 2).toLowerCase());
    if (sh && opts.length < 4) {
      const stem = prompt.slice(0, 3).toLowerCase();
      const look = Object.keys(sh).filter(function (w) { return w.indexOf(stem) === 0 && Math.abs(w.length - prompt.length) <= 3 && sh[w].d && sh[w].d.length && ok(w); });
      if (look.length) { const w = look[Math.floor(Math.random() * Math.min(look.length, 12))]; opts.push(w); why[w] = { kind: "look" }; }
    }
    if (token !== runToken) return;
    // never claim "unrelated" for a word that shares an ancestor with the prompt
    const ancSet = new Set(RootMap.lineage(pi));
    Object.keys(why).forEach(function (w) {
      if (why[w].kind === "cousin") return;
      const hit = RootMap.lineage(RootMap.find(w)).find(function (x) { return ancSet.has(x); });
      if (hit != null) why[w] = { kind: "cousin", via: hit };
    });
    while (opts.length < 4) {
      const q = pool[Math.floor(Math.random() * pool.length)];
      const w = q[Math.random() < 0.5 ? 0 : 1];
      if (!own.has(w) && opts.indexOf(w) < 0) opts.push(w);
    }
    opts.sort(function () { return Math.random() - 0.5; });

    currentWord = ""; mapWord = null; input.value = ""; input.blur();
    hideSuggest(); hideRecent();
    if (!browseEl.hidden) closeBrowse();
    clearStage(); hint.hidden = true;
    lowerForFlight();
    await Promise.race([RootMap.focus(pi, { fly: true, dur: 1000 }), delay(1600)]);
    if (token !== runToken) return;
    setSheet("peek");
    const head = el("div", "node-head hunt-head");
    head.appendChild(el("div", "node-lang", "Doublet hunt" + (hunt.streak ? " · streak " + hunt.streak : "") + (hunt.best ? " · best " + hunt.best : "")));
    head.appendChild(el("div", "node-term hunt-word", prompt));
    head.appendChild(el("div", "node-gloss", "Which of these came from the same source, by a different road?"));
    entryEl.appendChild(head);
    requestAnimationFrame(function () { entryEl.classList.add("in"); });
    const card = el("div", "card in hunt-card");
    const grid = el("div", "hunt-opts");
    const out = el("div", "hunt-out");
    opts.forEach(function (w) {
      const b = el("button", "hunt-opt", w); b.type = "button";
      b.addEventListener("click", function () {
        if (grid.classList.contains("done")) return;
        grid.classList.add("done");
        const right = w === answer;
        grid.querySelectorAll(".hunt-opt").forEach(function (x) { if (x.textContent === answer) x.classList.add("right"); else if (x === b) x.classList.add("wrong"); });
        hunt.streak = right ? hunt.streak + 1 : 0;
        if (hunt.streak > hunt.best) { hunt.best = hunt.streak; try { localStorage.setItem("rootwork.huntBest", String(hunt.best)); } catch (e) {} }
        out.innerHTML = "";
        const line = el("div", "hunt-verdict");
        line.appendChild(el("b", null, right ? "Yes. " : "Not quite. "));
        line.appendChild(el("i", null, prompt)); line.appendChild(txtNode(" and "));
        line.appendChild(el("i", null, answer));
        if (via >= 0) {
          const vi = RootMap.info(via);
          line.appendChild(txtNode(" both come from " + vi.lang + " "));
          line.appendChild(el("i", null, vi.label));
          line.appendChild(txtNode(", by different routes."));
        } else line.appendChild(txtNode(" are doublets: one source, two arrivals."));
        out.appendChild(line);
        // what the trap was
        const trap = !right && why[w];
        if (trap) {
          const t = el("div", "lin-note");
          if (trap.kind === "cousin") {
            const vi = RootMap.info(trap.via);
            t.appendChild(el("i", null, w));
            t.appendChild(txtNode(" shares the root " + vi.lang + " "));
            t.appendChild(el("i", null, vi.label));
            t.appendChild(txtNode(", but it's a different word built on it: a cousin, not a doublet."));
          } else if (trap.kind === "sense") {
            t.appendChild(el("i", null, w));
            t.appendChild(txtNode(" means something close, but its history is its own: same sense, different lineage."));
          } else {
            t.appendChild(el("i", null, w));
            t.appendChild(txtNode(" only looks related: similar spelling, unrelated source."));
          }
          out.appendChild(t);
        }
        const acts = el("div", "key-actions");
        const next = el("button", "home-act", "Next →"); next.type = "button"; next.addEventListener("click", openHunt);
        const o1 = el("button", "lin-part", "Open " + prompt); o1.type = "button"; o1.addEventListener("click", function () { run(prompt); });
        const o2 = el("button", "lin-part", "Open " + answer); o2.type = "button"; o2.addEventListener("click", function () { run(answer); });
        acts.appendChild(next); acts.appendChild(o1); acts.appendChild(o2);
        out.appendChild(acts);
        showFork(pi, [[answer, via >= 0 ? via : null]]);
        holdSheetUntil = Date.now() + 1500; // keep the half sheet so the fork stays visible
        requestAnimationFrame(function () { contentEl.scrollTo({ top: contentEl.scrollHeight, behavior: "smooth" }); });
      });
      grid.appendChild(b);
    });
    card.appendChild(grid); card.appendChild(out);
    cardsEl.appendChild(card);
  }
  const huntBtn = $("huntBtn");
  if (huntBtn && typeof huntBtn.addEventListener === "function") huntBtn.addEventListener("click", openHunt);

  // ---- step out: word → its family → its language group → the whole map ----
  var stepLevel = 0;
  function stepOut() {
    if (!window.RootMap || !RootMap.loaded()) { goHome(); return; }
    const i = mapWord ? (mapWord[0] === "@" ? Number(mapWord.slice(1)) : RootMap.find(mapWord)) : -1;
    if (i < 0 || stepLevel >= 2) { stepLevel = 0; goHome(); return; }
    stepLevel++;
    if (sheetState === "full" || sheetState === "peek" || sheetState === "mini") setSheet(calloutFor >= 0 ? "callout" : "mini");
    if (stepLevel === 1) RootMap.frameFamily(i); else RootMap.frameRegion(i);
  }

  // ---- lenses ----
  let dblPairsP = null;
  function loadDblPairs() {
    if (!dblPairsP) dblPairsP = fetch("graph/doublets.json?v=1").then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return dblPairsP;
  }
  const GOLD = [0.94, 0.75, 0.3];
  async function applyLens() {
    if (!window.RootMap) return;
    await RootMap.ready;
    if (lensName === "doublets") {
      const pairs = await loadDblPairs();
      RootMap.setGlobal(pairs.map(function (p) { return [p[0], p[1], GOLD]; }));
    } else RootMap.setGlobal(null);
    if (!mapWord) return;
    const i = mapWord[0] === "@" ? Number(mapWord.slice(1)) : RootMap.find(mapWord);
    if (i < 0) return;
    if (lensName === "sense" && mapWord[0] !== "@") {
      const token = runToken;
      const rec = await getWord(mapWord);
      if (token !== runToken) return;
      const syn = [];
      ((rec && rec.s) || []).slice(0, 18).forEach(function (w) { const j = RootMap.find(w); if (j >= 0 && j !== i && syn.indexOf(j) < 0) syn.push(j); });
      RootMap.setExtra(syn.map(function (j) { return [i, j, hexRgb(RootMap.colorOf(RootMap.info(j).fam))]; }));
      if (syn.length && !lensQuiet) RootMap.fit([i].concat(syn));
    } else if (lensName === "doublets") {
      const d = await RootMap.details(i);
      if (d.dbl && d.dbl.length) showFork(i, d.dbl, lensQuiet); else RootMap.setExtra(null);
    } else {
      RootMap.setExtra(null);
    }
  }
  // a word's family on the map is the family of its deepest ancestor
  function familyOf(inf) {
    let r = inf.idx, n = 0;
    while (RootMap.info(r).parent >= 0 && n++ < 40) r = RootMap.info(r).parent;
    return RootMap.info(r).family;
  }
  // The lens switch and the sheet's cards are one thing seen two ways: tapping
  // a lens scrolls to its card; reading down to a card switches the lens
  // (overlay only — the camera moves only when you ask it to).
  let lensQuiet = false, lensTapAt = 0;
  const LENS_CARD = { descent: ".hist-card", sense: ".sense-card", doublets: ".dbl-card" };
  function markLens(name) {
    lensName = name;
    document.querySelectorAll(".lens-btn").forEach(function (x) { const on = x.dataset.lens === name; x.classList.toggle("on", on); x.setAttribute("aria-selected", on ? "true" : "false"); });
  }
  (typeof document.querySelectorAll === "function" ? document.querySelectorAll(".lens-btn") : []).forEach(function (b) {
    b.addEventListener("click", function () {
      markLens(b.dataset.lens);
      lensTapAt = Date.now(); lensQuiet = false;
      if (lensName !== "sense" && mapWord && window.RootMap) {
        const i = mapWord[0] === "@" ? Number(mapWord.slice(1)) : RootMap.find(mapWord);
        if (i >= 0) RootMap.focus(i, { fly: true });
      }
      applyLens();
      const card = cardsEl.querySelector(LENS_CARD[lensName]);
      if (card && sheetState !== "hidden" && sheetState !== "home") {
        if (sheetState === "mini") setSheet("peek");
        holdSheetUntil = Date.now() + 1500;
        contentEl.scrollTo({ top: card.offsetTop - 30, behavior: "smooth" });
      }
    });
  });
  if (typeof IntersectionObserver === "function" && contentEl) {
    const seen = new Map();
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { seen.set(e.target, e.isIntersecting ? e.intersectionRatio : 0); });
      if (Date.now() - lensTapAt < 1500 || !currentWord) return;
      let best = null, br = 0.35;
      seen.forEach(function (r, t) { if (r > br && document.contains(t)) { br = r; best = t; } });
      if (!best) return;
      const name = Object.keys(LENS_CARD).find(function (k) { return best.matches(LENS_CARD[k]); });
      if (name && name !== lensName) { markLens(name); lensQuiet = true; applyLens().then(function () { lensQuiet = false; }); }
    }, { root: contentEl, threshold: [0, 0.35, 0.6, 0.9] });
    new MutationObserver(function () {
      cardsEl.querySelectorAll(".hist-card, .sense-card, .dbl-card").forEach(function (c) { if (!c._io) { c._io = 1; io.observe(c); } });
    }).observe(cardsEl, { childList: true });
  }

  // One gesture everywhere: a word inside a definition or etymology is a
  // point on the map too — tap it to go there.
  function wordAtPoint(x, y) {
    let node = null, off = 0;
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
    if (!node || node.nodeType !== 3) return null;
    const t = node.textContent;
    let a = off, b = off;
    while (a > 0 && /[\p{L}'’-]/u.test(t[a - 1])) a--;
    while (b < t.length && /[\p{L}'’-]/u.test(t[b])) b++;
    const w = t.slice(a, b).replace(/^['’-]+|['’-]+$/g, "");
    return w.length > 1 ? w : null;
  }
  if (cardsEl && typeof cardsEl.addEventListener === "function") {
    cardsEl.addEventListener("click", function (e) {
      if (e.target.closest("button, a, .bp, .lin-body")) return;
      if (!e.target.closest(".def-card .sense, .hist")) return;
      if (window.getSelection && String(window.getSelection())) return;
      const w = wordAtPoint(e.clientX, e.clientY);
      if (!w || !window.RootMap || !RootMap.loaded()) return;
      const cand = [w, w.toLowerCase()];
      const i = cand.map(function (x) { return RootMap.find(x); }).find(function (j) { return j >= 0; });
      if (i == null || i < 0) return;
      const label = RootMap.info(i).label;
      if (label.toLowerCase() === String(currentWord).toLowerCase()) return;
      run(label);
    });
  }

  // ---- the key ----
  const keyBtn = $("mapKeyBtn"), keyEl = $("mapKey");
  if (keyBtn && keyEl && typeof keyBtn.addEventListener === "function") {
    keyBtn.addEventListener("click", function () {
      if (!keyEl.hidden) { keyEl.hidden = true; return; }
      keyEl.innerHTML = "";
      const h = function (t) { keyEl.appendChild(el("h3", null, t)); };
      const p = function (t, parent) { (parent || keyEl).appendChild(el("p", null, t)); };
      const act = function (label, fn) { const b = el("button", "menu-act", label); b.type = "button"; b.addEventListener("click", function () { keyEl.hidden = true; fn(); }); return b; };
      // go somewhere
      const go = el("div", "menu-acts");
      go.appendChild(act("⤨ Somewhere else", randomStart));
      go.appendChild(act("⑂ Doublet hunt", openHunt));
      go.appendChild(act("✦ Quiz", function () { if (typeof openQuiz === "function") openQuiz(); }));
      const n = typeof getSaved === "function" ? getSaved().length : 0;
      go.appendChild(act("★ Saved" + (n ? " (" + n + ")" : ""), function () { if (typeof openSavedWords === "function") openSavedWords(); }));
      keyEl.appendChild(go);
      // the look: five interfaces, each after one real source
      h("Look");
      const looks = el("div", "menu-looks");
      LOOK_ORDER.forEach(function (k) {
        const ui = LOOK_UI[k];
        const b = el("button", "menu-look" + (k === lookName ? " on" : "")); b.type = "button"; b.dataset.look = k;
        b.appendChild(el("span", "ml-name", ui.name)); b.appendChild(el("span", "ml-sub", ui.sub));
        b.addEventListener("click", function () {
          applyLook(k, true);
          looks.querySelectorAll(".menu-look").forEach(function (x) { x.classList.toggle("on", x === b); });
        });
        looks.appendChild(b);
      });
      keyEl.appendChild(looks);
      // how to read it
      const det = el("details", "menu-key");
      det.appendChild(el("summary", null, "How to read the map"));
      p("Every dot is a word or an older form of one. Each family is drawn around its deepest known ancestor.", det);
      p("Distance from a family's centre is time: the ancestor in the middle, then Latin, Old French, Middle English and today's English on the rim. Zoom into a family to see its era rings.", det);
      p("Families that share compounds or cross-links sit next to each other. The faint outer band holds entries with no recorded ancestry.", det);
      p("Dot size is how many English words descend from that point. Colour is the language family:", det);
      const fams = el("div", "fams");
      (window.RootMap ? RootMap.families() : []).forEach(function (f, k) {
        const row = el("div", "fam"); const dot = el("i"); dot.style.background = RootMap.colorOf(k);
        row.appendChild(dot); row.appendChild(txtNode(f)); fams.appendChild(row);
      });
      det.appendChild(fams);
      p("Descent: where a word came from and what came from it. Sense: its synonyms, wherever their histories put them. Doublets: one source that reached English twice.", det);
      keyEl.appendChild(det);
      keyEl.appendChild(el("p", "lin-note", "Built only from Wiktionary, so the map and the text never disagree."));
      const acts = el("div", "key-actions");
      const upd = el("button", "lin-part", "Check for updates"); upd.type = "button";
      upd.addEventListener("click", function () { const rb = $("refreshBtn"); if (rb) rb.click(); });
      acts.appendChild(upd);
      keyEl.appendChild(acts);
      keyEl.hidden = false;
    });
    document.addEventListener("pointerdown", function (e) { if (!keyEl.hidden && !e.target.closest(".map-key, #mapKeyBtn")) keyEl.hidden = true; });
  }

  // ---- lineage (one card for words and ancestors alike) ----
  const KIND_TXT = { inh: "inherited as", bor: "borrowed as", lbor: "borrowed (learned) as", der: "became", via: "passed on as",
    cal: "calqued as", cmp: "built into", aff: "built into" };
  async function lineageCard(i, token, title) {
    const rows = await lineageRows(i, token);
    if (!rows) return null;
    const card = el("div", "card lin-card");
    card.appendChild(el("div", "cap", title));
    rows.forEach(function (r) { card.appendChild(r); });
    return card;
  }
  async function lineageRows(i, token) {
    const chain = [i].concat(RootMap.lineage(i));
    if (chain.length < 2) return null;
    const ds = await Promise.all(chain.map(function (c) { return RootMap.details(c); }));
    const engYear = await Promise.all(chain.map(function (c) {
      const inf = RootMap.info(c);
      if (inf.lang !== "English") return null;
      return Promise.resolve(getWord(inf.label)).then(function (r) { return r && r.e ? extractYear(r.e) : null; }).catch(function () { return null; });
    }));
    if (token !== runToken) return null;
    const out = [];
    const card = { appendChild: function (x) { out.push(x); } };
    for (let k = chain.length - 1; k >= 0; k--) {
      const c = chain[k], inf = RootMap.info(c), d = ds[k];
      const row = el("div", "lin-row" + (k === 0 ? " lin-here" : ""));
      const rail = el("div", "lin-rail"); const dot = el("span", "lin-dot"); dot.style.background = RootMap.colorOf(inf.fam);
      rail.appendChild(dot);
      const body = el("div", "lin-body");
      if (k < chain.length - 1) {
        const up = (d.up || []).find(function (u) { return u[0] === chain[k + 1]; });
        body.appendChild(el("span", "lin-kind", KIND_TXT[up ? up[1] : "der"] || "became"));
      }
      // a language's period says when that language was spoken, not when this word appeared:
      // English (today's) gets a date only when the word's own etymology gives one
      let era = langEra(inf.lang);
      if (inf.lang === "English") { era = engYear[k] || ""; }
      if (era) body.appendChild(el("span", "lin-era", era));
      body.appendChild(el("span", "lin-lang", inf.lang));
      body.appendChild(el("span", "lin-term", inf.label));
      if (d.g) body.appendChild(el("span", "lin-gloss", "“" + firstSense(d.g) + "”"));
      if (k > 0) body.addEventListener("click", function () { run(inf.isWord ? inf.label : "@" + c); });
      row.appendChild(rail); row.appendChild(body);
      card.appendChild(row);
      const others = (d.up || []).filter(function (u) { return u[0] !== chain[k + 1]; });
      if (others.length) {
        const pr = el("div", "lin-parts");
        others.forEach(function (u) {
          const oi = RootMap.info(u[0]);
          const b = el("button", "lin-part", "+ " + oi.label); b.type = "button"; b.title = oi.lang;
          b.addEventListener("click", function () { run(oi.isWord ? oi.label : "@" + u[0]); });
          pr.appendChild(b);
        });
        card.appendChild(pr);
      }
    }
    return out;
  }
  function showFork(i, list, keepCamera) {
    const segs = [], ink = inkRgb(), pts = [i];
    const walk = function (j, stop) {
      let x = j, n = 0;
      while (x >= 0 && x !== stop && n++ < 14) { const p = RootMap.info(x).parent; if (p < 0) break; segs.push([x, p, ink]); pts.push(p); x = p; }
    };
    list.forEach(function (pair) {
      const j = RootMap.find(pair[0]); if (j < 0) return;
      pts.push(j);
      const via = pair[1] != null ? pair[1] : -1;
      walk(j, via); walk(i, via);
    });
    RootMap.setExtra(segs);
    if (!keepCamera) RootMap.fit(pts);
  }
  function doubletCard(i, d) {
    if (!d.dbl || !d.dbl.length) return null;
    const card = el("div", "card dbl-card");
    card.appendChild(el("div", "cap", "Doublets"));
    card.appendChild(el("div", "lin-note", "One source that reached English more than once, by different routes:"));
    d.dbl.forEach(function (pair) {
      const row = el("div", "dbl-row");
      const b = el("button", "dbl-word", pair[0]); b.type = "button";
      b.addEventListener("click", function () { run(pair[0]); });
      row.appendChild(b);
      if (pair[1] != null) {
        const vi = RootMap.info(pair[1]);
        const v = el("span", "dbl-via");
        v.appendChild(txtNode("split from " + vi.lang + " "));
        v.appendChild(el("i", null, vi.label));
        row.appendChild(v);
      }
      card.appendChild(row);
    });
    const show = el("button", "lin-part", "Show the fork on the map"); show.type = "button";
    show.style.marginTop = "10px";
    show.addEventListener("click", function () { showFork(i, d.dbl); if (sheetState === "full") setSheet("peek"); });
    card.appendChild(show);
    return card;
  }
  // word pages: Lineage + Doublets cards, both read off the map
  async function buildLineageCards(word, token) {
    if (!window.RootMap) return null;
    await RootMap.ready;
    const i = RootMap.find(word);
    if (i < 0 || token !== runToken) return null;
    const d = await RootMap.details(i);
    const out = [];
    const dbl = doubletCard(i, d);
    if (dbl) out.push(dbl);
    return token === runToken ? out : null;
  }

  // ---- ancestor pages: standing on a form that isn't an English headword ----
  async function openNode(i, force) {
    if (!window.RootMap) return;
    stepLevel = 0;
    const token = ++runToken;
    await RootMap.ready;
    if (token !== runToken) return;
    const inf = RootMap.info(i);
    if (!inf) return;
    if (inf.isWord && !force) { runToken++; return run(inf.label); }
    currentWord = "";
    input.value = ""; input.blur();
    hideSuggest(); hideRecent();
    if (!browseEl.hidden) closeBrowse();
    if (treeEl && !treeEl.hidden) closeTree();
    clearStage(); hint.hidden = true;
    if (contentEl) contentEl.scrollTop = 0;
    pushNav("@" + i);
    mapWord = "@" + i;
    lowerForFlight();
    noteWalk(i);
    const flight = navigating ? RootMap.focus(i, { fly: true, dur: 900 }) : RootMap.trace(i);
    const dP = RootMap.details(i);
    await Promise.race([flight, delay(4200)]);
    applyLens();
    if (token !== runToken) return;
    const d = await dP;
    if (token !== runToken) return;
    showNodeCallout(i, d);
    setSheet(navigating ? "peek" : "callout");
    const head = el("div", "node-head");
    head.appendChild(el("div", "node-lang", inf.lang));
    head.appendChild(el("div", "node-term", inf.label));
    if (d.tr) head.appendChild(el("div", "node-tr", d.tr));
    if (d.g) head.appendChild(el("div", "node-gloss", "“" + d.g + "”"));
    const era = langEra(inf.lang);
    if (era) head.appendChild(el("div", "node-era", inf.lang + ", " + era));
    entryEl.appendChild(head);
    requestAnimationFrame(function () { entryEl.classList.add("in"); });
    const add = function (c) { if (!c) return; cardsEl.appendChild(c); requestAnimationFrame(function () { c.classList.add("in"); }); };
    // what it became in English
    if (d.en && d.en.length) {
      const card = el("div", "card");
      card.appendChild(el("div", "cap", "In English"));
      const list = el("div", "desc-list");
      d.en.forEach(function (w) {
        const b = el("button", "desc-chip", w); b.type = "button";
        b.addEventListener("click", function () { run(w); });
        list.appendChild(b);
      });
      card.appendChild(list);
      if (d.ne > d.en.length) card.appendChild(el("div", "desc-more", "…and " + (d.ne - d.en.length) + " more, most common first."));
      add(card);
    }
    // doublets that split here
    const pairs = (await loadDblPairs()).filter(function (p) { return p[2] === i; });
    if (token !== runToken) return;
    if (pairs.length) {
      const card = el("div", "card dbl-card");
      card.appendChild(el("div", "cap", "Splits here"));
      card.appendChild(el("div", "lin-note", "These reached English from this one form by different routes:"));
      pairs.forEach(function (p) {
        const row = el("div", "dbl-row");
        [p[0], p[1]].forEach(function (j, k) {
          if (k) row.appendChild(el("span", "dbl-via", "and"));
          const w = RootMap.info(j).label;
          const b = el("button", "dbl-word", w); b.type = "button";
          b.addEventListener("click", function () { run(w); });
          row.appendChild(b);
        });
        card.appendChild(row);
      });
      add(card);
    }
    // the next stages (forms in other languages that came from it)
    const kids = RootMap.children(i).filter(function (k) { return !RootMap.info(k).isWord; });
    if (kids.length) {
      const card = el("div", "card");
      card.appendChild(el("div", "cap", "Became"));
      kids.slice(0, 40).forEach(function (k) {
        const ki = RootMap.info(k);
        const row = el("div", "lin-row");
        const rail = el("div", "lin-rail"); const dot = el("span", "lin-dot"); dot.style.background = RootMap.colorOf(ki.fam); rail.appendChild(dot);
        const body = el("div", "lin-body");
        body.appendChild(el("span", "lin-lang", ki.lang));
        body.appendChild(el("span", "lin-term", ki.label));
        body.addEventListener("click", function () { run("@" + k); });
        row.appendChild(rail); row.appendChild(body);
        card.appendChild(row);
      });
      add(card);
    }
    add(await lineageCard(i, token, "Where it came from"));
  }


  // ---------- vocab quiz: save + SM-2 spaced repetition + MC + discovery ----------

  const quizEl = $("quiz");
  const quizCountEl = $("quizCount");
  const quizPeekBack = $("quizPeekBack");
  const appEl = document.querySelector(".app");
  // open a word's full card as a frosted sheet above the quiz, leaving the
  // quiz's DOM (and the revealed answers) untouched underneath
  function openQuizCard(word) {
    appEl.classList.add("quiz-peek");
    run(word);
  }
  if (quizPeekBack) {
    quizPeekBack.addEventListener("click", function () { appEl.classList.remove("quiz-peek"); });
  }
  // swipe down on the peek card to dismiss it (same action as the "Back to
  // quiz" button) — only while the card is scrolled to its top, so the
  // gesture doesn't fight normal upward scrolling inside the card.
  (function () {
    let startY = null, dragging = false;
    contentEl.addEventListener("touchstart", function (e) {
      if (!appEl.classList.contains("quiz-peek")) { startY = null; return; }
      if (contentEl.scrollTop > 0) { startY = null; return; }
      startY = e.touches[0].clientY;
      dragging = false;
    }, { passive: true });
    contentEl.addEventListener("touchmove", function (e) {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 8) dragging = true;
    }, { passive: true });
    contentEl.addEventListener("touchend", function (e) {
      if (startY == null) return;
      const dy = (e.changedTouches[0] ? e.changedTouches[0].clientY : startY) - startY;
      if (dragging && dy > 70) appEl.classList.remove("quiz-peek");
      startY = null;
      dragging = false;
    }, { passive: true });
  })();
  const SAVE_KEY = "rootwork.saved";
  const SR_KEY = "rootwork.sr";
  const SEEN_KEY = "rootwork.seen";    // rolling log of discovery words shown
  const SAVED_CAP = 10;               // max saved words per session
  const DISCOVER_COUNT = 10;          // discovery words added every session

  // -- saved word list --
  function getSaved() { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "[]"); } catch (e) { return []; } }
  function setSaved(arr) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(arr)); } catch (e) {} }
  function isSaved(w) { return getSaved().indexOf(w) !== -1; }
  function toggleSaved(w) {
    const arr = getSaved(); const i = arr.indexOf(w);
    if (i === -1) arr.push(w); else arr.splice(i, 1);
    setSaved(arr); updateQuizBadge(); return i === -1;
  }
  function updateQuizBadge() {
    const n = getSaved().length;
    if (quizCountEl) { quizCountEl.textContent = n || ""; quizCountEl.hidden = n === 0; }
    if (savedWordsBtn) savedWordsBtn.classList.toggle("has-saved", n > 0);
  }

  // -- seen log: prevents discovery words from repeating within ~300 sessions --
  function getSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); } catch (e) { return []; } }
  function addSeen(words) {
    if (!words.length) return;
    let s = getSeen().concat(words);
    if (s.length > 400) s = s.slice(-400);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (e) {}
  }

  // -- SM-2 spaced repetition --
  function getSR() { try { return JSON.parse(localStorage.getItem(SR_KEY) || "{}"); } catch (e) { return {}; } }
  function putSR(sr) { try { localStorage.setItem(SR_KEY, JSON.stringify(sr)); } catch (e) {} }
  function srUpdate(word, correct) {
    const sr = getSR();
    const s = sr[word] || { ef: 2.5, interval: 0, reps: 0 };
    const q = correct ? 4 : 1;
    if (q >= 3) {
      s.interval = s.reps === 0 ? 1 : s.reps === 1 ? 6 : Math.round(s.interval * s.ef);
      s.ef = Math.max(1.3, s.ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
      s.reps++;
    } else {
      s.reps = 0; s.interval = 1;
      s.ef = Math.max(1.3, s.ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    }
    s.due = Date.now() + s.interval * 86400000;
    sr[word] = s; putSR(sr);
  }

  // -- word classification --
  // pointer entries ("Alternative spelling of X", "Plural of Y") make useless
  // questions — the answer is just another form of the headword. The optional
  // qualifier word (e.g. "letter-case" in "Alternative letter-case form of
  // Islamism") keeps these from slipping through unmatched.
  const VARIANT_RE = /^(a |an |the )?(alternative|alt\.?|variant|obsolete|archaic|dated|nonstandard|non-standard|standard|common|eye|rare|informal|formal|colloquial|chiefly [a-z]+|british|american|canadian|australian|scottish|irish|dialectal) ([a-z-]+ )?(spelling|spellings|form|pronunciation) of\b/i;
  // The clause a quiz option shows — same first-clause split as shortGloss, but
  // (unlike shortGloss) never hard-truncates mid-word with "…". A sense whose
  // first clause doesn't fit in that length isn't a good multiple-choice option,
  // so it's filtered out below rather than chopped.
  function quizGloss(g) { return String(g).split(/;| — /)[0].trim(); }
  // A sense whose own gloss contains the headword ("Clipping of rheumatologist"
  // for rheum, "...in a phial" for phial) hands the answer away — skip it.
  const QUIZ_BANNED_DOMAINS = /^(chemistry|biochemistry|alchemy)$/i;
  // "A piece of ornamentation in this style." (rococo) only makes sense after
  // reading an earlier sense of the same word — unintelligible on its own.
  const BACKREF_RE = /\b(in|of|with|like|on|for|to) (this|that|the (same|aforementioned|above)) (style|kind|sense|manner|fashion|way|sort|type|form|context|regard)\b/i;
  function senseOk(s, word) {
    const g = s && s.g;
    if (!g) return false;
    if (s.dom && QUIZ_BANNED_DOMAINS.test(s.dom)) return false;
    const qg = quizGloss(g);
    if (qg.length < 8 || qg.length > 140) return false;
    if (/^(form|plural|past|variant|alternative|synonym|misspelling|archaic|abbreviation|initialism|acronym|contraction) of\b/i.test(qg)) return false;
    if (VARIANT_RE.test(qg)) return false;
    if (/wikipedia/i.test(qg)) return false;
    if (BACKREF_RE.test(qg)) return false;
    if (word && glossMentions(qg, word)) return false;
    return true;
  }
  // indices of senses good enough to ask a question about
  function validSenseIdx(rec, word) {
    if (!rec || !rec.d) return [];
    const out = [];
    rec.d.forEach(function (s, i) { if (senseOk(s, word)) out.push(i); });
    return out;
  }
  // Etymology like "Acronym of not in my back yard." marks the headword itself
  // as an acronym/initialism (nimby) rather than an organically grown word —
  // not the kind of vocabulary the quiz should be testing.
  const ACRONYM_ETYM_RE = /^(an? )?(acronym|initialism|abbreviation)( for| of)\b/i;
  // confirmed case-by-case as too easily mistaken for a misspelling of a far
  // more common word with an overlapping sense (mirrors build-quiz-pool.js)
  const QUIZ_EXCLUDE_WORDS = new Set(["unsoluble"]);
  function isQuizzable(rec, word) {
    if (QUIZ_EXCLUDE_WORDS.has(word)) return false;
    if (rec && rec.e && ACRONYM_ETYM_RE.test(rec.e)) return false;
    return validSenseIdx(rec, word).length > 0;
  }

  // Proper-noun / gazetteer / onomastic glosses (places, surnames, given names,
  // taxonomic genera). The eras pool stores these lowercased, so we detect them
  // by gloss shape rather than capitalization. Tuned to avoid false positives on
  // real words ("the state of being cruel", "the capital of a column").
  const GEO_RE = /^(a |an |the )(city|town|township|village|hamlet|borough|suburb|port|seaport|commune|municipality|canton|oblast|krai|province|prefecture|governorate|county|island|isle|archipelago|peninsula|river|lake|mountain|volcano|gulf|bay|strait|cape)\b[^.]*\b(in|of|on|near|located|situated)\b/i;
  const NAME_RE = /^(a |an )?((male |female |unisex )?given name|surname|patronymic|nickname)\b/i;
  const CAP_RE = /^(the )?((state |provincial )?capital (city )?of|largest city|chief town)\b/i;
  const GENUS_RE = /^(a |an )?genus of\b/i;
  const PEOPLE_RE = /\bmember of (a |an |the )?[^.]*\b(people|peoples|tribe|nation|clan|dynasty)\b|\b(ethnic group|indigenous (people|peoples|group))\b/i;
  const LANG_RE = /^(a |an |the )?([a-z]+ )?(language|dialect|languages|dialects)\b[^.]*\b(of|spoken|used)\b|\bdialects? of\b/i;
  function looksProper(rec) {
    const g = (rec && rec.d && rec.d[0] && rec.d[0].g) || "";
    return GEO_RE.test(g) || NAME_RE.test(g) || CAP_RE.test(g) || GENUS_RE.test(g) || PEOPLE_RE.test(g) || LANG_RE.test(g);
  }

  // Show a random valid sense (not always sense 0) so repeat review of a word
  // rotates through its meanings. Targeting *forgotten* senses needs per-sense
  // register data the corpus doesn't carry — deferred (see notes).
  function pickSenseToShow(rec, word) {
    const idxs = validSenseIdx(rec, word);
    return idxs[Math.floor(Math.random() * idxs.length)];
  }

  function qShuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // -- discovery engine --
  // Pool = quiz-pool.json: ~4000 vetted [word, era] pairs built offline by
  // scripts/build-quiz-pool.js — rare, older/forgotten, short, real words with
  // proper nouns / taxa / inflections filtered out. era is the word's usage
  // centroid (9–17 ≈ 1725–1949). We weight the draw toward EARLIER eras (more
  // forgotten) and SHORTER words, then sample globally from one flat list — so
  // there's no per-shard prefix clustering.
  let eraPoolPromise = null;
  function getEraPool() {
    if (eraPoolPromise) return eraPoolPromise;
    if (typeof fetch !== "function") return (eraPoolPromise = Promise.resolve([]));
    eraPoolPromise = fetch("quiz-pool.json?v=" + DATA_V)
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (arr) {
        return (arr || []).map(function (e) { return { w: e[0], era: e[1] }; });
      });
    return eraPoolPromise;
  }
  // earlier era favored: era 0 -> 21, era 20 -> 1
  function eraWeight(era) { return 21 - era; }
  // shorter favored: len 3 -> 9, len 8 -> 4, len 14 -> 1
  function lenWeight(w) { return Math.max(1, 12 - w.length); }

  async function pickDiscoveryWords(n, excludeSet, seenSet) {
    const pool = await getEraPool();
    // Efraimidis–Spirakis weighted sampling without replacement: key = U^(1/weight),
    // take the largest keys. Higher weight (early era + short) -> picked more often,
    // but every word keeps a chance, so the deck varies session to session.
    const scored = [];
    for (const p of pool) {
      if (excludeSet.has(p.w) || seenSet.has(p.w)) continue;
      const wgt = eraWeight(p.era) * lenWeight(p.w);
      scored.push({ w: p.w, k: Math.pow(Math.random(), 1 / wgt) });
    }
    scored.sort(function (a, b) { return b.k - a.k; });

    const results = [];
    for (const c of scored) {
      if (results.length >= n) break;
      const rec = await getWord(c.w);
      if (rec && isQuizzable(rec, c.w) && !looksProper(rec) && !(rec.rel && /\bof$/.test(rec.rel.t || ""))) {
        results.push({ w: c.w, rec: rec, senseIdx: pickSenseToShow(rec, c.w) });
      }
    }
    return results;
  }

  // -- distractor helpers --
  let distractorPool = [];
  async function warmPool() {
    if (distractorPool.length > 60) return;
    const L = "abcdefghijklmnopqrstuvwxyz";
    const keys = [];
    while (keys.length < 8) {
      const k = L[Math.floor(Math.random() * 26)] + L[Math.floor(Math.random() * 26)];
      if (keys.indexOf(k) === -1) keys.push(k);
    }
    for (const k of keys) {
      const sh = await fetchShard(k);
      if (!sh) continue;
      for (const w of Object.keys(sh)) {
        const r = sh[w];
        if (!r || !r.d || !r.d.length) continue;
        if (r.rel && /\bof$/.test(r.rel.t || "")) continue;
        if (w.length < 7) continue;
        if (looksProper(r)) continue; // random fallback pool — don't let place/name entries through
        if (!isQuizzable(r, w)) continue;
        const si = pickSenseToShow(r, w);
        const sense = r.d[si];
        const g = quizGloss(sense.g);
        if (g.length < 12) continue;
        distractorPool.push({ w: w, g: g, p: sense.p, dom: sense.dom });
      }
    }
  }

  function glossMentions(gloss, word) {
    const g = (gloss || "").toLowerCase(), w = word.toLowerCase();
    if (g.includes(w)) return true;
    if (w.length >= 7 && g.includes(w.slice(0, w.length - 2))) return true;
    return false;
  }

  // Two glosses sharing a content word ("A basket." / "An osier basket that
  // anglers use to hold fish.") read as the same concept at a glance, even when
  // technically distinct — confusing rather than genuinely wrong. Reject those.
  const GLOSS_STOPWORDS = new Set(["that", "this", "with", "from", "into", "onto", "upon", "also",
    "such", "than", "then", "they", "them", "have", "has", "had", "for", "are", "was", "were",
    "being", "been", "not", "but", "its", "his", "her", "their", "our", "your", "you", "one",
    "especially", "particular", "particularly", "used", "use", "uses", "usually", "often"]);
  function significantWords(g) {
    return (String(g).toLowerCase().match(/[a-z]+/g) || []).filter(function (w) {
      return w.length >= 4 && !GLOSS_STOPWORDS.has(w);
    });
  }
  function glossOverlaps(g1, g2) {
    const s2 = new Set(significantWords(g2));
    return significantWords(g1).some(function (w) { return s2.has(w); });
  }

  // Bigram (letter-pair) overlap — a cheap, offline stand-in for "looks/sounds
  // similar". Used to find orthographic near-misses (importune / impertinent)
  // as distractors: genuinely confusable, but — unlike synonyms — not at risk
  // of secretly also being a correct answer.
  function bigramSet(w) {
    const s = String(w).toLowerCase();
    const m = {};
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m[g] = (m[g] || 0) + 1; }
    return m;
  }
  function bigramSim(aMap, aTotal, b) {
    const bMap = bigramSet(b);
    let common = 0, bTotal = 0;
    for (const g in bMap) bTotal += bMap[g];
    for (const g in aMap) { if (bMap[g]) common += Math.min(aMap[g], bMap[g]); }
    return aTotal + bTotal ? (2 * common) / (aTotal + bTotal) : 0;
  }
  async function getLookalikes(word, excludeSet, count) {
    const key = word.slice(0, 2).toLowerCase();
    const sh = await fetchShard(key);
    if (!sh) return [];
    const aMap = bigramSet(word);
    let aTotal = 0; for (const g in aMap) aTotal += aMap[g];
    const scored = [];
    for (const w of Object.keys(sh)) {
      if (w === word || excludeSet.has(w)) continue;
      if (Math.abs(w.length - word.length) > 3) continue;
      const r = sh[w];
      if (!r || !isQuizzable(r, w) || looksProper(r)) continue;
      const sim = bigramSim(aMap, aTotal, w);
      if (sim < 0.3) continue;
      scored.push({ w: w, sim: sim, rec: r });
    }
    scored.sort(function (a, b) { return b.sim - a.sim; });
    return scored.slice(0, count);
  }

  async function getDistractors(word, rec, count, correctGloss) {
    const ok = function (g) { return !glossMentions(g, word) && !glossOverlaps(g, correctGloss); };
    // Never a registered synonym of the target — a synonym's own definition will,
    // by definition, usually also describe the target word correctly ("masturbate"
    // for wank, "brackish" for briny, "sunfish" for mola), which made for
    // distractors that were secretly right (and, worse, got shown as a second
    // "correct" choice alongside the target on the reveal screen).
    const synonymSet = new Set([word].concat((rec && rec.s) || []));
    const neighborWords = qShuffle(((rec && rec.r) || []).filter(function (w) { return !synonymSet.has(w); }));
    const candidates = [];
    for (const nw of neighborWords.slice(0, count * 6)) {
      if (candidates.length >= count) break;
      const nrec = await getWord(nw);
      if (isQuizzable(nrec, nw) && !looksProper(nrec)) {
        const si = pickSenseToShow(nrec, nw);
        const g = quizGloss(nrec.d[si].g);
        if (ok(g)) candidates.push({ w: nw, g: g });
      }
    }
    // rec.r runs thin for rare/obscure words — rather than fall straight to a
    // fully random word, prefer orthographic near-misses: words that look like
    // they could be confused with this one, even though they aren't related.
    if (candidates.length < count) {
      const used = new Set(candidates.map(function (c) { return c.w; }));
      synonymSet.forEach(function (w) { used.add(w); });
      const look = await getLookalikes(word, used, count - candidates.length);
      for (const l of look) {
        const si = pickSenseToShow(l.rec, l.w);
        const g = quizGloss(l.rec.d[si].g);
        if (ok(g)) candidates.push({ w: l.w, g: g });
      }
    }
    if (candidates.length >= count) return candidates.slice(0, count);
    const extra = qShuffle(distractorPool.filter(function (d) { return !synonymSet.has(d.w) && ok(d.g); }));
    return candidates.concat(extra).slice(0, count);
  }

  // -- quiz state & control --
  let quizState = null;
  let quizToken = 0;

  // Quiz always runs — discovery words fill any gap in the saved deck.
  function openQuiz() {
    quizEl.hidden = false;
    quizEl.innerHTML = '<div class="quiz-loading">Loading…</div>';
    startQuiz(getSaved());
  }

  function closeQuiz() {
    quizToken++;
    quizEl.hidden = true;
    quizEl.innerHTML = "";
    quizState = null;
    appEl.classList.remove("quiz-peek");
  }

  async function startQuiz(saved) {
    const tok = ++quizToken;
    const sr = getSR();
    // Sort saved by SM-2 due date (most overdue first), cap to SAVED_CAP
    const sorted = saved.slice().sort(function (a, b) {
      return ((sr[a] || { due: 0 }).due) - ((sr[b] || { due: 0 }).due);
    }).slice(0, SAVED_CAP);

    const recs = {};
    const senseIdx = {};
    await Promise.all(sorted.map(function (w) {
      return getWord(w).then(function (r) { if (r) { recs[w] = r; senseIdx[w] = pickSenseToShow(r, w); } });
    }));
    if (tok !== quizToken) return;
    const savedQueue = sorted.filter(function (w) { return isQuizzable(recs[w], w); });

    // Discovery: fill remaining slots with rare/loanword/archaic/specialized words
    const excludeSet = new Set(saved);
    const seenSet = new Set(getSeen());
    const discovered = await pickDiscoveryWords(DISCOVER_COUNT, excludeSet, seenSet);
    if (tok !== quizToken) return;
    const discoveryWords = [];
    discovered.forEach(function (d) { recs[d.w] = d.rec; senseIdx[d.w] = d.senseIdx; discoveryWords.push(d.w); });
    addSeen(discoveryWords);

    await warmPool();
    if (tok !== quizToken) return;

    // Interleave: saved words first (they have SM-2 state), then discovery
    const savedSet = new Set(saved);
    const queue = savedQueue.concat(discoveryWords.filter(function (w) { return isQuizzable(recs[w], w); }));
    if (!queue.length) { renderQuizEmpty(); return; }

    quizState = { queue: queue, idx: 0, recs: recs, senseIdx: senseIdx, savedSet: savedSet, score: { correct: 0, total: 0 }, missed: [], tok: tok };
    renderQuestion();
  }

  async function renderQuestion() {
    if (!quizState || quizEl.hidden) return;
    const { queue, idx, recs, senseIdx, savedSet, tok } = quizState;
    if (idx >= queue.length) { renderResult(); return; }
    const word = queue[idx];
    const rec = recs[word];
    const sense = rec.d[senseIdx[word]] || rec.d[0];
    const correctGloss = quizGloss(sense.g);
    const pos = sense.p || "";
    const isNew = !savedSet.has(word);
    const distractors = await getDistractors(word, rec, 3, correctGloss);
    if (tok !== quizToken) return;
    // A choice is correct if it's drawn from the target word itself OR one of its
    // registered synonyms — a synonym's own gloss genuinely does describe the
    // target word too, so picking it shouldn't be marked wrong.
    const correctWords = new Set([word].concat((rec && rec.s) || []));
    const choices = qShuffle([{ g: correctGloss, w: word, correct: true }].concat(
      distractors.slice(0, 3).map(function (d) { return { g: d.g, w: d.w, correct: correctWords.has(d.w) }; })
    ));

    quizEl.innerHTML = "";
    const head = el("div", "quiz-head");
    const xBtn = el("button", "quiz-close", "✕"); xBtn.type = "button";
    xBtn.setAttribute("aria-label", "Close quiz"); xBtn.addEventListener("click", closeQuiz);
    head.appendChild(xBtn);
    head.appendChild(el("div", "quiz-title", isNew ? "Discovery" : "Quiz"));
    head.appendChild(el("div", "quiz-prog", (idx + 1) + " / " + queue.length));
    quizEl.appendChild(head);
    const wordRow = el("div", "quiz-word-row");
    wordRow.appendChild(el("span", "quiz-word", word));
    const pronTxt = rec.i || rec.rs;
    if (pronTxt) wordRow.appendChild(el("span", "quiz-pron", pronTxt));
    quizEl.appendChild(wordRow);
    const sub = el("div", "quiz-pos");
    if (pos) sub.appendChild(el("span", null, pos));
    if (isNew) {
      const tag = el("span", "quiz-new-tag", "new");
      sub.appendChild(tag);
    }
    quizEl.appendChild(sub);

    const choicesEl = el("div", "quiz-choices");
    choices.forEach(function (c) {
      const row = el("div", "mc-row");
      const btn = el("button", "mc-btn", c.g); btn.type = "button";
      btn.addEventListener("click", function () { onAnswer(btn, c.correct, choices, choicesEl, word, idx, isNew); });
      row.appendChild(btn);
      const reveal = el("div", "mc-reveal"); reveal.hidden = true;
      reveal.appendChild(el("span", "mc-reveal-word", c.w));
      const openBtn = el("button", "mc-reveal-open", "Open card ›"); openBtn.type = "button";
      openBtn.addEventListener("click", function () { openQuizCard(c.w); });
      reveal.appendChild(openBtn);
      row.appendChild(reveal);
      choicesEl.appendChild(row);
    });
    quizEl.appendChild(choicesEl);
  }

  function onAnswer(clickedBtn, correct, choices, choicesEl, word, idx, isNew) {
    Array.prototype.forEach.call(choicesEl.children, function (row, i) {
      const btn = row.querySelector(".mc-btn");
      btn.disabled = true;
      if (choices[i].correct) btn.classList.add("correct");
      else if (btn === clickedBtn) btn.classList.add("wrong");
      row.querySelector(".mc-reveal").hidden = false;
    });
    srUpdate(word, correct);
    quizState.score.total++;
    if (correct) quizState.score.correct++;
    else quizState.missed.push(word);
    // Offer to star discovery words so they enter the SM-2 deck
    if (isNew && !isSaved(word)) {
      const saveRow = el("div", "quiz-save-row");
      const saveBtn = el("button", "quiz-save-btn", "☆  Add to my deck"); saveBtn.type = "button";
      saveBtn.addEventListener("click", function () {
        toggleSaved(word);
        saveBtn.textContent = "★  Added";
        saveBtn.disabled = true;
        quizState.savedSet.add(word);
      });
      saveRow.appendChild(saveBtn);
      quizEl.appendChild(saveRow);
    }
    const isLast = idx >= quizState.queue.length - 1;
    const nextBtn = el("button", "quiz-next", isLast ? "See results →" : "Next →");
    nextBtn.type = "button";
    nextBtn.addEventListener("click", function () { quizState.idx++; renderQuestion(); });
    quizEl.appendChild(nextBtn);
  }

  function renderResult() {
    const { score, missed } = quizState;
    quizEl.innerHTML = "";
    const head = el("div", "quiz-head");
    const xBtn = el("button", "quiz-close", "✕"); xBtn.type = "button";
    xBtn.addEventListener("click", closeQuiz);
    head.appendChild(xBtn);
    head.appendChild(el("div", "quiz-title", "Quiz complete"));
    quizEl.appendChild(head);
    const res = el("div", "quiz-result");
    res.appendChild(el("div", "quiz-result-score", score.correct + " / " + score.total));
    res.appendChild(el("div", "quiz-result-label", (score.total ? Math.round(score.correct / score.total * 100) : 0) + "% correct"));
    if (missed.length) {
      const ms = el("div", "quiz-result-missed");
      ms.appendChild(el("div", "quiz-result-missed-title", "REVIEW"));
      missed.forEach(function (w) {
        const row = el("button", "quiz-result-word", w); row.type = "button";
        row.addEventListener("click", function () { closeQuiz(); run(w); });
        ms.appendChild(row);
      });
      res.appendChild(ms);
    }
    const btns = el("div", "quiz-result-btns");
    const again = el("button", "quiz-next", "Quiz again"); again.type = "button";
    again.addEventListener("click", function () {
      quizEl.innerHTML = '<div class="quiz-loading">Loading…</div>';
      startQuiz(getSaved());
    });
    const done = el("button", "quiz-next secondary", "Done"); done.type = "button";
    done.addEventListener("click", closeQuiz);
    btns.appendChild(again); btns.appendChild(done);
    res.appendChild(btns);
    quizEl.appendChild(res);
  }

  function renderQuizEmpty() {
    quizEl.innerHTML = "";
    const head = el("div", "quiz-head");
    const xBtn = el("button", "quiz-close", "✕"); xBtn.type = "button";
    xBtn.addEventListener("click", closeQuiz);
    head.appendChild(xBtn);
    head.appendChild(el("div", "quiz-title", "Quiz"));
    quizEl.appendChild(head);
    const msg = el("div", "quiz-empty");
    msg.appendChild(el("div", "quiz-empty-icon", "◈"));
    msg.appendChild(el("div", "quiz-empty-text", "No words found — try again"));
    quizEl.appendChild(msg);
  }

  const homeQuizBtn = $("homeQuizBtn");
  if (homeQuizBtn) homeQuizBtn.addEventListener("click", openQuiz);
  const savedWordsBtn = $("savedWordsBtn");
  if (savedWordsBtn) savedWordsBtn.addEventListener("click", openSavedWords);
  updateQuizBadge();

})();
