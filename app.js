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
  const ipaKeyEl = $("ipaKey");
  const noteEl = $("note");
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
    return { prefix: "prefix", root: "root", suffix: "suffix", linker: "link", unknown: "stem", word: "word" }[k] || k;
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
  const DATA_V = "17";
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

  // ---------- hybrid breakdown ----------
  // Prefer Wiktionary's own morphological split (rec.b) when the heuristic engine
  // produced junk (unknown stems / low confidence) and the real split tiles the
  // word. Enrich each part from our morpheme data so known roots keep their
  // Greek/Latin etymon; otherwise fall back to Wiktionary's gloss.
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
    const bad = !result.hasRoot ||
      result.parts.some(function (p) { return p.kind === "unknown"; }) ||
      (result.confidence || 0) < 0.6;
    if (bad && rec && rec.b && rec.b.length >= 2) return rec.b.map(hybridPart);
    // No recognized root and no real breakdown: don't force a garbage split
    // (etymon ≠ ety + mon). Present the word as a single unit.
    if (bad && !result.hasRoot) {
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
  function renderHistory() {
    const h = loadHistory();
    recentEl.innerHTML = "";
    if (!h.length) { recentEl.hidden = true; return; }
    recentEl.hidden = false;
    recentEl.appendChild(el("span", "recent-label", "Recent"));
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
    ipaKeyEl.hidden = true; ipaKeyEl.innerHTML = "";
    noteEl.hidden = true; noteEl.textContent = "";
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
    const recP = getWord(result.word); // one fetch, shared by every panel
    const rec = await recP;
    if (token !== runToken) return;
    const parts = chooseBreakdown(result, rec);
    const isWhole = parts.length === 1 && parts[0].whole;

    // Flag words we can't find a definition for.
    if (!rec || !rec.d || !rec.d.length) {
      noteEl.textContent = isWhole
        ? "“" + result.word + "” isn’t in the dictionary."
        : "“" + result.word + "” isn’t in the dictionary — here’s how its parts would break down.";
      noteEl.hidden = false;
    }

    // 1) lay down morphemes (tight) and the dots between them.
    const morphEls = [];
    parts.forEach(function (p, i) {
      if (i) wordLine.appendChild(el("span", "dot", "·"));
      const span = el("span", "morph");
      span.dataset.kind = p.kind;
      const mw = el("span", "mw", p.surface);
      mw.appendChild(el("span", "ul")); // underline
      span.appendChild(mw);
      if (!p.whole) span.appendChild(el("span", "tag", kindLabel(p.kind)));
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
    fillPron(recP, result.word, token);

    // 5) a tile per meaningful morpheme — skipped for a single-unit word, and
    //    skip lone junk stems (a stray "g").
    await delay(140);
    if (!isWhole) {
      parts.filter(function (p) {
        return !(p.kind === "unknown" && p.surface.length < 3);
      }).forEach(function (p) { tilesEl.appendChild(buildTile(p)); });
    } else if (rec && rec.e) {
      // Single-unit word: still show the original source word (parity).
      const src = extractSource(cleanProse(rec.e));
      if (src) tilesEl.appendChild(originTile(src));
    }
    const tileEls = Array.prototype.slice.call(tilesEl.children);
    for (let i = 0; i < tileEls.length; i++) { if (token !== runToken) return; tileEls[i].classList.add("in"); await delay(70); }

    // 6) panels: meaning, thesaurus, origin.
    await delay(180);
    if (token !== runToken) return;
    const meaningPanel = buildMeaningPanel(result, parts);
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

  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  function speak(word) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = "en-US"; u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // Tap the IPA → a pronunciation key for the symbols in this word.
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
  // Names for the symbols that have them.
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
      if (token !== runToken) return;
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
        // Tap the plain-language respelling (or a speaker) to hear the word.
        if (ipa) pronEl.appendChild(el("span", "pdot", "•"));
        const rb = el("button", "resp speakable", resp || word);
        rb.type = "button";
        rb.setAttribute("aria-label", "Pronounce " + word);
        rb.appendChild(el("span", "spk-ico", "▶"));
        rb.addEventListener("click", function () { speak(word); });
        pronEl.appendChild(rb);
      } else if (resp) {
        if (ipa) pronEl.appendChild(el("span", "pdot", "•"));
        pronEl.appendChild(el("span", "resp", resp));
      }
      if (pronEl.children.length) requestAnimationFrame(function () { pronEl.classList.add("in"); });
    });
  }

  // ---------- tiles ----------
  function originTile(src) {
    const t = el("div", "tile");
    t.dataset.kind = "root";
    t.appendChild(el("div", "rk", src.lang));
    t.appendChild(el("div", "surf", src.word));
    if (src.translit) t.appendChild(el("div", "forms", src.translit));
    if (src.gloss) t.appendChild(el("div", "mean", src.gloss));
    return t;
  }

  // ---------- tiles ----------
  function buildTile(p) {
    const tile = el("div", "tile");
    tile.dataset.kind = p.kind;

    // Lead with the actual root/affix (the etymon), since the surface fragment is
    // already shown in the breakdown at the top. Fold origin into the label.
    const label = kindLabel(p.kind) + (p.origin ? " · " + p.origin : "");
    tile.appendChild(el("div", "rk", label));
    tile.appendChild(el("div", "surf", p.source || p.surface));

    if (p.forms && p.forms.length) {
      tile.appendChild(el("div", "forms", "appears as: " + p.forms.join(", ")));
    }
    let meaning = p.meaning;
    if (!meaning) {
      meaning = p.silentE
        ? "the silent “magic” e — lengthens the vowel before it; a spelling marker, not a sound"
        : p.kind === "linker" ? "connecting vowel — joins the roots"
        : "a native English or modern stem";
    }
    tile.appendChild(el("div", "mean", meaning));

    // Tappable pieces drop down their word families inside the card itself.
    if (p.id) {
      tile.classList.add("tappable");
      tile.setAttribute("role", "button");
      tile.setAttribute("tabindex", "0");
      tile.appendChild(el("div", "tile-more", "more words ▾"));
      const open = function () { toggleCardWords(p, tile); };
      tile.addEventListener("click", open);
      tile.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    }
    return tile;
  }

  function collapseCard(tile) {
    if (!tile.classList.contains("expanded")) return;
    tile.classList.remove("expanded");
    const box = tile.querySelector(".card-words"); if (box) box.remove();
    const more = tile.querySelector(".tile-more"); if (more) more.textContent = "more words ▾";
  }

  function toggleCardWords(p, tile) {
    if (tile.classList.contains("expanded")) { collapseCard(tile); return; }
    tile.classList.add("expanded");
    const more = tile.querySelector(".tile-more"); if (more) more.textContent = "fewer words ▴";

    const box = el("div", "card-words");
    box.appendChild(el("div", "related-empty", "finding words…"));
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

  // Group the related words into families of close relatives (discredit,
  // discreditable, discredited… / deceit, deceitful, deception, deceptive…)
  // rather than an arbitrary common-vs-rare split, and drop absurdly long
  // entries that read as non-words.
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
  // Keep it short: prefer everyday (shorter) words, drop the absurdly long
  // ones, and cap the total shown across a few families.
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

  // ---------- panels ----------
  function buildMeaningPanel(result, parts) {
    currentWord = result.word;
    const panel = el("div", "panel");

    const glossable = parts.filter(function (p) { return p.meaning; });
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
      // Each group is one wrapping line: an inline label, then the chips.
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
        panel.appendChild(row);
      }
      group("Synonyms", s, "syn");
      group("Antonyms", a, "ant");
      group("Related", r, "rel");
    });
  }

  // Some Wiktionary etymologies are a bare "tree" of ancestor forms rather than
  // a readable sentence; skip those for the prose but still use them for the
  // language journey below.
  function looksLikeTree(e) {
    return /(Proto-|-der\.)/.test(e) && !/\bfrom\b/i.test(e);
  }

  // Languages we can place on a timeline, with a rough chronological rank and
  // the language's own historical period (we can't get exact crossing dates).
  const LANGS = {
    "Proto-Indo-European": { rank: -4500, short: "PIE", era: "ancestor" },
    "Proto-Hellenic": { rank: -2000, era: "prehistoric" },
    "Proto-Italic": { rank: -1500, era: "prehistoric" },
    "Proto-Germanic": { rank: -500, era: "c. 500 BCE" },
    "Proto-West Germanic": { rank: -100, era: "c. 1 CE" },
    "Ancient Greek": { rank: -800, era: "c. 800 BCE–300 CE" },
    "Hellenistic Greek": { rank: -300, era: "c. 300 BCE" },
    "Koine Greek": { rank: -200, era: "c. 300 BCE–300 CE" },
    "Byzantine Greek": { rank: 600, era: "4th–15th c." },
    "Greek": { rank: 1700, era: "modern" },
    "Latin": { rank: -75, era: "c. 75 BCE–200 CE" },
    "Classical Latin": { rank: -75, era: "c. 75 BCE–200 CE" },
    "Vulgar Latin": { rank: 200, era: "1st–7th c." },
    "Late Latin": { rank: 300, era: "3rd–6th c." },
    "Ecclesiastical Latin": { rank: 400, era: "4th c.+" },
    "Medieval Latin": { rank: 900, era: "9th–15th c." },
    "New Latin": { rank: 1550, era: "16th c.+" },
    "Old English": { rank: 700, era: "5th–11th c." },
    "Middle English": { rank: 1200, era: "1150–1500" },
    "Old French": { rank: 1000, era: "9th–14th c." },
    "Anglo-Norman": { rank: 1100, era: "11th–14th c." },
    "Middle French": { rank: 1450, era: "14th–17th c." },
    "French": { rank: 1700, era: "modern" },
    "Old Norse": { rank: 800, era: "8th–14th c." },
    "Italian": { rank: 1400, era: "modern" },
    "Spanish": { rank: 1400, era: "modern" },
    "Portuguese": { rank: 1400, era: "modern" },
    "Dutch": { rank: 1500, era: "modern" },
    "German": { rank: 1500, era: "modern" },
    "Arabic": { rank: 600, era: "7th c.+" },
    "Sanskrit": { rank: -1500, era: "ancient" },
    "Hebrew": { rank: -900, era: "ancient" },
    "Persian": { rank: 800, era: "medieval+" },
    "English": { rank: 1500, era: "1500–today" },
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

  // Strip leading wiktextract "ancestor tree" junk (der./bor./*roots) and keep
  // the readable sentence.
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

  // The immediate source word from the etymology — e.g. etymon → Ancient Greek
  // ἔτυμον (étymon). Used to keep the original word visible for single-unit words.
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
    const colors = ["var(--root)", "var(--suffix)", "var(--prefix)", "var(--stem)", "var(--ink)"];
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

  function fillOrigin(recP, result, panel, token) {
    recP.then(function (rec) {
      if (token !== runToken) return;
      panel.innerHTML = "";
      const e = rec && rec.e;
      const tl = e ? buildTimeline(e) : null;
      const prose = (e && !looksLikeTree(e)) ? e : null;
      const known = result.parts.filter(function (p) { return p.origin && p.source; });
      if (!tl && !prose && !known.length) { panel.remove(); return; }

      panel.appendChild(el("div", "lab", "Word history"));
      if (tl) panel.appendChild(tl);

      if (prose) {
        panel.appendChild(el("div", "sub", "Etymology"));
        panel.appendChild(el("div", "hist", cleanProse(prose)));
      } else if (known.length) {
        panel.appendChild(el("div", "sub", "Etymology"));
        const origins = [];
        known.forEach(function (p) { if (origins.indexOf(p.origin) === -1) origins.push(p.origin); });
        const chain = known.map(function (p) {
          return "<i>" + escapeHtml(p.source) + '</i> (“' + escapeHtml(firstSense(p.meaning)) + "”)";
        }).join(" + ");
        const h = el("div", "hist");
        h.innerHTML = "From <span class=\"origin\">" + escapeHtml(origins.join(" and ")) + "</span> — " + chain + ".";
        panel.appendChild(h);
      }

      // First recorded — only when the source actually states a date.
      const yr = e ? extractYear(e) : null;
      if (yr) {
        const fr = el("div", "first-rec");
        fr.innerHTML = '<span class="sub">First recorded</span> ' + escapeHtml(yr);
        panel.appendChild(fr);
      }
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
