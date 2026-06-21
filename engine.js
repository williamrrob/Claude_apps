// Etymology engine: decomposes a word into prefixes, a root, and suffixes
// using the curated MORPHEME database, then synthesizes a literal reading.
//
// Segmentation is done with a small scored search rather than greedy peeling:
// every legal way to slice the word into prefix* (root|linker)* suffix* is
// explored, and the parse that explains the most letters with real morphemes
// (and contains an actual root) wins.

(function (global) {
  "use strict";

  const data = global.MORPHEMES || (typeof require !== "undefined" ? require("./data.js").MORPHEMES : null);

  function indexBy(list) {
    const byForm = [];
    list.forEach(function (entry) {
      entry.forms.forEach(function (form) { byForm.push({ form: form, entry: entry }); });
    });
    byForm.sort(function (a, b) { return b.form.length - a.form.length; });
    return byForm;
  }

  const PREFIX_INDEX = indexBy(data.prefixes);
  const ROOT_INDEX = indexBy(data.roots);
  const SUFFIX_INDEX = indexBy(data.suffixes);
  const LINKERS = { o: 1, i: 1, u: 1, a: 1, e: 1, y: 1 };

  // Scoring weights tuned so that: covering a letter with a known morpheme beats
  // leaving it unknown; roots are worth the most; affixes a bit; linkers ~free.
  const W_KNOWN = 1.0;
  const ROOT_BONUS = 1.0;        // prefer reading shared letters as a root
  const AFFIX_BONUS = 0.0;       // length alone already beats "unknown"
  const SEGMENT_PENALTY = 0.12;  // prefer fewer, longer morphemes on ties
  const LINK_SCORE = 0.05;
  const UNKNOWN_PENALTY = -0.7;

  function part(kind, surface, entry, start) {
    return {
      kind: kind,
      surface: surface,
      origin: entry ? entry.origin : null,
      source: entry ? entry.source : null,
      meaning: entry ? entry.meaning : null,
      id: entry ? entry.id : null,
      forms: entry ? entry.forms : null,
      start: start
    };
  }

  // The single-letter "a" prefix is ambiguous. Latin ad- assimilates to "a-"
  // before s + consonant (ad+scribere → a·scribe, a·spire, a·scend), whereas the
  // Greek privative a- ("not") appears before s + vowel (a·symmetric, a·sexual)
  // or other letters (a·typical, a·moral). Pick the reading the spelling implies.
  const VOWELS = "aeiouy";
  function aFormFits(entry, word, pos) {
    const sCluster = word[pos + 1] === "s" && word[pos + 2] && VOWELS.indexOf(word[pos + 2]) < 0;
    if (entry.id === "ad") return sCluster;
    if (entry.id === "a-priv") return !sCluster;
    return true;
  }

  function matchesAt(index, word, pos) {
    const out = [];
    for (let i = 0; i < index.length; i++) {
      const f = index[i].form;
      if (word.slice(pos, pos + f.length) === f) out.push(index[i]);
    }
    return out;
  }

  function bestParse(word) {
    // phase: 0 = prefix zone, 1 = root zone, 2 = suffix zone
    const memo = new Map();

    function rec(pos, phase) {
      if (pos === word.length) return { parts: [], score: 0 };
      const key = pos + ":" + phase;
      if (memo.has(key)) return memo.get(key);

      let best = null;
      function consider(piece, rest, gain) {
        const score = gain - SEGMENT_PENALTY + rest.score;
        if (!best || score > best.score) {
          best = { parts: [piece].concat(rest.parts), score: score };
        }
      }

      if (phase === 0) {
        // Prefix zone never emits unknown letters; that prevents short prefixes
        // (e.g. "e", "a") from being matched inside a non-classical stem.
        matchesAt(PREFIX_INDEX, word, pos).forEach(function (m) {
          if (word.length - (pos + m.form.length) < 2) return; // leave room for a stem
          if (m.form === "a" && !aFormFits(m.entry, word, pos)) return; // a- vs ad-
          const rest = rec(pos + m.form.length, 0);
          consider(part("prefix", m.form, m.entry, pos), rest, m.form.length * W_KNOWN + AFFIX_BONUS);
        });
        // Enter the root zone without consuming.
        const t = rec(pos, 1);
        if (!best || t.score > best.score) best = t;
        memo.set(key, best);
        return best;
      }

      if (phase === 1) {
        matchesAt(ROOT_INDEX, word, pos).forEach(function (m) {
          const rest = rec(pos + m.form.length, 1);
          consider(part("root", m.form, m.entry, pos), rest, m.form.length * W_KNOWN + ROOT_BONUS);
        });
        // A connecting vowel only counts as a linker when a real root follows it.
        if (LINKERS[word[pos]] && matchesAt(ROOT_INDEX, word, pos + 1).length) {
          const rest = rec(pos + 1, 1);
          consider(part("linker", word[pos], null, pos), rest, LINK_SCORE);
        }
        // Move into the suffix zone without consuming.
        const t = rec(pos, 2);
        if (!best || t.score > best.score) best = t;
      } else {
        matchesAt(SUFFIX_INDEX, word, pos).forEach(function (m) {
          const rest = rec(pos + m.form.length, 2);
          consider(part("suffix", m.form, m.entry, pos), rest, m.form.length * W_KNOWN + AFFIX_BONUS);
        });
        // A lone trailing "e" is the silent "magic e" suffix (revolve, provoke).
        if (word[pos] === "e" && pos === word.length - 1) {
          consider(silentE(pos), { parts: [], score: 0 }, LINK_SCORE);
        }
      }

      // Fallback (root/suffix zones only): swallow one character as "unknown" so
      // the search can always reach the end. Adjacent unknowns merge later.
      const restU = rec(pos + 1, phase);
      consider(part("unknown", word[pos], null, pos), restU, UNKNOWN_PENALTY);

      memo.set(key, best);
      return best;
    }

    return rec(0, 0);
  }

  function mergeUnknowns(parts) {
    const out = [];
    parts.forEach(function (p) {
      const last = out[out.length - 1];
      if (p.kind === "unknown" && last && last.kind === "unknown") {
        last.surface += p.surface;
      } else {
        out.push(Object.assign({}, p));
      }
    });
    return out;
  }

  // The silent final "e" is its own morpheme — not a connector but a suffix-like
  // spelling marker (the "magic e"). Kept meaning-less so it doesn't pollute the
  // literal gloss; the UI describes it.
  function silentE(start) {
    return {
      kind: "suffix", surface: "e", origin: null, source: null,
      meaning: null, id: null, forms: null, silentE: true, start: start
    };
  }

  // microscope = micro + scop + e: when the last piece is a root ending in "e"
  // and the same root also exists without it (a known shorter form), peel it off.
  function peelSilentE(parts) {
    if (!parts.length) return parts;
    const last = parts[parts.length - 1];
    if (last.kind === "root" && last.forms && last.surface.length >= 4 &&
        last.surface.charAt(last.surface.length - 1) === "e") {
      const stem = last.surface.slice(0, -1);
      if (last.forms.indexOf(stem) !== -1) {
        const trimmed = Object.assign({}, last, { surface: stem });
        return parts.slice(0, -1).concat([trimmed, silentE(last.start + stem.length)]);
      }
    }
    return parts;
  }

  function decompose(rawWord) {
    const word = String(rawWord || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!word) return null;

    const parsed = bestParse(word);
    const parts = peelSilentE(mergeUnknowns(parsed.parts));

    let known = 0;
    parts.forEach(function (p) {
      if (p.kind === "prefix" || p.kind === "root" || p.kind === "suffix") known += p.surface.length;
    });
    const hasRoot = parts.some(function (p) { return p.kind === "root"; });

    return {
      word: word,
      parts: parts,
      hasRoot: hasRoot,
      confidence: word.length ? known / word.length : 0,
      reading: synthesize(word, parts)
    };
  }

  function firstSense(meaning) { return meaning.split(",")[0].trim(); }

  function synthesize(word, parts) {
    const glossable = parts.filter(function (p) { return p.meaning; });
    if (!glossable.length) {
      return {
        literal: null,
        sentence: "No classical Latin or Greek roots were recognized here. The word may be of Old English or other Germanic origin — switch on AI mode for a deeper analysis."
      };
    }

    const withGloss = function (kind) {
      return parts.filter(function (p) { return p.kind === kind && p.meaning; }).map(function (p) { return firstSense(p.meaning); });
    };
    const literal = glossable.map(function (p) { return firstSense(p.meaning); }).join(" + ");
    const prefixG = withGloss("prefix");
    const rootG = withGloss("root");
    const suffixG = withGloss("suffix");

    let sentence;
    if (rootG.length) {
      sentence = "Built on “" + rootG.join(" + ") + "”";
      if (prefixG.length) sentence += ", qualified by “" + prefixG.join(", ") + "”";
      if (suffixG.length) sentence += ", and turned into “" + suffixG.join(", ") + "”";
      sentence += ".";
    } else {
      sentence = "Reads literally as “" + literal + ".”";
    }
    return { literal: literal, sentence: sentence };
  }

  const engine = { decompose: decompose };
  global.EtymologyEngine = engine;
  if (typeof module !== "undefined" && module.exports) module.exports = engine;
})(typeof window !== "undefined" ? window : globalThis);
