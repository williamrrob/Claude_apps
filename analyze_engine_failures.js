#!/usr/bin/env node
/**
 * Analyze engine failures to find improvement opportunities.
 */
const { MORPHEMES } = require('./data.js');
const engine = require('./engine.js');

console.log('================================================================================');
console.log('ENGINE IMPROVEMENT ANALYSIS');
console.log('================================================================================\n');

console.log('OPPORTUNITY 1: Missing Suffix -um (Latin nominative)');
console.log('-'.repeat(80));
const umWords = ['aluminum', 'museum', 'stadium', 'helium'];
umWords.forEach(word => {
  const result = engine.decompose(word);
  const pad = word.padEnd(15);
  console.log('  ' + pad + ' = ' + result.parts.map(p => p.id || p.surface).join(' + '));
});

console.log('\nOPPORTUNITY 2: Missing/Weak Suffix Recognition');
console.log('-'.repeat(80));
console.log('Current SUFFIX entries in data.js:');
const sufCount = MORPHEMES.suffixes.length;
console.log('  Total: ' + sufCount);
const sufExamples = MORPHEMES.suffixes.slice(0, 10);
sufExamples.forEach(s => {
  console.log('    ' + s.id.padEnd(12) + ' (forms: ' + s.forms.join(', ') + ')');
});
console.log('  ...');

console.log('\nOPPORTUNITY 3: Root Detection Issues');
console.log('-'.repeat(80));
const rootWords = ['algorithm', 'ambiguous', 'ambiance'];
rootWords.forEach(word => {
  const result = engine.decompose(word);
  const roots = MORPHEMES.roots.filter(r => word.includes(r.forms[0]));
  console.log('  ' + word);
  console.log('    Engine result: ' + result.parts.map(p => p.id || p.surface).join(' + '));
  if (roots.length) {
    console.log('    Potential roots in word: ' + roots.map(r => r.id).join(', '));
  } else {
    console.log('    No known roots detected');
  }
});

console.log('\nOPPORTUNITY 4: Prefix-Root-Suffix Sequencing');
console.log('-'.repeat(80));
const seqWords = ['alignment', 'admittible', 'accidence'];
seqWords.forEach(word => {
  const result = engine.decompose(word);
  console.log('  ' + word);
  const parts = result.parts.map(p => {
    return p.kind + '(' + (p.id || '?') + ') = ' + p.surface;
  }).join(' + ');
  console.log('    Breakdown: ' + parts);
  console.log('    Confidence: ' + (result.confidence * 100).toFixed(0) + '%');
});

console.log('\n' + '='.repeat(80));
console.log('RECOMMENDED IMPROVEMENTS:');
console.log('='.repeat(80));
console.log(`
1. ADD -UM SUFFIX: Latin nominative singular ending
   - aluminum, museum, stadium, helium all end in -um
   - High value target: common in classical compounds

2. IMPROVE SUFFIX COVERAGE: Check for missing common endings
   - -ation vs -ion handling
   - -ence vs -ance handling
   - -or vs -er vs -ar agent nouns

3. FIX PREFIX-ROOT SEQUENCING: Better scoring for valid chains
   - ad + ? + gen should detect when middle char can't be matched
   - Give preference to segmentations where EVERY character is accounted for
   - Penalize [?X] unknown parts more heavily

4. ADD MISSING ROOTS: Scan failures for roots not in database
   - algorithm: "log" root IS in database but "algo" prefix isn't
   - "algo" = Greek "algo-" (other/pain) - might add but low priority
`);
