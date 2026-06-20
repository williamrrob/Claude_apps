// Rootwork UI controller: takes a word, runs the offline etymology engine, and
// choreographs the reveal — word with dots, pronunciation, a tile per morpheme,
// then panels for meaning, synonyms/antonyms, and origin. Tiles expand in place
// to show other words built on the same piece. Searches are remembered.

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const themeToggle = $("themeToggle");
  const contentEl = $("content");
  const hint = $("hint");
  const wordLine = $("wordLine");
  const pronEl = $("pron");
  const tilesEl = $("tiles");
  const panelsEl = $("panels");
  const recentEl = $("recent");
  const form = $("searchForm");
  const input = $("wordInput");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = reduceMotion ? 0 : 1;
  let runToken = 0;
  let currentWord = "";
  let meaningEl = null;

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
  function kindLabel(k) {
    return { prefix: "prefix", root: "root", suffix: "suffix", linker: "link", unknown: "stem" }[k] || k;
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

  // ---------- vendored data (loaded once, async) ----------
  let DICT = null, MORPH = null, PRON = null, THES = null, dataPromise = null;
  function loadData() {
    if (dataPromise) return dataPromise;
    function grab(url) {
      if (typeof fetch !== "function") return Promise.resolve(null);
      return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }
    dataPromise = Promise.all([
      grab("dictionary.json?v=5"), grab("morpheme-index.json?v=5"),
      grab("pronunciation.json?v=5"), grab("thesaurus.json?v=5")
    ]).then(function (o) { DICT = o[0] || {}; MORPH = o[1] || {}; PRON = o[2] || {}; THES = o[3] || {}; });
    return dataPromise;
  }

  // ---------- search history ----------
  const HKEY = "rootwork.history";
  function store() { try { return localStorage; } catch (e) { return null; } }
  function loadHistory() { const s = store(); if (!s) return []; try { return JSON.parse(s.getItem(HKEY)) || []; } catch (e) { return []; } }
  function saveHistory(h) { const s = store(); if (s) try { s.setItem(HKEY, JSON.stringify(h)); } catch (e) {} }
  function pushHistory(w) { let h = loadHistory().filter(function (x) { return x !== w; }); h.unshift(w); saveHistory(h.slice(0, 20)); renderHistory(); }
  function renderHistory() {
    const h = loadHistory();
    recentEl.innerHTML = "";
    if (!h.length) { recentEl.hidden = true; return; }
    recentEl.hidden = false;
    h.forEach(function (w) {
      const b = el("button", "history-chip", w);
      b.addEventListener("click", function () { run(w); });
      recentEl.appendChild(b);
    });
    const clr = el("button", "history-clear", "Clear");
    clr.addEventListener("click", function () { saveHistory([]); renderHistory(); });
    recentEl.appendChild(clr);
  }

  // ---------- stage ----------
  function clearStage() {
    wordLine.className = "word-line"; wordLine.innerHTML = "";
    pronEl.className = "pron"; pronEl.innerHTML = "";
    tilesEl.innerHTML = "";
    panelsEl.innerHTML = "";
    meaningEl = null;
  }
  function showStatus(html, isError) {
    clearStage(); hint.hidden = true;
    const d = el("div", "status" + (isError ? " error" : "")); d.innerHTML = html;
    wordLine.appendChild(d);
  }

  async function run(rawWord) {
    const word = String(rawWord || "").trim();
    if (!word) return;
    const token = ++runToken;
    input.value = word;
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
      currentWord = result.word;
      pushHistory(result.word);
      await reveal(result, token);
    } catch (err) {
      showStatus("Something went wrong: " + escapeHtml(String(err && err.message || err)), true);
    }
  }

  async function reveal(result, token) {
    clearStage();
    const parts = result.parts;

    // 1) the word, split with interpunct dots.
    parts.forEach(function (p, i) {
      if (i) wordLine.appendChild(el("span", "dot", "·"));
      const span = el("span", "morph");
      span.dataset.kind = p.kind;
      span.textContent = p.surface;
      span.appendChild(el("span", "tag", kindLabel(p.kind)));
      wordLine.appendChild(span);
    });
    const seq = Array.prototype.slice.call(wordLine.children);
    for (let i = 0; i < seq.length; i++) { if (token !== runToken) return; seq[i].classList.add("in"); await delay(55); }

    // 2) pronunciation (fills when the data arrives).
    fillPron(result.word, token);

    // 3) a tile per morpheme — boom, boom, boom.
    await delay(220);
    parts.forEach(function (p) { tilesEl.appendChild(buildTile(p)); });
    const tileEls = Array.prototype.slice.call(tilesEl.children);
    for (let i = 0; i < tileEls.length; i++) { if (token !== runToken) return; tileEls[i].classList.add("in"); await delay(85); }

    // 4) panels: meaning, thesaurus, origin.
    await delay(200);
    if (token !== runToken) return;
    const meaningPanel = buildMeaningPanel(result);
    const thesPanel = el("div", "panel");
    const originPanel = buildOriginPanel(result);
    panelsEl.appendChild(meaningPanel);
    panelsEl.appendChild(thesPanel);
    if (originPanel) panelsEl.appendChild(originPanel);

    const panels = [meaningPanel, thesPanel].concat(originPanel ? [originPanel] : []);
    for (let i = 0; i < panels.length; i++) { if (token !== runToken) return; panels[i].classList.add("in"); await delay(100); }

    fillMeaning(result.word, token);
    fillThesaurus(thesPanel, result.word, token);
  }

  function fillPron(word, token) {
    loadData().then(function () {
      if (token !== runToken) return;
      const p = PRON[word];
      if (!p) { pronEl.innerHTML = ""; return; }
      pronEl.innerHTML = '<span class="ipa">' + escapeHtml(p[0]) + '</span>' +
        '<span class="pdot">•</span><span class="resp">' + escapeHtml(p[1]) + "</span>";
      requestAnimationFrame(function () { pronEl.classList.add("in"); });
    });
  }

  // ---------- tiles ----------
  function buildTile(p) {
    const tile = el("div", "tile");
    tile.dataset.kind = p.kind;
    tile.appendChild(el("div", "rk", p.kind === "linker" && p.surface === "e" ? "silent e" : kindLabel(p.kind)));
    tile.appendChild(el("div", "surf", p.surface));

    if (p.forms) {
      const others = p.forms.filter(function (f) { return f !== p.surface; });
      if (others.length) tile.appendChild(el("div", "forms", "also: " + others.join(", ")));
    }
    if (p.origin) {
      const org = el("div", "org");
      org.innerHTML = escapeHtml(p.origin) + (p.source ? ' · <i>' + escapeHtml(p.source) + "</i>" : "");
      tile.appendChild(org);
    }
    let meaning = p.meaning;
    if (!meaning) {
      meaning = p.kind === "linker"
        ? (p.surface === "e" ? "silent final e — lengthens the vowel before it; no sound of its own"
                             : "connecting vowel — joins the roots")
        : "a native English or modern stem";
    }
    tile.appendChild(el("div", "mean", meaning));

    // Tappable pieces expand to list words sharing them.
    if (p.id) {
      tile.classList.add("tappable");
      tile.setAttribute("role", "button");
      tile.setAttribute("tabindex", "0");
      tile.appendChild(el("div", "tile-more", "more words ▾"));
      const toggle = function () { toggleTileWords(tile, p); };
      tile.addEventListener("click", toggle);
      tile.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    }
    return tile;
  }

  function collapseTile(tile) {
    if (!tile.classList.contains("expanded")) return;
    tile.classList.remove("expanded");
    const box = tile.querySelector(".tile-words"); if (box) box.remove();
    const more = tile.querySelector(".tile-more"); if (more) more.textContent = "more words ▾";
  }

  function toggleTileWords(tile, p) {
    if (tile.classList.contains("expanded")) { collapseTile(tile); return; }
    Array.prototype.slice.call(tilesEl.children).forEach(collapseTile);
    tile.classList.add("expanded");
    const more = tile.querySelector(".tile-more"); if (more) more.textContent = "fewer words ▴";

    const box = el("div", "tile-words");
    box.innerHTML = '<span class="related-empty">finding words…</span>';
    tile.appendChild(box);

    const token = runToken;
    loadData().then(function () {
      if (token !== runToken || !tile.classList.contains("expanded")) return;
      const words = (MORPH[p.id] || []).filter(function (w) { return w !== currentWord; });
      box.innerHTML = "";
      if (!words.length) { box.appendChild(el("div", "related-empty", "No other words with this piece yet.")); return; }
      renderWordGroups(box, words, p.kind);
    });
  }

  // The index is stored shortest→longest. For a common affix that means the
  // front is everyday words and the tail is rare ones — show a bit of each.
  function renderWordGroups(box, words, kind) {
    if (words.length <= 22) { box.appendChild(chipRow(words, kind)); return; }
    box.appendChild(el("div", "lab", "Common"));
    box.appendChild(chipRow(words.slice(0, 14), kind));
    const l = el("div", "lab", "Rarer"); l.style.marginTop = "12px";
    box.appendChild(l);
    box.appendChild(chipRow(words.slice(-8), kind));
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

  // ---------- panels ----------
  function buildMeaningPanel(result) {
    currentWord = result.word;
    const panel = el("div", "panel");

    const glossable = result.parts.filter(function (p) { return p.meaning; });
    if (glossable.length) {
      panel.appendChild(el("div", "lab", "Built from"));
      const built = el("div", "built");
      glossable.forEach(function (p, i) {
        if (i) built.appendChild(el("span", "op", "+"));
        const g = el("span", "g", firstSense(p.meaning));
        g.dataset.kind = p.kind;
        built.appendChild(g);
      });
      panel.appendChild(built);
      panel.appendChild(el("div", "arrow", "↓"));
    }

    panel.appendChild(el("div", "lab", "Meaning"));
    meaningEl = el("div", "def-meaning");
    meaningEl.innerHTML = '<span class="def-loading">looking it up…</span>';
    panel.appendChild(meaningEl);
    return panel;
  }

  function fillMeaning(word, token) {
    const slot = meaningEl;
    loadData().then(function () {
      if (token !== runToken || !slot) return;
      const senses = DICT[word];
      if (senses && senses.length) {
        slot.innerHTML = "";
        senses.forEach(function (s, i) {
          const row = el("div", "sense");
          row.appendChild(el("span", "num", String(i + 1)));
          const body = el("span");
          body.innerHTML = '<span class="pos">' + escapeHtml(s.p) + "</span>" + escapeHtml(s.d);
          row.appendChild(body);
          slot.appendChild(row);
        });
      } else {
        slot.innerHTML = '<span class="def-loading">No exact dictionary entry — the build above is your best read.</span>';
      }
    });
  }

  function fillThesaurus(panel, word, token) {
    loadData().then(function () {
      if (token !== runToken) return;
      const t = THES[word];
      if (!t || (!t.s && !t.a)) { panel.remove(); return; }
      panel.innerHTML = "";
      if (t.s && t.s.length) {
        panel.appendChild(el("div", "lab", "Synonyms"));
        panel.appendChild(thesRow(t.s, "syn"));
      }
      if (t.a && t.a.length) {
        const l = el("div", "lab", "Antonyms");
        if (t.s && t.s.length) l.style.marginTop = "12px";
        panel.appendChild(l);
        panel.appendChild(thesRow(t.a, "ant"));
      }
    });
  }

  function thesRow(words, cls) {
    const list = el("div", "related-list");
    words.forEach(function (w, i) {
      const c = el("button", "related-chip thes-" + cls, w);
      c.style.setProperty("--i", i);
      c.addEventListener("click", function () { run(w); });
      list.appendChild(c);
    });
    return list;
  }

  function buildOriginPanel(result) {
    const known = result.parts.filter(function (p) { return p.origin && p.source; });
    if (!known.length) return null;
    const panel = el("div", "panel");
    panel.appendChild(el("div", "lab", "Origin"));
    const origins = [];
    known.forEach(function (p) { if (origins.indexOf(p.origin) === -1) origins.push(p.origin); });
    const chain = known.map(function (p) {
      return "<i>" + escapeHtml(p.source) + '</i> (“' + escapeHtml(firstSense(p.meaning)) + "”)";
    }).join(" + ");
    const h = el("div", "hist");
    h.innerHTML = "Formed from <span class=\"origin\">" + escapeHtml(origins.join(" and ")) +
      "</span> — " + chain + ".";
    panel.appendChild(h);
    return panel;
  }

  // ---------- events ----------
  function submit() { input.blur(); run(input.value); }
  form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  form.querySelector(".search-btn").addEventListener("click", function (e) { e.preventDefault(); submit(); });
  document.querySelectorAll(".example").forEach(function (btn) {
    btn.addEventListener("click", function () { run(btn.dataset.word); });
  });

  loadData();
  renderHistory();

  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);
})();
