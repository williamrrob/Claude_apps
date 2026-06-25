#!/usr/bin/env node
/**
 * Update Germanic compound words in word shards with corrected morpheme data
 * After fixing the curated data, update the corresponding word shards
 */
const fs = require('fs');
const path = require('path');

const curatedPath = './curated_morphemes_complete.json';
const wordsDir = './words';

const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

console.log(`
================================================================================
UPDATING GERMANIC COMPOUND WORDS IN WORD SHARDS
================================================================================\n`);

// Words that were just fixed and need shard updates
const fixedWords = [
  'understand', 'understanding', 'understood',
  'withstand', 'withstanding', 'withstood',
  'outstanding',
  'breakthrough',
  'breaker', 'breaking',
  'upbring', 'upbringing',
  'rebuild', 'rebuilding',
  'unbuilt'
];

let updated = 0;
let notFound = 0;

fixedWords.forEach(word => {
  if (!curated[word]) {
    console.log(`✗ NOT IN CURATED: ${word}`);
    notFound++;
    return;
  }

  // Determine which shard file
  const firstTwoLetters = word.substring(0, 2).toLowerCase();
  const shardPath = path.join(wordsDir, `${firstTwoLetters}.json`);

  if (!fs.existsSync(shardPath)) {
    console.log(`✗ SHARD NOT FOUND: ${word} (${firstTwoLetters}.json)`);
    notFound++;
    return;
  }

  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));

  if (!shard[word]) {
    console.log(`✗ WORD NOT IN SHARD: ${word}`);
    notFound++;
    return;
  }

  const morphemeData = curated[word];

  // Update the morpheme data
  shard[word].m = {
    parts: morphemeData.parts || [],
    root: morphemeData.root,
    verified: morphemeData.mwVerified || false,
    source: morphemeData.source || 'family verified'
  };

  // Add etymology if available
  if (morphemeData.mwEtymology) {
    shard[word].m.etymology = morphemeData.mwEtymology;
  }

  fs.writeFileSync(shardPath, JSON.stringify(shard, null, 2));
  updated++;

  console.log(`✓ UPDATED: ${word}`);
  console.log(`  → [${morphemeData.parts.map(p => `${p.kind}:${p.id}`).join(', ')}]`);
});

console.log(`\n================================================================================`);
console.log(`Results: ${updated} updated, ${notFound} not found/error`);
console.log(`================================================================================\n`);
