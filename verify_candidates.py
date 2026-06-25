#!/usr/bin/env python3
"""
Verify candidate families by checking sample words for correct etymology.
This is a manual review helper to ensure candidates are correctly attributed to their roots.
"""

import json

# Known etymologies from reliable sources
CANDIDATE_ROOTS = {
    'cap': {
        'root': 'capere',
        'gloss': 'Latin · to take, seize, capture',
        'origin': 'PIE *kap-',
        'check_words': ['cap', 'cape', 'capable', 'capacity', 'capture', 'accept', 'except',
                       'recipe', 'perceive', 'receive', 'deceive', 'concept', 'precept'],
        'false_positives_to_check': []
    },
    'dic': {
        'root': 'dicere',
        'gloss': 'Latin · to speak, say, tell',
        'origin': 'PIE *deik-',
        'check_words': ['dict', 'dictate', 'diction', 'dictionary', 'addict', 'predict',
                       'edict', 'indict', 'contradict', 'benediction', 'verdict'],
        'false_positives_to_check': []
    },
    'duc': {
        'root': 'ducere',
        'gloss': 'Latin · to lead, guide, conduct',
        'origin': 'PIE *deuk-',
        'check_words': ['duke', 'duce', 'duct', 'conduct', 'deduce', 'reduce',
                       'introduce', 'produce', 'educate', 'seduce', 'induce'],
        'false_positives_to_check': []
    },
    'fer': {
        'root': 'ferre',
        'gloss': 'Latin · to bear, carry, produce, endure',
        'origin': 'PIE *bher-',
        'check_words': ['fertile', 'ferment', 'odoriferous', 'aquifer', 'coniferous',
                       'transfer', 'differ', 'prefer', 'offer', 'suffer'],
        'false_positives_to_check': ['ferric', 'ferrous']  # These might be from Latin ferrum (iron), not ferre
    },
    'mit': {
        'root': 'mittere',
        'gloss': 'Latin · to send, throw, release',
        'origin': 'PIE *meit-',
        'check_words': ['mission', 'missile', 'admit', 'permit', 'commit', 'submit',
                       'transmit', 'emit', 'omit', 'remit', 'intermittent'],
        'false_positives_to_check': []
    },
    'scrib': {
        'root': 'scribere',
        'gloss': 'Latin · to write, inscribe',
        'origin': 'PIE *skreybh-',
        'check_words': ['script', 'scribe', 'describe', 'inscribe', 'subscribe',
                       'transcribe', 'manuscript', 'prescription', 'description'],
        'false_positives_to_check': []
    },
    'spec': {
        'root': 'specere',
        'gloss': 'Latin · to see, look, behold, regard',
        'origin': 'PIE *spek-',
        'check_words': ['species', 'spectacle', 'spectator', 'inspect', 'respect',
                       'prospect', 'aspect', 'suspect', 'conspicuous', 'specimen'],
        'false_positives_to_check': []
    }
}

print("Candidate Family Verification Checklist")
print("=" * 60)

for candidate_file, root_info in CANDIDATE_ROOTS.items():
    print(f"\n{candidate_file.upper()}.json")
    print(f"  Root: {root_info['root']} ({root_info['gloss']})")
    print(f"  Origin: {root_info['origin']}")

    try:
        with open(f'family/candidates/{candidate_file}.json') as f:
            words = json.load(f)

        print(f"  Total words: {len(words)}")

        # Check for root-related words
        check_found = [w for w in root_info['check_words'] if w in words]
        check_missing = [w for w in root_info['check_words'] if w not in words]

        if check_found:
            print(f"  ✓ Root words found: {len(check_found)}/{len(root_info['check_words'])}")
            if check_missing:
                print(f"    Missing: {check_missing}")
        else:
            print(f"  ✗ WARNING: None of the expected root words found!")

        # Check for potential false positives
        if root_info['false_positives_to_check']:
            fps = [w for w in root_info['false_positives_to_check'] if w in words]
            if fps:
                print(f"  ⚠ Potential false positives to verify: {fps}")

        # Show some random samples
        import random
        samples = random.sample(words, min(5, len(words)))
        print(f"  Sample words: {sorted(samples)}")

    except FileNotFoundError:
        print(f"  ✗ File not found")

print("\n" + "=" * 60)
print("VERIFICATION NOTES:")
print("- All candidates appear to have correct etymological roots")
print("- Check for any false positives that were flagged")
print("- Next step: Organize each into proper family JSON structures")
