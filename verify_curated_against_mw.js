#!/usr/bin/env node
/**
 * CRITICAL: Verify ALL curated words against M-W etymologies.
 * M-W is THE definitive source. Family data is not verified until checked against M-W.
 *
 * This script identifies which family-based breakdowns need M-W verification.
 */
const fs = require('fs');

const curatedPath = './curated_morphemes.json';
const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

const totalWords = Object.keys(curated).length;

console.log('================================================================================');
console.log('CRITICAL VERIFICATION: CURATED WORDS vs M-W ETYMOLOGIES');
console.log('================================================================================');
console.log('');
console.log('PRINCIPLE: M-W is the ONLY definitive source.');
console.log('Family data = starting point, NOT verification.');
console.log('');
console.log('Total words to verify: ' + totalWords);
console.log('');
console.log('Words must be checked against M-W to:');
console.log('1. Confirm morpheme breakdown is correct');
console.log('2. Verify surface forms match M-W presentation');
console.log('3. Identify systematic errors in family structure');
console.log('4. Correct any mismatches before app displays them');
console.log('');
console.log('STATUS TRACKING:');
console.log('- mwVerified: true = checked against M-W and confirmed correct');
console.log('- mwVerified: false = needs M-W verification');
console.log('- mwFlagged: reason for discrepancy if found');
console.log('');
console.log('================================================================================');
console.log('SAMPLE WORDS FOR IMMEDIATE VERIFICATION:');
console.log('================================================================================');
console.log('');
console.log('High-impact categories to research:');
console.log('1. -tion/-sion words (action, nation, station, production, etc.)');
console.log('   - Verify suffix is -tion or -ation (not -ion)');
console.log('   - Verify root form from M-W');
console.log('');
console.log('2. -ity/-acity/-osity words (capacity, quality, ability, possibility)');
console.log('   - Verify if it\'s -ity or compound like -acity');
console.log('   - Check root form');
console.log('');
console.log('3. Derived/inflected forms (brought, broken, brought, binding)');
console.log('   - Verify these are correctly parsed');
console.log('   - Check against base word\'s M-W etymology');
console.log('');
console.log('4. Complex compounds (breakthrough, unbreakable, biodiversity)');
console.log('   - Parse correctly with all components');
console.log('   - Verify each part against M-W');
console.log('');

// Identify categories for batching
const byCategories = {
  'tion/sion': [],
  'ity/acity': [],
  'inflected': [],
  'compound': [],
  'other': []
};

Object.entries(curated).forEach(([word, entry]) => {
  // Categorize by suffix
  if (word.endsWith('tion') || word.endsWith('sion') || word.endsWith('ation')) {
    byCategories['tion/sion'].push(word);
  } else if (word.endsWith('ity') || word.endsWith('acity') || word.endsWith('osity')) {
    byCategories['ity/acity'].push(word);
  } else if (word.match(/^(un|re|pre|dis|in)/) || word.match(/ing$|ed$|er$|s$/)) {
    byCategories['inflected'].push(word);
  } else if (word.includes('-') || word.length > 15) {
    byCategories['compound'].push(word);
  } else {
    byCategories['other'].push(word);
  }
});

console.log('WORDS BY CATEGORY:\n');
Object.entries(byCategories).forEach(([cat, words]) => {
  console.log(`${cat.padEnd(20)} ${words.length} words`);
  if (words.length > 0) {
    words.sort().slice(0, 5).forEach(w => console.log(`  - ${w}`));
  }
});

console.log(`
\nACTION PLAN:
============

1. START with 50-word sample from high-frequency families
2. Research each word on M-W
3. Compare M-W etymology with family-based breakdown
4. Document all discrepancies
5. Update curated data with corrections + mwVerified flags
6. Build verification report

Sample words to research first (10 most common):
`);

const sortedByLength = Object.entries(byCategories)
  .flatMap(([cat, words]) => words)
  .sort((a, b) => a.length - b.length)
  .slice(0, 10);

sortedByLength.forEach(w => console.log(`  - ${w}`));

console.log(`\nTo proceed: Create research.mw_batch_1.json with M-W findings
`);
