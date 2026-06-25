#!/usr/bin/env node
/**
 * Apply Batch 2 corrections: Update -ity words from verb stems to adjective stems
 */
const fs = require('fs');

const curatedPath = './curated_morphemes_complete.json';
const correctionMatrixPath = './batch2_correction_matrix.json';

const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));
const corrections = JSON.parse(fs.readFileSync(correctionMatrixPath, 'utf8'));

console.log(`
================================================================================
APPLYING BATCH 2 CORRECTIONS
================================================================================

Updating morpheme breakdowns from verb stems to adjective stems for -ity words.
This corrects the systematic error where -ity words were incorrectly parsed
using verb stems instead of adjective stems.

================================================================================\n`);

let updated = 0;
let already_correct = 0;

Object.entries(corrections.corrections).forEach(([word, correction]) => {
  if (!curated[word]) {
    console.log(`⚠ SKIPPED: ${word} - not found in curated data`);
    return;
  }

  const entry = curated[word];
  
  // Check if entry has parts array
  if (!entry.parts || !Array.isArray(entry.parts)) {
    console.log(`⚠ SKIPPED: ${word} - no parts array in entry`);
    return;
  }

  // Get current breakdown
  const currentBreakdown = entry.parts.map(p => p.id).join(' + ');
  
  if (currentBreakdown === correction.correct_breakdown.replace(/ \+ /g, ' + ')) {
    console.log(`✓ ALREADY CORRECT: ${word} (${currentBreakdown})`);
    already_correct++;
    return;
  }

  // Log what we're changing
  console.log(`\nUpdating: ${word}`);
  console.log(`  Current:  ${currentBreakdown}`);
  console.log(`  Correct:  ${correction.correct_breakdown}`);
  
  // Parse correct breakdown
  const parts = correction.correct_breakdown.split(' + ').map(part => {
    part = part.trim();
    
    // Identify kind
    let kind = 'root';
    let gloss = '';
    
    if (part === 'ity' || part === 'acity' || part === 'osity') {
      kind = 'suffix';
      gloss = 'state or quality of';
    } else if (part === 'al') {
      kind = 'suffix';
      gloss = 'relating to, connected with';
    } else if (part === 'ibl' || part === 'able') {
      kind = 'suffix';
      gloss = 'able to be, capable of';
    } else if (part.length <= 3 && (
      part === 'in' || part === 'ir' || part === 'di' || part === 're' || 
      part === 'con' || part === 'ad' || part === 'per' || part === 'super' ||
      part === 'multi' || part === 'uni' || part === 'bio' || part === 'contro' ||
      part === 'ante' || part === 'sub' || part === 'anti'
    )) {
      kind = 'prefix';
    }
    
    return {
      kind: kind,
      id: part,
      surface: part,
      gloss: gloss,
      source: '-' + part
    };
  });

  // Update entry
  entry.parts = parts;
  entry.mwVerified = true;
  entry.source = 'M-W corrected';
  entry.batch2_corrected = true;
  
  console.log(`  ✓ Updated morpheme breakdown`);
  updated++;
});

console.log(`

================================================================================
CORRECTION SUMMARY
================================================================================

Total words processed: ${Object.keys(corrections.corrections).length}
Updated: ${updated}
Already correct: ${already_correct}
Skipped: ${Object.keys(corrections.corrections).length - updated - already_correct}

Total curated entries: ${Object.keys(curated).length}

Saving to: ${curatedPath}
`);

fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2));

console.log('✓ File saved successfully\n');
