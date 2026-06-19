// Optional AI analysis via the Anthropic API, called directly from the browser
// with the user's own key. Returns the same shape the local engine produces so
// the renderer doesn't care where the breakdown came from.

(function (global) {
  "use strict";

  const ENDPOINT = "https://api.anthropic.com/v1/messages";
  const DEFAULT_MODEL = "claude-fable-5";

  const SYSTEM = [
    "You are an etymologist. Given a single English word, break it into its",
    "morphemes (prefixes, root(s), suffixes) in left-to-right order and explain",
    "each one's origin and meaning. Respond with ONLY a JSON object, no prose,",
    "no markdown fences. Shape:",
    "{",
    '  "word": string,',
    '  "parts": [',
    '    { "surface": string,  // how this piece is spelled in the word',
    '      "kind": "prefix"|"root"|"suffix"|"linker"|"unknown",',
    '      "origin": string,   // source language, e.g. "Latin", "Greek", "Old English"',
    '      "source": string,   // the original element, e.g. "aqua", "graphein"',
    '      "meaning": string } // short gloss, e.g. "water", "to write"',
    "  ],",
    '  "reading": { "literal": string,   // pieces joined like "not + water"',
    '               "sentence": string } // one-sentence plain-language synthesis',
    "}",
    "The surface fields, joined in order, must reconstruct the word. Keep glosses",
    "short. If a piece has no classical morphology, mark it kind \"unknown\"."
  ].join("\n");

  function getConfig() {
    return {
      key: localStorage.getItem("rootwork.apiKey") || "",
      model: localStorage.getItem("rootwork.model") || DEFAULT_MODEL,
      enabled: localStorage.getItem("rootwork.ai") === "1"
    };
  }

  async function analyze(word) {
    const cfg = getConfig();
    if (!cfg.key) throw new Error("No API key set. Open Settings to add one.");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: "user", content: "Analyze the word: " + word }]
      })
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error?.message || ""; } catch (e) {}
      throw new Error("Claude API error (" + res.status + "). " + detail);
    }

    const data = await res.json();
    const text = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim();
    const json = extractJson(text);

    // Normalize so it matches the local engine output.
    const parts = (json.parts || []).map(function (p) {
      return {
        kind: p.kind || "unknown",
        surface: p.surface || "",
        origin: p.origin || null,
        source: p.source || null,
        meaning: p.meaning || null,
        id: null,
        start: 0
      };
    });
    return {
      word: json.word || word,
      parts: parts,
      hasRoot: parts.some(function (p) { return p.kind === "root"; }),
      confidence: 1,
      reading: json.reading || { literal: null, sentence: "" },
      ai: true
    };
  }

  function extractJson(text) {
    try { return JSON.parse(text); } catch (e) {}
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Could not parse Claude's response.");
  }

  global.RootworkAI = { analyze: analyze, getConfig: getConfig, DEFAULT_MODEL: DEFAULT_MODEL };
})(window);
