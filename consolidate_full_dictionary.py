#!/usr/bin/env python3
"""
Consolidate the full dictionary by applying inflection mappings.
Result: Greek and Latin words organized as lemmas with derivatives.
"""

import json
import os
from collections import defaultdict

def load_full_dictionary():
    """Load all words from export/words directory."""
    all_words = {}
    for fname in sorted(os.listdir('export/words')):
        if fname.endswith('.json'):
            with open(f'export/words/{fname}') as f:
                data = json.load(f)
                all_words.update(data)
    return all_words

def load_consolidation_map():
    """Load the conservative inflection consolidation map."""
    with open('family/inflections_conservative.json') as f:
        data = json.load(f)
    return data['map']

def consolidate_dictionary(all_words, consolidation_map):
    """
    Apply consolidation mapping to full dictionary.
    Returns organized structure with lemmas and their derivatives.
    """

    # Organize words into lemmas and derivatives
    lemmas = {}  # lemma -> list of (derivative_word, inflection_type)
    consolidated_count = 0

    for word in all_words:
        if word in consolidation_map:
            # This word is an inflection
            mapping = consolidation_map[word]
            lemma = mapping['lemma']
            inflection_type = mapping['type']

            if lemma not in lemmas:
                lemmas[lemma] = {'derivatives': [], 'count': 1}

            lemmas[lemma]['derivatives'].append({
                'word': word,
                'type': inflection_type
            })
            consolidated_count += 1
        else:
            # This word is a base form (lemma)
            if word not in lemmas:
                lemmas[word] = {'derivatives': [], 'count': 1}
            else:
                lemmas[word]['count'] = 1

    return lemmas, consolidated_count

def generate_report(all_words, lemmas, consolidated_count):
    """Generate consolidation report."""

    report = {
        'total_original_words': len(all_words),
        'total_lemmas': len(lemmas),
        'inflections_consolidated': consolidated_count,
        'estimated_reduction': len(all_words) - len(lemmas),
        'reduction_percentage': round(100 * (len(all_words) - len(lemmas)) / len(all_words), 1),
        'final_word_count': len(lemmas),
    }

    # Breakdown by inflection type
    type_counts = defaultdict(int)
    for lemma_data in lemmas.values():
        for deriv in lemma_data['derivatives']:
            type_counts[deriv['type']] += 1

    report['inflections_by_type'] = dict(sorted(type_counts.items(),
                                                key=lambda x: -x[1]))

    # Lemmas with the most derivatives
    lemmas_by_derivative_count = sorted(
        [(lemma, len(data['derivatives'])) for lemma, data in lemmas.items()],
        key=lambda x: -x[1]
    )

    report['top_lemmas_by_derivative_count'] = [
        {'lemma': lemma, 'derivative_count': count}
        for lemma, count in lemmas_by_derivative_count[:20]
    ]

    return report

def main():
    print("Loading full dictionary...")
    all_words = load_full_dictionary()
    print(f"Total words: {len(all_words)}")

    print("Loading consolidation map...")
    consolidation_map = load_consolidation_map()
    print(f"Consolidation rules: {len(consolidation_map)}")

    print("\nConsolidating dictionary...")
    lemmas, consolidated_count = consolidate_dictionary(all_words, consolidation_map)

    print(f"Consolidated {consolidated_count} inflections")
    print(f"Resulting lemmas: {len(lemmas)}")
    print(f"Reduction: {len(all_words) - len(lemmas)} words ({100 * (len(all_words) - len(lemmas)) / len(all_words):.1f}%)")

    # Generate report
    report = generate_report(all_words, lemmas, consolidated_count)

    # Save consolidated dictionary
    print("\nSaving consolidated dictionary...")
    consolidated_dict = {}
    for lemma, data in sorted(lemmas.items()):
        consolidated_dict[lemma] = {
            'derivatives': data['derivatives'],
            'derivative_count': len(data['derivatives'])
        }

    with open('consolidated_dictionary.json', 'w') as f:
        json.dump(consolidated_dict, f, indent=2)

    # Save report
    with open('consolidation_report.json', 'w') as f:
        json.dump(report, f, indent=2)

    print("\nConsolidation Report:")
    print(f"  Original words: {report['total_original_words']}")
    print(f"  Final lemmas: {report['final_word_count']}")
    print(f"  Inflections consolidated: {report['inflections_consolidated']}")
    print(f"  Word reduction: {report['estimated_reduction']} ({report['reduction_percentage']}%)")

    print(f"\nInflections by type:")
    for inflection_type in sorted(report['inflections_by_type'].keys(),
                                  key=lambda x: -report['inflections_by_type'][x])[:10]:
        count = report['inflections_by_type'][inflection_type]
        print(f"  {inflection_type}: {count}")

    print(f"\nTop lemmas by derivative count:")
    for item in report['top_lemmas_by_derivative_count'][:10]:
        print(f"  {item['lemma']}: {item['derivative_count']} derivatives")

    print(f"\nFiles saved:")
    print(f"  - consolidated_dictionary.json (full lemma + derivative structure)")
    print(f"  - consolidation_report.json (statistics and analysis)")

if __name__ == '__main__':
    main()
