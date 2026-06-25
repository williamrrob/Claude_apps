#!/usr/bin/env node
/**
 * Recursive Engine Improvement Test: baseline + identify next targets
 * Run this after each improvement to measure impact and find next opportunities
 */
const fs = require('fs');
const { MORPHEMES } = require('./data.js');
const engine = require('./engine.js');

// Load sample of 600 random words
let allWords = [];
try {
  const consolidated = JSON.parse(fs.readFileSync('consolidated_dictionary.json', 'utf8'));
  allWords = Object.keys(consolidated);
} catch (e) {
  console.error('Could not load consolidated_dictionary.json');
  process.exit(1);
}

// Seed random for reproducibility
function seededRandom(seed) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

// Sample 600 words using seeded random
const sample = [];
const seen = new Set();
let seed = 42;
while (sample.length < Math.min(600, allWords.length)) {
  const idx = Math.floor(seededRandom(seed) * allWords.length);
  seed++;
  const word = allWords[idx];
  if (!seen.has(word)) {
    sample.push(word);
    seen.add(word);
  }
}

console.log('================================================================================');
console.log('RECURSIVE ENGINE IMPROVEMENT TEST');
console.log('Testing ' + sample.length + ' random words from consolidated dictionary');
console.log('================================================================================\n');

// Test each word
let stats = {
  total: sample.length,
  good: 0,      // 80%+ confidence with root
  partial: 0,   // 50-80% confidence
  poor: 0,      // <50% confidence
  noRoot: 0,    // No classical roots found
  unknownParts: 0  // Contains [?X] unknown parts
};

const categorized = {
  good: [],
  partial: [],
  poor: [],
  noRoot: [],
  unknownWords: []
};

for (const word of sample) {
  const result = engine.decompose(word);
  if (!result) continue;

  const { parts, hasRoot, confidence } = result;
  const hasUnknown = parts.some(p => p.kind === 'unknown');

  if (!hasRoot) {
    stats.noRoot++;
    if (hasUnknown) {
      categorized.unknownWords.push({ word, confidence });
      stats.unknownParts++;
    }
  } else if (confidence >= 0.8) {
    stats.good++;
    categorized.good.push({ word, confidence });
  } else if (confidence >= 0.5) {
    stats.partial++;
    categorized.partial.push({ word, confidence });
    if (hasUnknown) stats.unknownParts++;
  } else {
    stats.poor++;
    categorized.poor.push({ word, confidence });
    if (hasUnknown) stats.unknownParts++;
  }
}

// Print results
console.log('CURRENT PERFORMANCE:');
console.log('-'.repeat(80));
const withRoot = stats.good + stats.partial + stats.poor;
const rootPct = (100 * withRoot / stats.total).toFixed(1);
const goodPct = stats.good > 0 ? (100 * stats.good / withRoot).toFixed(0) : 0;
console.log('Total words tested: ' + stats.total);
console.log('Words with roots found: ' + withRoot + ' (' + rootPct + '%)');
console.log('  - GOOD (80%+): ' + stats.good + ' (' + goodPct + '%)');
console.log('  - PARTIAL (50-80%): ' + stats.partial);
console.log('  - POOR (<50%): ' + stats.poor);
console.log('Words with NO classical roots: ' + stats.noRoot);
console.log('Words with unknown letter parts [?X]: ' + stats.unknownParts);

console.log('\n' + '='.repeat(80));
console.log('NEXT IMPROVEMENT TARGETS (by impact):');
console.log('='.repeat(80));

// Find common issues in partial/poor words
const problemWords = categorized.partial.concat(categorized.poor).slice(0, 20);
if (problemWords.length > 0) {
  console.log('\nSample words needing improvement:');
  problemWords.forEach(item => {
    const result = engine.decompose(item.word);
    const breakdown = result.parts.map(p => {
      if (p.kind === 'unknown') return '[?' + p.surface + ']';
      return p.id || p.surface;
    }).join(' + ');
    console.log('  ' + item.word.padEnd(20) + ' = ' + breakdown + ' (' + (item.confidence * 100).toFixed(0) + '%)');
  });
}

// Scan for missing morphemes
console.log('\nMissing morpheme opportunities:');
const totalPrefixes = MORPHEMES.prefixes.length;
const totalRoots = MORPHEMES.roots.length;
const totalSuffixes = MORPHEMES.suffixes.length;
console.log('  Current inventory: ' + totalPrefixes + ' prefixes, ' + totalRoots + ' roots, ' + totalSuffixes + ' suffixes');

// High-impact opportunities
const opportunities = [
  '- Add more Latin nominatives (-um is done)',
  '- Improve vowel-elision handling (e.g., alumin+um → aluminum)',
  '- Add missing root variants (logo, phob, graph, etc.)',
  '- Better prefix priority: prefer longer, disambiguate (ad-, a-priv-, etc.)',
  '- Germanic root coverage (understand, break, etc.) ← CURATED DATA HANDLES'
];
console.log('\nRecommended improvements (in order):');
opportunities.forEach(opp => console.log('  ' + opp));

console.log('\n' + '='.repeat(80));
console.log('HOW TO USE:');
console.log('='.repeat(80));
console.log(`
1. Make a targeted improvement to data.js or engine.js
2. Re-run this test: node recursive_engine_test.js
3. Compare new stats to baseline
4. Pick next highest-impact improvement
5. Repeat until satisfied with coverage

The system combines:
  - CURATED layer (741 words from family research) ← Use this for high-value words
  - ENGINE layer (this test) ← Improves for all other words
  - Both together provide complete coverage
`);
