// Rootwork UI controller: takes a word, runs the local engine (or Claude in AI
// mode), and choreographs the reveal — word in, split into morphemes, spread
// apart, detail cards, then the assembled meaning.

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const form = $("searchForm");
  const input = $("wordInput");
  const submitBtn = form.querySelector(".search-btn");
  const stage = $("stage");
  const hint = $("hint");
  const wordLine = $("wordLine");
  const cardsEl = $("cards");
  const defEl = $("definition");
  const legend = $("legend");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = reduceMotion ? 0 : 1;
  let runToken = 0;

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms * step); }); }

  function kindLabel(kind) {
    return { prefix: "prefix", root: "root", suffix: "suffix", linker: "link", unknown: "stem" }[kind] || kind;
  }

  function clearStage() {
    wordLine.className = "word-line";
    wordLine.innerHTML = "";
    cardsEl.innerHTML = "";
    defEl.className = "definition";
    defEl.innerHTML = "";
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
    submitBtn.disabled = true;
    hint.hidden = true;

    let result;
    const cfg = window.RootworkAI.getConfig();
    try {
      if (cfg.enabled && cfg.key) {
        showStatus('<div class="spinner"></div><p>Asking Claude about “' + escapeHtml(word) + '”…</p>');
        result = await window.RootworkAI.analyze(word);
      } else {
        result = window.EtymologyEngine.decompose(word);
        // If the offline engine learned almost nothing and AI is on (key set),
        // fall back to Claude automatically.
        if (cfg.enabled && cfg.key && (!result || !result.hasRoot)) {
          showStatus('<div class="spinner"></div><p>Asking Claude about “' + escapeHtml(word) + '”…</p>');
          result = await window.RootworkAI.analyze(word);
        }
      }
    } catch (err) {
      if (token !== runToken) return;
      // Fall back to the offline engine if AI failed.
      const local = window.EtymologyEngine.decompose(word);
      if (local) {
        result = local;
        result.aiError = err.message;
      } else {
        submitBtn.disabled = false;
        showStatus("Couldn’t analyze that. " + escapeHtml(err.message), true);
        return;
      }
    }

    if (token !== runToken) return;
    submitBtn.disabled = false;

    if (!result || !result.parts || !result.parts.length) {
      showStatus("Hmm, nothing to break down there. Try another word.", true);
      return;
    }

    await reveal(result, token);
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
    await delay(450);
    if (token !== runToken) return;
    wordLine.classList.add("spread");

    // 4) Detail cards rise, one per meaningful piece, staggered.
    await delay(500);
    const meaningful = result.parts.filter(function (p) { return p.kind !== "linker"; });
    meaningful.forEach(function (p) { cardsEl.appendChild(buildCard(p)); });

    const cardEls = Array.prototype.slice.call(cardsEl.children);
    for (let i = 0; i < cardEls.length; i++) {
      if (token !== runToken) return;
      cardEls[i].classList.add("in");
      await delay(120);
    }

    // 5) The assembled meaning.
    await delay(300);
    if (token !== runToken) return;
    defEl.appendChild(buildDefinition(result));
    requestAnimationFrame(function () { defEl.classList.add("in"); });
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
    meaning.textContent = p.meaning ? p.meaning : "Origin not in the offline dictionary — turn on AI mode for a full trace.";
    card.appendChild(meaning);

    return card;
  }

  function buildDefinition(result) {
    const box = document.createElement("div");
    box.className = "def-box";

    if (result.reading && result.reading.literal) {
      const label = document.createElement("div");
      label.className = "def-label";
      label.textContent = "Literal construction";
      box.appendChild(label);

      const lit = document.createElement("div");
      lit.className = "def-literal";
      lit.innerHTML = result.reading.literal
        .split(" + ")
        .map(function (s) { return escapeHtml(s); })
        .join('<span class="op">+</span>');
      box.appendChild(lit);
    }

    if (result.reading && result.reading.sentence) {
      const sent = document.createElement("p");
      sent.className = "def-sentence";
      sent.textContent = result.reading.sentence;
      box.appendChild(sent);
    }

    if (result.aiError) {
      const note = document.createElement("p");
      note.className = "def-note";
      note.textContent = "AI mode couldn’t be reached (" + result.aiError + "), so this is the offline reading.";
      box.appendChild(note);
    }

    const tag = document.createElement("span");
    tag.className = "def-source-tag";
    tag.textContent = result.ai ? "Analyzed by Claude" : "Offline root dictionary";
    box.appendChild(tag);

    return box;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- events ----------
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    input.blur();
    run(input.value);
  });

  document.querySelectorAll(".example").forEach(function (btn) {
    btn.addEventListener("click", function () { run(btn.dataset.word); });
  });

  // ---------- settings ----------
  const backdrop = $("sheetBackdrop");
  const aiToggle = $("aiToggle");
  const apiKey = $("apiKey");
  const modelId = $("modelId");

  function openSheet() {
    const cfg = window.RootworkAI.getConfig();
    aiToggle.checked = cfg.enabled;
    apiKey.value = cfg.key;
    modelId.value = cfg.model || window.RootworkAI.DEFAULT_MODEL;
    modelId.placeholder = window.RootworkAI.DEFAULT_MODEL;
    backdrop.hidden = false;
  }
  function closeSheet() { backdrop.hidden = true; }

  $("settingsBtn").addEventListener("click", openSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeSheet(); });
  $("saveSettings").addEventListener("click", function () {
    localStorage.setItem("rootwork.ai", aiToggle.checked ? "1" : "0");
    localStorage.setItem("rootwork.apiKey", apiKey.value.trim());
    localStorage.setItem("rootwork.model", modelId.value.trim() || window.RootworkAI.DEFAULT_MODEL);
    closeSheet();
  });

  // Deep link: #word=...
  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);

  input.focus();
})();
