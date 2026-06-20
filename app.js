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
  const thumbEl = $("thumb");
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
  let thumbHandle = null, thumbRail = null, thumbCloseRail = null;

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
    currentWord = "";
    input.value = "";
    hint.hidden = false;
    if (themeToggle) themeToggle.hidden = false; // toggle returns on the home screen
    if (contentEl) contentEl.scrollTop = 0;
    highlightThumb("");
  }

  // ---------- stage ----------
  function clearStage() {
    entryEl.className = "entry"; entryEl.innerHTML = "";
    noteEl.hidden = true; noteEl.textContent = "";
    ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = "";
    cardsEl.innerHTML = "";
    miniHead.hidden = true; miniHead.innerHTML = "";
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
    hideSuggest();
    hideRecent();
    if (thumbCloseRail) thumbCloseRail();
    if (themeToggle) themeToggle.hidden = true; // toggle lives on the home screen only
    if (!browseEl.hidden) closeBrowse();
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
      // If we have neither a dictionary definition nor a Wiktionary etymology,
      // there's nothing trustworthy to show — don't invent a breakdown.
      const rec0 = await getWord(result.word);
      if (token !== runToken) return;
      if (!rec0 || (!(rec0.d && rec0.d.length) && !rec0.e)) {
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

  function buildEntry(word, rec) {
    entryEl.className = "entry"; entryEl.innerHTML = "";
    const ruleRow = el("div", "entry-rule-row");
    ruleRow.appendChild(el("span", "entry-rule"));
    const pos = rec && rec.d && rec.d[0] && rec.d[0].p;
    if (pos) ruleRow.appendChild(el("span", "entry-pos", pos));
    entryEl.appendChild(ruleRow);
    entryEl.appendChild(el("div", "entry-word", word));
    pronEl = el("div", "pron");
    entryEl.appendChild(pronEl);
    const gloss = rec && rec.d && rec.d[0] && rec.d[0].g;
    if (gloss) entryEl.appendChild(el("div", "entry-gloss", shortGloss(gloss)));
    // compact pinned header (revealed on scroll)
    miniHead.innerHTML = "";
    miniHead.appendChild(el("span", "minihead-word", word));
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
    buildEntry(result.word, rec);
    highlightThumb(result.word);
    requestAnimationFrame(function () { entryEl.classList.add("in"); });
    await delay(110); if (token !== runToken) return;
    fillPron(recP, result.word, token);

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

    // 1) pop each piece in as a tight row — boom boom boom
    for (let i = 0; i < bpEls.length; i++) { if (token !== runToken) return; bpEls[i].classList.add("in"); await delay(80); }
    await delay(340); if (token !== runToken) return;

    if (reduceMotion) {
      bd.classList.add("stacked");
      bpEls.forEach(function (bp) { bp.classList.add("open"); });
    } else {
      // 2) slide them off the left edge, leftmost first
      bd.classList.add("exiting");
      for (let i = 0; i < bpEls.length; i++) { if (token !== runToken) return; bpEls[i].classList.add("exit"); await delay(120); }
      await delay(300); if (token !== runToken) return;
      // 3) restack while off-screen, then bring each back from the left as an
      //    acrostic — top (leftmost) first — unfolding its info as it lands.
      bd.classList.add("stacked");
      void bd.offsetWidth; // flush the new layout before animating back in
      for (let i = 0; i < bpEls.length; i++) {
        if (token !== runToken) return;
        const bp = bpEls[i];
        bp.classList.remove("exit");
        // start just inside the card's left edge, then slide into place
        bp.style.transition = "none";
        bp.style.transform = "translateX(-36px)";
        bp.style.opacity = "0";
        void bp.offsetWidth;
        bp.style.transition = "";
        bp.classList.add("open");
        bp.style.transform = "";
        bp.style.opacity = "";
        await delay(170);
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

    // 5) Thesaurus
    const thesCard = buildThesaurusCard(recP, token);
    cardsEl.appendChild(thesCard);
    requestAnimationFrame(function () { thesCard.classList.add("in"); });
  }

  function defaultGloss(p) {
    if (p.silentE) return "silent “magic” e — a spelling marker, not a sound";
    if (p.kind === "linker") return "connecting vowel — joins the roots";
    return null;
  }

  function buildBP(p, rec) {
    const bp = el("div", "bp");
    bp.dataset.kind = p.kind;
    const inner = el("div", "bp-inner"); // wrapper so the row height can animate
    const main = el("div", "bp-main");
    main.appendChild(el("span", "bp-vline")); // vertical accent to the left
    main.appendChild(el("span", "mw", p.surface));
    const info = el("span", "bp-info");

    let g = p.meaning ? firstSense(p.meaning) : defaultGloss(p);
    let origin = p.origin, source = p.source;
    if ((!origin || !source) && p.whole && rec && rec.e) {
      const s = extractSource(cleanProse(rec.e));
      if (s) { origin = s.lang; source = s.word + (s.translit ? " (" + s.translit + ")" : ""); if (!g && s.gloss) g = s.gloss; }
    }
    if (g) info.appendChild(el("span", "gl", g));
    if (origin && source) {
      const src = el("span", "src");
      let h = escapeHtml(origin) + " <b>" + escapeHtml(source) + "</b>";
      const alts = (p.forms || []).filter(function (f) { return f !== p.surface; });
      if (alts.length) h += ' <span class="alt">· also ' + escapeHtml(alts.join(", ")) + "</span>";
      src.innerHTML = h;
      info.appendChild(src);
    }
    main.appendChild(info);
    inner.appendChild(main);
    bp.appendChild(inner);

    // Tap a morpheme to drop down other words built on it (no visible label).
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
    const list = el("div", "card-related");
    list.appendChild(el("div", "related-empty", "finding words…"));
    box.appendChild(list);
    bp.classList.add("expanded");
    (bp.querySelector(".bp-inner") || bp).appendChild(box);

    const token = runToken;
    loadData().then(function () {
      if (token !== runToken || !bp.classList.contains("expanded")) return;
      const words = (MORPH[p.id] || []).filter(function (w) { return w !== currentWord; });
      list.innerHTML = "";
      if (!words.length) { list.appendChild(el("div", "related-empty", "No other words with this piece yet.")); return; }
      list.appendChild(el("div", "lab", "More words"));
      renderWordGroups(list, words, p.kind);
    });
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
    const MAX = 15;
    const clean = words.filter(function (w) { return w.length <= 12; });
    const pick = (clean.length ? clean : words)
      .slice().sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
      .slice(0, 20);
    let shown = 0;
    clusterFamilies(pick).slice(0, 4).forEach(function (fam) {
      if (shown >= MAX) return;
      const row = fam.slice(0, Math.max(2, MAX - shown));
      shown += row.length;
      box.appendChild(chipRow(row, kind));
    });
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

  function fillPron(recP, word, token) {
    recP.then(function (rec) {
      if (token !== runToken || !pronEl) return;
      pronEl.innerHTML = "";
      ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = "";
      const ipa = rec && rec.i, resp = rec && rec.rs;
      if (ipa) {
        const ib = el("button", "ipa", ipa);
        ib.type = "button";
        ib.setAttribute("aria-label", "Show pronunciation key");
        ib.addEventListener("click", function () { toggleIpaKey(ipa); });
        pronEl.appendChild(ib);
      }
      if (canSpeak) {
        if (ipa) pronEl.appendChild(el("span", "pdot", "•"));
        const rb = el("button", "resp speakable", resp || word);
        rb.type = "button";
        rb.setAttribute("aria-label", "Pronounce " + word);
        rb.addEventListener("click", function () { speak(word); });
        pronEl.appendChild(rb);
      } else if (resp) {
        if (ipa) pronEl.appendChild(el("span", "pdot", "•"));
        pronEl.appendChild(el("span", "resp", resp));
      }
      if (pronEl.children.length) requestAnimationFrame(function () { pronEl.classList.add("in"); });
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
    const card = el("div", "card");
    card.appendChild(el("div", "cap", "Thesaurus"));
    recP.then(function (rec) {
      if (token !== runToken) return;
      const s = rec && rec.s, a = rec && rec.a, r = rec && rec.r;
      if (!(s && s.length) && !(a && a.length) && !(r && r.length)) { card.remove(); return; }
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

  // Languages we can place on a timeline, with a rough chronological rank and the
  // period the language was in use (modern ones show when they began). BC/AD.
  const LANGS = {
    "Proto-Indo-European": { rank: -4500, short: "PIE", era: "c. 4500 BC" },
    "Proto-Hellenic": { rank: -2000, era: "c. 2000 BC" },
    "Proto-Italic": { rank: -1500, era: "c. 1500 BC" },
    "Proto-Germanic": { rank: -500, era: "c. 500 BC" },
    "Proto-West Germanic": { rank: -100, era: "c. 1 AD" },
    "Ancient Greek": { rank: -800, era: "c. 800 BC–300 AD" },
    "Hellenistic Greek": { rank: -300, era: "c. 300 BC" },
    "Koine Greek": { rank: -200, era: "c. 300 BC–300 AD" },
    "Byzantine Greek": { rank: 600, era: "4th–15th c." },
    "Greek": { rank: 1700, era: "from c. 1500" },
    "Latin": { rank: -75, era: "c. 75 BC–200 AD" },
    "Classical Latin": { rank: -75, era: "c. 75 BC–200 AD" },
    "Vulgar Latin": { rank: 200, era: "1st–7th c." },
    "Late Latin": { rank: 300, era: "3rd–6th c." },
    "Ecclesiastical Latin": { rank: 400, era: "4th c.+" },
    "Medieval Latin": { rank: 900, era: "9th–15th c." },
    "New Latin": { rank: 1550, era: "from c. 1500" },
    "Old English": { rank: 700, era: "5th–11th c." },
    "Middle English": { rank: 1200, era: "1150–1500" },
    "Old French": { rank: 1000, era: "9th–14th c." },
    "Anglo-Norman": { rank: 1100, era: "11th–14th c." },
    "Middle French": { rank: 1450, era: "14th–17th c." },
    "French": { rank: 1700, era: "from c. 1600" },
    "Old Norse": { rank: 800, era: "8th–14th c." },
    "Italian": { rank: 1400, era: "from c. 1400" },
    "Spanish": { rank: 1400, era: "from c. 1400" },
    "Portuguese": { rank: 1400, era: "from c. 1400" },
    "Dutch": { rank: 1500, era: "from c. 1500" },
    "German": { rank: 1500, era: "from c. 1500" },
    "Arabic": { rank: 600, era: "7th c.+" },
    "Sanskrit": { rank: -1500, era: "c. 1500 BC" },
    "Hebrew": { rank: -900, era: "c. 900 BC" },
    "Persian": { rank: 800, era: "medieval+" },
    "English": { rank: 1500, era: "from c. 1500" },
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
    const inner = m[3].split(",");
    const translit = inner[0].trim();
    const gloss = inner.slice(1).join(",").replace(/[“”"]/g, "").trim();
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
    const tl = el("div", "tl");
    chain.forEach(function (name, i) {
      const node = el("div", "node");
      const dot = el("div", "dot");
      dot.style.background = colors[i % colors.length];
      node.appendChild(dot);
      node.appendChild(el("div", "lang", LANGS[name].short || name));
      node.appendChild(el("div", "era", LANGS[name].era));
      tl.appendChild(node);
    });
    return tl;
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

  // ---------- thumb index + browse-by-letter ----------
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function buildThumb() {
    thumbEl.innerHTML = "";
    const handle = el("div", "thumb-handle", "A");
    thumbEl.appendChild(handle);
    const rail = el("div", "thumb-rail");
    ALPHA.split("").forEach(function (c) {
      const t = el("div", "thumb-tab", c);
      t.dataset.letter = c;
      t.addEventListener("click", function () { closeRail(); browseLetter(c); });
      rail.appendChild(t);
    });
    thumbEl.appendChild(rail);
    thumbHandle = handle; thumbRail = rail;

    function openRail() { thumbEl.classList.add("open"); }
    function closeRail() { thumbEl.classList.remove("open"); clearDrag(); }
    function clearDrag() { Array.prototype.forEach.call(rail.children, function (t) { t.classList.remove("drag-active"); }); }
    function tabAt(x, y) { const e = document.elementFromPoint(x, y); return (e && e.dataset && e.dataset.letter) ? e : null; }
    thumbCloseRail = closeRail;

    let dragging = false, moved = false;
    handle.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      if (thumbEl.classList.contains("open")) { closeRail(); return; } // tap again to close
      dragging = true; moved = false; openRail();
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });
    if (typeof document.addEventListener === "function") {
      document.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        moved = true; clearDrag();
        const t = tabAt(e.clientX, e.clientY); if (t) t.classList.add("drag-active");
      });
      document.addEventListener("pointerup", function (e) {
        if (!dragging) return; dragging = false;
        const t = tabAt(e.clientX, e.clientY);
        if (t) { const L = t.dataset.letter; closeRail(); browseLetter(L); }
        else if (moved) { closeRail(); } // released off the rail after dragging
        // a plain tap (no drag) leaves the rail open so letters can be tapped
      });
    }
  }
  function highlightThumb(word) {
    const L = String(word || "").charAt(0).toUpperCase();
    const cur = /[A-Z]/.test(L) ? L : "A";
    if (thumbHandle) thumbHandle.textContent = cur;
    if (thumbRail) Array.prototype.forEach.call(thumbRail.children, function (t) {
      if (t.dataset.letter === cur) t.classList.add("on"); else t.classList.remove("on");
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
    highlightThumb(letter);
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
    fetchShard(key).then(function (sh) {
      if (token !== suggestToken || !sh) return;
      if (input.value.trim().toLowerCase() !== v) return;
      // Only suggest words we actually have a definition for.
      const matches = Object.keys(sh)
        .filter(function (w) { return w.indexOf(v) === 0 && w !== v && sh[w] && sh[w].d && sh[w].d.length; })
        .sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
        .slice(0, 8);
      renderSuggest(matches, v);
    });
  }
  function renderSuggest(words, q) {
    suggestEl.innerHTML = "";
    if (!words.length) { hideSuggest(); return; }
    words.forEach(function (w) {
      const li = document.createElement("li");
      const b = el("button", "suggest-item"); b.type = "button";
      b.innerHTML = '<span class="hl">' + escapeHtml(w.slice(0, q.length)) + "</span>" + escapeHtml(w.slice(q.length));
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

  buildThumb();
  loadData();
  renderHistory();
  updateNav();

  // pin the word to the top: show the compact header once the full one scrolls off
  miniHead.hidden = true;
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { miniHead.hidden = en.isIntersecting || !currentWord; });
    }, { root: contentEl, threshold: 0 });
    io.observe(entryEl);
  }

  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);
})();
