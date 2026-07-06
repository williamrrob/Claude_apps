/*
 * mw-map.js — pure Merriam-Webster → `_mw` mapping, shared by the CLI importer
 * (scripts/mw-enrich.js) and the browser (app.js auto-fetch on search) so both
 * produce the SAME per-homograph staging shape. No I/O here: callers fetch the
 * raw dictionary + thesaurus JSON and hand the arrays to mapMwResponse().
 *
 * UMD-ish: exports as a CommonJS module under Node, and as window.MWMap in the
 * browser (loaded via a <script> tag before app.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MWMap = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var lc = function (s) { return String(s == null ? "" : s).toLowerCase(); };

  // MW text is peppered with {tokens}. Pipe-delimited link tokens carry a display
  // string as their first arg ({d_link|behaviour|behavior} -> "behaviour"); paired
  // formatting tags ({it}…{/it}) are stripped to their inner text; a few
  // punctuation tokens map to literal characters.
  function stripMw(s) {
    if (s == null) return "";
    var t = String(s);
    t = t.replace(/\{(?:sx|dxt|dx_def|d_link|a_link|i_link|et_link|mat)\|([^|}]*)(?:\|[^}]*)?\}/g, "$1");
    t = t.replace(/\{bc\}/g, ": ");
    t = t.replace(/\{ldquo\}/g, "“").replace(/\{rdquo\}/g, "”");
    t = t.replace(/\{p_br\}/g, " ");
    t = t.replace(/\{\/?[a-z_0-9]+(?:\|[^}]*)?\}/g, "");
    return t.replace(/\s+/g, " ").trim();
  }

  function dedup(arr, cap, exclude) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = lc(arr[i]);
      if (!k || k === exclude || seen[k]) continue;
      seen[k] = 1; out.push(arr[i]);
      if (out.length >= cap) break;
    }
    return out;
  }

  var CAPS = { syn: 12, ant: 8, rel: 12, stems: 24, phrases: 12 };

  // one MW dictionary entry -> one staged homograph object
  function mapDictEntry(e, word) {
    var hom = {};
    if (typeof e.hom === "number") hom.hom = e.hom;
    if (e.fl) hom.fl = e.fl;
    var hw = e.hwi && e.hwi.hw ? e.hwi.hw.replace(/\*/g, "") : lc(word);
    hom.hwi = { hw: hw };
    var ipa = e.hwi && e.hwi.prs && e.hwi.prs.filter(function (p) { return p.ipa; })[0];
    if (ipa) hom.hwi.prs = [{ ipa: ipa.ipa }];
    if (Array.isArray(e.shortdef) && e.shortdef.length) hom.shortdef = e.shortdef.map(stripMw);
    if (Array.isArray(e.et)) {
      var et = e.et.filter(function (x) { return Array.isArray(x) && x[0] === "text"; })
        .map(function (x) { return stripMw(x[1]); }).join(" ")
        // MW etymology prose can end in a bare cross-ref to another homograph
        // ("… uninhabited" desert:2) — drop that dangling pointer.
        .replace(/\s+[a-zà-ÿ]+:\d+\s*$/i, "").replace(/\s+/g, " ").trim();
      if (et) hom.et = et;
    }
    if (e.date) hom.date = stripMw(e.date).replace(/\s*\{ds\|[^}]*\}/g, "").trim();
    var phrases = [];
    for (var i = 0; i < (e.dros || []).length; i++) if (e.dros[i].drp) phrases.push(stripMw(e.dros[i].drp));
    var stems = (e.meta && Array.isArray(e.meta.stems)) ? e.meta.stems : [];
    for (var j = 0; j < stems.length; j++) if (/\s/.test(stems[j])) phrases.push(stems[j]);
    var ph = dedup(collapsePhrases(phrases), CAPS.phrases, lc(word));
    if (ph.length) hom.phrases = ph;
    var forms = dedup(stems.filter(function (st) { return !/\s/.test(st); }), CAPS.stems, lc(word));
    if (forms.length) hom.stems = forms;
    return hom;
  }

  // Collapse near-duplicate phrase variants that differ only by a possessive
  // pronoun or a verb inflection ("get her/his/one's just deserts",
  // "gets/getting …") down to one canonical form so the phrases line stays short.
  // common irregular verbs whose inflections collapse to a base form
  var VERB_BASE = { got: "get", gets: "get", getting: "get", gotten: "get",
    made: "make", makes: "make", making: "make", took: "take", takes: "take", taking: "take",
    went: "go", goes: "go", going: "go", came: "come", comes: "come", coming: "come" };
  function collapsePhrases(phrases) {
    var seen = {}, out = [];
    for (var i = 0; i < phrases.length; i++) {
      var norm = lc(phrases[i])
        .replace(/\b(?:my|your|his|her|its|our|their|one's|someone's|somebody's)\b/g, "one's")
        .replace(/[a-z]+/g, function (w) { return VERB_BASE[w] || w; })
        .replace(/\s+/g, " ").trim();
      if (seen[norm]) continue;
      seen[norm] = 1; out.push(norm); // canonical form, e.g. "get one's just deserts"
    }
    return out;
  }

  // ---- thesaurus ----
  var STOP = { a:1,an:1,the:1,of:1,in:1,to:1,and:1,or:1,is:1,are:1,that:1,as:1,with:1,
    for:1,on:1,by:1,be:1,its:1,from:1,into:1,than:1,usually:1,used:1,such:1,something:1,someone:1 };
  function wordBag(strs) {
    var bag = {};
    strs = strs || [];
    for (var i = 0; i < strs.length; i++) {
      var parts = stripMw(strs[i]).toLowerCase().split(/[^a-z]+/);
      for (var j = 0; j < parts.length; j++) if (parts[j] && !STOP[parts[j]]) bag[parts[j]] = 1;
    }
    return bag;
  }
  function overlap(a, b) {
    var ak = Object.keys(a), bk = Object.keys(b);
    if (!ak.length || !bk.length) return 0;
    var inter = 0;
    for (var i = 0; i < ak.length; i++) if (b[ak[i]]) inter++;
    return inter / (ak.length + bk.length - inter);
  }
  // pull synonyms/antonyms (from meta) and related words (per-sense rel_list)
  function collectThes(e) {
    var s = [], a = [], r = [];
    var syns = (e.meta && e.meta.syns) || [], ants = (e.meta && e.meta.ants) || [];
    for (var i = 0; i < syns.length; i++) for (var j = 0; j < syns[i].length; j++) s.push(syns[i][j]);
    for (var k = 0; k < ants.length; k++) for (var m = 0; m < ants[k].length; m++) a.push(ants[k][m]);
    var walk = function (node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === "object") {
        var rl = node.rel_list || [];
        for (var x = 0; x < rl.length; x++) for (var y = 0; y < rl[x].length; y++) if (rl[x][y] && rl[x][y].wd) r.push(rl[x][y].wd);
        if (node.sseq) walk(node.sseq);
        if (node.def) walk(node.def);
      }
    };
    walk(e.def || []);
    return { s: s, a: a, r: r };
  }
  // Assign thesaurus entries to dict homographs ONE-TO-ONE. MW numbers homographs
  // independently across its dictionary and thesaurus products, so dict `hom`
  // never reliably aligns with thesaurus `hom`. We match on part of speech, and
  // greedily by gloss overlap so a strong match ("arid land" ↔ "land not fit for
  // crops") claims its entry first — freeing the ambiguous zero-overlap case
  // ("just deserts" vs "punishment", no literal words shared) to take the only
  // remaining same-PoS entry instead of duplicating another sense's synonyms.
  function assignThes(homs, thesEntries) {
    var result = homs.map(function () { return { s: [], a: [], r: [] }; });
    var pairs = [];
    homs.forEach(function (h, i) {
      thesEntries.forEach(function (t, j) {
        if (lc(t.fl) === lc(h.fl)) pairs.push({ i: i, j: j, sc: overlap(wordBag(h.shortdef), wordBag(t.shortdef)) });
      });
    });
    pairs.sort(function (a, b) { return b.sc - a.sc; });
    var usedH = {}, usedT = {};
    for (var p = 0; p < pairs.length; p++) {
      var pr = pairs[p];
      if (usedH[pr.i] || usedT[pr.j]) continue;
      usedH[pr.i] = 1; usedT[pr.j] = 1;
      result[pr.i] = collectThes(thesEntries[pr.j]);
    }
    return result;
  }

  // Keep only real entry objects for THIS headword (drop cross-ref stubs and
  // suggestion strings MW returns for misses).
  function entriesFor(arr, word) {
    if (!Array.isArray(arr) || !arr.length || typeof arr[0] === "string") return [];
    return arr.filter(function (e) {
      return e && e.hwi && lc((e.hwi.hw || "").replace(/\*/g, "")) === lc(word);
    });
  }

  // dictArr + thesArr (raw MW JSON arrays) -> `_mw` staging array
  function mapMwResponse(dictArr, thesArr, word) {
    var dictEntries = (Array.isArray(dictArr) && dictArr.length && typeof dictArr[0] !== "string")
      ? dictArr.filter(function (e) { return e && e.meta && e.hwi && lc((e.hwi.hw || "").replace(/\*/g, "")) === lc(word); })
      : [];
    if (!dictEntries.length) return [];
    var thes = entriesFor(thesArr, word);
    var homs = dictEntries.map(function (e) { return mapDictEntry(e, word); });
    var byHom = assignThes(homs, thes);
    return homs.map(function (hom, i) {
      var t = byHom[i];
      var S = dedup(t.s, CAPS.syn, lc(word)), A = dedup(t.a, CAPS.ant, lc(word)), R = dedup(t.r, CAPS.rel, lc(word));
      if (S.length) hom.s = S;
      if (A.length) hom.a = A;
      if (R.length) hom.r = R;
      return hom;
    });
  }

  return {
    stripMw: stripMw,
    mapDictEntry: mapDictEntry,
    collectThes: collectThes,
    assignThes: assignThes,
    entriesFor: entriesFor,
    mapMwResponse: mapMwResponse
  };
});
