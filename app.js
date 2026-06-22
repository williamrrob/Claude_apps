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
  const DATA_V = "19";
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
    const key = String(word || "").slice(0, 2).toLowerCase();
    return fetchShard(key).then(function (sh) { return sh ? (sh[word] || null) : null; });
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
    return /\b(\d{3,4}|born|died|politician|philosopher|mathematician|physicist|chemist|scientist|writer|author|poet|dramatist|playwright|novelist|composer|painter|sculptor|artist|architect|king|queen|emperor|empress|prince|princess|saint|pope|actor|actress|singer|musician|general|president|monarch|leader|deity|god|goddess|hero)\b/i.test(desc)
      || /^(capital|city|town|municipality|village|commune|river|mountain|lake|island|countr|state|province|region|county|district|nation|kingdom|empire|sea|ocean|continent|settlement|locality|peninsula)\b/i.test(desc);
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
      if (wp.type === "standard" && wp.thumb) {
        const card = buildImageCard(wp);
        const thes = cardsEl.querySelector ? cardsEl.querySelector(".thes-card") : null;
        if (thes) cardsEl.insertBefore(card, thes); // near the end, before related words
        else cardsEl.appendChild(card);
        requestAnimationFrame(function () { card.classList.add("in"); });
      }
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
  let MFORMS = null;
  function morphFind(s) {
    if (!MFORMS) {
      MFORMS = {};
      const M = window.MORPHEMES || {};
      ["prefixes", "roots", "suffixes"].forEach(function (cat) {
        (M[cat] || []).forEach(function (e) {
          (e.forms || []).forEach(function (f) { if (!MFORMS[f]) MFORMS[f] = e; });
        });
      });
    }
    return MFORMS[s] || MFORMS[s.replace(/^-|-$/g, "")] || null;
  }
  function hybridPart(x) {
    const e = morphFind(x.s);
    if (e) return { kind: x.k, surface: x.s, origin: e.origin, source: e.source, meaning: e.meaning, id: e.id, forms: e.forms };
    return { kind: x.k, surface: x.s, origin: null, source: null, meaning: x.g || null, id: null, forms: null };
  }
  function chooseBreakdown(result, rec) {
    // Eponyms / place names aren't built from roots — "davenport" is a surname,
    // not a·ven·port. When the etymology says so (and Wiktionary offers no real
    // affix split), present the word whole instead of force-splitting it.
    const ety = (rec && rec.e) || "";
    const eponym = /named after|\bsurname\b|\beponym|place name|toponym|genericized trademark/i.test(ety);
    if (eponym && !(rec && rec.b && rec.b.length >= 2)) {
      return [{ kind: "word", surface: result.word, origin: null, source: null, meaning: null, id: null, forms: null, whole: true }];
    }
    const bad = !result.hasRoot ||
      result.parts.some(function (p) { return p.kind === "unknown"; }) ||
      (result.confidence || 0) < 0.6;
    if (bad && rec && rec.b && rec.b.length >= 2) return rec.b.map(hybridPart);
    // No Wiktionary rescue available: a split with no real root, or one carrying a
    // big unknown chunk (e.g. colpomicroscope → col·pomicr·o·scop·e), is worse than
    // showing the word whole.
    const bigUnknown = result.parts.some(function (p) { return p.kind === "unknown" && p.surface.length >= 4; });
    if (bad && (!result.hasRoot || bigUnknown)) {
      return [{ kind: "word", surface: result.word, origin: null, source: null, meaning: null, id: null, forms: null, whole: true }];
    }
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
    if (contentEl) contentEl.scrollTop = 0;
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

  async function run(rawWord) {
    const word = String(rawWord || "").trim();
    if (!word) return;
    const token = ++runToken;
    input.value = word;
    input.blur(); // dismiss the keyboard so the dock returns to the bottom
    hideSuggest();
    hideRecent();
    if (themeToggle) themeToggle.hidden = true; // toggle lives on the home screen only
    if (!browseEl.hidden) closeBrowse();
    if (treeEl && !treeEl.hidden) closeTree();
    hint.hidden = true;
    loadData();
    if (contentEl) contentEl.scrollTop = 0;
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
      if (!rec0 || (!(rec0.d && rec0.d.length) && !rec0.e)) {
        // Not an English headword — maybe it's a source word (a Latin/Greek/PIE
        // root). Try the built-in lexicon first, then a quick live lookup.
        await loadRoots();
        if (token !== runToken) return;
        const rk = foldKey(result.word);
        if (ROOTS && ROOTS[rk]) { pushHistory(result.word); pushNav(result.word); renderSource(ROOTS[rk], token); return; }
        showStatus("Looking up “" + escapeHtml(result.word) + "” …", false);
        const online = await lookupOnline(result.word);
        if (token !== runToken) return;
        if (online) { pushHistory(result.word); pushNav(result.word); renderSource(online, token); return; }
        showStatus("“" + escapeHtml(result.word) + "” isn’t in the dictionary.", true);
        return;
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
    // tree button (top-left) — collapse this card into the word-family tree
    if (parts && parts.some(function (p) { return p.kind === "root" && p.id; })) {
      const tb = el("button", "tree-btn"); tb.type = "button";
      tb.setAttribute("aria-label", "Show " + word + " in the word-family tree");
      tb.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M7.2 11 16 6.6M7.2 13 16 17.4"/></svg>';
      tb.addEventListener("click", function () { openTree(word, parts); });
      ruleRow.appendChild(tb);
    }
    ruleRow.appendChild(el("span", "entry-rule"));
    const pos = rec && rec.d && rec.d[0] && rec.d[0].p;
    if (pos) ruleRow.appendChild(el("span", "entry-pos", pos));
    entryEl.appendChild(ruleRow);

    // headword with subtle dots between its parts
    const wordEl = el("div", "entry-word");
    const surfaces = (parts && parts.length > 1 && !parts[0].whole) ? parts.map(function (p) { return p.surface; }) : [word];
    surfaces.forEach(function (s, i) {
      if (i) wordEl.appendChild(el("span", "entry-dot", "·"));
      wordEl.appendChild(el("span", "ew-part", s));
    });
    entryEl.appendChild(wordEl);

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
    const gloss = rec && rec.d && rec.d[0] && rec.d[0].g;
    if (gloss) entryEl.appendChild(el("div", "entry-gloss", shortGloss(gloss)));
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
    const parts = chooseBreakdown(result, rec);
    const isWhole = parts.length === 1 && parts[0].whole;

    if (!rec || !rec.d || !rec.d.length) {
      noteEl.textContent = isWhole
        ? "“" + result.word + "” isn’t in the dictionary."
        : "“" + result.word + "” isn’t in the dictionary — here’s how its parts would break down.";
      noteEl.hidden = false;
    }

    // 1) headword
    buildEntry(result.word, rec, parts);
    requestAnimationFrame(function () { entryEl.classList.add("in"); });
    await delay(110); if (token !== runToken) return;
    fillPron(recP, result.word, token);
    addWikiInfo(result.word, token); // lead image + proper-noun capitalization
    prefetchTree(result.word, parts); // build the family tree in the background

    // 2) Breakdown — pop in split, then stack into an acrostic, then unfold info.
    await delay(120); if (token !== runToken) return;
    const shown = isWhole ? parts : parts.filter(function (p) { return !(p.kind === "unknown" && p.surface.length < 3); });
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
    for (let i = 0; i < bpEls.length; i++) { if (token !== runToken) return; bpEls[i].classList.add("in"); await delay(navigating ? 0 : 130); }

    // Skip the animation for single-unit words ("ism"), reduced-motion users, and
    // when revisiting via the back/forward buttons (it's not a fresh discovery).
    if (reduceMotion || navigating || bpEls.length <= 1) {
      bd.classList.add("split"); bd.classList.add("stacked");
      bpEls.forEach(function (bp) { swapToSource(bp); bp.classList.add("open"); });
    } else {
      // 2) breathe out: gaps open and the dots grow in between the pieces
      await delay(360); if (token !== runToken) return;
      bd.classList.add("split");
      await delay(680); if (token !== runToken) return;
      // 3) breathe in: pieces draw back together and the dots fade away
      bd.classList.remove("split");
      await delay(560); if (token !== runToken) return;
      // 4) chase out toward the card's inner-left edge, leftmost first — each
      //    piece darts after the one before it
      for (let i = 0; i < bpEls.length; i++) { if (token !== runToken) return; bpEls[i].classList.add("exit"); await delay(210); }
      await delay(420); if (token !== runToken) return;
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
        await delay(180);
      }
    }

    // 3) Definition
    await delay(120); if (token !== runToken) return;
    const defCard = buildDefinitionCard(recP, token);
    cardsEl.appendChild(defCard);
    requestAnimationFrame(function () { defCard.classList.add("in"); });

    // 4) divider + Word history
    const divider = fleuron();
    const histCard = buildHistoryCard(recP, parts, token, divider);
    cardsEl.appendChild(divider);
    cardsEl.appendChild(histCard);
    requestAnimationFrame(function () { divider.classList.add("in"); histCard.classList.add("in"); });

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
    r1.appendChild(el("span", "mw", p.surface));
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
    // where it comes from — the source language and a one-line note about it
    const olang = p.origin === "Greek" ? "Ancient Greek" : p.origin;
    if (olang && LANGS[olang]) {
      const o = el("div", "bpw-origin");
      const h = el("div", "bpw-origin-head");
      h.appendChild(el("span", "bpw-origin-lang", olang));
      h.appendChild(el("span", "bpw-origin-era", LANGS[olang].era));
      o.appendChild(h);
      if (LANGS[olang].desc) o.appendChild(el("div", "bpw-origin-desc", LANGS[olang].desc));
      box.appendChild(o);
    }
    // deep-link to the full source-word entry (its derivatives + Wiktionary)
    if (p.source && /^[a-zà-ɏ'-]{2,}$/i.test(p.source) && foldKey(p.source) !== foldKey(currentWord)) {
      const link = el("button", "bpw-source"); link.type = "button";
      link.textContent = "Explore the source word: " + p.source + " →";
      link.addEventListener("click", function (e) { e.stopPropagation(); run(p.source); });
      box.appendChild(link);
    }
    const list = el("div", "card-related");
    list.appendChild(el("div", "related-empty", "finding words…"));
    box.appendChild(list);
    bp.classList.add("expanded");
    // into .bp-col so it lines up under the morpheme text, not the accent rule
    (bp.querySelector(".bp-col") || bp.querySelector(".bp-inner") || bp).appendChild(box);

    const token = runToken;
    loadData().then(async function () {
      if (token !== runToken || !bp.classList.contains("expanded")) return;
      const cand = (MORPH[p.id] || [])
        .filter(function (w) { return w !== currentWord && w.length <= 12; })
        .sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
        .slice(0, 40);
      const valid = await validateWords(cand, 18); // only words with real entries
      if (token !== runToken || !bp.classList.contains("expanded")) return;
      list.innerHTML = "";
      if (!valid.length) { list.appendChild(el("div", "related-empty", "No common words share this piece.")); return; }
      list.appendChild(el("div", "lab", "More words"));
      renderWordGroups(list, valid, p.kind);
    });
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

  // ---------- related word families ----------
  function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
  function clusterFamilies(words) {
    const sorted = words.slice().sort();
    const groups = [];
    sorted.forEach(function (w) {
      const g = groups[groups.length - 1];
      if (g && commonPrefix(g[g.length - 1], w) >= 4) g.push(w);
      else groups.push([w]);
    });
    groups.sort(function (a, b) { return b.length - a.length || a[0].localeCompare(b[0]); });
    return groups;
  }
  function renderWordGroups(box, words, kind) {
    const clean = words.filter(function (w) { return w.length <= 14; });
    const pick = (clean.length ? clean : words)
      .slice().sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
      .slice(0, 18);
    // one wrapping list so chips fill rows naturally (no ragged per-family rows)
    box.appendChild(chipRow(pick, kind));
  }
  function chipRow(words, kind) {
    const list = el("div", "related-list");
    words.forEach(function (w, i) {
      const c = el("button", "related-chip", w);
      if (kind) c.dataset.kind = kind;
      c.style.setProperty("--i", i);
      c.addEventListener("click", function (e) { e.stopPropagation(); run(w); });
      list.appendChild(c);
    });
    return list;
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

  function fillPron(recP, word, token) {
    const pe = pronEl; // capture: a later search may null/replace pronEl
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
      if (canSpeak) {
        if (ipa) pe.appendChild(el("span", "pdot", "•"));
        const rb = el("button", "resp speakable", resp || word);
        rb.type = "button";
        rb.setAttribute("aria-label", "Pronounce " + word);
        rb.addEventListener("click", function () { speak(word); });
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
    const card = el("div", "card");
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
          let html = '<span class="pos">' + escapeHtml(s.p) + "</span>" + escapeHtml(s.g);
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
  // Most prefixes sit directly under the root, but a few cohesive sets read better
  // bundled into a labelled group (you only see these when the root has them).
  const CLUSTER = {
    Number: ["bi", "tri", "uni", "mono", "multi", "poly", "semi", "hemi", "deca", "cent", "quadr", "penta", "oct", "milli", "kilo"],
    Target: ["auto", "homo", "hetero", "allo"],
    Degree: ["hyper", "hypo", "iso", "ultra", "infra", "supra"],
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
  const treeCache = {};    // word -> promise of its family root node
  function closeTree() { treeEl.hidden = true; treeEl.classList.remove("tree-in"); treeEl.innerHTML = ""; treeToken++; }

  // Build the family in the background as the word card opens, so the tree is
  // ready to animate in instantly when the tree button is tapped.
  function prefetchTree(word, parts) {
    const rootPart = (parts || []).filter(function (p) { return p.kind === "root" && p.id; })[0];
    if (!rootPart || treeCache[word]) return;
    treeCache[word] = loadData().then(async function () {
      const fam = (MORPH[rootPart.id] || []).filter(function (w) { return w !== word && /^[a-z]{2,}$/.test(w) && w.length <= 16; });
      const valid = await validateWords(fam, 200);
      return buildFamilyTree(rootPart, word, valid);
    }).catch(function () { return null; });
  }

  async function openTree(word, parts) {
    const rootPart = (parts || []).filter(function (p) { return p.kind === "root" && p.id; })[0];
    if (!rootPart) return;
    const token = ++treeToken;
    prefetchTree(word, parts);
    contentEl.classList.add("to-tree"); // the card contracts away
    const root = await treeCache[word];
    await delay(170);                   // let the contraction read
    if (token !== treeToken) { contentEl.classList.remove("to-tree"); return; }
    contentEl.classList.remove("to-tree");
    if (!root) { closeTree(); return; }
    treeEl.hidden = false;
    treeEl.classList.add("tree-in");
    treeRoot = root; treeRoot._open = true;
    renderTree(null);
  }

  // Nest words by derivation: a longer word that starts with a shorter family
  // word descends from it (transcribe → transcribed, transcriber; transcript →
  // transcription). Returns the forest roots; each node may itself have children.
  function deriveForest(words, headword) {
    const arr = words.slice().sort(function (a, b) { return a.length - b.length || a.localeCompare(b); });
    const nodes = arr.map(function (w) { return { type: "word", word: w, current: w === headword, children: [] }; });
    nodes.forEach(function (n) {
      let best = null;
      nodes.forEach(function (m) {
        if (m !== n && n.word.length > m.word.length && n.word.indexOf(m.word) === 0 && (!best || m.word.length > best.word.length)) best = m;
      });
      n._parent = best;
    });
    const roots = [];
    nodes.forEach(function (n) { (n._parent ? n._parent.children : roots).push(n); delete n._parent; });
    return roots;
  }
  function countWords(nodes) {
    return nodes.reduce(function (n, c) { return n + (c.type === "word" ? 1 : 0) + countWords(c.children || []); }, 0);
  }

  function buildFamilyTree(rootPart, headword, words) {
    // root → prefix groups (and a "base" group) → derivation forest of words
    const groups = {};
    words = words.concat([headword]); // the headword sits in the tree too
    const seen = {};
    words.forEach(function (w) {
      if (seen[w]) return; seen[w] = 1;
      let pre = null;
      try { pre = window.EtymologyEngine.decompose(w).parts.filter(function (p) { return p.kind === "prefix"; })[0]; } catch (e) {}
      if (pre) {
        const lab = (pre.source || pre.surface).replace(/[-\s]+$/, "") + "-"; // canonical: trans-, not tran-
        const g = groups[pre.id] || (groups[pre.id] = { label: lab, gloss: (pre.source || pre.surface) + (pre.meaning ? " · " + firstSense(pre.meaning) : ""), words: [] });
        g.words.push(w);
      } else {
        const g = groups["(base)"] || (groups["(base)"] = { label: "base", gloss: "the root as a word", words: [], base: true });
        g.words.push(w);
      }
    });
    // build a node per prefix; route a few into cohesive clusters, rest stay direct
    let baseNode = null; const direct = []; const clusters = {};
    Object.keys(groups).forEach(function (k) {
      const g = groups[k];
      const kids = deriveForest(g.words, headword);
      const node = { type: "group", label: g.label, gloss: g.gloss, count: countWords(kids), children: kids };
      if (g.base) { node._base = true; baseNode = node; return; }
      const cl = PRE_CLUSTER[k];
      if (cl) { (clusters[cl] = clusters[cl] || []).push(node); } else { direct.push(node); }
    });
    const clusterNodes = Object.keys(clusters).map(function (cl) {
      const ch = clusters[cl].sort(function (a, b) { return b.count - a.count; });
      return { type: "group", label: cl, gloss: "", count: ch.reduce(function (n, p) { return n + p.count; }, 0), children: ch };
    });
    let children = direct.concat(clusterNodes).sort(function (a, b) { return b.count - a.count; });
    if (baseNode) children.unshift(baseNode); // base always first
    return { type: "root", label: rootPart.surface, source: rootPart.source,
      gloss: (rootPart.source || rootPart.surface) + (rootPart.meaning ? " · " + firstSense(rootPart.meaning) : ""),
      children: children, _open: true };
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
    head.appendChild(el("div", "tree-title", "Word family · " + treeRoot.label + "-"));
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
    c.appendChild(el("div", "tree-root-w", node.label + "-"));
    if (node.gloss) c.appendChild(el("div", "tree-root-g", node.gloss));
    return c;
  }

  function nodeChip(node) {
    const expandable = node.children && node.children.length;
    if (node.type === "word") {
      const c = el("div", "tnode word" + (node.current ? " current" : ""));
      c.appendChild(el("span", "tnode-w", dotted(node.word)));
      const g = el("span", "tnode-sub", ""); c.appendChild(g);
      c.appendChild(el("span", "tnode-mark dot", ""));
      getWord(node.word).then(function (rec) {
        const def = rec && rec.d && rec.d[0] && rec.d[0].g;
        if (def) g.textContent = shortGloss(def);
      });
      c.setAttribute("role", "button"); c.setAttribute("tabindex", "0");
      const open = function () { closeTree(); run(node.word); };
      c.addEventListener("click", open);
      c.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      if (expandable) { // also a branch — a toggle reveals the words derived from it
        const t = el("button", "tnode-toggle", node._open ? "−" : "+"); t.type = "button";
        t.setAttribute("aria-label", (node._open ? "Hide" : "Show") + " words from " + node.word);
        t.addEventListener("click", function (e) { e.stopPropagation(); toggle(node); });
        c.appendChild(t);
      }
      return c;
    }
    // group (sense category / prefix step) — tapping expands/collapses it
    const c = el("div", "tnode step" + (node._open ? " open" : ""));
    c.appendChild(el("span", "tnode-w", node.label));
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
    Promise.all([fetchShard(key), loadRoots()]).then(function (res) {
      const sh = res[0];
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
  input.addEventListener("input", onType);
  input.addEventListener("focus", function () { if (!input.value.trim()) showRecent(); });
  input.addEventListener("blur", function () { setTimeout(function () { hideSuggest(); hideRecent(); }, 150); });
  if (navHome) navHome.addEventListener("click", goHome);
  if (navBack) navBack.addEventListener("click", goBack);
  if (navFwd) navFwd.addEventListener("click", goFwd);
  document.querySelectorAll(".example").forEach(function (btn) {
    btn.addEventListener("click", function () { run(btn.dataset.word); });
  });

  buildAlpha();
  loadData();
  renderHistory();
  updateNav();

  // Pin the word to the top: the compact header is a non-layout overlay toggled
  // purely from scroll position (with hysteresis), so it can't feed back into
  // the layout and flicker the way an IntersectionObserver did.
  if (contentEl && typeof contentEl.addEventListener === "function") {
    let miniShown = false;
    contentEl.addEventListener("scroll", function () {
      const y = contentEl.scrollTop || 0;
      if (currentWord && !miniShown && y > 72) { miniHead.classList.add("show"); miniShown = true; }
      else if (miniShown && (!currentWord || y < 40)) { miniHead.classList.remove("show"); miniShown = false; }
    });
  }

  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);
})();
