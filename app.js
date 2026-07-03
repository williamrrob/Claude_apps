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
  const DATA_V = "140";
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
  // Obscure roots we didn't build in are looked up live — Wiktionary's REST
  // endpoint is CORS-enabled and groups definitions by language.
  const ONLINE_LANGS = { la: "Latin", grc: "Ancient Greek", "ine-pro": "Proto-Indo-European",
    "gem-pro": "Proto-Germanic", "itc-pro": "Proto-Italic", el: "Greek" };
  const onlineCache = {};
  function lookupOnline(word) {
    const w = String(word || "").trim();
    if (typeof fetch !== "function" || !/^[a-zÀ-ɏ-]{2,40}$/i.test(w)) return Promise.resolve(null);
    if (w in onlineCache) return Promise.resolve(onlineCache[w]);
    const url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(w);
    const timeout = new Promise(function (r) { setTimeout(function () { r(null); }, 4500); });
    const req = fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j) return null;
      const order = ["la", "grc", "ine-pro", "gem-pro", "itc-pro", "el"];
      let code = null;
      for (let i = 0; i < order.length; i++) if (j[order[i]]) { code = order[i]; break; }
      if (!code) return null;
      const sec = j[code][0];
      if (!sec || !sec.definitions || !sec.definitions.length) return null;
      const def = sec.definitions[0].definition.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (!def) return null;
      return { l: w, lang: ONLINE_LANGS[code] || sec.language || "", g: def.split(/[;]/)[0].slice(0, 90).trim(), en: [], online: true };
    }).catch(function () { return null; });
    return Promise.race([req, timeout]).then(function (res) { onlineCache[w] = res; return res; });
  }

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
      if (wp.type !== "standard" || !wp.thumb) return;
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
  function chooseBreakdown(result, rec) {
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
    const d = el("div", "status" + (isError ? " error" : "")); d.innerHTML = html;
    entryEl.appendChild(d);
  }

  async function run(rawWord, sourcePart) {
    const word = String(rawWord || "").trim();
    if (!word) return;
    treeReturn = openingFromTree; openingFromTree = false; // came from a tree?
    const token = ++runToken;
    input.value = word;
    input.blur(); // dismiss the keyboard so the dock returns to the bottom
    hideSuggest();
    hideRecent();
    if (themeToggle) themeToggle.hidden = true; // toggle lives on the home screen only
    if (savedWordsBtn) savedWordsBtn.hidden = true; // saved-words icon lives on the home screen only
    if (!browseEl.hidden) closeBrowse();
    if (treeEl && !treeEl.hidden) closeTree();
    hint.hidden = true;
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
      await reveal(result, token);
    } catch (err) {
      showStatus("Something went wrong: " + escapeHtml(String(err && err.message || err)), true);
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

  function buildEntry(word, rec, parts) {
    entryEl.className = "entry"; entryEl.innerHTML = "";
    const ruleRow = el("div", "entry-rule-row");
    // when this word was reached from a tree, offer a way to shrink back into it
    if (treeReturn && treeRoot) {
      const bk = el("button", "tree-btn", "✕"); bk.type = "button";
      bk.setAttribute("aria-label", "Back to the word-family tree");
      bk.addEventListener("click", returnToTree);
      ruleRow.appendChild(bk);
    }
    ruleRow.appendChild(el("span", "entry-rule"));
    const pos = rec && rec.d && rec.d[0] && rec.d[0].p;
    if (pos) ruleRow.appendChild(el("span", "entry-pos", pos));
    const savedNow = isSaved(word);
    const starBtn = el("button", "save-btn" + (savedNow ? " saved" : ""), savedNow ? "★" : "☆");
    starBtn.type = "button";
    starBtn.setAttribute("aria-label", savedNow ? "Remove from quiz" : "Save for quiz");
    starBtn.addEventListener("click", function () {
      const on = toggleSaved(word);
      starBtn.textContent = on ? "★" : "☆";
      starBtn.className = "save-btn" + (on ? " saved" : "");
      starBtn.setAttribute("aria-label", on ? "Remove from quiz" : "Save for quiz");
    });
    ruleRow.appendChild(starBtn);

    // ruleRow + the headword live together in one wrapper so the pair can be
    // pinned as a single fused unit in quiz-peek mode (see .entry-head in CSS) —
    // no separate duplicate header bar, the real headword itself glues in place.
    const headWrap = el("div", "entry-head");
    headWrap.appendChild(ruleRow);

    // headword with subtle dots between its parts. `rec.bWhole` means the
    // curated roots are real but the modern spelling doesn't cleanly tile
    // them (congee's "gee" bears no visual resemblance to its source meō) —
    // show the headword undivided even though the Breakdown card below still
    // lists the genuine roots.
    const wordEl = el("div", "entry-word");
    const surfaces = (parts && parts.length > 1 && !parts[0].whole && !(rec && rec.bWhole)) ? parts.map(function (p) { return p.disp || p.surface; }) : [word];
    surfaces.forEach(function (s, i) {
      if (i) wordEl.appendChild(el("span", "entry-dot", "·"));
      wordEl.appendChild(el("span", "ew-part", s));
    });
    headWrap.appendChild(wordEl);
    entryEl.appendChild(headWrap);

    // half-circle letter badge by the word — tap to browse that letter
    const L = String(word).charAt(0).toUpperCase();
    if (/[A-Z]/.test(L)) {
      const badge = el("button", "entry-letter", L); badge.type = "button";
      badge.setAttribute("aria-label", "Browse words starting with " + L);
      badge.addEventListener("click", function () { browseLetter(L); });
      entryEl.appendChild(badge);
    }

    pronEl = el("div", "pron");
    entryEl.appendChild(pronEl);
    const isAbbr = rec && rec.d && rec.d[0] && rec.d[0].p === "abbr.";
    const gloss = rec && rec.d && rec.d[0] && rec.d[0].g;
    // Abbreviations show "read as" in the pron slot instead of an entry gloss.
    if (gloss && !isAbbr) entryEl.appendChild(el("div", "entry-gloss", shortGloss(gloss)));
    // compact pinned header (revealed on scroll) — same subtle dots between parts
    miniHead.innerHTML = "";
    const mw = el("span", "minihead-word");
    surfaces.forEach(function (s, i) {
      if (i) mw.appendChild(el("span", "entry-dot", "·"));
      mw.appendChild(el("span", "mh-part", s));
    });
    miniHead.appendChild(mw);
    if (pos) miniHead.appendChild(el("span", "minihead-pos", pos));
  }

  async function reveal(result, token) {
    clearStage();
    const recP = getWord(result.word);
    const rec = await recP;
    if (token !== runToken) return;
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

    if (!rec || !rec.d || !rec.d.length) {
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
      rel.appendChild(document.createTextNode((rec.rel.t || "from") + " "));
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
      av.appendChild(document.createTextNode("also spelled "));
      rec.vars.forEach(function (v, i) {
        if (i) av.appendChild(document.createTextNode(", "));
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
      fr.appendChild(document.createTextNode("forms: "));
      rec.forms.forEach(function (v, i) {
        if (i) fr.appendChild(document.createTextNode(", "));
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
    prefetchTree(result.word, parts); // build the family tree in the background

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

    // 3) Definition
    await delay(30); if (token !== runToken) return;
    const defCard = buildDefinitionCard(recP, token);
    cardsEl.appendChild(defCard);
    requestAnimationFrame(function () { defCard.classList.add("in"); });

    // 3.5) Word family — if this word belongs to a curated family, tie its page
    // to the family tree (shows the region it sits in + opens the tree).
    buildFamilyCard(parts, result.word, token).then(function (famCard) {
      if (famCard && token === runToken) {
        if (defCard.nextSibling) cardsEl.insertBefore(famCard, defCard.nextSibling);
        else cardsEl.appendChild(famCard);
        requestAnimationFrame(function () { famCard.classList.add("in"); });
      }
    });
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

    // 4) divider + Word history
    const divider = fleuron();
    const histCard = buildHistoryCard(recP, parts, token, divider);
    cardsEl.appendChild(divider);
    cardsEl.appendChild(histCard);
    requestAnimationFrame(function () { divider.classList.add("in"); histCard.classList.add("in"); });

    // 4.5) Ancestry — the word's position on the etymology graph (trees/),
    // ancestors tappable: entries open, shared roots pivot to descendants.
    buildAncestryCard(result.word, token).then(function (ancCard) {
      if (ancCard && token === runToken) {
        if (histCard.nextSibling) cardsEl.insertBefore(ancCard, histCard.nextSibling);
        else cardsEl.appendChild(ancCard);
        requestAnimationFrame(function () { ancCard.classList.add("in"); });
      }
    });

    // 5) Usage over time
    const useCard = buildUsageCard(result.word, token);
    cardsEl.appendChild(useCard);
    requestAnimationFrame(function () { useCard.classList.add("in"); });

    // 6) Thesaurus
    const thesCard = buildThesaurusCard(recP, token);
    cardsEl.appendChild(thesCard);
    requestAnimationFrame(function () { thesCard.classList.add("in"); });
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
    const kind = p.whole ? null : kindLabel(p.kind);
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

    // tap a morpheme to hear the root and see other words built on it
    if (p.id) {
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
    const s = ipa.replace(/[\/\[\].]/g, "");
    const out = [], seen = {};
    for (let i = 0; i < s.length;) {
      let sym = null;
      if (IPA_KEY[s.substr(i, 2)]) { sym = s.substr(i, 2); i += 2; }
      else { if (IPA_KEY[s[i]]) sym = s[i]; i += 1; }
      if (sym && !seen[sym]) { seen[sym] = 1; out.push(sym); }
    }
    return out;
  }
  function toggleIpaKey(ipa) {
    if (!ipaKeyEl.hidden) { ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = ""; return; }
    ipaKeyEl.innerHTML = "";
    ipaKeyEl.appendChild(el("div", "lab", "Pronunciation key"));
    const list = el("div", "ipa-key-list");
    tokenizeIPA(ipa).forEach(function (sym) {
      const row = el("div", "ipa-key-row");
      row.appendChild(el("span", "ipa-sym", sym));
      if (IPA_NAME[sym]) row.appendChild(el("span", "ipa-name", IPA_NAME[sym]));
      row.appendChild(el("span", "ipa-desc", IPA_KEY[sym]));
      list.appendChild(row);
    });
    ipaKeyEl.appendChild(list);
    ipaKeyEl.hidden = false;
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
        ib.addEventListener("click", function () { toggleIpaKey(ipa); });
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
        senses.forEach(function (s, i) {
          const row = el("div", "sense");
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

  // ---------- thesaurus ----------
  function buildThesaurusCard(recP, token) {
    const card = el("div", "card thes-card");
    card.appendChild(el("div", "cap", "Thesaurus"));
    recP.then(async function (rec) {
      if (token !== runToken) return;
      // Only offer words we can actually open — Wiktionary's related/synonym
      // lists include forms we have no entry for (e.g. "prescriptionless"), and
      // tapping those dead-ends. Keep just the ones with a real entry.
      const s = await validateWords(rec && rec.s || [], 12);
      const a = await validateWords(rec && rec.a || [], 8);
      const r = await validateWords(rec && rec.r || [], 12);
      if (token !== runToken) return;
      if (!s.length && !a.length && !r.length) { card.remove(); return; }
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
      group("Synonyms", s, "syn");
      group("Antonyms", a, "ant");
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

  function parseChain(e) {
    const names = Object.keys(LANGS).sort(function (a, b) { return b.length - a.length; });
    let work = " " + e + " ";
    const found = {};
    names.forEach(function (name) {
      let idx;
      while ((idx = work.indexOf(name)) >= 0) {
        if (found[name] === undefined) found[name] = idx;
        work = work.slice(0, idx) + new Array(name.length + 1).join(" ") + work.slice(idx + name.length);
      }
    });
    let chain = Object.keys(found).sort(function (a, b) { return LANGS[a].rank - LANGS[b].rank; });
    if (chain.length > 5) chain = chain.slice(0, 4).concat(chain.slice(-1));
    return chain;
  }

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

  function buildTimeline(e) {
    const chain = parseChain(e);
    if (chain.length < 2) return null;
    const colors = ["var(--root)", "var(--suffix)", "var(--prefix-ink)", "var(--stem)", "var(--ink)"];
    const wrap = el("div", "tl-wrap");
    const tl = el("div", "tl");
    const detail = el("div", "tl-detail");
    detail.appendChild(el("div", "tl-hint", "Tap a stage to learn about each language."));
    let open = null;

    function select(name, color) {
      const nodes = tl.children;
      for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("sel", nodes[i].dataset.name === name);
      const L = LANGS[name];
      detail.innerHTML = "";
      const head = el("div", "tl-d-head");
      const sw = el("span", "tl-d-dot"); sw.style.background = color; head.appendChild(sw);
      head.appendChild(el("span", "tl-d-name", name));
      head.appendChild(el("span", "tl-d-era", L.era));
      detail.appendChild(head);
      if (L.desc) detail.appendChild(el("div", "tl-d-desc", L.desc));
    }
    function toggle(name, color) {
      if (open === name) { // tapping the open one collapses back to the hint
        open = null;
        const nodes = tl.children;
        for (let i = 0; i < nodes.length; i++) nodes[i].classList.remove("sel");
        detail.innerHTML = ""; detail.appendChild(el("div", "tl-hint", "Tap a stage to learn about each language."));
        return;
      }
      open = name; select(name, color);
    }

    chain.forEach(function (name, i) {
      const color = colors[i % colors.length];
      const node = el("div", "node"); node.dataset.name = name;
      node.setAttribute("role", "button"); node.setAttribute("tabindex", "0");
      const dot = el("div", "dot"); dot.style.background = color;
      node.appendChild(dot);
      node.appendChild(el("div", "lang", LANGS[name].short || name));
      node.appendChild(el("div", "era", LANGS[name].era));
      node.addEventListener("click", function () { toggle(name, color); });
      node.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(name, color); } });
      tl.appendChild(node);
    });
    wrap.appendChild(tl);
    wrap.appendChild(detail);
    return wrap;
  }

  function buildHistoryCard(recP, parts, token, divider) {
    const card = el("div", "card");
    card.appendChild(el("div", "cap", "Word history"));
    recP.then(function (rec) {
      if (token !== runToken) return;
      const e = rec && rec.e;
      const tl = e ? buildTimeline(e) : null;
      const prose = (e && !looksLikeTree(e)) ? e : null;
      const known = parts.filter(function (p) { return p.origin && p.source; });
      if (!tl && !prose && !known.length) { card.remove(); if (divider) divider.remove(); return; }

      if (tl) card.appendChild(tl);
      if (prose) {
        card.appendChild(el("div", "sub", "Etymology"));
        card.appendChild(el("div", "hist", cleanProse(prose)));
      } else if (known.length) {
        card.appendChild(el("div", "sub", "Etymology"));
        const origins = [];
        known.forEach(function (p) { if (origins.indexOf(p.origin) === -1) origins.push(p.origin); });
        const chain = known.map(function (p) {
          return "<i>" + escapeHtml(p.source) + '</i> (“' + escapeHtml(firstSense(p.meaning)) + "”)";
        }).join(" + ");
        const h = el("div", "hist");
        h.innerHTML = "From <span class=\"origin\">" + escapeHtml(origins.join(" and ")) + "</span> — " + chain + ".";
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

  // ---------- Ancestry card (trees/<xx>.json from the canonical graph) ----------
  // Node: { l:lang, t:term, k:edge kind, s:sources, g:gloss, hw:headword,
  //         x:contested, d:descendant count, n:pivot key, c:[parents…] }
  const treeShardCache = {};
  function fetchTreeShard(key) {
    if (!treeShardCache[key]) {
      treeShardCache[key] = fetch("trees/" + key + ".json?v=" + DATA_V)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return treeShardCache[key];
  }
  // canonical node key, mirroring build-etymgraph.js foldTerm:
  // NFD, strip combining marks, lowercase, drop asterisks
  function ancNodeKey(lang, term) {
    const t = String(term || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\*/g, "").trim();
    return lang + "|" + t;
  }
  // pivot index is sharded by first character of the folded term
  const descShardCache = {};
  function fetchDescShard(key) {
    const term = key.slice(key.indexOf("|") + 1);
    let c = (term[0] || "_").toLowerCase();
    if (!/^[a-z]$/.test(c)) c = "_";
    if (!descShardCache[c]) {
      descShardCache[c] = fetch("trees/_desc-" + c + ".json?v=" + DATA_V)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return descShardCache[c];
  }

  const ANC_KIND = { inh: "inherited from", bor: "borrowed from", der: "from", aff: "affix", cmp: "compound of", root: "root" };
  const ANC_SRC = { e: "Wiktionary etymology parse", k: "Wiktionary etymon tree", y: "EtymDB" };

  function ancSrcTitle(s) {
    return (s || "").split("").map(function (c) { return ANC_SRC[c] || c; }).join(" + ");
  }

  function buildAncestryRows(node, depth, rows, budget) {
    const kids = node.c || [];
    for (let i = 0; i < kids.length; i++) {
      if (budget.n >= budget.max) { budget.overflow = true; return; }
      budget.n++;
      rows.push({ node: kids[i], depth: depth, alt: kids.length > 1 && i > 0 });
      buildAncestryRows(kids[i], depth + 1, rows, budget);
    }
  }

  function ancRowEl(r, token, refocus) {
    const row = el("div", "anc-row" + (r.alt ? " anc-alt" : ""));
    row.style.paddingLeft = Math.min(r.depth, 7) * 14 + "px";
    const n = r.node;

    const line = el("div", "anc-line");
    if (r.depth > 0) line.appendChild(el("span", "anc-tick", "└"));
    if (n.k) line.appendChild(el("span", "anc-kind", ANC_KIND[n.k] || n.k));
    const term = el("span", "anc-term", n.t);
    if (n.s) term.title = ancSrcTitle(n.s);
    line.appendChild(el("span", "anc-lang", n.l));
    line.appendChild(term);
    if (n.g) line.appendChild(el("span", "anc-gloss", "“" + firstSense(n.g) + "”"));
    if (n.x) {
      const b = el("span", "anc-badge", "contested");
      b.title = "Sources disagree on this word's route — all recorded routes are shown.";
      line.appendChild(b);
    }
    if (n.hw) {
      term.classList.add("anc-link");
      term.addEventListener("click", function (e) { e.stopPropagation(); runFromLink(n.hw); });
    }
    // tapping the row itself refocuses the tree on this ancestor (its
    // subtree is already in the loaded data)
    if (refocus && (n.c || []).length) {
      row.classList.add("anc-focusable");
      line.addEventListener("click", function () { refocus(n); });
    }
    row.appendChild(line);

    if (n.d) {
      const key = ancNodeKey(n.l, n.t);
      const pivot = el("button", "anc-pivot", "+" + n.d + " words from this root");
      pivot.type = "button";
      const panel = el("div", "anc-desc"); panel.hidden = true;
      pivot.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!panel.hidden) { panel.hidden = true; return; }
        fetchDescShard(key).then(function (idx) {
          if (token !== runToken) return;
          panel.innerHTML = "";
          const words = idx[key] || [];
          words.forEach(function (w) {
            const chip = el("button", "anc-desc-word", w);
            chip.type = "button";
            chip.addEventListener("click", function (ev) { ev.stopPropagation(); runFromLink(w); });
            panel.appendChild(chip);
          });
          if (!words.length) panel.appendChild(el("span", "anc-desc-empty", "No list for this root yet."));
          panel.hidden = false;
          panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      });
      row.appendChild(pivot);
      row.appendChild(panel);
    }
    return row;
  }

  function runFromLink(w) { run(w); }

  function buildAncestryCard(word, token) {
    const key = word.slice(0, 2).toLowerCase();
    if (!/^[a-z]{2}$/.test(key)) return Promise.resolve(null);
    return fetchTreeShard(key).then(function (sh) {
      const tree = sh[word] || sh[word.toLowerCase()];
      if (!tree || !tree.c || token !== runToken) return null;
      const card = el("div", "card anc-card");
      card.appendChild(el("div", "cap", "Ancestry"));
      const crumb = el("div", "anc-crumb"); crumb.hidden = true;
      card.appendChild(crumb);
      const holder = el("div", "anc-holder");
      card.appendChild(holder);
      const more = el("button", "anc-more", "Show the full tree");
      more.type = "button";
      card.appendChild(more);

      // render(focusNode): the card can refocus on any ancestor — its
      // subtree is already in this tree object. A crumb walks back out.
      const stack = [];
      function render(node, full) {
        holder.innerHTML = "";
        const rows = [];
        const budget = { n: 0, max: full ? 200 : 14, overflow: false };
        buildAncestryRows(node, 0, rows, budget);
        const refocus = function (child) { stack.push(node); render(child, false); };
        rows.forEach(function (r) { holder.appendChild(ancRowEl(r, token, refocus)); });
        crumb.hidden = !stack.length;
        if (stack.length) {
          crumb.innerHTML = "";
          const back = el("button", "anc-back", "← back");
          back.type = "button";
          back.addEventListener("click", function () { render(stack.pop(), false); });
          crumb.appendChild(back);
          crumb.appendChild(el("span", "anc-crumb-word", node.l + " " + node.t));
        }
        more.hidden = !budget.overflow;
        more.onclick = function () { render(node, true); };
      }
      render(tree, false);
      return card;
    });
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

  // ---------- word-family tree ----------
  // Prefixes are bundled by sense so the top of a family isn't a long flat list.
  // A group only actually forms when ≥2 of its prefixes appear (see buildFamilyTree),
  // so a lone prefix still shows directly — no weird one-item groups.
  const CLUSTER = {
    "Place / direction": ["ad", "ab", "de", "e", "in-loc", "ex", "sub", "super", "trans", "cis", "circum", "inter", "intra",
      "extra", "intro", "retro", "peri", "para", "dia", "epi", "per", "pro", "ecto", "endo", "exo"],
    "Time / order": ["pre", "post", "ante", "fore", "neo", "paleo", "proto"],
    "Negation": ["a-priv", "in-neg", "un", "non", "dis"],
    "Against": ["anti", "contra", "ob"],
    "Together": ["co", "syn"],
    "Number": ["bi", "tri", "uni", "mono", "multi", "poly", "semi", "hemi", "deca", "cent", "quadr", "penta", "oct", "milli", "kilo"],
    "Degree": ["hyper", "hypo", "iso", "ultra", "infra", "supra", "mega", "macro", "micro"],
    "Self / other": ["auto", "homo", "hetero", "allo"],
    "Again / back": ["re"],
  };
  const PRE_CLUSTER = {};
  Object.keys(CLUSTER).forEach(function (c) { CLUSTER[c].forEach(function (id) { PRE_CLUSTER[id] = c; }); });

  function dotted(w) { // word split by morpheme, joined with subtle dots
    try {
      const ps = window.EtymologyEngine.decompose(w).parts;
      if (ps.length > 1) return ps.map(function (p) { return p.surface; }).join("·");
    } catch (e) {}
    return w;
  }

  let treeRoot = null;     // the family tree (grows in place as you expand)
  let treeToken = 0;
  let openingFromTree = false; // set when a word is opened by tapping a tree chip
  let treeReturn = false;      // current word came from a tree → offer a way back
  const treeCache = {};    // root id -> promise of its family root node
  function closeTree() { treeEl.hidden = true; treeEl.classList.remove("tree-in"); treeEl.innerHTML = ""; treeToken++; }

  // Hand-curated family (from the curator editor) for a root id, if one exists.
  // Fetched fresh each open (no-store) so it follows editor saves after deploy.
  function loadFamily(id) {
    return fetch("family/" + id + ".json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

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
  // A "Word family" card for the word page: if any root has a curated family that
  // contains this word, show which region it lives in and a button to open the tree.
  async function buildFamilyCard(parts, word, token) {
    const rootParts = (parts || []).filter(function (p) { return p.kind === "root" && p.id; });
    for (const rp of rootParts) {
      const fam = await loadFamily(rp.id);
      if (token !== runToken) return null;
      if (!fam || !fam.placements) continue;
      const pl = fam.placements.find(function (p) { return p.w === word; });
      const col = fam.collapse && fam.collapse[word];
      if (!pl && !col) continue;
      const card = el("div", "card fam-card");
      card.appendChild(el("div", "cap", "Word family"));
      const row = el("div", "fam-row");
      const region = pl && (fam.regions || []).find(function (r) { return r.id === pl.region; });
      const where = el("div", "fam-where");
      where.innerHTML = '<span class="fam-root">' + escapeHtml(fam.rootLabel || (rp.surface + "-")) + "</span>" +
        (region ? ' · <span class="fam-region">' + escapeHtml(region.label) + "</span>" : "");
      row.appendChild(where);
      const btn = el("button", "fam-open", "Open tree →"); btn.type = "button";
      btn.addEventListener("click", function () { openTreeRoot(rp, word); });
      row.appendChild(btn);
      card.appendChild(row);
      const sub = region ? region.gloss : (col ? (col.t + " " + col.l) : "");
      if (sub) card.appendChild(el("div", "fam-gloss", sub));
      return card;
    }
    return null;
  }

  // Convert the curator's placement format into the tree's node shape: regions are
  // groups (by meaning), placements nest by parent (descent). A word placed more
  // than once in a region (different senses) is shown once — its senses associate.
  function curatedFamilyTree(doc, rootPart) {
    const byRegion = {};
    (doc.placements || []).forEach(function (p) { (byRegion[p.region] = byRegion[p.region] || []).push(p); });
    const regionNodes = (doc.regions || []).map(function (rg) {
      const here = byRegion[rg.id] || [];
      const parentOf = {}, order = [], meta = {};
      here.forEach(function (p) { if (!(p.w in parentOf)) { parentOf[p.w] = p.parent || null; order.push(p.w); meta[p.w] = p; } });
      const present = {}; order.forEach(function (w) { present[w] = 1; });
      const isTop = function (w) { const par = parentOf[w]; return !par || !present[par]; };
      function build(par) {
        return order.filter(function (w) { return par === null ? isTop(w) : parentOf[w] === par; })
          .sort(function (a, b) { return a.localeCompare(b); })
          .map(function (w) {
            const m = meta[w] || {};
            // A "source" placement (e.g. Latin conferre) is a label node, not a
            // dictionary entry: it carries its own gloss/lang and doesn't navigate.
            return { type: "word", word: w, current: false, kind: m.kind || null,
              lang: m.lang || null, glossText: m.gloss || null, tag: m.tag || null, children: build(w) };
          });
      }
      const kids = build(null);
      if (!kids.length) return null;
      // Count is the entries immediately connected to this category, not the
      // whole subtree.
      return { type: "group", label: rg.label, gloss: rg.gloss || "", count: kids.length, children: kids };
    }).filter(Boolean);
    return { type: "root", label: doc.rootLabel || rootPart.surface, infinitive: !!doc.rootLabel, source: rootPart.source,
      gloss: doc.rootGloss || ((rootPart.source || rootPart.surface) + (rootPart.meaning ? " · " + firstSense(rootPart.meaning) : "")),
      children: regionNodes, _open: true };
  }

  // Build each root's family in the background as the word card opens, so a tree
  // animates in instantly when its button is tapped.
  function prefetchTree(word, parts) {
    (parts || []).forEach(function (rp) {
      if (rp.kind !== "root" || !rp.id || treeCache[rp.id]) return;
      treeCache[rp.id] = loadData().then(async function () {
        const fam = (MORPH[rp.id] || []).filter(function (w) { return w !== word && /^[a-z]{2,}$/.test(w) && w.length <= 16; });
        const valid = await validateWords(fam, 200);
        return buildFamilyTree(rp, word, valid);
      }).catch(function () { return null; });
    });
  }

  async function openTreeRoot(rootPart, word) {
    if (!rootPart || !rootPart.id) return;
    const token = ++treeToken;
    contentEl.classList.add("to-tree"); // the card contracts away
    // Prefer a hand-curated family (family/<id>.json, edited in the curator) and
    // fall back to the heuristic prefix-grouped tree when there isn't one.
    const curated = await loadFamily(rootPart.id);
    let root;
    if (curated && curated.placements && curated.placements.length) {
      root = curatedFamilyTree(curated, rootPart);
    } else {
      if (!treeCache[rootPart.id]) prefetchTree(word, [rootPart]);
      root = await treeCache[rootPart.id];
    }
    await delay(170);
    if (token !== treeToken) { contentEl.classList.remove("to-tree"); return; }
    contentEl.classList.remove("to-tree");
    if (!root) { closeTree(); return; }
    treeEl.hidden = false; treeEl.classList.add("tree-in");
    treeRoot = root;
    resetTreeState(treeRoot); treeRoot._open = true; // clear flags from a prior open
    const cur = expandToCurrent(treeRoot, word); // open the path down to the word we came from
    renderTree(cur);
  }
  // Shrink the current word page back into the tree it came from (X / back).
  function returnToTree() {
    if (!treeRoot) return;
    const token = ++treeToken;
    contentEl.classList.add("to-tree");
    setTimeout(function () {
      if (token !== treeToken) return;
      contentEl.classList.remove("to-tree");
      treeEl.hidden = false; treeEl.classList.add("tree-in");
      renderTree(null);
    }, 190);
  }

  function countWords(nodes) {
    return nodes.reduce(function (n, c) { return n + (c.type === "word" ? 1 : 0) + countWords(c.children || []); }, 0);
  }

  // ---- decomposition helpers (cached per tree build) ----
  function decompParts(w, cache) {
    if (cache[w]) return cache[w];
    let ps = [];
    try { ps = window.EtymologyEngine.decompose(w).parts; } catch (e) {}
    cache[w] = ps; return ps;
  }
  function firstPrefixOf(w, cache) {
    const ps = decompParts(w, cache);
    for (let i = 0; i < ps.length; i++) { if (ps[i].kind === "prefix") return ps[i]; if (ps[i].kind === "root") break; }
    return null;
  }
  // A "complex" word is more than a bare root (+ silent e): it carries a prefix,
  // a real suffix, or a second root — so other words can derive *from* it.
  function isComplexWord(w, cache) {
    const ps = decompParts(w, cache);
    let roots = 0, pre = false, suf = false;
    ps.forEach(function (p) {
      if (p.kind === "prefix") pre = true;
      else if (p.kind === "root") roots++;
      else if (p.kind === "suffix" && !p.silentE) suf = true;
    });
    return pre || suf || roots >= 2;
  }

  // Build one derivation forest over the whole family, then group its roots by
  // their leading prefix. A word descends from another when it merely adds a
  // suffix (transcribe → transcribed) or when stripping its prefix leaves a
  // complete, already-complex family word (nontelescopic → telescopic). A bare
  // prefix+root form (transcribe, transcript) has no such parent, so it sits
  // directly in its prefix group — making transcribe and transcript siblings
  // under "trans-".
  function buildFamilyTree(rootPart, headword, words) {
    const dcache = {};
    const list = []; const have = {};
    words.concat([headword]).forEach(function (w) { if (!have[w]) { have[w] = 1; list.push(w); } });
    const byWord = {};
    list.forEach(function (w) { byWord[w] = { type: "word", word: w, current: w === headword, children: [] }; });

    function parentOf(w) {
      // (a) suffix derivation — the longest shorter family word w extends. A
      // derived word shares its parent's *stem*, not always its exact spelling:
      // geology → geolog·ical / geolog·ist, so strip a final e/y before matching.
      let best = null, bestLen = 0;
      list.forEach(function (p) {
        if (p === w || p.length >= w.length) return;
        const stem = (p.length >= 5 && /[ey]$/.test(p)) ? p.slice(0, -1) : p;
        if (stem.length >= 4 && w.indexOf(stem) === 0 && p.length > bestLen) { best = p; bestLen = p.length; }
      });
      if (best) return best;
      // (b) prefix derivation — strip the leading prefix; if a complete, complex
      // family word remains, w descends from it
      const pre = firstPrefixOf(w, dcache);
      if (pre) {
        const stem = w.slice(pre.surface.length);
        if (stem !== w && byWord[stem] && isComplexWord(stem, dcache)) return stem;
      }
      return null;
    }

    const roots = [];
    list.forEach(function (w) {
      const par = parentOf(w);
      if (par && byWord[par]) byWord[par].children.push(byWord[w]); else roots.push(byWord[w]);
    });
    (function sortKids(nodes) {
      nodes.sort(function (a, b) { return a.word.length - b.word.length || a.word.localeCompare(b.word); });
      nodes.forEach(function (n) { sortKids(n.children); });
    })(roots);

    // group the forest roots by leading prefix (or a "base" group of bare roots)
    const groups = {};
    roots.forEach(function (n) {
      const pre = firstPrefixOf(n.word, dcache);
      if (pre) {
        const lab = (pre.source || pre.surface).replace(/[-\s]+$/, "") + "-"; // canonical: trans-, not tran-
        const g = groups[pre.id] || (groups[pre.id] = { id: pre.id, label: lab,
          gloss: (pre.source || pre.surface) + (pre.meaning ? " · " + firstSense(pre.meaning) : ""), nodes: [] });
        g.nodes.push(n);
      } else {
        const g = groups["(base)"] || (groups["(base)"] = { id: "(base)", base: true,
          label: rootPart.surface, gloss: "the root as a word", nodes: [] });
        g.nodes.push(n);
      }
    });

    let baseNode = null; const direct = []; const clusters = {};
    Object.keys(groups).forEach(function (k) {
      const g = groups[k];
      g.nodes.sort(function (a, b) { return a.word.length - b.word.length || a.word.localeCompare(b.word); });
      const words = countWords(g.nodes);
      const node = { type: "group", label: g.label, gloss: g.gloss, count: words, _weight: words, children: g.nodes, _root: rootPart.surface };
      if (g.base) { node._base = true; node._root = null; node.label = rootPart.surface; baseNode = node; return; }
      const cl = PRE_CLUSTER[g.id];
      if (cl) { (clusters[cl] = clusters[cl] || []).push(node); } else { direct.push(node); }
    });

    // a sense cluster forms only when ≥2 of its prefixes appear (else it didn't
    // group well — show those prefixes directly). Its number is the count of
    // affixes it bundles, not the number of words.
    const clusterNodes = [];
    Object.keys(clusters).forEach(function (cl) {
      const arr = clusters[cl].sort(function (a, b) { return b.count - a.count; });
      if (arr.length >= 2) clusterNodes.push({ type: "group", label: cl, gloss: "", count: arr.length,
        _weight: arr.reduce(function (n, p) { return n + p._weight; }, 0), _affixGroup: true, children: arr });
      else arr.forEach(function (n) { direct.push(n); });
    });

    let children = direct.concat(clusterNodes).sort(function (a, b) { return (b._weight || b.count) - (a._weight || a.count); });
    if (baseNode) children.unshift(baseNode); // base always first
    return { type: "root", label: rootPart.surface, source: rootPart.source,
      gloss: (rootPart.source || rootPart.surface) + (rootPart.meaning ? " · " + firstSense(rootPart.meaning) : ""),
      children: children, _open: true };
  }

  // A family tree is cached per root and shared by every word in the family, so
  // before (re)opening it we clear stale expansion/current flags — otherwise it
  // stays focused on whichever word first built it.
  function resetTreeState(node) {
    node._open = false;
    if (node.type === "word") node.current = false;
    (node.children || []).forEach(resetTreeState);
  }
  // Open every node on the path from the tree root down to `word` (and mark it
  // current), so the tree lands already expanded to it. Returns its node.
  function expandToCurrent(node, word) {
    let found = (node.type === "word" && node.word === word) ? node : null;
    if (found) node.current = true;
    (node.children || []).forEach(function (k) { const f = expandToCurrent(k, word); if (f) found = found || f; });
    if (found && found !== node) node._open = true;
    return found;
  }

  // Open (or close) every branch in the tree.
  function setAllOpen(node, on) {
    if (node.children && node.children.length) node._open = on;
    (node.children || []).forEach(function (k) { setAllOpen(k, on); });
  }
  // Re-open just the path down to whichever word is currently marked.
  function openPathToCurrent(node) {
    if (node.type === "word" && node.current) return true;
    let found = false;
    (node.children || []).forEach(function (k) { if (openPathToCurrent(k)) found = true; });
    if (found) node._open = true;
    return found;
  }

  // The whole tree renders from treeRoot based on each node's _open flag, so it
  // accumulates: expanding a branch keeps everything else in place.
  function renderTree(opened) {
    treeEl.innerHTML = "";
    const head = el("div", "tree-head");
    const x = el("button", "tree-close", "✕"); x.type = "button";
    x.setAttribute("aria-label", "Close tree");
    x.addEventListener("click", closeTree);
    head.appendChild(x);
    head.appendChild(el("div", "tree-title", "Word family · " + treeRoot.label + (treeRoot.infinitive ? "" : "-")));
    // Show-all / collapse toggle — expand every branch at once, or fold back to
    // just the path to the current word.
    const allBtn = el("button", "tree-all", treeRoot._allOpen ? "Collapse" : "Show all");
    allBtn.type = "button";
    allBtn.addEventListener("click", function () {
      treeRoot._allOpen = !treeRoot._allOpen;
      if (treeRoot._allOpen) { setAllOpen(treeRoot, true); }
      else { setAllOpen(treeRoot, false); treeRoot._open = true; openPathToCurrent(treeRoot); }
      renderTree(null);
    });
    head.appendChild(allBtn);
    treeEl.appendChild(head);

    const body = el("div", "tree-body");
    const canvas = el("div", "tree-canvas");
    const links = el("div", "tree-links"); canvas.appendChild(links);
    canvas.appendChild(renderNode(treeRoot));
    body.appendChild(canvas);
    treeEl.appendChild(body);

    requestAnimationFrame(function () {
      drawAllLinks(canvas, links);
      if (opened && opened._el && opened._el.scrollIntoView) {
        opened._el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }
    });
  }

  function toggle(node, opened) {
    node._open = !node._open;
    node._justOpen = node._open;
    renderTree(node._open ? node : null);
  }

  function renderNode(node) {
    const row = el("div", "tnode-row");
    const chip = node.type === "root" ? rootChip(node) : nodeChip(node);
    node._el = chip;
    row.appendChild(chip);
    if (node.children && node.children.length && node._open) {
      const kids = el("div", "tnode-kids" + (node._justOpen ? " just-open" : ""));
      node._justOpen = false;
      node.children.forEach(function (c) { kids.appendChild(renderNode(c)); });
      row.appendChild(kids);
    }
    return row;
  }

  function rootChip(node) {
    const c = el("div", "tree-root");
    c.appendChild(el("div", "tree-root-w", node.label + (node.infinitive ? "" : "-")));
    if (node.gloss) c.appendChild(el("div", "tree-root-g", node.gloss));
    return c;
  }

  function nodeChip(node) {
    const expandable = node.children && node.children.length;
    if (node.type === "word") {
      const isSource = node.kind === "source"; // Latin label node, not an entry
      const c = el("div", "tnode word" + (node.current ? " current" : "") + (isSource ? " source" : ""));
      const wrap = el("span", "tnode-w");
      // Source labels (Latin lemmas) are shown whole; entries get morpheme dots.
      wrap.appendChild(document.createTextNode(isSource ? node.word : dotted(node.word)));
      if (node.lang) wrap.appendChild(el("span", "tnode-lang", node.lang));
      c.appendChild(wrap);
      const g = el("span", "tnode-sub", node.glossText ? shortGloss(node.glossText) : ""); c.appendChild(g);
      if (!expandable) c.appendChild(el("span", "tnode-mark dot", ""));
      if (!node.glossText) getWord(node.word).then(function (rec) {
        const def = rec && rec.d && rec.d[0] && rec.d[0].g;
        if (def) g.textContent = shortGloss(def);
      });
      c.setAttribute("role", "button"); c.setAttribute("tabindex", "0");
      if (!isSource) {
        const open = function () { openingFromTree = true; closeTree(); run(node.word); };
        c.addEventListener("click", open);
        c.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      } else if (expandable) {
        // A source label (Latin conferre) doesn't open a page — the whole chip
        // just expands/collapses its descendants.
        c.addEventListener("click", function () { toggle(node); });
        c.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(node); } });
      }
      if (expandable) { // also a branch — a toggle reveals the words derived from it
        // Big hit target: the right third of the chip toggles, so the +/− is easy
        // to hit without opening the word. (Source chips already toggle wholesale.)
        if (!isSource) {
          const hit = el("button", "tnode-hit", ""); hit.type = "button";
          hit.setAttribute("aria-label", (node._open ? "Hide" : "Show") + " words from " + node.word);
          hit.addEventListener("click", function (e) { e.stopPropagation(); toggle(node); });
          c.appendChild(hit);
        }
        c.appendChild(el("span", "tnode-mark plus", node._open ? "−" : "+"));
      }
      return c;
    }
    // group (sense category / prefix step) — tapping expands/collapses it
    const c = el("div", "tnode step" + (node._open ? " open" : ""));
    const w = el("span", "tnode-w");
    if (node._root) { // affix chip: show the root with it, e.g. "trans- + scrīb"
      w.innerHTML = '<span class="t-aff">' + escapeHtml(node.label) + '</span><span class="t-plus"> + </span><span class="t-root">' + escapeHtml(node._root) + "</span>";
    } else { w.textContent = node.label; }
    c.appendChild(w);
    if (node.gloss) c.appendChild(el("span", "tnode-sub", node.gloss));
    c.appendChild(el("span", "tnode-count", String(node.count)));
    c.appendChild(el("span", "tnode-mark plus", node._open ? "−" : "+"));
    c.setAttribute("role", "button"); c.setAttribute("tabindex", "0");
    const t = function () { toggle(node); };
    c.addEventListener("click", t);
    c.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(); } });
    return c;
  }

  // one SVG of curved connectors over the whole canvas, redrawn on every change
  function drawAllLinks(canvas, links) {
    if (!canvas.querySelectorAll || typeof canvas.offsetWidth !== "number") return;
    const rows = canvas.querySelectorAll(".tnode-row");
    let p = "";
    Array.prototype.forEach.call(rows, function (row) {
      if (row.children.length < 2) return;
      const chip = row.children[0], kids = row.children[1];
      const sx = chip.offsetLeft + chip.offsetWidth, sy = chip.offsetTop + chip.offsetHeight / 2;
      Array.prototype.forEach.call(kids.children, function (kr) {
        const cc = kr.children[0];
        const ex = cc.offsetLeft, ey = cc.offsetTop + cc.offsetHeight / 2, mx = (sx + ex) / 2;
        p += '<path d="M' + sx + ' ' + sy + ' C' + mx + ' ' + sy + ' ' + mx + ' ' + ey + ' ' + ex + ' ' + ey +
          '" fill="none" stroke="rgba(245,235,215,0.32)" stroke-width="1.6"/>';
      });
    });
    const w = canvas.scrollWidth || canvas.offsetWidth, h = canvas.scrollHeight || canvas.offsetHeight;
    links.innerHTML = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="position:absolute;inset:0;overflow:visible">' + p + "</svg>";
  }

  // ---------- typeahead ----------
  let suggestToken = 0;
  function hideSuggest() { suggestEl.hidden = true; suggestEl.innerHTML = ""; }
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
      // pointerdown fires before the input's blur-hide, so the tap always lands
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); hideSuggest(); run(w); });
      b.addEventListener("click", function () { hideSuggest(); run(w); });
      li.appendChild(b);
      suggestEl.appendChild(li);
    });
    suggestEl.hidden = false;
  }

  // ---------- events ----------
  function submit() { input.blur(); hideSuggest(); run(input.value); }
  form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  form.querySelector(".search-btn").addEventListener("click", function (e) { e.preventDefault(); submit(); });
  // While focused (typing), fold the ⌂ ‹ › nav buttons away so the search bar
  // expands to the full dock width; restore them on blur.
  const dockRow = document.querySelector(".dock-row");
  function setTyping(on) { if (dockRow && dockRow.classList) dockRow.classList[on ? "add" : "remove"]("typing"); }
  input.addEventListener("input", onType);
  input.addEventListener("focus", function () { setTyping(true); if (!input.value.trim()) showRecent(); });
  input.addEventListener("blur", function () { setTimeout(function () { setTyping(false); hideSuggest(); hideRecent(); }, 150); });
  if (navHome) navHome.addEventListener("click", goHome);
  if (navBack) navBack.addEventListener("click", goBack);
  if (navFwd) navFwd.addEventListener("click", goFwd);
  document.querySelectorAll(".example").forEach(function (btn) {
    btn.addEventListener("click", function () { run(btn.dataset.word); });
  });
  // Home chips: three SHOWCASE classics that decompose beautifully (the
  // first-tap demo) plus three random discovery words from quiz-pool.json —
  // already vetted for "decent data" (real headwords, proper nouns/taxa/
  // inflections excluded, usage breadth in a healthy band) by
  // scripts/build-quiz-pool.js. All-random chips made a weak first
  // impression: the pool is full of rare words ("gallinula") that don't
  // show off the breakdown animation at all.
  const SHOWCASE = ["biography", "incredible", "democracy", "prescription",
    "philosophy", "microscope", "circumnavigate", "photosynthesis", "manuscript"];
  function renderHomeChips() {
    const chipsEl = document.querySelector(".chips");
    if (!chipsEl) return;
    getEraPool().then(function (pool) {
      if (!pool.length) return;
      const words = qShuffle(SHOWCASE).slice(0, 3)
        .concat(qShuffle(pool).map(function (p) { return p.w; }))
        .filter(function (w, i, a) { return a.indexOf(w) === i; })
        .slice(0, 6);
      chipsEl.innerHTML = "";
      words.forEach(function (w) {
        const b = el("button", "example", w);
        b.type = "button"; b.dataset.word = w;
        b.addEventListener("click", function () { run(w); });
        chipsEl.appendChild(b);
      });
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

  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);

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
