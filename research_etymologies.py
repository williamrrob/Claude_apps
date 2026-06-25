#!/usr/bin/env python3
"""
Research etymologies for high-frequency words.
Start with meaningful words (nouns, verbs, adjectives).
Track progress and findings.
"""

import json
from collections import defaultdict

# Load consolidated dictionary
with open('consolidated_dictionary.json') as f:
    consolidated = json.load(f)

with open('high_frequency_words.json') as f:
    high_freq_data = json.load(f)

high_freq_words = high_freq_data['words']

# Known etymologies for common words
KNOWN_ETYMOLOGIES = {
    # Germanic roots - Core verbs
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
    'use': {'root': 'Old French user', 'origin': 'French', 'family': 'use'},
    'work': {'root': 'Proto-Germanic *werkaz', 'origin': 'Germanic', 'family': 'work'},
    'think': {'root': 'Proto-Germanic *thankaną', 'origin': 'Germanic', 'family': 'think'},

    # Germanic - Nouns
    'good': {'root': 'Proto-Germanic *gōdaz', 'origin': 'Germanic', 'family': 'good'},
    'man': {'root': 'Proto-Germanic *mannaz', 'origin': 'Germanic', 'family': 'man'},
    'woman': {'root': 'Old English wīfman', 'origin': 'Germanic', 'family': 'woman'},
    'time': {'root': 'Proto-Germanic *tīmiz', 'origin': 'Germanic', 'family': 'time'},
    'water': {'root': 'Proto-Germanic *watōr', 'origin': 'Germanic', 'family': 'water'},
    'life': {'root': 'Proto-Germanic *libiz', 'origin': 'Germanic', 'family': 'life'},
    'hand': {'root': 'Proto-Germanic *handuz', 'origin': 'Germanic', 'family': 'hand'},
    'heart': {'root': 'Proto-Germanic *hertōn', 'origin': 'Germanic', 'family': 'heart'},
    'head': {'root': 'Proto-Germanic *haubidaz', 'origin': 'Germanic', 'family': 'head'},
    'eye': {'root': 'Proto-Germanic *augōn', 'origin': 'Germanic', 'family': 'eye'},
    'house': {'root': 'Proto-Germanic *hustiz', 'origin': 'Germanic', 'family': 'house'},
    'tree': {'root': 'Proto-Germanic *trewwaz', 'origin': 'Germanic', 'family': 'tree'},
    'stone': {'root': 'Proto-Germanic *stainaz', 'origin': 'Germanic', 'family': 'stone'},
    'fire': {'root': 'Proto-Germanic *fuir', 'origin': 'Germanic', 'family': 'fire'},
    'day': {'root': 'Proto-Germanic *dagaz', 'origin': 'Germanic', 'family': 'day'},
    'year': {'root': 'Proto-Germanic *jēraz', 'origin': 'Germanic', 'family': 'year'},
    'week': {'root': 'Proto-Germanic *wikōn', 'origin': 'Germanic', 'family': 'week'},
    'place': {'root': 'Old French place', 'origin': 'French', 'family': 'place'},
    'school': {'root': 'Greek scholē', 'origin': 'Greek', 'family': 'scholē'},
    'person': {'root': 'Latin persōna', 'origin': 'Latin', 'family': 'persōna'},
    'people': {'root': 'Latin populāris', 'origin': 'Latin', 'family': 'populāris'},
    'thing': {'root': 'Proto-Germanic *thingam', 'origin': 'Germanic', 'family': 'thing'},
    'world': {'root': 'Proto-Germanic *wer- + ald', 'origin': 'Germanic', 'family': 'world'},

    # Latin roots
    'accept': {'root': 'Latin accipere', 'origin': 'Latin', 'family': 'capere'},
    'contain': {'root': 'Latin continere', 'origin': 'Latin', 'family': 'tenere'},
}

def categorize_words():
    """Categorize high-frequency words by part of speech likelihood."""

    # Words that are likely nouns
    nouns = ['man', 'woman', 'child', 'person', 'people', 'thing', 'place', 'time', 'year',
             'day', 'week', 'month', 'house', 'world', 'life', 'work', 'school', 'hand',
             'eye', 'face', 'head', 'heart', 'body', 'blood', 'water', 'fire', 'stone',
             'tree', 'flower', 'animal', 'dog', 'cat', 'bird', 'fish', 'snake', 'horse']

    # Words that are likely verbs
    verbs = ['be', 'have', 'do', 'say', 'go', 'make', 'get', 'know', 'take', 'come',
             'see', 'think', 'give', 'want', 'use', 'find', 'tell', 'ask', 'work',
             'call', 'try', 'feel', 'become', 'leave', 'put', 'mean', 'keep', 'let',
             'begin', 'seem', 'help', 'talk', 'turn', 'start', 'show', 'hear', 'play',
             'run', 'move', 'like', 'live', 'believe', 'hold', 'bring', 'happen',
             'write', 'read', 'watch', 'follow', 'stop', 'create', 'speak', 'learn',
             'change', 'lead', 'understand', 'watch', 'follow', 'meet', 'include']

    # Words that are likely adjectives
    adjectives = ['good', 'bad', 'big', 'small', 'long', 'short', 'hot', 'cold',
                  'fast', 'slow', 'high', 'low', 'happy', 'sad', 'angry', 'beautiful',
                  'ugly', 'smart', 'stupid', 'strong', 'weak', 'old', 'new', 'young',
                  'white', 'black', 'red', 'blue', 'green', 'yellow', 'first', 'last',
                  'other', 'different', 'same', 'right', 'wrong', 'true', 'false',
                  'easy', 'difficult', 'possible', 'impossible']

    # Categorize
    categorized = {
        'nouns': [],
        'verbs': [],
        'adjectives': [],
        'other': []
    }

    for word in high_freq_words:
        if word in nouns:
            categorized['nouns'].append(word)
        elif word in verbs:
            categorized['verbs'].append(word)
        elif word in adjectives:
            categorized['adjectives'].append(word)
        else:
            categorized['other'].append(word)

    print("High-Frequency Word Categorization:")
    print("=" * 60)
    for category, words in categorized.items():
        print(f"\n{category.upper()} ({len(words)}):")
        known_count = sum(1 for w in words if w in KNOWN_ETYMOLOGIES)
        unknown_count = len(words) - known_count
        print(f"  Known: {known_count}, Requiring research: {unknown_count}")

        # Show sample
        unknown_words = [w for w in words if w not in KNOWN_ETYMOLOGIES]
        if unknown_words:
            print(f"  Samples needing research: {unknown_words[:10]}")

    print("\n" + "=" * 60)
    print("RECOMMENDATION:")
    print("Start with nouns and verbs (most meaningful, clearest etymologies)")
    print("These will form the core word families.")

    # Save for next phase
    with open('categorized_high_frequency.json', 'w') as f:
        json.dump(categorized, f, indent=2)

    return categorized

if __name__ == '__main__':
    categorize_words()
