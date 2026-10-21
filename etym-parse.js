/*
 * etym-parse.js — turn a Wiktionary etymology paragraph (the `e` field every
 * entry already carries) into structure. This is the ONE source for every
 * etymology view in the app — ancestry tree, word-history timeline, doublets,
 * cognates — so no view can disagree with the prose printed under it.
 *
 * Loads in the browser (window.EtymParse) and in Node (require).
 *
 *   EtymParse.parse(word, e) → {
 *     prose: cleaned paragraph (tree-blob debris removed),
 *     chain: [node…]   nearest ancestor first. node = {l, t, g?, tr?, k, q?, p?}
 *                      l language, t term, g gloss, tr transliteration,
 *                      k how the CHILD came from it: inh | bor | der | lbor | cal | via
 *                      q hedge ("probably", "possibly"…), p components when
 *                      the step is "X + Y" (each {l,t,g?,tr?,aff?}).
 *     parts: [{t,g?,aff?}]   English surface analysis ("from un- + heard",
 *                             "equivalent to in- + credible") when stated.
 *     doublets: [word…], cognates: [{l,t,g?}…], see: [word…]
 *   }
 */
(function (root) {
  "use strict";

  // ---- languages, as Wiktionary spells them -------------------------------
  const BASE = ("Latin|Greek|English|French|German|Dutch|Norse|Saxon|Frisian|Irish|Welsh|Scots|Danish|Swedish|Norwegian|Icelandic|Faroese|Gothic|Frankish|Spanish|Portuguese|Italian|Catalan|Occitan|Galician|Romanian|Sicilian|Neapolitan|Venetan|Lombard|Lombardic|Provençal|Picard|Walloon|Norman|Anglo-Norman|Anglo-Latin|Russian|Ukrainian|Belarusian|Polish|Czech|Slovak|Slovene|Serbo-Croatian|Bulgarian|Macedonian|Lithuanian|Latvian|Prussian|Albanian|Armenian|Georgian|Persian|Avestan|Sanskrit|Prakrit|Pali|Hindi|Urdu|Hindustani|Bengali|Punjabi|Gujarati|Marathi|Nepali|Sinhalese|Sindhi|Odia|Assamese|Konkani|Kashmiri|Tamil|Telugu|Kannada|Malayalam|Arabic|Hebrew|Aramaic|Syriac|Akkadian|Sumerian|Phoenician|Punic|Egyptian|Coptic|Amharic|Ge'ez|Turkish|Ottoman Turkish|Turkic|Tatar|Kazakh|Kyrgyz|Uyghur|Uzbek|Azerbaijani|Mongolian|Mongol|Manchu|Hungarian|Finnish|Estonian|Basque|Etruscan|Oscan|Umbrian|Gaulish|Celtic|Breton|Cornish|Manx|Gaelic|Brythonic|Chinese|Mandarin|Cantonese|Hokkien|Teochew|Hakka|Japanese|Korean|Ainu|Okinawan|Vietnamese|Thai|Lao|Khmer|Burmese|Tibetan|Dzongkha|Malay|Indonesian|Javanese|Tagalog|Filipino|Cebuano|Malagasy|Hawaiian|Maori|Māori|Samoan|Tongan|Tahitian|Fijian|Swahili|Zulu|Xhosa|Yoruba|Igbo|Hausa|Wolof|Akan|Twi|Kongo|Kimbundu|Tswana|Sotho|Shona|Somali|Afrikaans|Yiddish|Romani|Angloromani|Esperanto|Nahuatl|Quechua|Aymara|Guarani|Tupi|Nheengatu|Taino|Arawak|Carib|Mayan|Cree|Ojibwe|Algonquian|Powhatan|Massachusett|Narragansett|Unami|Munsee|Abenaki|Dakota|Lakota|Navajo|Hopi|Inuktitut|Greenlandic|Aleut|Dharug|Wiradjuri|Nyunga|Hittite|Tocharian|Illyrian|Thracian|Phrygian|Lydian|Scythian|Sogdian|Pashto|Tajik|Kurdish|Dhivehi|Maltese|Bantu|Semitic|Iranian|Indo-Iranian|Indo-Aryan|Slavic|Germanic|Romance|Italic|Hellenic|Balto-Slavic|Polynesian|Malayo-Polynesian|Austronesian|Dravidian|Tupi-Guarani|Kartvelian|Uralic|Finnic|Sami|Indo-European|Indo-Germanic|Italo-Celtic|Celtic|Brittonic|Goidelic|Anatolian|Albanoid|Armeno-Greek|Graeco-Aryan|Flemish|Limburgish|Luxembourgish|Yola|Norn|Cockney|Chinook Jargon|Tok Pisin|Bislama|Lojban|Volapük|Interlingua|Manipuri|Tulu|Chuvash|Bashkir|Ladino|Mozarabic|Asturian|Aragonese|Leonese|Ligurian|Friulian|Sardinian|Corsican|Romansch|Romansh|Dalmatian|Vandalic|Burgundian|Crimean Gothic|Sorbian|Kashubian|Rusyn|Syriac|Mandaic|Ugaritic|Elamite|Hurrian|Luwian|Choctaw|Creek|Cherokee|Mohawk|Seneca|Ottawa|Menominee|Lenape|Mi'kmaq|Wampanoag|Mohegan|Halkomelem|Lushootseed|Yupik|Iñupiaq|Inupiaq|Nyungar|Kaurna|Pitjantjatjara|Warlpiri|Yolŋu|Guugu Yimidhirr").split("|");
  const MOD = "(?:Proto-|Pre-|Old |Middle |Late |Early |Medieval |Ecclesiastical |New |Vulgar |Classical |Ancient |Archaic |Modern |Koine |Byzantine |Hellenistic |Biblical |Mishnaic |Rabbinic |Medieval |Early Modern |Late Middle |Late Old |Northern |Southern |Western |Eastern |Central |West |East |North |South |Low |High |Upper |Lower |Common |Primitive |Brazilian |European |American |British |Canadian |Mexican |Australian |Jamaican |Cajun |Louisiana |Quebec |Swiss |Austrian |Egyptian |Gulf |Levantine |Moroccan |Algerian |Tunisian |Iraqi |Classical Middle |Anglian |West Saxon |Kentish |Mercian |Northumbrian |Scottish |Irish |Norman |Old Northern |Northern Middle |Southern Middle |Kievan |Imperial |Literary |Standard |Cypriot |Attic |Ionic |Doric |Aeolic |Epic |Mycenaean |Homeric |Hellenistic Ancient )*";
  const LANG_RE_SRC = MOD + "(?:" + BASE.slice().sort(function (a, b) { return b.length - a.length; })
    .map(function (s) { return s.replace(/[.*+?^${}()|[\]\\']/g, "\\$&"); }).join("|") + ")(?:-[A-Z][a-z]+)?";
  const LANG_AT = new RegExp("^(" + LANG_RE_SRC + ")\\b\\s*");
  const LANG_ANY = new RegExp("\\b(" + LANG_RE_SRC + ")\\b", "g");

  // ---- helpers -------------------------------------------------------------
  function fold(s) {
    return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[*]/g, "").trim();
  }

  // split on a separator regex, but only at depth 0 (outside () [] and “”)
  function splitTop(s, re) {
    const out = []; let depth = 0, q = false, last = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "[") depth++;
      else if ((c === ")" || c === "]") && depth > 0) depth--;
      else if (c === "“") q = true;
      else if (c === "”") q = false;
      else if (!depth && !q) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (m && m.index === i) { out.push(s.slice(last, i)); out.push(m); last = i + m[0].length; i = last - 1; }
      }
    }
    out.push(s.slice(last));
    return out;
  }

  // sentences: split on ". " (also "…"), outside parens/quotes, and not after
  // abbreviations like "c." "e.g." "lit." or a single capital initial.
  function sentences(text) {
    const res = []; let depth = 0, q = false, cur = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i]; cur += c;
      if (c === "(" || c === "[") depth++;
      else if ((c === ")" || c === "]") && depth > 0) depth--;
      else if (c === "“") q = true;
      else if (c === "”") q = false;
      else if (!depth && !q && (c === "." || c === "…" || c === ";") && (i + 1 >= text.length || text[i + 1] === " ")) {
        const tail = cur.slice(-6);
        if (c === "." && /(\bc|\be\.g|\bi\.e|\blit|\bcf|\bvs|\bviz|\bSt|\bMr|\bDr|\bno|\bp|\bpp|\bca|\bfl|\b[A-Z])\.$/.test(tail)) continue;
        res.push({ s: cur.trim(), end: c }); cur = "";
      }
    }
    if (cur.trim()) res.push({ s: cur.trim(), end: "" });
    return res;
  }

  // Remove a flattened etymon-tree blob ("Proto-Italic *x Latin ybor. … English word")
  // that some imports glued in front of the real prose.
  const STARTERS = /\b(From|Borrowed from|Inherited from|Learned borrowing from|Semi-learned borrowing from|Unadapted borrowing from|Orthographic borrowing from|Derived from|Calque of|Partial calque of|Compound of|Blend of|Clipping of|Back-formation from|Coined|Recorded|First attested|Attested|Probably from|Possibly from|Perhaps from|Ultimately from|Uncertain|Unknown|Of uncertain|Of unknown|Named after|Equivalent to|By surface analysis|Doublet of|The (?:adjective|noun|verb|word|term|name|sense))\b/;
  function stripBlob(word, e) {
    let s = String(e || "").trim();
    const looksBlob = /^(?:Proto-|[A-Z][\w-]+(?: [A-Z][\w-]+)* \*?\S+?(?:bor|inh|der|nom|cal|lbor|bf|af)\.)/.test(s) ||
      /\S(?:bor|inh|der|lbor|cal)\.\s/.test(s.slice(0, 400));
    if (looksBlob) {
      const tag = "English " + word + " ";
      const k = s.lastIndexOf(tag);
      if (k >= 0 && k < s.length - tag.length) s = s.slice(k + tag.length);
      else { const m = s.match(STARTERS); if (m && m.index > 0) s = s.slice(m.index); }
    }
    return s.replace(/\s{2,}/g, " ").trim();
  }

  // ---- term + gloss --------------------------------------------------------
  // "hospitālis, hospitāle (“hospice, shelter”)" → {t, alt, tr?, g?}
  function parseTerm(seg) {
    let s = seg.trim();
    let g = "", tr = "";
    const pi = s.indexOf("(");
    let head = pi >= 0 ? s.slice(0, pi) : s;
    let paren = "";
    if (pi >= 0) {
      let d = 0, j = pi;
      for (; j < s.length; j++) { if (s[j] === "(") d++; else if (s[j] === ")") { d--; if (!d) break; } }
      paren = s.slice(pi + 1, j);
    }
    if (paren) {
      const qi = paren.indexOf("“");
      if (qi >= 0) {
        tr = paren.slice(0, qi).replace(/[,;]\s*$/, "").trim();
        const qe = paren.indexOf("”", qi);
        g = paren.slice(qi + 1, qe > qi ? qe : undefined).trim();
      } else if (/^[^,]+,\s*[^,]+$/.test(paren) && !/\b(?:compare|whence|from|see|English|Modern|cf|also|literally|lit|equivalent)\b/i.test(paren)) {
        const c = paren.indexOf(",");
        tr = paren.slice(0, c).trim(); g = paren.slice(c + 1).trim();
      } else if (!/\b(?:compare|whence|from|see|English|Modern|cf|also|literally|lit)\b/i.test(paren)) {
        tr = paren.split(",")[0].trim();
      }
    }
    head = head.replace(/\s+(?:also|and|or)\s*$/, "").replace(/\s+or\s+.*$/, "");
    head = head.replace(/^(?:(?:medical|legal|technical|botanical|zoological|anatomical|military|nautical|poetic|religious|philosophical|grammatical|rhetorical|musical|culinary|scientific)\s+)?(?:term|word|name|title|expression|phrase|epithet)\s+(?=\S)/i, "");
    const forms = head.split(/,\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
    let t = (forms[0] || "").replace(/[.;:]+$/, "");
    // drop leading descriptors: "noun use of", "the verb", "a diminutive of"…
    t = t.replace(/^(?:the |a |an )?(?:(?:present|past|perfect|perfect passive|future|passive) )?(?:participle|infinitive|stem|genitive|accusative|plural|diminutive|feminine|masculine|neuter|adjective|noun|verb|noun use|substantive use|frequentative|variant|form|root|oblique stem)(?: form)? of /i, "");
    if (/\s/.test(t) && !/^\*/.test(t)) {
      // a multiword term is fine for phrases ("in dies"), but cut trailing prose
      t = t.replace(/\s+(?:with|which|that|meaning|whence|in the|of the|itself|ultimately).*$/, "");
    }
    // trailing descriptors glued after the term: "abiens present participle of abeō",
    // "allegorizer and Middle French …", "adulteration and its etymon Latin …"
    t = t.replace(/\s+(?:(?:present|past|perfect|passive|nominative|accusative|genitive|neuter|feminine|masculine|singular|plural|extended|participial|irregular)\s+)*(?:participle|stem|form|modification|translation|calque|variant|of uncertain|of unknown|or a|or an|and its|as well as|and the|either:|\[|etc|of American|and Middle|and Old|and Latin|and Late).*$/i, "");
    t = t.replace(/\s+\*\s.*$/, "").trim();
    if (t.split(/\s+/).length > 3) return null;
    if (!t || t.length > 60 || /^(?:the|a|an|unknown|uncertain|origin|its|this|which)$/i.test(t)) return null;
    const out = { t: t };
    if (forms.length > 1) out.alt = forms.slice(1, 4);
    if (tr) out.tr = tr;
    if (g) out.g = g;
    return out;
  }

  const DESCR = /^(?:the |a |an )?(?:(?:present|past|perfect|perfect passive|future|passive|active) )?(?:participle|infinitive|stem|genitive|accusative|ablative|nominative|plural|singular|diminutive|feminine|masculine|neuter|adjective|noun|verb|noun use|substantive use|substantivized|frequentative|variant|form|root|oblique stem|inchoative|intensive)(?: form)? (?:use )?of /i;
  const ISAFF = function (t) { return /^-|-$/.test(t); };

  // one link of a chain, e.g. "Latin incrēdibilis (“…”)" or "in- (“not”) + crēdibilis"
  function parseStep(seg, prevLang) {
    let s = seg.trim().replace(/^[,;:\s]+/, "");
    const hedge = (s.match(/^(probably|possibly|perhaps|ultimately|likely|apparently|partly|presumably)\s+/i) || [])[1];
    if (hedge) s = s.slice(hedge.length).trim();
    s = s.replace(/^(?:the |an? )?(?:same )?(?:source as |root of )?/i, "");
    const parts = splitTop(s, /\s\+\s/g).filter(function (x) { return typeof x === "string"; });
    if (parts.length > 1) {
      let lang = prevLang;
      const comps = [];
      parts.forEach(function (p) {
        let ps = p.trim(), l = null;
        const m = ps.match(LANG_AT);
        if (m) { l = m[1]; ps = ps.slice(m[0].length); lang = l; }
        const tt = parseTerm(ps);
        if (tt) { tt.l = l || lang; if (ISAFF(tt.t)) tt.aff = 1; comps.push(tt); }
      });
      if (comps.length < 2) return null;
      const step = { l: comps[0].l, t: comps.map(function (c) { return c.t; }).join(" + "), p: comps };
      if (hedge) step.q = hedge.toLowerCase();
      return step;
    }
    s = s.replace(DESCR, "");
    // "Middle French sur or Old French seür" → take the first, keep the rest as alts
    const orSplit = s.split(/\s+or\s+(?=[A-Z])/);
    if (orSplit.length > 1) s = orSplit[0];
    let l = null;
    let m = s.match(LANG_AT);
    if (m) { l = m[1]; s = s.slice(m[0].length); }
    // "Old Northern French variant of Old French guarantie" / "Old French verb guarantir":
    // a descriptor after the language points past itself.
    const s2 = s.replace(DESCR, "").replace(/^(?:(?:dialectal|regional|late|early|learned|popular|unattested|hypothetical) )*(?:variant|form|spelling|alteration|verb|noun|adjective)\s+(?:of\s+)?/i, "");
    if (s2 !== s) {
      const m2 = s2.match(LANG_AT);
      if (m2) { l = m2[1]; s = s2.slice(m2[0].length); } else s = s2;
    }
    const tt = parseTerm(s);
    if (!tt) return null;
    tt.l = l || prevLang;
    if (!tt.l) return null;
    if (hedge) tt.q = hedge.toLowerCase();
    return tt;
  }

  const LEAD = [
    [/^(?:(?:probably|possibly|perhaps|ultimately|likely|apparently)\s+)?inherited from\s+/i, "inh"],
    [/^(?:(?:probably|possibly|perhaps|ultimately|likely|apparently)\s+)?(?:semi-)?learned borrowing from\s+/i, "lbor"],
    [/^(?:(?:probably|possibly|perhaps|ultimately|likely|apparently)\s+)?(?:unadapted |orthographic |partial |direct |late )?borrow(?:ed|ing) (?:partly )?from\s+/i, "bor"],
    [/^(?:(?:probably|possibly|perhaps|ultimately|likely|apparently)\s+)?(?:partial )?calque of\s+/i, "cal"],
    [/^(?:(?:probably|possibly|perhaps|ultimately|likely|apparently)\s+)?derived from\s+/i, "der"],
    [/^(?:(?:probably|possibly|perhaps|ultimately|likely|apparently)\s+)?(?:coined (?:in English )?)?from\s+/i, "der"],
  ];
  // chain link separators inside a sentence
  const LINK = /,?\s*(?:(?:and|or)\s+)?(?:(?:itself|in turn|ultimately|probably|possibly|perhaps|likely|apparently|presumably|originally|partly)\s+)*(?:(?:inherited|borrowed|derived)\s+from|from|via)\s+/gi;

  function relOf(sep) {
    const s = sep.toLowerCase();
    if (/inherited/.test(s)) return "inh";
    if (/borrowed/.test(s)) return "bor";
    if (/\bvia\b/.test(s)) return "via";
    return "der";
  }

  function parseChainSentence(word, s, out) {
    let kind = null, body = s.replace(/[.…;]$/, "");
    // strip a leading clause like "The adjective is first attested in 1534, the verb circa 1631; borrowed from"
    let leadHit = LEAD.some(function (L) { return L[0].test(body); });
    const lm = body.match(/\b(?:inherited|borrowed|borrowing|derived|calque of|from)\b/i);
    if (!lm) return false;
    if (!leadHit && lm.index > 0) {
      const pre = body.slice(0, lm.index);
      if (/\b(?:recorded|attested|since|circa|c\.|\d{3,4})\b/i.test(pre) || /^(?:Recorded|First|Coined|Attested)/.test(pre)) body = body.slice(lm.index);
      else return false;
    }
    for (let i = 0; i < LEAD.length; i++) {
      const m = body.match(LEAD[i][0]);
      if (m) { kind = LEAD[i][1]; body = body.slice(m[0].length); break; }
    }
    if (!kind) return false;
    const pieces = splitTop(body, LINK);
    let rel = kind, prevLang = null, any = false;
    const stopAt = /^(?:compare|cognate|doublet|see|related|whence|displaced|equivalent|more at|cf\b)/i;
    for (let i = 0; i < pieces.length; i += 2) {
      let seg = pieces[i];
      if (stopAt.test(seg.trim())) break;
      // "equivalent to X + Y" tacked onto a step → English surface analysis
      const eq = seg.match(/,?\s*(?:equivalent to|by surface analysis,?)\s+(.+)$/i);
      if (eq) { seg = seg.slice(0, eq.index); surface(eq[1], out); }
      const step = parseStep(seg, prevLang);
      if (step) {
        // a first step with no language is an English-internal formation
        if (!step.l) step.l = "English";
        step.k = rel;
        // English-internal compound "From quag + mire" is the word's breakdown
        if (step.l === "English" && step.p && !out.chain.length) {
          if (!out.parts.length) out.parts = step.p.map(function (c) { const o = { t: c.t }; if (c.g) o.g = c.g; if (c.aff) o.aff = 1; return o; });
        } else if (!(step.l === "English" && fold(step.t) === fold(word))) {
          out.chain.push(step);
        }
        prevLang = step.l === "English" ? prevLang : step.l;
        any = true;
      }
      const sep = pieces[i + 1];
      if (sep && /^,?\s*or\b/i.test(sep[0])) break; // "…, or from X": an alternative, not a further step
      if (sep) rel = relOf(sep[0]);
    }
    return any;
  }

  function surface(s, out) {
    if (out.parts.length) return;
    const comps = splitTop(s.replace(/[.;]$/, ""), /\s\+\s/g).filter(function (x) { return typeof x === "string"; });
    if (comps.length < 2) return;
    const parts = [];
    comps.forEach(function (c) { const t = parseTerm(c.replace(LANG_AT, "")); if (t) { const o = { t: t.t }; if (t.g) o.g = t.g; if (ISAFF(t.t)) o.aff = 1; parts.push(o); } });
    if (parts.length >= 2) out.parts = parts;
  }

  function wordList(s) {
    // "hotel and hospital" / "cape, capo, caput, and chief through Latin, and head…"
    const clean = s.replace(/\([^()]*\)/g, "").replace(/“[^”]*”/g, "")
      .replace(/\bthrough [A-Z][\w-]*(?: [A-Z][\w-]*)*/g, ",")
      .replace(/\b(?:the |a )?(?:now )?(?:obsolete|archaic|dialectal|rare|regional|Scottish|British|American|Middle English|Old English|English)(?: or (?:obsolete|archaic|dialectal|rare))?\s+/g, "");
    return clean.split(/\s*(?:,|;|\band\b|\bor\b)\s*/).map(function (x) {
      return x.trim().replace(/[.…:]+$/, "").replace(/^(?:also|the|more at|see|compare)\s+/i, "").trim();
    }).filter(function (x) {
      return x && x.length < 30 && x.split(" ").length <= 2 && /^[\p{L}][\p{L}'-]*(?: [\p{L}'-]+)?$/u.test(x) &&
        !/\b(?:etymology|sense|senses|word|words|its|this|which|that|also|use|mean|the|of|to|in|with|from|is|are|was)\b/i.test(x);
    });
  }

  function cognateList(s) {
    const out = [];
    const items = splitTop(s.replace(/[.…;]$/, ""), /\s*(?:,|;)\s*(?:and\s+)?|\s+and\s+/g).filter(function (x) { return typeof x === "string"; });
    let lang = null;
    items.forEach(function (it) {
      let x = it.trim(); if (!x) return;
      const m = x.match(LANG_AT);
      if (m) { lang = m[1]; x = x.slice(m[0].length); }
      const t = parseTerm(x);
      if (t && t.t && !/\s/.test(t.t.replace(/^\*/, ""))) { t.l = lang || "English"; delete t.alt; out.push(t); }
    });
    return out;
  }

  // Flattened etymon tree: "Proto-Indo-European *kap- … Latin caput Vulgar Latin capus Old French chiefbor. … English chief"
  // Deepest ancestor first. Used only when the prose yields no chain, and only
  // when it is a single line of descent (one English node, at the end).
  function parseBlob(word, e) {
    const tag = "English " + word;
    const k = e.indexOf(tag);
    if (k < 0) return null;
    let blob = e.slice(0, k).trim();
    if (!blob || /\bEnglish\s/.test(blob.replace(/(?:Middle|Old|Early Modern|Late Middle|Late Old) English/g, ""))) return null;
    const nodes = [];
    while (blob.length) {
      const m = blob.match(LANG_AT);
      if (!m) break;
      blob = blob.slice(m[0].length);
      const nx = blob.search(new RegExp("\\s(?=" + LANG_RE_SRC + "\\s)"));
      let term = (nx >= 0 ? blob.slice(0, nx) : blob).trim();
      blob = nx >= 0 ? blob.slice(nx).trim() : "";
      let rel = "der";
      const rm = term.match(/(bor|inh|der|lbor|cal|nom|af|bf)\.\s*\??$/);
      if (rm) { rel = rm[1] === "inh" ? "inh" : rm[1] === "bor" || rm[1] === "lbor" ? "bor" : "der"; term = term.slice(0, rm.index).trim(); }
      if (!term || /\s/.test(term.replace(/^\*/, ""))) return null;
      nodes.push({ l: m[1], t: term, k: rel });
    }
    if (nodes.length < 2) return null;
    // stored deepest-first; each node's rel describes the edge to the NEXT (younger) node
    const chain = [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const younger = i === nodes.length - 1 ? null : nodes[i + 1];
      chain.push({ l: nodes[i].l, t: nodes[i].t, k: i === nodes.length - 1 ? nodes[i].k : nodes[i].k, blob: 1 });
    }
    // collapse consecutive duplicates (same lang+term)
    return chain.filter(function (n, i) { return !i || fold(n.t) !== fold(chain[i - 1].t) || n.l !== chain[i - 1].l; });
  }

  function parse(word, e) {
    const out = { prose: "", chain: [], parts: [], doublets: [], cognates: [], see: [] };
    if (!e) return out;
    const prose = stripBlob(word, e);
    out.prose = prose;
    // Some imports clipped the middle out ("…(“ho … Doublet of hotel"): parse
    // each side on its own, cutting the clipped tail back to a clean boundary.
    const sents = [];
    prose.split(/\s*…\s*/).forEach(function (chunk, i, all) {
      let c = chunk;
      if (i < all.length - 1) {
        const lp = c.lastIndexOf("("), rp = c.lastIndexOf(")");
        if (lp > rp) c = c.slice(0, lp);
        const lq = c.lastIndexOf("“"), rq = c.lastIndexOf("”");
        if (lq > rq) c = c.slice(0, lq);
        c = c.replace(/[,;\s]+$/, "");
        out.clipped = 1;
      }
      sentences(c).forEach(function (o) { sents.push(o); });
    });
    let chainDone = false;
    sents.forEach(function (o) {
      const s = o.s;
      let m;
      if ((m = s.match(/^(?:Piecewise )?doublet of\s+(.+)$/i)) || (m = s.match(/\b(?:and )?doublet of\s+(.+)$/i))) {
        wordList(m[1].replace(/\s+through Proto-Indo-European.*$/, "")).forEach(function (w) { if (out.doublets.indexOf(w) < 0 && fold(w) !== fold(word)) out.doublets.push(w); });
        if (/^(?:piecewise )?doublet/i.test(s)) return;
      }
      if ((m = s.match(/\bcognate (?:with|to)\s+(.+)$/i))) {
        const pre = s.slice(0, m.index);
        cognateList(m[1].replace(/,?\s*and doublet of.*$/i, "")).forEach(function (c) { out.cognates.push(c); });
        if (!pre.trim()) return;
      }
      if ((m = s.match(/^(?:see(?: also)?|more at|compare(?: also)?|related to)\s+(.+)$/i))) {
        // only bare English words go to see-also; foreign comparanda are noise here
        if (!LANG_ANY.test(m[1])) wordList(m[1]).forEach(function (w) { if (out.see.indexOf(w) < 0) out.see.push(w); });
        LANG_ANY.lastIndex = 0;
        return;
      }
      if ((m = s.match(/^(?:equivalent to|by surface analysis,?)\s+(.+)$/i))) { surface(m[1], out); return; }
      if (!chainDone) chainDone = parseChainSentence(word, s, out);
    });
    if (!out.chain.length && !out.parts.length) {
      const b = parseBlob(word, String(e));
      if (b) { out.chain = b; out.fromBlob = 1; }
    }
    // English cognates in "Cognate to fraction, fracture" are lateral links, not foreign cognates
    out.cognates = out.cognates.filter(function (c) {
      if (c.l === "English") { if (out.see.indexOf(c.t) < 0) out.see.push(c.t); return false; }
      return true;
    });
    return out;
  }

  // The prose as shown on the page: blob debris removed, and the spots an
  // earlier import clipped ("(“ho … Doublet") cut back to a clean " … ".
  function display(word, e) {
    const prose = stripBlob(word, e);
    return prose.split(/\s*…\s*/).map(function (chunk, i, all) {
      let c = chunk;
      if (i < all.length - 1) {
        const lp = c.lastIndexOf("("), rp = c.lastIndexOf(")"); if (lp > rp) c = c.slice(0, lp);
        const lq = c.lastIndexOf("“"), rq = c.lastIndexOf("”"); if (lq > rq) c = c.slice(0, lq);
        c = c.replace(/[,;\s]+$/, "");
      }
      return c;
    }).join(" … ").replace(/\s{2,}/g, " ").trim();
  }
  const api = { parse: parse, display: display, fold: fold, stripBlob: stripBlob, sentences: sentences };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EtymParse = api;
})(typeof window !== "undefined" ? window : this);
