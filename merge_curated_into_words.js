#!/usr/bin/env node
/**
 * Merge curated morpheme breakdowns into word shard JSON files.
 * This prioritizes curated data over engine-generated data in the app.
 */
const fs = require('fs');
const path = require('path');

// Load curated morphemes
const curatedPath = './curated_morphemes.json';
const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

console.log(`Loaded ${Object.keys(curated).length} curated morpheme entries`);

// Helper to convert curated part to word shard format
function convertPart(part) {
  return {
    s: part.surface,
    k: part.kind,
    id: part.id || undefined,
    g: part.gloss || undefined,
    src: part.source || undefined,
    ori: part.origin || undefined,
  };
}

// Process each word in the curated data
const wordsByPrefix = {};
Object.entries(curated).forEach(([word, data]) => {
  const prefix = word.slice(0, 2).toLowerCase();
  if (!wordsByPrefix[prefix]) wordsByPrefix[prefix] = [];
  wordsByPrefix[prefix].push({
    word,
    breakdown: data.parts.map(convertPart),
    root: data.root,
    family: data.family,
  });
});

console.log(`Grouped into ${Object.keys(wordsByPrefix).length} prefixes`);

// Update each shard
let updated = 0;
let added = 0;

Object.entries(wordsByPrefix).forEach(([prefix, words]) => {
  const shardPath = path.join('./words', prefix + '.json');

  if (!fs.existsSync(shardPath)) {
    console.log(`Shard ${prefix}.json not found, skipping`);
    return;
  }

  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));

  words.forEach(({ word, breakdown, root, family }) => {
    if (!shard[word]) {
      shard[word] = {};
    }

    if (!shard[word].b || shard[word].b.length === 0) {
      // Add curated breakdown if not already present
      shard[word].b = breakdown;
      shard[word].root = root;
      if (family) shard[word].family = family;
      added++;
    } else {
      // Update existing breakdown
      shard[word].b = breakdown;
      shard[word].root = root;
      if (family) shard[word].family = family;
      updated++;
    }
  });

  // Write shard back
  fs.writeFileSync(shardPath, JSON.stringify(shard, null, 2));
  console.log(`Updated ${prefix}.json: ${updated} updated, ${added} added`);
  updated = 0;
  added = 0;
});

console.log('\nMerge complete! Curated morphemes are now in the word shards.');
console.log('The app will now show curated breakdowns instead of engine-generated ones.');
