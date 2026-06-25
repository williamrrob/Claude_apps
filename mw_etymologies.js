#!/usr/bin/env node
/**
 * Fetch and analyze M-W etymologies to identify:
 * 1. The real morphological structure (per M-W)
 * 2. How our engine decomposes it (wrong way)
 * 3. The gap that needs fixing
 */

// High-frequency words across multiple categories
const testWords = [
  // Words we know are wrong
  'dictionary', 'capacity', 'education', 'audition',

  // High-frequency words to test
  'education', 'information', 'situation', 'nation', 'station',
  'ability', 'quality', 'reality', 'reality', 'possibility',
  'action', 'function', 'production', 'construction',
  'important', 'different', 'particular', 'similar',
  'president', 'student', 'government', 'development',
  'increase', 'decrease', 'produce', 'reduce',
  'complete', 'separate', 'private', 'general',
];

console.log(`
================================================================================
M-W ETYMOLOGY RESEARCH PLAN
================================================================================

Goal: Identify systematic gaps between M-W etymology and our engine decomposition.

Word batch: ${testWords.length} words across multiple categories
Categories: -tion/-sion, -ity/-acity/-osity, -ent/-ant, -able/-ible, etc.

For each word, we need:
1. M-W etymology (authoritative source of truth)
2. Our engine decomposition (current wrong behavior)
3. Gap analysis (what's broken)
4. Corrected morpheme breakdown (for curated data)

Example:
--------
Word: dictionary
M-W:   dictiōn- (from Latin dictiō "speech") + -ārium/-ary
Engine: dic + ion + ary  ← WRONG
Gap:    Engine treats "dic" as root, "ion" as suffix
        But really "dicti(ō)" is the root element, "-ary" is suffix

Word: capacity
M-W:   capax (Latin "able to hold") + -itas → capacitas
Engine: cap + ity  ← WRONG
Gap:    Engine drops the middle "ac" part
        Should be capac- (from capax) + -ity

================================================================================

Next steps:
1. Fetch M-W pages for sample words
2. Parse etymologies to identify source languages and morpheme boundaries
3. Create morpheme breakdown based on M-W structure
4. Update curated_morphemes.json with corrected breakdowns
5. Retest engine to measure systematic improvements

Words to prioritize (by frequency + impact):
- Verbs: produce, reduce, increase, decrease
- Nouns: nation, station, action, function, education, information
- Adjectives: possible, complete, different, similar
- -ation/-ition/-sion endings (high frequency, often wrong)
- -ity/-acity/-osity endings (high frequency, often wrong)

================================================================================
`);

const engine = require('./engine.js');

console.log('Current engine decompositions (to compare with M-W):');
console.log('');

testWords.slice(0, 10).forEach(word => {
  const result = engine.decompose(word);
  const breakdown = result.parts
    .filter(p => p.kind !== 'unknown')
    .map(p => p.surface)
    .join(' + ');
  console.log(`${word.padEnd(20)} → ${breakdown}`);
});

console.log(`
\nTo fetch M-W etymologies, run:
  for word in ${testWords.slice(0, 5).join(' ')} ; do
    echo "=== $word ==="
    node -e "const WebFetch = require('./engine.js'); console.log('TODO: fetch https://merriam-webster.com/dictionary/$word')"
  done
`);
