#!/usr/bin/env node
/**
 * Research M-W etymologies and identify systematic gaps in our engine.
 * This reveals the "real and deep problem": our engine produces
 * etymologically inaccurate morpheme breakdowns.
 */

const engine = require('./engine.js');
const fs = require('fs');

// Words to research - high frequency + known issues
const researchBatch = [
  { word: 'dictionary', category: 'noun', expectedMW: 'dictiō + -ary' },
  { word: 'capacity', category: 'noun', expectedMW: 'capax + -ity/-itas' },
  { word: 'education', category: 'noun', expectedMW: 'e + ducere + -ation' },
  { word: 'nation', category: 'noun', expectedMW: 'natus/nasci + -ion/-atio' },
  { word: 'station', category: 'noun', expectedMW: 'stare + -ion/-atio' },
  { word: 'action', category: 'noun', expectedMW: 'agere + -ion/-actio' },
  { word: 'function', category: 'noun', expectedMW: 'fungi + -ion/-atio' },
  { word: 'production', category: 'noun', expectedMW: 'pro + ducere + -ion' },
  { word: 'ability', category: 'noun', expectedMW: 'habilis/habere + -ity' },
  { word: 'quality', category: 'noun', expectedMW: 'qualis + -ity' },
  { word: 'possibility', category: 'noun', expectedMW: 'possibilis + -ity' },
  { word: 'reality', category: 'noun', expectedMW: 'realis + -ity' },
  { word: 'important', category: 'adj', expectedMW: 'importare + -ant' },
  { word: 'different', category: 'adj', expectedMW: 'differre + -ent' },
  { word: 'complete', category: 'adj', expectedMW: 'com + plere + -e' },
  { word: 'separate', category: 'adj', expectedMW: 'separare' },
  { word: 'produce', category: 'verb', expectedMW: 'pro + ducere' },
  { word: 'reduce', category: 'verb', expectedMW: 're + ducere' },
  { word: 'increase', category: 'verb', expectedMW: 'in + crescere' },
  { word: 'decrease', category: 'verb', expectedMW: 'de + crescere' },
];

console.log(`
================================================================================
SYSTEMATIC M-W ETYMOLOGY RESEARCH
================================================================================

Analyzing ${researchBatch.length} words to identify engine gaps.
These are high-frequency words where etymology matters for accuracy.

For each word:
- ENGINE: What our morpheme decomposition says (likely wrong)
- M-W: Authoritative etymology from Merriam-Webster
- GAP: The systematic problem revealed
- CURATED: Corrected morpheme breakdown for curated data

================================================================================
\n`);

const results = [];

researchBatch.forEach(test => {
  const engineResult = engine.decompose(test.word);
  const engineBreakdown = engineResult.parts
    .filter(p => p.kind !== 'unknown')
    .map(p => p.surface)
    .join(' + ');

  results.push({
    word: test.word,
    category: test.category,
    engine: engineBreakdown,
    mwExpected: test.expectedMW,
    engineHasRoot: engineResult.hasRoot,
    engineConfidence: (engineResult.confidence * 100).toFixed(0),
  });

  console.log(`${test.word.padEnd(20)} (${test.category})`);
  console.log(`  ENGINE:  ${engineBreakdown}`);
  console.log(`  M-W:     ${test.expectedMW}`);
  console.log(`  MATCH:   ${engineBreakdown === test.expectedMW.replace(/ \+ /g, ' + ') ? '✓' : '✗'}`);
  console.log('');
});

// Summarize patterns
console.log(`
================================================================================
PATTERN ANALYSIS
================================================================================

Common issues:\n`);

// Group by suffix patterns
const bySuffix = {};
results.forEach(r => {
  const lastPart = r.engine.split(' + ').pop();
  if (!bySuffix[lastPart]) bySuffix[lastPart] = [];
  bySuffix[lastPart].push(r);
});

Object.entries(bySuffix).sort((a, b) => b[1].length - a[1].length).forEach(([suffix, words]) => {
  console.log(`\n  Suffix "${suffix}" (${words.length} words):`);
  words.slice(0, 3).forEach(w => {
    console.log(`    - ${w.word}: Engine="${w.engine}" vs M-W="${w.mwExpected}"`);
  });
});

// Save summary
const summaryPath = './mw_research_summary.json';
fs.writeFileSync(summaryPath, JSON.stringify({
  batchSize: researchBatch.length,
  timestamp: new Date().toISOString(),
  words: results,
  summary: {
    totalWords: results.length,
    wordsWithRoots: results.filter(r => r.engineHasRoot).length,
    wordsMatching: results.filter(r => r.engine === r.mwExpected.replace(/ \+ /g, ' + ')).length,
  }
}, null, 2));

console.log(`\n
================================================================================
RESEARCH SUMMARY
================================================================================

Total words researched: ${results.length}
Engine found roots: ${results.filter(r => r.engineHasRoot).length}
Correct matches with M-W: ${results.filter(r => r.engine === r.mwExpected.replace(/ \+ /g, ' + ')).length}

Summary saved to: ${summaryPath}

NEXT STEP:
----------
Manually review M-W pages to get exact etymologies, then:
1. Create corrected morpheme breakdowns based on M-W
2. Add to curated_morphemes.json
3. Update data.js with any missing morphemes
4. Retest to measure improvement
`);
