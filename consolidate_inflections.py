#!/usr/bin/env python3
"""
Analyze and consolidate English inflections in the wordlist.
Maps inflected forms to their base lemmas and reports redundancy.
"""

import json
import os
from collections import defaultdict
from pathlib import Path

# Standard English inflection patterns
INFLECTION_PATTERNS = {
    # Verb forms
    (-2, 'ed'): 'past_tense',      # walked, talked
    (-3, 'ing'): 'present_participle',  # walking, talking
    (-1, 's'): 'third_person_singular',  # walks, talks
    (-3, 'ies'): 'plural',  # flies -> fly (special case)

    # Adjective/Adverb forms
    (-2, 'er'): 'comparative',     # faster, bigger
    (-3, 'est'): 'superlative',    # fastest, biggest
    (-2, 'ly'): 'adverbial',       # quickly, slowly

    # Noun forms
    (-1, 's'): 'plural',           # cats, dogs
    (-2, 'es'): 'plural',          # boxes, pushes
    (-3, 'ies'): 'plural',         # babies, ladies

    # Derived forms
    (-2, 'er'): 'agent_noun',      # walker, talker
    (-4, 'ness'): 'abstract_noun', # sadness, happiness
    (-4, 'tion'): 'noun_form',     # action, creation
}

def analyze_potential_lemma(word):
    """
    Given an inflected word, generate potential base lemmas.
    Returns list of (potential_lemma, pattern_type) tuples.
    """
    candidates = []

    # Pattern: word + ed -> word (most recent -ed forms)
    if word.endswith('ed') and len(word) > 3:
        base = word[:-2]
        candidates.append((base, 'past_tense_remove_ed'))
        # Special cases: doubled consonants
        if len(base) > 1 and base[-1] == base[-2] and base[-2] not in 'aeiou':
            candidates.append((base[:-1], 'past_tense_doubled'))

    # Pattern: word + ing -> word
    if word.endswith('ing') and len(word) > 4:
        base = word[:-3]
        candidates.append((base, 'present_participle_remove_ing'))
        # Special case: silent e
        candidates.append((base + 'e', 'present_participle_restore_e'))

    # Pattern: word + s/es -> word
    if word.endswith('es') and len(word) > 3:
        base = word[:-2]
        candidates.append((base, 'plural_remove_es'))
        # Special case: y -> ies
        candidates.append((base[:-1] + 'y', 'plural_y_to_ies'))
    elif word.endswith('s') and len(word) > 2:
        base = word[:-1]
        if not base.endswith('s'):  # avoid duplicates like "loss->los"
            candidates.append((base, 'plural_remove_s'))

    # Pattern: word + er -> word (agent noun or comparative)
    if word.endswith('er') and len(word) > 3:
        base = word[:-2]
        candidates.append((base, 'agent_noun_or_comparative'))

    # Pattern: word + ly -> word (adverbial)
    if word.endswith('ly') and len(word) > 3:
        base = word[:-2]
        # For adjectives ending in -ic, -ic + ly = ically
        if base.endswith('ic'):
            candidates.append((base[:-2] + 'al', 'adverbial_ic_to_ical'))
        candidates.append((base, 'adverbial_remove_ly'))

    # Pattern: un + word -> word (negation)
    if word.startswith('un') and len(word) > 4:
        base = word[2:]
        candidates.append((base, 'negative_prefix'))

    return candidates

def load_all_words():
    """Load all words from export/words directory."""
    all_words = set()
    for fname in os.listdir('export/words'):
        if fname.endswith('.json'):
            with open(f'export/words/{fname}') as f:
                data = json.load(f)
                for word in data.keys():
                    all_words.add(word)
    return all_words

def consolidate():
    """Main consolidation analysis."""
    print("Loading wordlist...")
    all_words = load_all_words()
    print(f"Total unique words: {len(all_words)}")

    # Find potential inflections
    mapped_count = 0
    lemma_groups = defaultdict(list)
    unmapped = []

    print("\nAnalyzing potential inflections...")

    for word in sorted(all_words):
        lemma_candidates = analyze_potential_lemma(word)

        # Check if any candidate exists in the wordlist
        found = False
        for candidate, pattern in lemma_candidates:
            if candidate in all_words and candidate != word:
                lemma_groups[candidate].append((word, pattern))
                mapped_count += 1
                found = True
                break

        if not found and (word.endswith(('ed', 'ing', 's', 'es', 'er', 'ly'))):
            unmapped.append(word)

    # Report findings
    print(f"\nConsolidation Analysis:")
    print(f"  Potential inflections identified: {mapped_count}")
    print(f"  Lemmas with inflections: {len(lemma_groups)}")
    print(f"  Words with inflection patterns but no base form: {len(unmapped)}")
    print(f"  Potential word reduction: ~{mapped_count} words")
    print(f"  New total if consolidated: ~{len(all_words) - mapped_count}")

    # Show samples
    print(f"\nSample consolidation groups (first 20):")
    count = 0
    for lemma in sorted(lemma_groups.keys())[:20]:
        inflections = lemma_groups[lemma]
        print(f"  {lemma}")
        for inflected, pattern in inflections[:3]:
            print(f"    - {inflected} ({pattern})")
        if len(inflections) > 3:
            print(f"    ... and {len(inflections) - 3} more")
        count += 1

    # Save detailed report
    with open('inflection_consolidation_report.json', 'w') as f:
        json.dump({
            'total_words': len(all_words),
            'mapped_inflections': mapped_count,
            'lemmas_with_inflections': len(lemma_groups),
            'unmapped_inflections': len(unmapped),
            'potential_reduction': len(all_words) - mapped_count,
            'groups': {k: [(w, p) for w, p in v] for k, v in sorted(lemma_groups.items())}
        }, f, indent=2)

    print(f"\nDetailed report saved to: inflection_consolidation_report.json")

    return len(all_words) - mapped_count

if __name__ == '__main__':
    consolidate()
