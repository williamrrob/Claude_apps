# Systematic issues found during review (drive category fixes)

These recur across many words; fix once at the engine/data level rather than
per word. Logged here as they're discovered so later sessions can batch them.

- **Plural / inflectional `-s` marked "unknown"** — `effects → ef·fect·s?`,
  `contents → con·tent·s?`, `resources`. The final `-s` (plural / 3rd person)
  isn't recognized as a suffix. Affects thousands. Needs a careful `-s` rule
  (avoid over-stripping non-plural `s`).
- **Missing common Latin/Greek roots** cause stray-letter mangling. Confirmed so
  far (added per-word via curated; promote to engine roots to generalize):
  `sid/sed` (sit), `sum` (take), `spons` (pledge), `prim` (first), `potent`
  (powerful), `offic` (duty), `abil` (able), `vis` (see), `son` (sound),
  `limit` (boundary).
- **Linking vowels mislabeled "unknown"** — e.g. `individual → in·di·vid·u·al?`
  (the `u`). A linker before a vowel-suffix should be a linker, not unknown.
- **MorphoLex alignment misses an epenthetic `i`** — `microbe + al → microbial`
  failed to align (handled via curated for now). Improve the aligner.
