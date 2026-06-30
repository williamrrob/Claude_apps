#!/usr/bin/env node
/*
 * build-quiz-pool.js — vet a discovery pool for the vocabulary quiz.
 *
 * The quiz's "discovery" mode needs rare-but-real, preferably older/forgotten,
 * preferably short words. eras.json is too proper-noun-heavy (it ranks by how
 * sharply a word peaked in one quarter-century, which favors place/brand/person
 * names). So we build a dedicated pool here, filtered hard and inspectable, and
 * ship it as quiz-pool.json. The runtime just samples from it.
 *
 * Each entry: [word, era]  — era is the rounded usage *centroid* (0=1500s..20=2000s),
 * the center of mass of the word's Google-Books usage curve. We use the centroid,
 * not the argmax peak, because per-word normalization makes a single sparse early
 * blip look like a "peak" (e.g. velleity reads as 1550 by peak, ~1850 by centroid).
 * The runtime weights the draw toward earlier eras and shorter words.
 *
 * Selection per word:
 *   - real headword: lowercase a–z only, 4–14 chars (3-letter Google-Books data is
 *     too noisy), contains a vowel (drops initialisms like "xxy"), single token
 *   - quizzable primary sense: a real definition, not a "form/spelling of" pointer
 *   - NOT a proper noun: gazetteer, given name/surname, capital, any genus mention,
 *     ethnonym, language, brand/trade name, scripture/mythology, astronomical body
 *   - established, not OCR noise / neologism: usage nonzero in >= 6 buckets
 *   - older/forgotten band: usage centroid in eras 9–17 (~1725–1949) — old enough
 *     to be somewhat forgotten, recent enough that the corpus data is reliable
 *
 *   node scripts/build-quiz-pool.js            # build -> quiz-pool.json
 *   node scripts/build-quiz-pool.js --sample   # print 60 sampled words, no write
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), WORDS = path.join(ROOT, "words"), USAGE = path.join(ROOT, "usage");
const SAMPLE = process.argv.includes("--sample");
const NB = 21, CAP = 4000;

// ---- proper-noun / non-vocabulary gloss patterns ----
const GEO = /^(a |an |the )(city|town|township|village|hamlet|borough|suburb|port|seaport|commune|municipality|canton|oblast|krai|province|prefecture|governorate|county|island|isle|archipelago|peninsula|river|lake|mountain|volcano|gulf|bay|strait|cape)\b[^.]*\b(in|of|on|near|located|situated)\b/i;
const GEO2 = /^(a |an |the )?(geographical|geographic) (region|area|location|feature)\b/i;
const NAME = /^(a |an )?((male |female |unisex )?given name|surname|patronymic|nickname)\b/i;
const CAPITAL = /^(the )?((state |provincial )?capital (city )?of|largest city|chief town)\b/i;
const GENUS = /\bgenus\b/i;
const PEOPLE = /\bmember of (a |an |the )?[^.]*\b(people|peoples|tribe|nation|clan|dynasty)\b|\b(ethnic group|indigenous (people|peoples|group))\b/i;
// demonym: "a native/inhabitant of <CapitalizedPlace>" (spares "inhabitant of a borough")
const DEMO = /^(a |an )?(native|inhabitant|citizen|resident|person)( or (native|inhabitant|resident))? (of|from) (the )?[A-Z]/;
const LANG = /^(a |an |the )?([a-z]+ )?(language|dialect|languages|dialects)\b[^.]*\b(of|spoken|used)\b|\bdialects? of\b|^(a |an |the )[a-z]+ (language|dialect)\b/i;
const BRAND = /\b(trade ?name|trademark|brand ?name|proprietary name)\b/i;
// bare deity/mythology headwords ("god of the underworld") are still proper nouns to
// exclude; the FAMOUS_NAME allowance below is narrower — it only keeps *derived* words
// (quixotic, herculean) whose gloss merely mentions a famous name in passing
const LORE = /\b(apocryphal book|book of the bible|(greek|roman|norse|hindu|egyptian|celtic|slavic|aztec|christian|biblical|teutonic|germanic) (mytholog|deity|god)|mythological|\bdeity\b|\bgoddess\b|\bgod (of|and)\b|chief (deity|god)|worshipped|mythology)/i;
// well-known gods/goddesses and famous legendary/literary characters: keep words derived
// from these names — don't let the capitalized name alone trigger the proper-noun filter
const FAMOUS_NAME = /\b(Hercules|Herculean|Zeus|Apollo|Hermes|Athena|Aphrodite|Ares|Artemis|Demeter|Dionysus|Hades|Hera|Hestia|Poseidon|Cronus|Cronos|Uranus|Gaia|Atlas|Prometheus|Promethean|Pandora|Midas|Narcissus|Cassandra|Oedipus|Oedipal|Sisyphus|Sisyphean|Tantalus|Icarus|Daedalus|Theseus|Perseus|Medusa|Hydra|Sphinx|Pegasus|Minotaur|Chimera|Cyclops|Circe|Calypso|Penelope|Odysseus|Ulysses|Achilles|Ajax|Hector|Helen|Paris|Troy|Trojan|Cupid|Venus|Mars|Martial|Mercury|Mercurial|Jupiter|Jove|Jovial|Neptune|Pluto|Juno|Vulcan|Janus|Bacchus|Diana|Minerva|Saturn|Saturnine|Titan|Titanic|Olympian|Olympus|Styx|Stygian|Quixote|Quixotic|Frankenstein|Dracula|Sherlock|Scrooge|Faust|Faustian|Pyrrhus|Pyrrhic|Gordius|Gordian|Procrustes|Procrustean|Byron|Byronic|Machiavelli|Machiavellian)\b/;
const LANG2 = /\ban? (ancient|extinct|classical|dead|old|modern) [a-z]+ language\b|\b(language|dialect) of (ancient|the)\b/i;
const SKY = /^(a |an |the )(star|constellation|planet|moon|asteroid|comet|galaxy|nebula)\b|\b(brightest|bright|binary|double|variable) star\b|\bstar in (the )?[a-z]/i;
const ZODIAC = /\b(astrological sign|sign of the zodiac|zodiac sign)\b/i;
// biography: life-date ranges "(1802-1887)", "born in 1949", or "<profession> who ..."
const BIO = /\(\s*\d{3,4}\s*[-–—]\s*\d{0,4}\s*\)|\(\d{1,2}(st|nd|rd|th) century\b|\bborn (in |about |around |circa |c\.? ?)?\d{3,4}\b|\b(physicist|chemist|biologist|mathematician|philosopher|poet|painter|composer|explorer|general|emperor|empress|king|queen|pharaoh|president|statesman|theologian|educator|novelist|playwright|economist|astronomer|engineer|architect|sculptor|botanist|geologist|inventor|naturalist|reformer|saint|martyr|prophet|prizefighter|dictator|actress|actor|singer|musician|director|footballer|cricketer|boxer|rabbi) who\b/i;
// nationality / relational adjective pointing at a capitalized proper noun
const RELADJ = /^(of or (relating|pertaining) to|relating to|pertaining to|characteristic of)\b[^.]*\b[A-Z][a-z]/;
// broad gazetteer: a/an/the + place-type + a later capitalized proper name
const GEO_BROAD = /^(a |an |the )(ancient |former |historic )?(republic|country|nation|kingdom|empire|state|province|region|territory|county|city|town|village|island|river|mountain|lake|sea|commune|municipality|canton|oblast|dynasty|peninsula|archipelago|battle|war) \b[^.]*\b[A-Z][a-z]/;
// two or more capitalized content words (excluding sentence start) => proper-noun def
function caps2(g) {
  const m = g.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  const startsWithCap = /^[A-Z][a-z]{2,}/.test(g.trim());
  const rest = startsWithCap ? m.slice(1) : m.slice();  // ignore the sentence-initial capital
  const significant = rest.filter(w => !FAMOUS_NAME.test(w));
  return significant.length >= 2;
}
function proper(g) {
  return GEO.test(g) || GEO2.test(g) || GEO_BROAD.test(g) || NAME.test(g) || CAPITAL.test(g) ||
    GENUS.test(g) || PEOPLE.test(g) || DEMO.test(g) || LANG.test(g) || LANG2.test(g) || BRAND.test(g) ||
    LORE.test(g) || SKY.test(g) || ZODIAC.test(g) || BIO.test(g) || RELADJ.test(g) || caps2(g);
}
// "form/spelling of" pointer senses and inflections make useless questions
const POINTER = /^(form|plural|past|variant|alternative|synonym|misspelling|archaic|abbreviation|initialism|acronym|contraction) of\b/i;
const VARIANT = /^(a |an |the )?(alternative|alt\.?|variant|obsolete|archaic|dated|nonstandard|non-standard|standard|common|eye|rare|informal|formal|colloquial|chiefly [a-z]+|british|american|canadian|australian|scottish|irish|dialectal) ([a-z-]+ )?(spelling|spellings|form|pronunciation) of\b/i;
const INFL = /^(\([^)]*\)\s*)?(simple past|past tense|past participle|present participle|present tense|gerund|third[- ]person singular|plural form|comparative|superlative)\b/i;
// back-reference to an earlier sense of the same word ("a piece of ornamentation
// in this style" for rococo) is unintelligible without that other sense
const BACKREF = /\b(in|of|with|like|on|for|to) (this|that|the (same|aforementioned|above)) (style|kind|sense|manner|fashion|way|sort|type|form|context|regard)\b/i;
function quizzableGloss(g) {
  return g && g.length >= 8 && !POINTER.test(g) && !VARIANT.test(g) && !INFL.test(g) && !/wikipedia/i.test(g) && !BACKREF.test(g);
}
// strict, well-formed Roman numerals (lxvi, mcmxliv) — but not real words like "mid"
const ROMAN = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

// ---- load words ----
const QUIZ_BANNED_DOMAINS = /^(chemistry|biochemistry|alchemy)$/i;
const ACRONYM_ETYM_RE = /^(an? )?(acronym|initialism|abbreviation)( for| of)\b/i;
const gloss = {};
for (const f of fs.readdirSync(WORDS)) {
  if (!f.endsWith(".json")) continue;
  const sh = JSON.parse(fs.readFileSync(path.join(WORDS, f), "utf8"));
  for (const w of Object.keys(sh)) {
    const r = sh[w];
    if (!r || !r.d || !r.d[0] || !r.d[0].g) continue;
    if (r.e && ACRONYM_ETYM_RE.test(r.e)) continue;
    if (r.d[0].dom && QUIZ_BANNED_DOMAINS.test(r.d[0].dom)) continue;
    gloss[w] = r.d[0].g;
  }
}

// ---- scan usage, build pool ----
const ERA_LO = 9, ERA_HI = 17;   // ~1725–1949: old-ish but reliable corpus data
const NZ_MIN = 6, NZ_MAX = 18;   // breadth band: >=6 real (not OCR/neologism),
                                 // <=18 not ubiquitous (breadth ~ commonness)
const pool = [];
const stats = { seen: 0, badWord: 0, roman: 0, noGloss: 0, notQuizzable: 0, proper: 0, breadth: 0, outOfBand: 0, kept: 0 };
for (const f of fs.readdirSync(USAGE)) {
  if (!f.endsWith(".json")) continue;
  const sh = JSON.parse(fs.readFileSync(path.join(USAGE, f), "utf8"));
  for (const w of Object.keys(sh)) {
    stats.seen++;
    if (!/^[a-z]{4,14}$/.test(w) || !/[aeiouy]/.test(w)) { stats.badWord++; continue; }
    if (/(idae|aceae|inae|ales)$/.test(w)) { stats.badWord++; continue; } // taxonomic family/order
    if (ROMAN.test(w)) { stats.roman++; continue; }
    const g = gloss[w];
    if (!g) { stats.noGloss++; continue; }
    if (!quizzableGloss(g)) { stats.notQuizzable++; continue; }
    if (proper(g)) { stats.proper++; continue; }
    const a = sh[w];
    if (!a || a.length !== NB) continue;
    let nz = 0, sum = 0, wsum = 0;
    for (let i = 0; i < NB; i++) { if (a[i] > 0) nz++; sum += a[i]; wsum += i * a[i]; }
    if (nz < NZ_MIN || nz > NZ_MAX) { stats.breadth++; continue; }
    const centroid = sum > 0 ? wsum / sum : 0;        // center of mass, blip-robust
    const era = Math.round(centroid);
    if (era < ERA_LO || era > ERA_HI) { stats.outOfBand++; continue; }
    pool.push([w, era, centroid, nz]);
    stats.kept++;
  }
}

// score: earlier centroid (more forgotten), shorter, and rarer (lower breadth) all better
function score(e) {
  const [w, , centroid, nz] = e;
  return (17 - centroid) * 2 + (14 - w.length) * 1.6 + (18 - nz) * 1.2;
}
pool.sort((a, b) => score(b) - score(a));
const top = pool.slice(0, CAP).map(e => [e[0], e[1]]);

// curated multi-word idiom headwords: capitalized + spaced, so the lowercase single-token
// regex above never sees them, and they have no usage data to derive an era from —
// verified to exist with real glosses, added by hand with an estimated old-ish era
const IDIOMS = [
  "Achilles heel", "Achilles tendon", "Pandora's box", "Trojan horse", "Midas touch",
  "Cassandra complex", "Pyrrhic victory", "Gordian knot", "Faustian bargain",
  "Oedipus complex", "Freudian slip",
];
const IDIOM_ERA = 13; // ~1825-1849, mid-band estimate
for (const w of IDIOMS) {
  if (gloss[w]) top.push([w, IDIOM_ERA]);
}

if (SAMPLE) {
  console.log("stats:", JSON.stringify(stats));
  console.log("pool size:", pool.length, "-> capped:", top.length);
  // even sample across the capped pool
  const step = Math.max(1, Math.floor(top.length / 60));
  const samp = [];
  for (let i = 0; i < top.length && samp.length < 60; i += step) samp.push(top[i][0] + "·" + top[i][1]);
  console.log("\nsample (word·peakEra):\n" + samp.join(", "));
} else {
  fs.writeFileSync(path.join(ROOT, "quiz-pool.json"), JSON.stringify(top));
  console.log("stats:", JSON.stringify(stats));
  console.log("wrote quiz-pool.json:", top.length, "words");
}
