#!/usr/bin/env node
/**
 * Fix Germanic compound words to include both prefix and root
 * These words were incorrectly showing only the root, missing the prefix component
 */
const fs = require('fs');

const curatedPath = './curated_morphemes_complete.json';
const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

console.log(`
================================================================================
FIXING GERMANIC COMPOUND WORDS (Missing Prefixes)
================================================================================\n`);

// Define Germanic compound words with missing prefixes
// Format: word -> { prefix, root }
const compoundWords = {
  // under- + stand
  'understand': { prefix: 'under', root: 'stand' },
  'understanding': { prefix: 'under', root: 'stand' },
  'understood': { prefix: 'under', root: 'stand' },

  // with- + stand
  'withstand': { prefix: 'with', root: 'stand' },
  'withstanding': { prefix: 'with', root: 'stand' },
  'withstood': { prefix: 'with', root: 'stand' },

  // out- + stand
  'outstanding': { prefix: 'out', root: 'stand' },
  'outstand': { prefix: 'out', root: 'stand' },

  // over- + stand (if present)
  'overstand': { prefix: 'over', root: 'stand' },

  // break- compounds
  'breakthrough': { prefix: 'break', root: 'through' },
  'breaker': { prefix: 'break', root: null }, // Just root
  'breaking': { prefix: 'break', root: null }, // Just root

  // bring- compounds
  'upbring': { prefix: 'up', root: 'bring' },
  'upbringing': { prefix: 'up', root: 'bring' },

  // build- compounds
  'rebuild': { prefix: 're', root: 'build' },
  'rebuilding': { prefix: 're', root: 'build' },
  'unbuilt': { prefix: 'un', root: 'built' },
};

let updated = 0;
let skipped = 0;
let notFound = 0;

console.log('Processing Germanic compound words:\n');

Object.entries(compoundWords).forEach(([word, { prefix, root }]) => {
  if (!curated[word]) {
    console.log(`✗ NOT FOUND: ${word}`);
    notFound++;
    return;
  }

  const entry = curated[word];

  // Check if already has prefix
  if (entry.parts && entry.parts.some(p => p.kind === 'prefix')) {
    console.log(`✓ ALREADY FIXED: ${word}`);
    skipped++;
    return;
  }

  // Build new parts array
  const newParts = [];

  // Add prefix if provided
  if (prefix) {
    newParts.push({
      kind: 'prefix',
      id: prefix,
      gloss: prefix,
      surface: prefix,
      origin: 'Germanic'
    });
  }

  // Add root if provided (or keep existing)
  if (root) {
    newParts.push({
      kind: 'root',
      id: root,
      gloss: root,
      surface: root,
      origin: 'Germanic'
    });
  } else if (entry.parts && entry.parts.length > 0) {
    // Keep existing root
    newParts.push(...entry.parts);
  }

  entry.parts = newParts;
  updated++;

  console.log(`✓ FIXED: ${word}`);
  console.log(`  → [${newParts.map(p => `${p.kind}:${p.id}`).join(', ')}]`);
});

console.log(`\n================================================================================`);
console.log(`Results: ${updated} updated, ${skipped} already fixed, ${notFound} not found`);
console.log(`================================================================================\n`);

fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2));
console.log('✓ Saved curated_morphemes_complete.json');
