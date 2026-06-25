#!/usr/bin/env node
/**
 * Add M-W source tracking and etymology to curated words.
 * Mark which words have M-W verification vs family-only verification.
 */
const fs = require('fs');

const curatedPath = './curated_morphemes_complete.json';
const mwCorrectionsPath = './mw_curated_corrections.json';

const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));
const mwCorrections = JSON.parse(fs.readFileSync(mwCorrectionsPath, 'utf8'));

console.log(`
================================================================================
ADD M-W SOURCE TRACKING
================================================================================

Processing ${Object.keys(curated).length} curated words.
Adding M-W etymologies and source tracking.

Words with M-W corrections: ${Object.keys(mwCorrections).length}
================================================================================
\n`);

let updated = 0;
let added = 0;

// Add M-W information to relevant words
Object.entries(mwCorrections).forEach(([word, mwData]) => {
  if (curated[word]) {
    // Update existing entry with M-W verification
    curated[word].mwEtymology = mwData.mwEtymology;
    curated[word].mwVerified = true;
    curated[word].source = 'family + M-W verified';
    updated++;
    console.log(`✓ Updated ${word} with M-W etymology`);
  } else {
    // Add new entry from M-W research
    curated[word] = mwData;
    curated[word].mwVerified = true;
    curated[word].source = 'M-W research';
    added++;
    console.log(`+ Added ${word} from M-W research`);
  }
});

// Mark all entries with source tracking
Object.entries(curated).forEach(([word, entry]) => {
  if (!entry.source) {
    if (entry.family) {
      entry.source = 'family verified';
    } else {
      entry.source = 'unknown';
    }
  }
  if (!entry.mwVerified) {
    entry.mwVerified = false;
  }
});

console.log(`
================================================================================
SUMMARY
================================================================================

Updated with M-W: ${updated}
Added from M-W: ${added}
Total curated entries: ${Object.keys(curated).length}

Source breakdown:
`);

const bySources = {};
Object.values(curated).forEach(entry => {
  const source = entry.source || 'unknown';
  bySources[source] = (bySources[source] || 0) + 1;
});

Object.entries(bySources)
  .sort((a, b) => b[1] - a[1])
  .forEach(([source, count]) => {
    console.log(`  ${source.padEnd(30)} ${count} words`);
  });

// Save updated file
fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2));

console.log(`
\nSaved to: ${curatedPath}

Next step: Merge into word shards so app shows M-W-verified etymologies.
`);
