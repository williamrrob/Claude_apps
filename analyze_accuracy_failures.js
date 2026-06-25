#!/usr/bin/env node
/**
 * Detailed analysis of engine accuracy failures.
 * Categorize by type and identify highest-impact fixes.
 */
const engine = require('./engine.js');

const testCases = [
  // Failures from accuracy test
  { word: 'education', expected: ['e', 'duc', 'ation'], actual: ['e', 'duc', 'ion'], issue: 'Suffix matching: -ion matched instead of -ation' },
  { word: 'dictionary', expected: ['dic', 'tion', 'ary'], actual: ['dic', 'ion', 'ary'], issue: 'Suffix matching: -ion instead of -tion' },
  { word: 'scriptum', expected: ['script', 'um'], actual: ['scrib', 'um'], issue: 'Root form: scrib vs script' },
  { word: 'capacity', expected: ['cap', 'acity'], actual: ['cap', 'ity'], issue: 'Suffix matching: -ity instead of -acity' },
  { word: 'telephone', expected: ['tele', 'phon'], actual: ['tele2', 'phon', 'e'], issue: 'Wrong root ID (tele2) and silent e handling' },
  { word: 'psychology', expected: ['psych', 'log', 'y'], actual: ['psych', 'log'], issue: 'Missing -y suffix' },

  // Additional test cases to find patterns
  { word: 'audition', expected: ['aud', 'ition'], actual: null, issue: 'Test' },
  { word: 'repetition', expected: ['re', 'pet', 'ition'], actual: null, issue: 'Test' },
  { word: 'deception', expected: ['de', 'cep', 'tion'], actual: null, issue: 'Test' },
  { word: 'acceptation', expected: ['ac', 'cep', 'tation'], actual: null, issue: 'Test' },
  { word: 'duration', expected: ['dur', 'ation'], actual: null, issue: 'Test' },
  { word: 'nativity', expected: ['nat', 'ivity'], actual: null, issue: 'Test' },
  { word: 'morality', expected: ['mor', 'ality'], actual: null, issue: 'Test' },
  { word: 'capability', expected: ['cap', 'ability'], actual: null, issue: 'Test' },
];

console.log('================================================================================');
console.log('FAILURE ANALYSIS: Engine Accuracy Issues');
console.log('================================================================================\n');

// Test each word
const failures = [];
const successes = [];

testCases.forEach(tc => {
  const result = engine.decompose(tc.word);
  if (!result) {
    console.log(`✗ ${tc.word.padEnd(20)} PARSE FAILED`);
    failures.push({ word: tc.word, issue: 'Parse failed', type: 'parse_error' });
    return;
  }

  const engineIds = result.parts
    .filter(p => p.kind !== 'unknown')
    .map(p => p.id || p.surface);

  const matches = engineIds.join(' + ') === tc.expected.join(' + ');

  console.log(`${matches ? '✓' : '✗'} ${tc.word.padEnd(20)} = ${engineIds.join(' + ').padEnd(30)} ${matches ? 'OK' : '✗ ' + tc.issue}`);

  if (!matches) {
    failures.push({
      word: tc.word,
      expected: tc.expected.join(' + '),
      actual: engineIds.join(' + '),
      issue: tc.issue,
      type: categorizeFailure(tc.issue)
    });
  } else {
    successes.push(tc.word);
  }
});

function categorizeFailure(issue) {
  if (issue.includes('Suffix')) return 'suffix_matching';
  if (issue.includes('Root form')) return 'root_form';
  if (issue.includes('Root ID')) return 'root_id';
  if (issue.includes('Missing')) return 'missing_morpheme';
  if (issue.includes('Parse')) return 'parse_error';
  return 'other';
}

console.log('\n' + '='.repeat(80));
console.log('FAILURE CATEGORIZATION:');
console.log('='.repeat(80));

const byType = {};
failures.forEach(f => {
  if (!byType[f.type]) byType[f.type] = [];
  byType[f.type].push(f);
});

Object.entries(byType).sort((a, b) => b[1].length - a[1].length).forEach(([type, items]) => {
  console.log(`\n${type.toUpperCase()} (${items.length} failures):`);
  items.forEach(item => {
    console.log(`  ${item.word.padEnd(20)} → expected: ${item.expected}, got: ${item.actual}`);
  });
});

console.log('\n' + '='.repeat(80));
console.log('RECOMMENDED FIXES (by impact):');
console.log('='.repeat(80));

const recommendations = [
  {
    type: 'suffix_matching',
    priority: 'HIGH',
    issue: '-ion vs -ation, -ity vs -acity confusion',
    fix: 'Add longer suffix forms with higher priority: -ation, -ition, -ation before -ion; -acity, -acity before -ity',
    impact: 'Fixes: education, dictionary, capacity, and many more'
  },
  {
    type: 'root_form',
    priority: 'HIGH',
    issue: 'Multiple root allomorphs not in database (scrib vs script)',
    fix: 'Expand root forms for common Latin roots: {id: "scrib", forms: ["script", "scrib"]}, etc.',
    impact: 'Fixes: scriptum and similar words with variant spellings'
  },
  {
    type: 'root_id',
    priority: 'MEDIUM',
    issue: 'Wrong root ID used (tele2 instead of tele)',
    fix: 'Clean up duplicate root IDs, consolidate variants under single IDs',
    impact: 'Fixes: telephone and other tele- words'
  },
  {
    type: 'missing_morpheme',
    priority: 'MEDIUM',
    issue: 'Silent e and -y suffix handling',
    fix: 'Improve suffix matching for -y, better handling of silent e',
    impact: 'Fixes: psychology, telephone, and others'
  }
];

recommendations.forEach(rec => {
  console.log(`\n${rec.priority}: ${rec.type}`);
  console.log(`  Issue: ${rec.issue}`);
  console.log(`  Fix: ${rec.fix}`);
  console.log(`  Impact: ${rec.impact}`);
});

console.log('\n' + '='.repeat(80));
console.log(`SUMMARY: ${successes.length}/${testCases.length} correct (${(100*successes.length/testCases.length).toFixed(0)}%)`);
console.log('='.repeat(80));
