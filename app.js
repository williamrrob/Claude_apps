// Rootwork UI controller: takes a word, runs the offline etymology engine, and
// choreographs the reveal — word in, split into morphemes, spread apart, detail
// cards, then the assembled meaning.

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const form = $("searchForm");
  const input = $("wordInput");
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
    hint.hidden = true;

    const result = window.EtymologyEngine.decompose(word);
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
    meaning.textContent = p.meaning ? p.meaning : "Not a classical root in the built-in dictionary — likely a native English or modern stem.";
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

    const tag = document.createElement("span");
    tag.className = "def-source-tag";
    tag.textContent = "Built-in root dictionary";
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

  // ---------- install to Home Screen ----------
  const installBtn = $("installBtn");
  const iosBackdrop = $("iosBackdrop");
  let deferredPrompt = null;

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS

  if (!isStandalone) {
    // Chrome / Edge / Android: capture the native prompt for a real one-tap install.
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.hidden = false;
    });
    // iOS Safari has no prompt event — offer instructions instead.
    if (isIOS) installBtn.hidden = false;
  }

  installBtn.addEventListener("click", async function () {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    } else {
      iosBackdrop.hidden = false;
    }
  });
  window.addEventListener("appinstalled", function () { installBtn.hidden = true; });

  $("iosClose").addEventListener("click", function () { iosBackdrop.hidden = true; });
  $("iosGot").addEventListener("click", function () { iosBackdrop.hidden = true; });
  iosBackdrop.addEventListener("click", function (e) { if (e.target === iosBackdrop) iosBackdrop.hidden = true; });

  // Deep link: #word=...
  const m = location.hash.match(/word=([a-zA-Z]+)/);
  if (m) run(m[1]);

  input.focus();
})();
