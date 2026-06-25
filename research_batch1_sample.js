#!/usr/bin/env node
/**
 * Research Batch 1 sample: 20 strategic words from -tion/-sion batch
 * to identify systematic patterns before doing full verification
 */
const fs = require('fs');

// Strategic sample covering different patterns and high frequency
const sampleWords = [
  // Already researched
  'action', 'station', 'abstraction', 'capacity',
  // Common base words (agere, ducere, stare families)
  'production', 'nation', 'education', 'traction',
  // Inspection family
  'inspection', 'description', 'prescription',
  // Conversion family
  'conversion', 'version', 'diversion',
  // Emission/mission family
  'mission', 'emission', 'transmission',
  // Other high-frequency
  'satisfaction', 'competition', 'direction', 'correction'
];

console.log(`
================================================================================
M-W RESEARCH: BATCH 1 SAMPLE (20 representative words)
================================================================================

Strategic sample to identify patterns:
- Action family (ag-): action ✓
- Stand family (st-): station [needs review]
- Pull family (tract-): abstraction, traction
- Carry/move family (port-, fer-): production (actually duc-)
- Look family (spec-): inspection, description, prescription
- Turn family (vert-): conversion, version, diversion
- Send family (mitt-): emission, transmission, mission
- Make/do family (fac-): satisfaction, production
- Run family (curr-): [in batch as 'current' words]

Research locations: Each word's M-W etymology section
Documentation: parts array with root, prefix, suffix breakdowns
================================================================================

Words to research (in order of priority):

`);

// Group by family
const byRoot = {};
const curated = JSON.parse(fs.readFileSync('./curated_morphemes_complete.json', 'utf8'));

sampleWords.forEach(w => {
  if (curated[w]) {
    const root = curated[w].root;
    if (!byRoot[root]) byRoot[root] = [];
    byRoot[root].push(w);
  }
});

Object.entries(byRoot).forEach(([root, words]) => {
  console.log(`${root}:`);
  words.forEach(w => console.log(`  - ${w}`));
  console.log('');
});

console.log(`
Research template for each word:
{
  "word": "...",
  "mwEtymology": "...",
  "mwPrefix": "",
  "mwRoot": "",
  "mwSuffix": "",
  "familyBreakdown": "root + suffix",
  "matches": true/false,
  "notes": "..."
}

Start with: production, nation, inspection, conversion, emission, satisfaction
These are high-frequency, commonly understood words with clear families.
`);
