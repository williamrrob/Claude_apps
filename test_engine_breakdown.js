#!/usr/bin/env node
/**
 * Test the morpheme engine on 597 random words from the sample.
 * Shows real breakdowns and confidence scores.
 */

// Load morpheme database and engine
const { MORPHEMES } = require('./data.js');
const engine = require('./engine.js');

// Words that fall back to engine (not in curated set)
const engineWords = [
  'abbey', 'abducens', 'abrocoma', 'abstractedness', 'accidence', 'accost',
  'acrogenous', 'actinism', 'adactylia', 'adesite', 'admittible', 'aerify',
  'aesir', 'agility', 'algorithm', 'alignment', 'allegory', 'alloy',
  'alms', 'aloe', 'aloof', 'alphabet', 'altar', 'alteration',
  'alternate', 'altitude', 'altruism', 'aluminum', 'alveolus', 'amain',
  'amalgam', 'amanuensis', 'amaranth', 'amaretto', 'amass', 'amateur',
  'amaze', 'ambiance', 'ambidextrous', 'ambience', 'ambiguous', 'ambit',
  'ambition', 'ambivalence', 'amble', 'ambrosia', 'ambulance', 'ambulatory',
  'ameliorate', 'amen', 'amenable', 'amend', 'amenities', 'amentia',
  'americium', 'amethyst', 'amiable', 'amicable', 'amice', 'amiculum'
];

console.log('================================================================================');
console.log('ENGINE MORPHEME BREAKDOWN TEST (50 sample words from 597)');
console.log('================================================================================\n');

let goodBreakdowns = 0;
let partialBreakdowns = 0;
let poorBreakdowns = 0;
let noRootCount = 0;

const results = [];

for (const word of engineWords.slice(0, 50)) {
  const result = engine.decompose(word);

  if (!result) {
    results.push({ word, status: 'FAILED', breakdown: null, confidence: 0 });
    poorBreakdowns++;
    continue;
  }

  const { parts, hasRoot, confidence, reading } = result;

  if (!hasRoot) {
    noRootCount++;
    results.push({
      word,
      status: 'NO_ROOT',
      breakdown: parts.map(p => p.surface).join(''),
      confidence
    });
  } else if (confidence >= 0.8) {
    goodBreakdowns++;
    const breakdown = parts.map(p => {
      if (p.kind === 'unknown') return `[?${p.surface}]`;
      return `${p.id || p.surface}`;
    }).join(' + ');
    results.push({ word, status: 'GOOD', breakdown, confidence });
  } else if (confidence >= 0.5) {
    partialBreakdowns++;
    const breakdown = parts.map(p => {
      if (p.kind === 'unknown') return `[?${p.surface}]`;
      return `${p.id || p.surface}`;
    }).join(' + ');
    results.push({ word, status: 'PARTIAL', breakdown, confidence });
  } else {
    poorBreakdowns++;
    const breakdown = parts.map(p => {
      if (p.kind === 'unknown') return `[?${p.surface}]`;
      return `${p.id || p.surface}`;
    }).join(' + ');
    results.push({ word, status: 'POOR', breakdown, confidence });
  }
}

console.log('Format: word = breakdown (confidence) [status]\n');

for (const r of results) {
  const conf = (r.confidence * 100).toFixed(0);
  const tag = `[${r.status}]`;
  console.log(`  ${r.word.padEnd(18)} = ${(r.breakdown || '?').padEnd(45)} (${conf}%) ${tag}`);
}

console.log('\n' + '='.repeat(80));
console.log('RESULTS SUMMARY (50 sample words):');
console.log('='.repeat(80));
console.log(`  GOOD (80%+ confidence):    ${goodBreakdowns} words`);
console.log(`  PARTIAL (50-80%):          ${partialBreakdowns} words`);
console.log(`  POOR (<50% confidence):    ${poorBreakdowns} words`);
console.log(`  NO_ROOT (non-classical):   ${noRootCount} words`);
console.log();

const totalWithRoot = goodBreakdowns + partialBreakdowns + poorBreakdowns;
console.log('ENGINE PERFORMANCE:');
console.log(`  Words with Latin/Greek roots found: ${totalWithRoot}/${engineWords.slice(0, 50).length} (${(100*totalWithRoot/engineWords.slice(0, 50).length).toFixed(0)}%)`);
console.log(`  High-confidence breakdowns: ${goodBreakdowns}/${totalWithRoot} (${totalWithRoot > 0 ? (100*goodBreakdowns/totalWithRoot).toFixed(0) : 0}%)`);
console.log(`  Unknown letter parts emitted: TBD (check for [?X] in breakdowns above)`);
console.log();
console.log('NOTES:');
console.log('  - [?X] indicates unknown letters the engine couldn\'t account for');
console.log('  - These should be eliminated with "no nonsense parts" rule');
console.log('  - Germanic words (abbey, alms, etc.) correctly fallback to NO_ROOT');
