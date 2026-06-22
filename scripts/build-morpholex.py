#!/usr/bin/env python3
"""Merge MorphoLex-en morphological parses into the per-word shards (words/*.json).

MorphoLex (https://github.com/hugomailhot/MorphoLex-en, CC-licensed, ~68k words)
gives a curated prefix/root/suffix parse for each word. It is strong exactly where
Rootwork's heuristic engine is weak — opaque or Germanic stems (mist, moral) the
engine would otherwise carve into spurious classical pieces (demos+ist+er). The
parse is canonical (lemma morphemes), so we align it back onto the surface string
with a small set of linguistically-grounded boundary rules (silent-e elision,
consonant doubling, y->i, latinate -er->-r) and only keep alignments that tile the
word exactly. Single-morpheme lemmas are recorded as "show whole" so the engine
stops splitting unanalyzable words (demo). Allomorph cases the engine handles well
(scribe/script) simply don't tile and are left to the engine.

The aligned parse lands in each word record's `b` field — the same authoritative
breakdown slot the app already prefers over the engine (see chooseBreakdown).

Run:  python3 scripts/build-morpholex.py
(downloads MorphoLEX_en.xlsx next to this script if not already present)
"""
import json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORDS = os.path.join(ROOT, "words")
XLSX = os.path.join(HERE, "MorphoLEX_en.xlsx")
URL = "https://raw.githubusercontent.com/hugomailhot/MorphoLex-en/master/MorphoLEX_en.xlsx"

VOW = set("aeiou")
INFL = {"s","es","ed","d","ing","er","est","en","ly","ies","ied","ings","ment","ation","ic","al"}


def parse_seg(seg):
    parts = []
    for m in re.finditer(r"\(([a-zA-Z]+)\)|<([a-zA-Z]+)<|>([a-zA-Z]+)>", seg or ""):
        if m.group(1): parts.append(("root", m.group(1).lower()))
        elif m.group(2): parts.append(("prefix", m.group(2).lower()))
        elif m.group(3): parts.append(("suffix", m.group(3).lower()))
    return parts


def variants(m):
    vs = [m]
    if m.endswith("e"): vs.append(m[:-1])                              # silent-e elision
    if len(m) >= 2 and m[-1] not in VOW and m[-2] in VOW: vs.append(m + m[-1])  # doubling
    if m.endswith("y"): vs.append(m[:-1] + "i")                        # y -> i
    if m.endswith("er"): vs.append(m[:-2] + "r")                       # latinate -er -> -r
    return sorted({v for v in vs if v}, key=len, reverse=True)


def align(word, parts):
    chunks = []
    def rec(pos, i):
        if i == len(parts):
            return pos == len(word) or word[pos:] in INFL
        for v in variants(parts[i][1]):
            if word.startswith(v, pos):
                chunks.append([parts[i][0], word[pos:pos + len(v)]])
                if rec(pos + len(v), i + 1): return True
                chunks.pop()
        return False
    if not rec(0, 0):
        return None
    used = sum(len(c[1]) for c in chunks)
    if used < len(word):
        chunks[-1][1] += word[used:]   # absorb a trailing inflection onto the last chunk
    return chunks


def build():
    import openpyxl
    wb = openpyxl.load_workbook(XLSX, read_only=True)
    vocab = set()
    for f in os.listdir(WORDS):
        if f.endswith(".json"):
            vocab.update(json.load(open(os.path.join(WORDS, f))).keys())

    out = {}
    seen = set()
    multi = whole = 0
    for sn in wb.sheetnames:
        if not re.match(r"\d+-\d+-\d+$", sn):
            continue
        ws = wb[sn]
        hdr = None; wi = si = None
        for row in ws.iter_rows(values_only=True):
            if hdr is None:
                hdr = list(row)
                try: wi = hdr.index("Word"); si = hdr.index("MorphoLexSegm")
                except ValueError: wi = None
                continue
            if wi is None:
                continue
            w = row[wi]
            if not isinstance(w, str):
                continue
            w = w.strip().lower()
            if not re.match(r"^[a-z]+$", w) or w not in vocab or w in seen:
                continue
            parts = parse_seg(row[si])
            if not parts:
                continue
            seen.add(w)
            if len(parts) == 1:
                if parts[0][1] == w:                                  # true single-morpheme lemma
                    out[w] = [{"s": w, "k": "word"}]; whole += 1
                continue                                              # inflected single root -> engine
            a = align(w, parts)
            if not a or any(len(c[1]) == 0 for c in a):
                continue
            out[w] = [{"s": c[1], "k": c[0]} for c in a]; multi += 1
    return out, multi, whole


def merge(out):
    changed = added = 0
    by_shard = {}
    for w, b in out.items():
        by_shard.setdefault(w[:2], {})[w] = b
    for key, words in by_shard.items():
        path = os.path.join(WORDS, key + ".json")
        shard = json.load(open(path)) if os.path.exists(path) else {}
        for w, b in words.items():
            rec = shard.get(w)
            if rec is None:
                shard[w] = {"b": b}; added += 1; changed += 1
                continue
            ex = rec.get("b")
            whole_new = len(b) == 1
            ex_multi = ex and len(ex) >= 2
            # multi-part MorphoLex overrides; a "whole" marker only fills an empty
            # or already-whole slot (never clobbers a real multi-part split).
            if whole_new and ex_multi:
                continue
            if ex == b:
                continue
            rec["b"] = b; changed += 1
        json.dump(shard, open(path, "w"), separators=(",", ":"))
    return changed, added


def main():
    if not os.path.exists(XLSX):
        sys.stderr.write("downloading MorphoLEX_en.xlsx ...\n")
        urllib.request.urlretrieve(URL, XLSX)
    out, multi, whole = build()
    changed, added = merge(out)
    print(f"morpholex entries: {len(out)} (multi-part {multi}, whole {whole})")
    print(f"shard records updated: {changed} (new words added: {added})")


if __name__ == "__main__":
    main()
