#!/usr/bin/env node
/**
 * Systematic M-W research plan for verifying curated words.
 * Prioritize by impact: -tion/-ity words first, then base words, then others.
 */
const fs = require('fs');

const curatedPath = './curated_morphemes.json';
const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

console.log(`
================================================================================
M-W VERIFICATION RESEARCH PLAN
================================================================================

Strategy: Verify highest-impact words against M-W in focused batches.

Batch priorities:
1. -tion/-sion words (101) - Common suffix, high error potential
2. -ity/-acity/-osity words (23) - Known discrepancies with engine
3. Base words from largest families (50) - Foundation for family verification
4. Common inflected forms (100) - Verify derive from correct base
5. Remaining words in phases

================================================================================\n`);

// Extract word categories
const byCategory = {
  'tion-sion': [],
  'ity-acity-osity': [],
  'other': []
};

Object.keys(curated).forEach(word => {
  if (word.endsWith('tion') || word.endsWith('sion') || word.endsWith('ation')) {
    byCategory['tion-sion'].push(word);
  } else if (word.endsWith('ity') || word.endsWith('acity') || word.endsWith('osity')) {
    byCategory['ity-acity-osity'].push(word);
  } else {
    byCategory['other'].push(word);
  }
});

// BATCH 1: -tion/-sion words (priority 1)
const batch1 = byCategory['tion-sion'].sort();
console.log(`BATCH 1: -TION/-SION WORDS (${batch1.length} words)\n`);
console.log('Sample (first 20):');
batch1.slice(0, 20).forEach(w => console.log(`  - ${w}`));
console.log(`\nREQUIRED M-W RESEARCH:`);
console.log(`1. For each word, find M-W entry`);
console.log(`2. Extract etymology showing:
   - Full language path (e.g., Latin actiōn- from agere)
   - Surface forms (whether -tion, -ation, -sion, or other)
   - Root form (agere vs ag-)
3. Compare with family-based breakdown
4. Flag any discrepancies

Sample research needed:
- action: M-W says "Latin actiōn-, actiō (from agere)" → verify breakdown
- nation: M-W says "Latin natio (from nasci)" → check if parsed correctly
- station: M-W says "Latin statiō (from stare)" → verify root
- production: M-W says "pro + ductiō (from ducere)" → check prefix + root + suffix

Save as: mw_batch_1_tion_sion.json
\n`);

// BATCH 2: -ity/-acity/-osity words (priority 2)
const batch2 = byCategory['ity-acity-osity'].sort();
console.log(`================================================================================`);
console.log(`BATCH 2: -ITY/-ACITY/-OSITY WORDS (${batch2.length} words)\n`);
batch2.forEach(w => console.log(`  - ${w}`));
console.log(`\nKNOWN ISSUES TO VERIFY:`);
console.log(`- capacity: Engine says "cap + acity" but M-W shows "capax + -itas"`);
console.log(`- quality: Engine says "al + ity" - needs M-W check`);
console.log(`- ability: Engine says "a + bi + ity" - check M-W`);
console.log(`- possibility: Engine says "pos + s + ity" - needs verification`);
console.log(`\nSave as: mw_batch_2_ity.json
\n`);

// BATCH 3: Base/common words from largest families (priority 3)
const familyCounts = {};
Object.entries(curated).forEach(([word, entry]) => {
  const root = entry.root;
  if (!familyCounts[root]) familyCounts[root] = [];
  familyCounts[root].push(word);
});

const batch3 = Object.entries(familyCounts)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 10)
  .flatMap(([root, words]) => {
    // Take 5 most common from each large family
    return words.sort().slice(0, 5);
  });

console.log(`================================================================================`);
console.log(`BATCH 3: BASE WORDS FROM LARGEST FAMILIES (${batch3.length} words)\n`);
console.log('By family (top 10 families, 5 words each):');
let current = null;
batch3.forEach(w => {
  const root = curated[w].root;
  if (current !== root) {
    console.log(`\n${root}:`);
    current = root;
  }
  console.log(`  - ${w}`);
});
console.log(`\nSave as: mw_batch_3_base_words.json
\n`);

console.log(`================================================================================`);
console.log(`RESEARCH PROCEDURE`);
console.log(`================================================================================

For each word:
1. Visit merriam-webster.com/dictionary/[word]
2. Look for "History and Etymology" section
3. Extract full etymology chain
4. Compare with family-based breakdown in curated_morphemes.json
5. Document in JSON:
   {
     "word": "action",
     "mwEtymology": "Latin actiōn-, actiō (from agere to do/act)",
     "mwSurfaceForm": "action",
     "family_breakdown": "ag + tion",
     "correct": true/false,
     "notes": "any discrepancies found"
   }

Next: Run M-W research for Batch 1 first (highest impact).
Then: Compare results and correct curated data.
`);
