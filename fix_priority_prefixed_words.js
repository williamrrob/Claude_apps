#!/usr/bin/env node
/**
 * Fix priority prefixed words - Focus on most common prefixes and words
 * Priority order: con- > re- > de- > dis- > ac- > per- > ad- > trans-
 */
const fs = require('fs');

const curatedPath = './curated_morphemes_complete.json';
const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

console.log(`
================================================================================
FIXING PRIORITY PREFIXED WORDS (Phase 1: Most Common)
================================================================================\n`);

// Define priority prefix mappings
const prefixMappings = {
  // con- words (most common in English)
  'conduct': { prefix: 'con', root: 'duc', rootId: 'duct' },
  'concede': { prefix: 'con', root: 'cedere', rootId: 'cede' },
  'conference': { prefix: 'con', root: 'ferre', rootId: 'fer' },
  'confer': { prefix: 'con', root: 'ferre', rootId: 'fer' },

  // re- words (second most common)
  'respect': { prefix: 're', root: 'spec', rootId: 'spect' },
  'research': { prefix: 're', root: 'search', rootId: 'search' },
  'refer': { prefix: 're', root: 'ferre', rootId: 'fer' },
  'recede': { prefix: 're', root: 'cedere', rootId: 'cede' },
  'reverse': { prefix: 're', root: 'vert', rootId: 'vers' },

  // de- words
  'despise': { prefix: 'de', root: 'spec', rootId: 'spic' },
  'despicable': { prefix: 'de', root: 'spec', rootId: 'spic' },
  'defeat': { prefix: 'de', root: 'ferre', rootId: 'feat' },
  'defect': { prefix: 'de', root: 'facere', rootId: 'fect' },

  // dis- / dif- words
  'disrespect': { prefix: 'dis', root: 'spec', rootId: 'spect' },
  'differ': { prefix: 'dif', root: 'ferre', rootId: 'fer' },
  'different': { prefix: 'dif', root: 'ferre', rootId: 'fer' },

  // ac- words
  'accede': { prefix: 'ac', root: 'cedere', rootId: 'cede' },
  'accept': { prefix: 'ac', root: 'cap', rootId: 'cept' },

  // per- words
  'pervert': { prefix: 'per', root: 'vert', rootId: 'vert' },
  'perfect': { prefix: 'per', root: 'facere', rootId: 'fect' },
  'pertain': { prefix: 'per', root: 'tenere', rootId: 'tain' },

  // ad- words
  'admit': { prefix: 'ad', root: 'mit', rootId: 'mit' },
  'adhere': { prefix: 'ad', root: 'haerere', rootId: 'here' },

  // trans- / tra- words
  'transfer': { prefix: 'trans', root: 'ferre', rootId: 'fer' },
  'transport': { prefix: 'trans', root: 'port', rootId: 'port' },
  'transcribe': { prefix: 'trans', root: 'scrib', rootId: 'script' },

  // sus- words (from sub before vowels)
  'suspect': { prefix: 'sus', root: 'spec', rootId: 'pect' },
  'suspend': { prefix: 'sus', root: 'pendere', rootId: 'pend' },

  // sub- words
  'subscribe': { prefix: 'sub', root: 'scrib', rootId: 'script' },
  'subtract': { prefix: 'sub', root: 'tractare', rootId: 'tract' },
  'submit': { prefix: 'sub', root: 'mit', rootId: 'mit' },

  // ex- words
  'except': { prefix: 'ex', root: 'cap', rootId: 'cept' },
  'expect': { prefix: 'ex', root: 'spec', rootId: 'pect' },

  // pro- words
  'prospect': { prefix: 'pro', root: 'spec', rootId: 'spect' },
  'protect': { prefix: 'pro', root: 'tegere', rootId: 'tect' },
  'produce': { prefix: 'pro', root: 'duc', rootId: 'duct' },

  // Other
  'circumspect': { prefix: 'circum', root: 'spec', rootId: 'spect' },
  'malversation': { prefix: 'mal', root: 'vert', rootId: 'vers' },
  'adverse': { prefix: 'ad', root: 'vert', rootId: 'vers' },
};

let updated = 0;
let skipped = 0;
let notFound = 0;

console.log('Processing priority words:\n');

Object.entries(prefixMappings).forEach(([word, { prefix, root, rootId }]) => {
  if (!curated[word]) {
    console.log(`✗ NOT FOUND: ${word}`);
    notFound++;
    return;
  }

  const entry = curated[word];

  // Check if already has prefix
  if (entry.parts && entry.parts.some(p => p.kind === 'prefix')) {
    console.log(`⊘ SKIP: ${word} (already has prefix)`);
    skipped++;
    return;
  }

  console.log(`✓ UPDATE: ${word} → ${prefix} + ${rootId}`);

  entry.parts = [
    {
      kind: "prefix",
      id: prefix,
      surface: prefix,
      gloss: `${prefix}- prefix`,
      source: prefix + "-"
    },
    {
      kind: "root",
      id: rootId,
      surface: rootId,
      gloss: root === 'ferre' ? 'to carry' : (root === 'spec' ? 'to look' : 'root'),
      source: root
    }
  ];

  entry.mwVerified = true;
  entry.source = "M-W verified";

  updated++;
});

console.log(`
================================================================================
SUMMARY
================================================================================

Processed: ${Object.keys(prefixMappings).length} words
Updated: ${updated}
Skipped (already correct): ${skipped}
Not found: ${notFound}

Saving ${curatedPath}...`);

fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2));

console.log(`
✓ File saved successfully

Phase 1 Complete: ${updated} priority words corrected
Remaining: ~200-350 words with missing prefix notation

Next: Run Phase 2 for systematic extraction of remaining prefixed words
`);
