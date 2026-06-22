#!/usr/bin/env python3
"""Fetch Wikipedia's "List of medical roots and affixes" and write the parsed
morpheme dataset to scripts/med-morphemes.json.

Wikipedia's list (CC BY-SA) is a curated table of medical/scientific combining
forms — organ roots (cardi-, nephr-, hepat-), conditions (-itis, -osis), and
procedures (-ectomy, -otomy) — exactly the Greek/Latin vocabulary the base
engine never had and so mis-segmented (esophageal → e·soph·a·ge·al, "wisdom of
the earth"). We render the page via the MediaWiki API (so transliterated source
words are visible), parse each row into {forms, meaning, origin, source}, and
keep only distinctive forms (>=4 letters). These are NOT added to the engine's
general matcher (that would mis-fire on common words); build-medbreakdowns.js
uses them only to rescue words the base engine already fails on.

Run:  python3 scripts/build-medroots.py
"""
import html as htmllib
import json
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "med-morphemes.json")
API = ("https://en.wikipedia.org/w/api.php?action=parse"
       "&page=List_of_medical_roots_and_affixes&prop=text&format=json&formatversion=2")

# Forms too ambiguous in general English — they cleanly tile common non-medical
# words (bili→a·bili·ty, uter→o·uter, hist→hist·ory, proct→proct·or), so we drop
# the form rather than risk an absurd gloss. Medical -o- combining variants of
# the same root (histo-, rhino-, entero-) are kept.
BLOCKLIST = set((
    "bili uter utero hist mast genu proct cili dura enter carp ventr sten trich atel "
    "rhin rhino cord cordi norm prim milli mero liss idio back blood body bone gold home "
    "silver yellow brain front amph andr angi balan lumb ossi piri thel isch labi dors "
    "burs coron arsen capit radic naso reno toco tony tome tide trop drom emia phos kine "
    "sial somn faci galact digit gloss melan mamm muscul nerv pelv rubr thym xero xeno "
    "presby chir chrom cost blast"
).split())


def strip_tags(s):
    return htmllib.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def expand(formtxt):
    """A form cell like "cardi(o)-, -cardia" -> (category, [surface forms])."""
    out, cat = [], None
    for tok in (t.strip() for t in formtxt.split(",") if t.strip()):
        lead, trail = tok.startswith("-"), tok.endswith("-")
        core = tok.strip("-").strip()
        if cat is None:
            cat = "suffix" if (lead and not trail) else "root"
        m = re.match(r"^([a-z]+)\(([a-z]+)\)$", core)
        if m:
            out += [m.group(1), m.group(1) + m.group(2)]
        else:
            core2 = re.sub(r"\([a-z]+\)", "", core)
            if re.match(r"^[a-z]+$", core2):
                out.append(core2)
    return cat, sorted(set(out), key=len, reverse=True)


def main():
    req = urllib.request.Request(API, headers={"User-Agent": "Rootwork/1.0 (etymology app; data build script)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        page = json.load(r)["parse"]["text"]

    morphemes, seen = [], set()
    for th, rest in re.findall(r'<tr>\s*<th scope="row">(.*?)</th>(.*?)</tr>', page, re.S):
        mf = re.search(r'class="nowrap">(.*?)</span>', th)
        tds = re.findall(r"<td>(.*?)</td>", rest, re.S)
        if not mf or len(tds) < 2:
            continue
        cat, forms = expand(strip_tags(mf.group(1)))
        forms = [f for f in forms if len(f) >= 4 and f not in BLOCKLIST]
        if not forms:
            continue
        meaning = re.sub(r"\s+", " ", strip_tags(tds[0]))[:70]
        origin = "Greek" if "Greek" in tds[1] else ("Latin" if "Latin" in tds[1] else None)
        mt = re.search(r'lang="[a-z]+-Latn"[^>]*>\s*<i>(.*?)</i>', tds[1])
        source = strip_tags(mt.group(1)) if mt else forms[0]
        if re.fullmatch(r"[a-z]{2,3}", source):  # leftover lang code, not a word
            source = forms[0]
        if not origin or not meaning:
            continue
        pid = "med-" + forms[0]
        if pid in seen:
            continue
        seen.add(pid)
        morphemes.append({"id": pid, "forms": forms, "cat": cat,
                          "origin": origin, "source": source, "meaning": meaning})

    out = {
        "_source": "Wikipedia: List of medical roots and affixes",
        "_license": "CC BY-SA 4.0",
        "_url": "https://en.wikipedia.org/wiki/List_of_medical_roots_and_affixes",
        "morphemes": morphemes,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=0, ensure_ascii=False)
    roots = sum(1 for m in morphemes if m["cat"] == "root")
    print(f"wrote {OUT}: {len(morphemes)} morphemes ({roots} roots, {len(morphemes) - roots} suffixes)")


if __name__ == "__main__":
    main()
