// Rootwork UI controller: takes a word, runs the offline etymology engine, and
// choreographs the reveal — word in, split into morphemes, detail cards, then
// the pieces fuse into a real dictionary meaning. Cards are tappable to explore
// other words sharing a morpheme, and searches are remembered.

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const form = $("searchForm");
  const input = $("wordInput");
  const hint = $("hint");
  const historyEl = $("history");
  const wordLine = $("wordLine");
  const cardsEl = $("cards");
  const relatedEl = $("related");
  const defEl = $("definition");
  const legend = $("legend");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = reduceMotion ? 0 : 1;
  let runToken = 0;
  let meaningEl = null; // the live "Meaning" slot for the current reveal

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms * step); }); }

  function kindLabel(kind) {
    return { prefix: "prefix", root: "root", suffix: "suffix", linker: "link", unknown: "stem" }[kind] || kind;
  }

  // ---------- vendored dictionary + morpheme index (loaded once, async) ----------
  let DICT = null;
  let MORPH_INDEX = null;
  let dataPromise = null;

  function loadData() {
    if (dataPromise) return dataPromise;
    function grab(url) {
      if (typeof fetch !== "function") return Promise.resolve(null);
      return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }
    dataPromise = Promise.all([grab("dictionary.json?v=1"), grab("morpheme-index.json?v=1")])
      .then(function (out) { DICT = out[0] || {}; MORPH_INDEX = out[1] || {}; });
    return dataPromise;
  }

  // ---------- search history (localStorage) ----------
  const HKEY = "rootwork.history";
  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function loadHistory() {
    const s = store();
    if (!s) return [];
    try { return JSON.parse(s.getItem(HKEY)) || []; } catch (e) { return []; }
  }
  function saveHistory(h) { const s = store(); if (s) try { s.setItem(HKEY, JSON.stringify(h)); } catch (e) {} }
  function pushHistory(word) {
    let h = loadHistory().filter(function (w) { return w !== word; });
    h.unshift(word);
    saveHistory(h.slice(0, 16));
    renderHistory();
  }
  function renderHistory() {
    const h = loadHistory();
    historyEl.innerHTML = "";
    if (!h.length) { historyEl.hidden = true; return; }
    historyEl.hidden = false;
    const label = document.createElement("span");
    label.className = "history-label";
    label.textContent = "Recent";
    historyEl.appendChild(label);
    h.forEach(function (w) {
      const b = document.createElement("button");
      b.className = "history-chip";
      b.textContent = w;
      b.addEventListener("click", function () { run(w); });
      historyEl.appendChild(b);
    });
    const clear = document.createElement("button");
    clear.className = "history-clear";
    clear.textContent = "Clear";
    clear.addEventListener("click", function () { saveHistory([]); renderHistory(); });
    historyEl.appendChild(clear);
  }

  function clearStage() {
    wordLine.className = "word-line";
    wordLine.innerHTML = "";
    cardsEl.innerHTML = "";
    relatedEl.hidden = true;
    relatedEl.className = "related";
    relatedEl.innerHTML = "";
    defEl.className = "definition";
    defEl.innerHTML = "";
    meaningEl = null;
  }

  function showStatus(html, isError) {
    clearStage();
    hint.hidden = true;
    legend.hidden = true;
    const div = document.createElement("div");
    div.className = "status" + (isError ? " error" : "");
    div.innerHTML = html;
    wordLine.appendChild(div);
  }

  async function run(rawWord) {
    const word = String(rawWord || "").trim();
    if (!word) return;

    const token = ++runToken;
    input.value = word;
    hint.hidden = true;
    loadData(); // kick off (or reuse) the dictionary fetch early

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
      pushHistory(result.word);
      await reveal(result, token);
    } catch (err) {
      showStatus("Something went wrong: " + escapeHtml(String(err && err.message || err)), true);
    }
  }

  async function reveal(result, token) {
    clearStage();
    legend.hidden = false;

    // 1) Lay down the morpheme chips, initially tight (reads as the whole word).
    const chips = result.parts.map(function (p) {
      const span = document.createElement("span");
      span.className = "morph";
      span.dataset.kind = p.kind;
      span.textContent = p.surface;
      const tick = document.createElement("span");
      tick.className = "tick";
      span.appendChild(tick);
      wordLine.appendChild(span);
      return span;
    });

    // 2) Fade the word in, left to right.
    for (let i = 0; i < chips.length; i++) {
      if (token !== runToken) return;
      chips[i].classList.add("in");
      await delay(70);
    }

    // 3) Beat, then split: gaps open and each piece takes on its colour.
    await delay(420);
    if (token !== runToken) return;
    wordLine.classList.add("spread");

    // 4) Detail cards rise, one per meaningful piece — boom, boom, boom.
    await delay(420);
    const meaningful = result.parts.filter(function (p) { return p.kind !== "linker"; });
    meaningful.forEach(function (p) { cardsEl.appendChild(buildCard(p)); });

    const cardEls = Array.prototype.slice.call(cardsEl.children);
    for (let i = 0; i < cardEls.length; i++) {
      if (token !== runToken) return;
      cardEls[i].classList.add("in");
      await delay(110);
    }

    // 5) Fusion: the pieces feed into the assembled meaning.
    await delay(260);
    if (token !== runToken) return;
    defEl.appendChild(buildDefinition(result));
    requestAnimationFrame(function () { defEl.classList.add("in"); });

    // The construction tokens pop in one by one, then the meaning resolves.
    const toks = Array.prototype.slice.call(defEl.querySelectorAll(".tok"));
    for (let i = 0; i < toks.length; i++) {
      if (token !== runToken) return;
      toks[i].classList.add("in");
      await delay(95);
    }
    await delay(160);
    if (token !== runToken) return;
    const fuse = defEl.querySelector(".def-fuse");
    if (fuse) fuse.classList.add("go");
    await delay(140);
    const block = defEl.querySelector(".def-meaning-block");
    if (block) block.classList.add("in");

    fillMeaning(result.word, token);
  }

  function buildCard(p) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.kind = p.kind;

    const top = document.createElement("div");
    top.className = "card-top";
    const surface = document.createElement("div");
    surface.className = "card-surface";
    surface.textContent = p.surface;
    const kind = document.createElement("div");
    kind.className = "card-kind";
    kind.textContent = kindLabel(p.kind);
    top.appendChild(surface);
    top.appendChild(kind);
    card.appendChild(top);

    if (p.origin) {
      const origin = document.createElement("div");
      origin.className = "card-origin";
      origin.textContent = "from " + p.origin;
      card.appendChild(origin);
    }
    if (p.source) {
      const src = document.createElement("div");
      src.className = "card-source";
      src.innerHTML = '“<em>' + escapeHtml(p.surface) + '</em>”<span class="card-arrow">→</span><em>' + escapeHtml(p.source) + "</em>";
      card.appendChild(src);
    }
    const meaning = document.createElement("div");
    meaning.className = "card-meaning";
    meaning.textContent = p.meaning ? p.meaning : "Not a classical root in the built-in dictionary — likely a native English or modern stem.";
    card.appendChild(meaning);

    // Tappable when the piece is a real morpheme we can find relatives for.
    if (p.id) {
      card.classList.add("tappable");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      const hintRow = document.createElement("div");
      hintRow.className = "card-explore";
      hintRow.textContent = "Tap to see words sharing this " + kindLabel(p.kind) + " →";
      card.appendChild(hintRow);
      card.addEventListener("click", function () { showRelated(p, card); });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showRelated(p, card); }
      });
    }

    return card;
  }

  function showRelated(p, card) {
    const token = runToken;
    Array.prototype.slice.call(cardsEl.children).forEach(function (c) { c.classList.remove("active"); });
    if (card) card.classList.add("active");

    relatedEl.hidden = false;
    relatedEl.className = "related in";
    relatedEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "related-head";
    head.innerHTML = 'Words sharing the ' + kindLabel(p.kind) + ' “<b>' + escapeHtml(p.surface) +
      '</b>”' + (p.meaning ? ' — <span class="related-gloss">' + escapeHtml(p.meaning) + "</span>" : "");
    relatedEl.appendChild(head);

    const list = document.createElement("div");
    list.className = "related-list";
    relatedEl.appendChild(list);

    const loading = document.createElement("div");
    loading.className = "related-empty";
    loading.textContent = "Finding related words…";
    list.appendChild(loading);

    loadData().then(function () {
      if (token !== runToken) return;
      const words = (MORPH_INDEX[p.id] || []).filter(function (w) { return w !== currentWord; });
      list.innerHTML = "";
      if (!words.length) {
        const none = document.createElement("div");
        none.className = "related-empty";
        none.textContent = "No other words with this piece in the dictionary yet.";
        list.appendChild(none);
        return;
      }
      words.forEach(function (w, i) {
        const chip = document.createElement("button");
        chip.className = "related-chip";
        chip.dataset.kind = p.kind;
        chip.textContent = w;
        chip.style.setProperty("--i", i);
        chip.addEventListener("click", function () { run(w); });
        list.appendChild(chip);
      });
    });
  }

  let currentWord = "";

  function buildDefinition(result) {
    currentWord = result.word;
    const box = document.createElement("div");
    box.className = "def-box";

    // (a) "Built from" — the literal pieces that fuse into the meaning.
    if (result.reading && result.reading.literal) {
      const label = document.createElement("div");
      label.className = "def-label";
      label.textContent = "Built from";
      box.appendChild(label);

      const cons = document.createElement("div");
      cons.className = "def-construction";
      const senses = result.reading.literal.split(" + ");
      senses.forEach(function (s, i) {
        if (i) {
          const op = document.createElement("span");
          op.className = "op";
          op.textContent = "+";
          cons.appendChild(op);
        }
        const tok = document.createElement("span");
        tok.className = "tok";
        tok.textContent = s;
        cons.appendChild(tok);
      });
      box.appendChild(cons);

      const fuse = document.createElement("div");
      fuse.className = "def-fuse";
      fuse.innerHTML = '<span class="fuse-line"></span><span class="fuse-arrow">↓</span><span class="fuse-line"></span>';
      box.appendChild(fuse);
    }

    // (b) The real, dictionary meaning (filled in once the dictionary loads).
    const block = document.createElement("div");
    block.className = "def-meaning-block";
    const mlabel = document.createElement("div");
    mlabel.className = "def-label";
    mlabel.textContent = "Meaning";
    block.appendChild(mlabel);
    meaningEl = document.createElement("div");
    meaningEl.className = "def-meaning";
    meaningEl.innerHTML = '<span class="def-loading">looking it up…</span>';
    block.appendChild(meaningEl);
    box.appendChild(block);

    // (c) The rules-based reading, kept as supporting colour.
    if (result.reading && result.reading.sentence) {
      const sent = document.createElement("p");
      sent.className = "def-sentence";
      sent.textContent = result.reading.sentence;
      box.appendChild(sent);
    }

    const tag = document.createElement("span");
    tag.className = "def-source-tag";
    tag.textContent = "Roots: built-in · Definitions: WordNet";
    box.appendChild(tag);

    return box;
  }

  function fillMeaning(word, token) {
    const slot = meaningEl;
    loadData().then(function () {
      if (token !== runToken || !slot) return;
      const senses = DICT[word];
      if (senses && senses.length) {
        slot.innerHTML = senses.map(function (s) {
          return '<span class="pos">' + escapeHtml(s.p) + "</span><span class=\"sense\">" + escapeHtml(s.d) + "</span>";
        }).join("");
      } else {
        slot.innerHTML = '<span class="def-loading">No exact dictionary entry — the literal construction above is your best read.</span>';
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- events ----------
  function submit() {
    input.blur();
    run(input.value);
  }
  form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  // Belt-and-suspenders: also handle a direct tap on the arrow in case the
  // form's submit event doesn't fire (some mobile keyboards / edge cases).
  form.querySelector(".search-btn").addEventListener("click", function (e) {
    e.preventDefault();
    submit();
  });

  document.querySelectorAll(".example").forEach(function (btn) {
    btn.addEventListener("click", function () { run(btn.dataset.word); });
  });

  // Prefetch the dictionary and paint history on load.
  loadData();
  renderHistory();

  // Deep link: #word=...
  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);

  input.focus();
})();
