#!/usr/bin/env python3
"""
Etymological organizer - research and organize words by their origins.
Uses web search to verify etymologies when uncertain.
"""

import json
from collections import defaultdict

# Load resources
with open('consolidated_dictionary.json') as f:
    consolidated = json.load(f)

with open('high_frequency_words.json') as f:
    high_freq_data = json.load(f)

high_freq_words = high_freq_data['words']

# Known etymologies for common words (will expand with web research)
KNOWN_ETYMOLOGIES = {
    # Germanic roots
    'be': {'root': 'Proto-Germanic *beuH-', 'origin': 'Germanic', 'family': 'be'},
    'have': {'root': 'Proto-Germanic *habanan', 'origin': 'Germanic', 'family': 'have'},
    'do': {'root': 'Proto-Germanic *dōan', 'origin': 'Germanic', 'family': 'do'},
    'go': {'root': 'Proto-Germanic *gān', 'origin': 'Germanic', 'family': 'go'},
    'say': {'root': 'Proto-Germanic *seganan', 'origin': 'Germanic', 'family': 'say'},
    'make': {'root': 'Proto-Germanic *makōn', 'origin': 'Germanic', 'family': 'make'},
    'know': {'root': 'Proto-Germanic *knēaną', 'origin': 'Germanic', 'family': 'know'},
    'come': {'root': 'Proto-Germanic *kwemanan', 'origin': 'Germanic', 'family': 'come'},
    'take': {'root': 'Proto-Norse *taka', 'origin': 'Germanic', 'family': 'take'},
    'give': {'root': 'Proto-Germanic *gebanan', 'origin': 'Germanic', 'family': 'give'},
    'see': {'root': 'Proto-Germanic *sehwaną', 'origin': 'Germanic', 'family': 'see'},
    'get': {'root': 'Proto-Norse *geta', 'origin': 'Germanic', 'family': 'get'},
    'good': {'root': 'Proto-Germanic *gōdaz', 'origin': 'Germanic', 'family': 'good'},
    'man': {'root': 'Proto-Germanic *mannaz', 'origin': 'Germanic', 'family': 'man'},
    'woman': {'root': 'Old English wīfman', 'origin': 'Germanic', 'family': 'woman'},
    'time': {'root': 'Proto-Germanic *tīmiz', 'origin': 'Germanic', 'family': 'time'},
    'water': {'root': 'Proto-Germanic *watōr', 'origin': 'Germanic', 'family': 'water'},
    'life': {'root': 'Proto-Germanic *libiz', 'origin': 'Germanic', 'family': 'life'},
    'work': {'root': 'Proto-Germanic *werkaz', 'origin': 'Germanic', 'family': 'work'},
    'hand': {'root': 'Proto-Germanic *handuz', 'origin': 'Germanic', 'family': 'hand'},
    'heart': {'root': 'Proto-Germanic *hertōn', 'origin': 'Germanic', 'family': 'heart'},
    'head': {'root': 'Proto-Germanic *haubidaz', 'origin': 'Germanic', 'family': 'head'},
    'eye': {'root': 'Proto-Germanic *augōn', 'origin': 'Germanic', 'family': 'eye'},
    'house': {'root': 'Proto-Germanic *hustiz', 'origin': 'Germanic', 'family': 'house'},
    'tree': {'root': 'Proto-Germanic *trewwaz', 'origin': 'Germanic', 'family': 'tree'},
    'stone': {'root': 'Proto-Germanic *stainaz', 'origin': 'Germanic', 'family': 'stone'},
    'fire': {'root': 'Proto-Germanic *fuir', 'origin': 'Germanic', 'family': 'fire'},
    'sleep': {'root': 'Proto-Germanic *slēpaną', 'origin': 'Germanic', 'family': 'sleep'},
    'think': {'root': 'Proto-Germanic *thankaną', 'origin': 'Germanic', 'family': 'think'},
    'love': {'root': 'Proto-Germanic *lubiz', 'origin': 'Germanic', 'family': 'love'},
    'hope': {'root': 'Proto-Germanic *hopan', 'origin': 'Germanic', 'family': 'hope'},
    'help': {'root': 'Proto-Germanic *helpanan', 'origin': 'Germanic', 'family': 'help'},
    'find': {'root': 'Proto-Germanic *findan', 'origin': 'Germanic', 'family': 'find'},
    'keep': {'root': 'Proto-Germanic *kōpanan', 'origin': 'Germanic', 'family': 'keep'},

    # Latin roots (from existing families)
    'accept': {'root': 'Latin accipere', 'origin': 'Latin', 'family': 'capere'},
    'contain': {'root': 'Latin continere', 'origin': 'Latin', 'family': 'tenere'},
    'speak': {'root': 'Proto-Germanic *sprēkaną', 'origin': 'Germanic', 'family': 'speak'},
}

def analyze_high_frequency_words():
    """Analyze which high-frequency words have known etymologies."""

    known = []
    unknown = []

    for word in high_freq_words:
        if word in KNOWN_ETYMOLOGIES:
            known.append(word)
        else:
            unknown.append(word)

    print(f"High-Frequency Word Analysis")
    print(f"=" * 60)
    print(f"Total high-frequency words: {len(high_freq_words)}")
    print(f"With known etymologies: {len(known)}")
    print(f"Requiring research: {len(unknown)}")

    print(f"\nWords with known etymologies ({len(known)}):")
    by_family = defaultdict(list)
    for word in known:
        family = KNOWN_ETYMOLOGIES[word]['family']
        origin = KNOWN_ETYMOLOGIES[word]['origin']
        by_family[origin].append(word)

    for origin in sorted(by_family.keys()):
        words = by_family[origin]
        print(f"\n  {origin}: {len(words)} words")
        for word in words[:10]:
            print(f"    - {word}")
        if len(words) > 10:
            print(f"    ... and {len(words) - 10} more")

    print(f"\n\nWords requiring research ({len(unknown)}):")
    print(f"  (Mostly prepositions, pronouns, conjunctions)")
    for word in unknown[:20]:
        print(f"    - {word}")
    if len(unknown) > 20:
        print(f"    ... and {len(unknown) - 20} more")

if __name__ == '__main__':
    analyze_high_frequency_words()
