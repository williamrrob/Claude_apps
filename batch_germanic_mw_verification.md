# Batch G: M-W Verification of Germanic Words

**Discovery:** Germanic words currently only have "family verified" status, but they should have M-W verification like all other words.

**Total Germanic words in curated data:** ~200-250 words

---

## Germanic Word Families (by count)

```
stand (standan):     47 words
  stand, standing, stood, standee, standpoint, outstanding, 
  withstand, understand, etc.

break (brecan):      28 words
  break, broken, breaking, breaker, breakage, unbreakable,
  breakthrough, etc.

bring (bringan):     25 words
  bring, brought, bringing, upbring, etc.

build (byldan):      16 words
  build, builder, building, built, rebuild, unbuilt, etc.

bind (bindan):       27 words
  bind, binding, bound, bondage, bondsman, rebind, etc.

grow (growan):       21 words
  grow, growing, grown, growth, grower, regrow, etc.

sing (singan):       20 words
  sing, singer, singing, song, songbird, etc.

speak (sprecan):     25 words
  speak, speaker, speaking, speech, speechless, etc.

spin (spinnan):      19 words
  spin, spinner, spinning, spinster, spindle, etc.

drink (drincan):     19 words
  drink, drinker, drinking, drunk, drunken, etc.

[Plus 8 more families with 10-20 words each]
```

---

## Why Germanic Words Need M-W Verification

### Current Status Issue

**Germanic words:**
- source: "family verified"
- mwVerified: false
- etymology: Not checked against M-W

**Why this is wrong:**
- M-W is supposed to be the definitive source for ALL etymologies
- Germanic words in M-W show different information than family structure
- Example: "stand" - does M-W confirm Germanic origin? Full chain?

### M-W Standard

Example M-W entry for "stand":

```
stand (verb)
Etymology: Middle English, from Old English standan; 
akin to Old Saxon standan, Old High German stantan, 
Old Norse standa, and probably to Latin stare to stand
```

The M-W etymology will:
1. Confirm German origin (or not)
2. Show the full etymological chain
3. Provide cognates (related words in other languages)
4. May reveal errors in family structure

---

## Known Germanic Words to Verify

### High Priority (Most Common, Most Used)

```
1. stand - "to be in upright position"
2. standing - "action of stand"
3. break - "to separate into pieces"
4. broken - "separated into pieces"
5. bring - "to cause to come with"
6. brought - "past tense of bring"
7. build - "to construct"
8. built - "past tense of build"
9. speak - "to use voice to express ideas"
10. grow - "to increase in size"
11. growing - "increasing in size"
12. bring - "carry toward"
13. understand - "know the meaning of"
14. withstand - "resist"
15. breakthrough - "sudden discovery"
```

### Medium Priority (Common, Need Review)

```
- bind, binding, bound
- grow, growing, grown
- sing, singer, singing, song
- drink, drinking, drunk
- spin, spinner, spinning
- speak, speaker, speech
```

---

## M-W Verification Template for Germanic

```json
{
  "word": "stand",
  "mwEtymology": "Middle English, from Old English standan; 
                  akin to Old Saxon standan, Old High German stantan, 
                  Old Norse standa, and probably to Latin stare to stand",
  "mwOrigin": "Germanic (West Germanic, Old English)",
  "mwCognates": [
    "Old Saxon: standan",
    "Old High German: stantan",
    "Old Norse: standa",
    "Latin: stare (related, but different root family)"
  ],
  "mwStructure": "Single Germanic root, no Latin components",
  "familyData": {
    "root": "stand",
    "breakdown": "stand (no affixes in base form)",
    "family": "stand (Germanic)",
    "origin": "Germanic standan"
  },
  "verification": "✓ CORRECT - Family structure matches M-W",
  "notes": "Germanic words show as single root. Inflected forms (stood, standing) should show root + inflection, but family data may not have this."
}
```

---

## Key Questions for M-W Verification

For each Germanic word, check M-W and verify:

1. **Origin:** Is origin really Germanic? (Could be borrowed Latin)
2. **Root structure:** Is it a single root or compound?
3. **Inflections:** Are past tenses shown correctly? (stand→stood is irregular)
4. **Cognates:** Are there related words in other Germanic languages?
5. **Compounds:** Are compound words (breakthrough, understand) correctly decomposed?

---

## Expected Issues to Find

### Issue 1: Irregular Forms
```
stand → stood (irregular past tense)
Not: stand → stood (should show stem change)
Family data: shows "stand" as root for both

Need to verify: Does M-W confirm "stood" is from "stand"?
```

### Issue 2: Compound Verbs
```
understand = under + stand (two roots combined)
withstand = with + stand (two roots combined)

Family data: shows as single root "stand"

Need to verify: Should these show prefix + root structure?
```

### Issue 3: Derived Words
```
standing (present participle) = stand + ing
standing (noun) = stand (stem) + ing

Family data: may not distinguish these uses

Need to verify: Are both uses correct?
```

---

## Research Plan

### Phase 1: Sample Verification (5-10 words)

Verify 10 high-priority Germanic words:
- stand, break, speak, bring, build, grow, bind, sing, understand, withstand

**Research method:**
1. Go to merriam-webster.com/dictionary/[word]
2. Read "History and Etymology" section
3. Note: origin, cognates, structure
4. Compare with family data
5. Document any discrepancies

**Estimated time:** 2-3 hours

### Phase 2: Full Coverage (all 200-250 words)

Systematic verification of all Germanic families:
- Use patterns from Phase 1 to extrapolate
- Verify edge cases and irregular forms
- Document all findings

**Estimated time:** 4-6 hours

### Phase 3: Correction

Apply corrections to Germanic words with errors:
- Fix morpheme breakdowns
- Update source to "M-W verified"
- Set mwVerified = true

**Estimated time:** 1-2 hours

---

## Expected Results

### Before Verification
- Germanic words: "family verified" status
- No M-W data
- Potential errors unknown

### After Verification (Target)
- All Germanic words: M-W verified
- Confirmation or correction of family data
- Full etymological information from M-W
- Same data quality as Latin words

---

## Impact on Overall Quality

Current status:
- Latin -tion words: 99/101 ✓
- Latin -ity words: 23/23 ✓
- Priority Latin compounds: 37/37 ✓
- Germanic words: 0/200-250 (no M-W verification yet)

After Batch G:
- All major word categories: M-W verified
- Data quality: 95%+ across entire 1,161 word set
- User confidence: "All etymologies checked against M-W"

---

## Next Steps

1. **Decide scope:** Focus on high-priority words first (10-15) or verify all?
2. **Assign effort:** 2-3 hours for sample, 6-8 hours for complete
3. **Execute Phase 1:** Verify 10 sample Germanic words
4. **Apply pattern:** Extend sample findings to all Germanic words
5. **Commit corrections:** Update curated data with M-W status

---

## Recommendation

**Priority:** HIGH - Germanic words represent ~17% of curated data

**Scope:** Start with Phase 1 (10-word sample) to identify any systematic issues
- If patterns found: Can extrapolate to all Germanic words
- If errors found: Need to understand scope of issue

**Timeline:** After Phase 4 (app integration) is complete, dedicate 6-8 hours to complete Germanic verification.

This will ensure EVERY word in the system (1,161 total) has M-W verification.
