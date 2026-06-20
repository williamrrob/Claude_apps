// Converts CMU ARPAbet pronunciations into (1) IPA and (2) a Merriam-Webster
// style plain respelling with the stressed syllable in CAPS.
"use strict";

const VOWELS = new Set(["AA","AE","AH","AO","AW","AY","EH","ER","EY","IH","IY","OW","OY","UH","UW"]);

const IPA = {
  AA:"ɑ",AE:"æ",AH:"ʌ",AO:"ɔ",AW:"aʊ",AY:"aɪ",EH:"ɛ",ER:"ɝ",EY:"eɪ",
  IH:"ɪ",IY:"i",OW:"oʊ",OY:"ɔɪ",UH:"ʊ",UW:"u",
  B:"b",CH:"tʃ",D:"d",DH:"ð",F:"f",G:"g",HH:"h",JH:"dʒ",K:"k",L:"l",M:"m",
  N:"n",NG:"ŋ",P:"p",R:"r",S:"s",SH:"ʃ",T:"t",TH:"θ",V:"v",W:"w",Y:"j",Z:"z",ZH:"ʒ",
};
const RES = {
  AA:"ah",AE:"a",AH:"uh",AO:"aw",AW:"ow",AY:"y",EH:"eh",ER:"ur",EY:"ay",
  IH:"i",IY:"ee",OW:"oh",OY:"oy",UH:"uu",UW:"oo",
  B:"b",CH:"ch",D:"d",DH:"th",F:"f",G:"g",HH:"h",JH:"j",K:"k",L:"l",M:"m",
  N:"n",NG:"ng",P:"p",R:"r",S:"s",SH:"sh",T:"t",TH:"th",V:"v",W:"w",Y:"y",Z:"z",ZH:"zh",
};

const ONSET2 = new Set("PR PL BR BL TR DR KR KL GR GL FR FL TH R SHR SP ST SK SL SM SN SW SF TW KW DW GW HW PY BY KY FY GY MY VY HY".split(" "));
const ONSET3 = new Set(["STR","SPR","SKR","SPL","SKW","SKL"]);

function legalOnset(cons) {
  if (cons.length === 0) return true;
  if (cons.length === 1) return cons[0] !== "NG";
  if (cons.length === 2) return ONSET2.has(cons.join(""));
  if (cons.length === 3) return ONSET3.has(cons.join(""));
  return false;
}

// Split phonemes into syllables using the maximal-onset principle.
function syllabify(tokens) {
  const vi = [];
  tokens.forEach((t, i) => { if (t.vowel) vi.push(i); });
  if (vi.length === 0) return [tokens];

  const syls = [];
  let start = 0;
  for (let s = 0; s < vi.length; s++) {
    const v = vi[s];
    const nextV = vi[s + 1];
    if (nextV === undefined) { syls.push(tokens.slice(start)); break; }
    const between = tokens.slice(v + 1, nextV); // consonants before next vowel
    // Give the largest legal suffix of `between` to the next onset.
    let onset = between.length;
    for (let k = between.length; k >= 0; k--) {
      if (legalOnset(between.slice(between.length - k).map((t) => t.arp))) { onset = k; break; }
    }
    const split = nextV - onset;
    syls.push(tokens.slice(start, split));
    start = split;
  }
  return syls;
}

function convert(arpabet) {
  const tokens = arpabet.trim().split(/\s+/).map((p) => {
    const m = p.match(/^([A-Z]+)([0-2])?$/);
    if (!m) return null;
    const arp = m[1];
    const stress = m[2] !== undefined ? Number(m[2]) : null;
    const vowel = VOWELS.has(arp);
    let ipa = IPA[arp] || "";
    if (arp === "AH" && stress === 0) ipa = "ə";
    if (arp === "ER" && stress === 0) ipa = "ɚ";
    return { arp, stress, vowel, ipa, res: RES[arp] || "" };
  }).filter(Boolean);
  if (!tokens.length) return null;

  const syls = syllabify(tokens);
  const multi = syls.length > 1;

  const ipa = syls.map((syl) => {
    const st = syl.find((t) => t.vowel && t.stress);
    let mark = "";
    if (multi && st) mark = st.stress === 1 ? "ˈ" : st.stress === 2 ? "ˌ" : "";
    return mark + syl.map((t) => t.ipa).join("");
  }).join("");

  const resp = syls.map((syl) => {
    const text = syl.map((t) => t.res).join("");
    const primary = syl.some((t) => t.vowel && t.stress === 1);
    return multi && primary ? text.toUpperCase() : text;
  }).join("-");

  return { ipa: "/" + ipa + "/", resp: resp };
}

module.exports = { convert };
