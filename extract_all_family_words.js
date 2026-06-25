#!/usr/bin/env node
/**
 * Extract ALL words from family files (1,191 total) and create comprehensive
 * curated morpheme breakdowns. This replaces the incomplete 777-word extraction.
 */
const fs = require('fs');
const path = require('path');

const familyDir = './family';
const outputPath = './curated_morphemes_complete.json';

// Helper: identify suffix ID from surface form
function identifySuffixId(surface) {
  const s = surface.toLowerCase();
  if (s === 'ing') return 'ing';
  if (s === 'ed') return 'ed';
  if (s === 'er' || s === 'or') return 'er-agent';
  if (s === 's' || s === 'es') return 's-plural';
  if (s.endsWith('tion') || s.endsWith('sion')) return 'ion';
  if (s.endsWith('ity')) return 'ity';
  if (s.endsWith('ary') || s.endsWith('ery') || s.endsWith('ory')) return 'ary';
  if (s.endsWith('able') || s.endsWith('ible')) return 'able';
  if (s === 'ly') return 'ly';
  if (s === 'en') return 'en';
  if (s === 'ness') return 'ness';
  return s; // use surface as ID if unrecognized
}

// Helper: get gloss for known suffixes
function getSuffixGloss(id) {
  const glosses = {
    'ing': 'action or process; present participle',
    'ed': 'past tense; having',
    'er-agent': 'one who, that which',
    's-plural': 'plural; or third-person singular verb',
    'ion': 'act, process, or result of',
    'ity': 'state or quality of',
    'ary': 'relating to, connected with',
    'able': 'able to be, capable of',
    'ly': 'in the manner of',
    'en': 'made of; to make',
    'ness': 'state or quality of',
  };
  return glosses[id] || '';
}

console.log(`
================================================================================
COMPREHENSIVE FAMILY WORD EXTRACTION
================================================================================

Extracting ALL placements from family files to build complete curated data.
This will include:
- Base words (already in curated_morphemes.json)
- Derived words (unbreakable, breakthrough, etc.)
- Inflected forms (bound, broken, brought, etc.)
- Compound words

Output: ${outputPath}
================================================================================
\n`);

const curated = {};
let totalExtracted = 0;
let byFamily = {};

// Process all family files
fs.readdirSync(familyDir).forEach(file => {
  if (!file.endsWith('.json') || file.startsWith('.')) return;

  // Skip metadata files
  if (['collections.json', 'inflections.json', 'inflections_conservative.json', 'variants.json'].includes(file)) {
    return;
  }

  const familyPath = path.join(familyDir, file);

  try {
    const family = JSON.parse(fs.readFileSync(familyPath, 'utf8'));

    if (!Array.isArray(family.placements)) {
      console.log(`Skipping ${file}: no placements array`);
      return;
    }

    const familyRoot = family.root;
    if (!byFamily[familyRoot]) byFamily[familyRoot] = 0;

    family.placements.forEach(placement => {
      const word = placement.w;
      const suffix = placement.s ? String(placement.s).trim() : '';

      totalExtracted++;
      byFamily[familyRoot]++;

      // Build morpheme breakdown from family structure
      const parts = [];

      // Root
      parts.push({
        kind: 'root',
        id: familyRoot,
        gloss: (family.rootGloss || '').split('·')[0].trim(),
        surface: familyRoot,
        origin: family.regions && family.regions.length ? family.regions[0] : 'Latin',
        source: family.root,
      });

      // Suffix (if any)
      if (suffix && suffix.trim()) {
        // Try to identify suffix type
        const suffixId = identifySuffixId(suffix);
        parts.push({
          kind: 'suffix',
          id: suffixId,
          gloss: getSuffixGloss(suffixId),
          surface: suffix,
          origin: 'Latin/Old English',
          source: '-' + suffix,
        });
      }

      // Store entry
      curated[word] = {
        parts: parts,
        root: familyRoot,
        family: familyPath,
        placement: {
          suffix: placement.s,
          region: placement.region,
          parent: placement.parent,
          by: placement.by,
        }
      };
    });

    console.log(`✓ ${familyRoot.padEnd(15)} ${byFamily[familyRoot]} words`);
  } catch (e) {
    console.log(`✗ Error reading ${file}: ${e.message}`);
  }
});

console.log(`
================================================================================
EXTRACTION COMPLETE
================================================================================

Total words extracted: ${totalExtracted}
Families processed: ${Object.keys(byFamily).length}

Words by family (top 10):
`);

Object.entries(byFamily)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([family, count]) => {
    console.log(`  ${family.padEnd(15)} ${count} words`);
  });

// Save to file
fs.writeFileSync(outputPath, JSON.stringify(curated, null, 2));
console.log(`
Output saved to: ${outputPath}
Total entries: ${Object.keys(curated).length}

Next steps:
1. Compare with existing curated_morphemes.json to identify new entries
2. Add M-W etymologies to key word patterns
3. Replace curated_morphemes.json with this complete version
`);
