#!/usr/bin/env node
/**
 * Integrate curated morpheme breakdown data into word shards
 * Adds morpheme information to every word in words/ directory
 */
const fs = require('fs');
const path = require('path');

const curatedPath = './curated_morphemes_complete.json';
const wordsDir = './words';

const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

console.log(`
================================================================================
INTEGRATING MORPHEME DATA INTO WORD SHARDS
================================================================================

Reading ${Object.keys(curated).length} curated words...
Processing word shards in ${wordsDir}...
================================================================================\n`);

let processed = 0;
let updated = 0;
let skipped = 0;
let notInShards = 0;

// Process each word shard file
const shardFiles = fs.readdirSync(wordsDir).filter(f => f.endsWith('.json'));

shardFiles.forEach(file => {
  const shardPath = path.join(wordsDir, file);
  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  let modified = false;

  // Check each word in the shard
  Object.entries(shard).forEach(([word, wordData]) => {
    processed++;

    // Look up in curated data
    if (curated[word]) {
      const morphemeData = curated[word];

      // Add morpheme breakdown if not already present
      if (!wordData.m) {
        wordData.m = {
          parts: morphemeData.parts || [],
          root: morphemeData.root,
          verified: morphemeData.mwVerified || false,
          source: morphemeData.source || 'family verified'
        };

        // Add etymology if available
        if (morphemeData.mwEtymology) {
          wordData.m.etymology = morphemeData.mwEtymology;
        }

        updated++;
        modified = true;
      } else {
        skipped++;
      }
    } else {
      notInShards++;
    }
  });

  // Save shard if modified
  if (modified) {
    fs.writeFileSync(shardPath, JSON.stringify(shard, null, 2));
  }
});

const coverage = ((updated + skipped) / processed * 100).toFixed(1);

console.log(`
================================================================================
INTEGRATION SUMMARY
================================================================================

Processed: ${processed} words
Updated with morpheme data: ${updated}
Skipped (already has morpheme data): ${skipped}
Not in curated data: ${notInShards}

Coverage: ${coverage}% of words now have morpheme data

Morpheme data fields added to word shards.

Status: ✓ Word shards updated with morpheme breakdown data
`);
