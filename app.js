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
  // Only the small morpheme index loads up front (for the "more words" lists).
  // Rich per-word data (definitions, pronunciation, etymology, relations) is
  // fetched lazily, one shard at a time, keyed by the word's first two letters.
  const DATA_V = "6";
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
  function getWord(word) {
    const key = String(word || "").slice(0, 2).toLowerCase();
    if (!/^[a-z]{2}$/.test(key) || typeof fetch !== "function") return Promise.resolve(null);
    if (!shardCache[key]) {
      shardCache[key] = fetch("words/" + key + ".json?v=" + DATA_V)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return shardCache[key].then(function (sh) { return sh[word] || null; });
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
    const recP = getWord(result.word); // one fetch, shared by every panel

    // 1) lay down morphemes (tight) and the dots between them.
    const morphEls = [];
    parts.forEach(function (p, i) {
      if (i) wordLine.appendChild(el("span", "dot", "·"));
      const span = el("span", "morph");
      span.dataset.kind = p.kind;
      span.textContent = p.surface;
      span.appendChild(el("span", "tag", kindLabel(p.kind)));
      span.appendChild(el("span", "ul")); // underline (pseudo-elements hold hyphens)
      wordLine.appendChild(span);
      morphEls.push(span);
    });

    // 2) pop each piece in, tight, so it reads as the whole word — boom boom boom.
    for (let i = 0; i < morphEls.length; i++) { if (token !== runToken) return; morphEls[i].classList.add("in"); await delay(45); }

    // 3) beat, then SPLIT: gaps open, dots grow, underlines draw, labels appear.
    await delay(300);
    if (token !== runToken) return;
    wordLine.classList.add("split");

    // 4) pronunciation (fills when the data arrives).
    await delay(160);
    fillPron(recP, token);

    // 5) a tile per morpheme — staggered pop.
    await delay(140);
    parts.forEach(function (p) { tilesEl.appendChild(buildTile(p)); });
    const tileEls = Array.prototype.slice.call(tilesEl.children);
    for (let i = 0; i < tileEls.length; i++) { if (token !== runToken) return; tileEls[i].classList.add("in"); await delay(70); }

    // 6) panels: meaning, thesaurus, origin.
    await delay(180);
    if (token !== runToken) return;
    const meaningPanel = buildMeaningPanel(result);
    const thesPanel = el("div", "panel");
    const originPanel = el("div", "panel");
    panelsEl.appendChild(meaningPanel);
    panelsEl.appendChild(thesPanel);
    panelsEl.appendChild(originPanel);

    const panels = [meaningPanel, thesPanel, originPanel];
    for (let i = 0; i < panels.length; i++) { if (token !== runToken) return; panels[i].classList.add("in"); await delay(100); }

    fillMeaning(recP, token);
    fillThesaurus(recP, thesPanel, token);
    fillOrigin(recP, result, originPanel, token);
  }

  function fillPron(recP, token) {
    recP.then(function (rec) {
      if (token !== runToken) return;
      if (!rec || (!rec.i && !rec.rs)) { pronEl.innerHTML = ""; return; }
      const ipa = rec.i ? '<span class="ipa">' + escapeHtml(rec.i) + "</span>" : "";
      const resp = rec.rs ? '<span class="resp">' + escapeHtml(rec.rs) + "</span>" : "";
      pronEl.innerHTML = ipa + (ipa && resp ? '<span class="pdot">•</span>' : "") + resp;
      requestAnimationFrame(function () { pronEl.classList.add("in"); });
    });
  }

  // ---------- tiles ----------
  function buildTile(p) {
    const tile = el("div", "tile");
    tile.dataset.kind = p.kind;

    // Lead with the actual root/affix (the etymon), since the surface fragment is
    // already shown in the breakdown at the top. Fold origin into the label.
    const isSilentE = p.kind === "linker" && p.surface === "e";
    const label = isSilentE ? "silent e" : kindLabel(p.kind) + (p.origin ? " · " + p.origin : "");
    tile.appendChild(el("div", "rk", label));
    tile.appendChild(el("div", "surf", p.source || p.surface));

    if (p.forms && p.forms.length) {
      tile.appendChild(el("div", "forms", "appears as: " + p.forms.join(", ")));
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

  function fillMeaning(recP, token) {
    const slot = meaningEl;
    recP.then(function (rec) {
      if (token !== runToken || !slot) return;
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
        slot.innerHTML = '<span class="def-loading">No dictionary entry — the build above is your best read.</span>';
      }
    });
  }

  function fillThesaurus(recP, panel, token) {
    recP.then(function (rec) {
      if (token !== runToken) return;
      const s = rec && rec.s, a = rec && rec.a, r = rec && rec.r;
      if (!(s && s.length) && !(a && a.length) && !(r && r.length)) { panel.remove(); return; }
      panel.innerHTML = "";
      let first = true;
      function group(label, words, cls) {
        if (!words || !words.length) return;
        const l = el("div", "lab", label);
        if (!first) l.style.marginTop = "12px";
        first = false;
        panel.appendChild(l);
        panel.appendChild(thesRow(words, cls));
      }
      group("Synonyms", s, "syn");
      group("Antonyms", a, "ant");
      group("Related", r, "rel");
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

  // Real etymology when we have it; otherwise the root chain from the engine.
  function fillOrigin(recP, result, panel, token) {
    recP.then(function (rec) {
      if (token !== runToken) return;
      panel.innerHTML = "";
      if (rec && rec.e) {
        panel.appendChild(el("div", "lab", "Origin"));
        panel.appendChild(el("div", "hist", rec.e));
        return;
      }
      const known = result.parts.filter(function (p) { return p.origin && p.source; });
      if (!known.length) { panel.remove(); return; }
      const origins = [];
      known.forEach(function (p) { if (origins.indexOf(p.origin) === -1) origins.push(p.origin); });
      const chain = known.map(function (p) {
        return "<i>" + escapeHtml(p.source) + '</i> (“' + escapeHtml(firstSense(p.meaning)) + "”)";
      }).join(" + ");
      panel.appendChild(el("div", "lab", "Origin"));
      const h = el("div", "hist");
      h.innerHTML = "Formed from <span class=\"origin\">" + escapeHtml(origins.join(" and ")) + "</span> — " + chain + ".";
      panel.appendChild(h);
    });
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
