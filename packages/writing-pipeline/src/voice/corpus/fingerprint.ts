// Voice corpus fingerprinting.
//
// Reads normalized corpus files from `voice-corpus/examples/` (optionally
// also `voice-corpus/calibration-shorts.md`), computes a distributional
// fingerprint and writes `voice-corpus/fingerprint-v1.json` for the
// voice-critic agent to consult.
//
// The fingerprint is intentionally simple/transparent: counts, means,
// std-devs, histograms, and category tallies. No ML, no embeddings. Every
// number you see here is reproducible from the corpus text with a stable
// regex or simple counter.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import { scoreSlop, type SlopScore } from '../anti-slop/slop-score.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LengthBucket = '1-5' | '6-10' | '11-20' | '21-40' | '41+';

export interface SentenceDistribution {
  sentence_count: number;
  mean_words_per_sentence: number;
  std_dev_words_per_sentence: number;
  length_histogram: { range: LengthBucket; count: number }[];
  shortest_sentence_words: number;
  longest_sentence_words: number;
}

export interface ParagraphDistribution {
  paragraph_count: number;
  mean_sentences_per_paragraph: number;
  std_dev_sentences_per_paragraph: number;
}

export interface DirectAddressStats {
  count: number;
  direct_address_per_1000_words: number;
}

export interface SelfInterruptionStats {
  parentheticals: number;
  em_dash_interruptions: number;
  mid_sentence_ellipses: number;
  parentheticals_per_1000_words: number;
  em_dash_interruptions_per_1000_words: number;
  mid_sentence_ellipses_per_1000_words: number;
}

export interface AussieMarkerStats {
  aussie_marker_count: number;
  aussie_markers_per_1000_words: number;
  matches: { marker: string; count: number }[];
}

export interface ProfanityStats {
  count: number;
  profanity_per_1000_words: number;
  per_post: number[];
}

export interface LargeNumberStats {
  large_number_count: number;
  large_numbers_per_1000_words: number;
}

export interface OpenerOrCloserCategory {
  category: string;
  count: number;
  examples: string[];
}

export interface TopContentWord {
  word: string;
  count: number;
}

export interface VoiceFingerprint {
  version: 1;
  generated_at: string;
  corpus_source: string;
  corpus_files: string[];
  total_words: number;
  total_posts: number;
  sentence_distribution: SentenceDistribution;
  paragraph_distribution: ParagraphDistribution;
  direct_address: DirectAddressStats;
  self_interruption: SelfInterruptionStats;
  aussie_markers: AussieMarkerStats;
  profanity: ProfanityStats;
  large_numbers: LargeNumberStats;
  opener_categories: OpenerOrCloserCategory[];
  closer_categories: OpenerOrCloserCategory[];
  top_content_words: TopContentWord[];
  corpus_slop_score: SlopScore;
}

export interface GenerateFingerprintOptions {
  includeShorts?: boolean;
  corpusSourceLabel?: string;
  /** Override the generated_at timestamp (useful for reproducible JSON output). */
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Text utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Strip YAML frontmatter (the leading `---\n...\n---\n` block) and the H1
 * title line, returning just the prose body for analysis.
 */
export function stripFrontmatterAndTitle(raw: string): string {
  let body = raw;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      body = body.slice(end + 4);
    }
  }
  // Eat any leading blank lines, then drop a leading H1 line if present.
  body = body.replace(/^\s*\n/, '');
  body = body.replace(/^#\s+[^\n]*\n+/, '');
  return body.trim();
}

/**
 * Count words. A "word" is a maximal run of letters, digits, apostrophes, and
 * hyphens. ASCII apostrophe and the Unicode curly apostrophe both count.
 */
export function countWords(text: string): number {
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g);
  return matches ? matches.length : 0;
}

/**
 * Split a body of text into paragraphs by blank-line boundaries. Empty
 * paragraphs are discarded.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// Common abbreviations that end in a period but do NOT terminate a sentence.
// All lowercased for matching.
const NON_TERMINAL_ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sr', 'jr', 'st', 'mt',
  'etc', 'vs', 'eg', 'ie', 'cf', 'al', 'inc', 'co', 'ltd',
  'no', 'vol', 'pp', 'pg',
  'p', 'c', // P. C. Wren style initials
]);

/**
 * Split a body of text into sentences. Handles common abbreviations
 * (Mr./Dr./etc./vs.) and decimal points (3.14) so they don't fire false
 * sentence boundaries. Terminators: `.`, `?`, `!`, `…`, plus any of those
 * followed by close-quote/paren.
 *
 * The algorithm is a single forward pass over the text rather than a regex
 * split — that lets us look at the character before a `.` (decimal? part of
 * an abbreviation?) without ugly lookbehind.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const chars = [...text];
  let buf = '';

  const isTerminator = (ch: string): boolean =>
    ch === '.' || ch === '?' || ch === '!' || ch === '\u2026';

  const isClosingQuoteOrBracket = (ch: string): boolean =>
    ch === '"' || ch === '\u201D' || ch === "'" || ch === '\u2019' ||
    ch === ')' || ch === ']' || ch === '}';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    buf += ch;

    if (!isTerminator(ch)) {
      continue;
    }

    // Greedily consume additional terminators or closing punctuation so a
    // multi-bang "Wait!!" stays one sentence.
    while (
      i + 1 < chars.length &&
      (isTerminator(chars[i + 1]!) || isClosingQuoteOrBracket(chars[i + 1]!))
    ) {
      buf += chars[++i]!;
    }

    // Decide whether this terminator ends a sentence.
    let breaksHere = true;

    if (ch === '.') {
      // Decimal: digit-dot-digit.
      const prev = chars[i - buf.length + buf.length - 2] ?? '';
      // Easier: look at the second-to-last char of `buf`.
      const before = buf.length >= 2 ? buf[buf.length - 2] : '';
      const next = chars[i + 1] ?? '';
      if (/\d/.test(before ?? '') && /\d/.test(next)) {
        breaksHere = false;
      } else {
        // Abbreviation check: pull the token immediately before the `.`.
        const tail = buf.slice(0, -1); // strip the terminator
        const tokenMatch = tail.match(/([A-Za-z]+)$/);
        if (tokenMatch) {
          const tok = tokenMatch[1]!.toLowerCase();
          if (NON_TERMINAL_ABBREVS.has(tok)) {
            breaksHere = false;
          } else if (tok.length === 1) {
            // Single-letter initial (e.g. "P. C. Wren") — treat as
            // non-terminal so we don't shatter initials across sentences.
            breaksHere = false;
          }
        }
        // suppress unused-var lint
        void prev;
      }
    }

    if (breaksHere) {
      // Consume trailing whitespace before emitting.
      while (i + 1 < chars.length && /\s/.test(chars[i + 1]!)) {
        i++;
      }
      const out = buf.trim();
      if (out.length > 0) sentences.push(out);
      buf = '';
    }
  }

  const tail = buf.trim();
  if (tail.length > 0) sentences.push(tail);

  return sentences;
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function bucketize(wordCount: number): LengthBucket {
  if (wordCount <= 5) return '1-5';
  if (wordCount <= 10) return '6-10';
  if (wordCount <= 20) return '11-20';
  if (wordCount <= 40) return '21-40';
  return '41+';
}

// ---------------------------------------------------------------------------
// Feature extractors
// ---------------------------------------------------------------------------

function computeSentenceDistribution(allBodies: string[]): SentenceDistribution {
  const allSentenceLengths: number[] = [];
  for (const body of allBodies) {
    for (const s of splitSentences(body)) {
      allSentenceLengths.push(countWords(s));
    }
  }
  const histogramOrder: LengthBucket[] = ['1-5', '6-10', '11-20', '21-40', '41+'];
  const counts: Record<LengthBucket, number> = {
    '1-5': 0, '6-10': 0, '11-20': 0, '21-40': 0, '41+': 0,
  };
  for (const len of allSentenceLengths) counts[bucketize(len)] += 1;

  return {
    sentence_count: allSentenceLengths.length,
    mean_words_per_sentence: round2(mean(allSentenceLengths)),
    std_dev_words_per_sentence: round2(stdDev(allSentenceLengths)),
    length_histogram: histogramOrder.map((range) => ({ range, count: counts[range] })),
    shortest_sentence_words: allSentenceLengths.length ? Math.min(...allSentenceLengths) : 0,
    longest_sentence_words: allSentenceLengths.length ? Math.max(...allSentenceLengths) : 0,
  };
}

function computeParagraphDistribution(allBodies: string[]): ParagraphDistribution {
  const paragraphSentenceCounts: number[] = [];
  for (const body of allBodies) {
    for (const para of splitParagraphs(body)) {
      paragraphSentenceCounts.push(splitSentences(para).length);
    }
  }
  return {
    paragraph_count: paragraphSentenceCounts.length,
    mean_sentences_per_paragraph: round2(mean(paragraphSentenceCounts)),
    std_dev_sentences_per_paragraph: round2(stdDev(paragraphSentenceCounts)),
  };
}

const DIRECT_ADDRESS_PATTERN = /\b(?:you|you're|you’re|you'd|you’d|your|yours|yourself)\b/gi;

function computeDirectAddress(concat: string, totalWords: number): DirectAddressStats {
  const matches = concat.match(DIRECT_ADDRESS_PATTERN);
  const count = matches ? matches.length : 0;
  return {
    count,
    direct_address_per_1000_words: round2(per1k(count, totalWords)),
  };
}

const PARENTHETICAL_PATTERN = /\([^)]{3,}\)/g;
const EM_DASH_PAIR_PATTERN = /\u2014[^\u2014]{3,}\u2014/g;
const MID_SENTENCE_ELLIPSIS_PATTERN = /\w\s*(?:\u2026|\.\.\.)\s*\w/g;

function computeSelfInterruption(concat: string, totalWords: number): SelfInterruptionStats {
  const parens = concat.match(PARENTHETICAL_PATTERN);
  const dashes = concat.match(EM_DASH_PAIR_PATTERN);
  const ellipses = concat.match(MID_SENTENCE_ELLIPSIS_PATTERN);
  const p = parens ? parens.length : 0;
  const d = dashes ? dashes.length : 0;
  const e = ellipses ? ellipses.length : 0;
  return {
    parentheticals: p,
    em_dash_interruptions: d,
    mid_sentence_ellipses: e,
    parentheticals_per_1000_words: round2(per1k(p, totalWords)),
    em_dash_interruptions_per_1000_words: round2(per1k(d, totalWords)),
    mid_sentence_ellipses_per_1000_words: round2(per1k(e, totalWords)),
  };
}

const AUSSIE_LEXICAL_MARKERS = [
  // Each entry is a regex source piece used in a single combined pattern below.
  // Word boundaries are added in the compiled regex.
  'arse', 'arsehole',
  'bloody', 'bloke',
  'mate', 'mates',
  'cheeky',
  'reckon',
  "G'day", 'Gday',
  'proper', 'properly',
  'cuppa',
  'telly',
  'whilst',
  'amongst',
  'dodgy',
  'stuffed',
];

// "-our" UK/AU spellings (we exclude bare "our" to avoid false positives).
const OUR_SPELLING_MARKERS = [
  'colour', 'colours', 'coloured', 'colouring', 'colourful',
  'favour', 'favours', 'favoured', 'favourite', 'favourable',
  'behaviour', 'behaviours', 'behavioural',
  'flavour', 'flavours', 'flavoured', 'flavourful',
  'honour', 'honours', 'honoured', 'honourable',
  'neighbour', 'neighbours', 'neighbouring',
  'rumour', 'rumours', 'rumoured',
  'humour', 'humoured', 'humourless',
  'labour', 'labours', 'laboured',
];

function buildAussiePattern(): RegExp {
  const all = [...AUSSIE_LEXICAL_MARKERS, ...OUR_SPELLING_MARKERS];
  // Escape apostrophes/spaces by joining; \b is good enough since none contain
  // special regex chars beyond the apostrophe in G'day.
  const escaped = all.map((m) => m.replace(/'/g, "['\u2019]"));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

function computeAussieMarkers(concat: string, totalWords: number): AussieMarkerStats {
  const pattern = buildAussiePattern();
  const matches = concat.match(pattern) || [];
  const tally = new Map<string, number>();
  for (const raw of matches) {
    const key = raw.toLowerCase();
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const sortedMatches = [...tally.entries()]
    .map(([marker, count]) => ({ marker, count }))
    .sort((a, b) => b.count - a.count);
  return {
    aussie_marker_count: matches.length,
    aussie_markers_per_1000_words: round2(per1k(matches.length, totalWords)),
    matches: sortedMatches,
  };
}

const PROFANITY_PATTERN = /\b(?:fuck(?:ing|ed|er|s)?|shit(?:ty|s|ting)?|arse(?:hole|holes)?|bullshit|bastard(?:s)?|piss(?:ed|ing)?|damn(?:ed|it)?|hell)\b/gi;

function computeProfanity(perPostBodies: string[], totalWords: number): ProfanityStats {
  const perPost: number[] = [];
  let total = 0;
  for (const body of perPostBodies) {
    const m = body.match(PROFANITY_PATTERN);
    const c = m ? m.length : 0;
    perPost.push(c);
    total += c;
  }
  return {
    count: total,
    profanity_per_1000_words: round2(per1k(total, totalWords)),
    per_post: perPost,
  };
}

const LARGE_NUMBER_PATTERN = /\b\d{2,}\b/g;

function computeLargeNumbers(concat: string, totalWords: number): LargeNumberStats {
  const m = concat.match(LARGE_NUMBER_PATTERN);
  const c = m ? m.length : 0;
  return {
    large_number_count: c,
    large_numbers_per_1000_words: round2(per1k(c, totalWords)),
  };
}

function categorizeOpenerOrCloser(sentence: string): string {
  const trimmed = sentence.trim();
  if (!trimmed) return 'other';
  // Strip a leading quote mark for classification purposes.
  const s = trimmed.replace(/^["'\u2018\u2019\u201C\u201D]+/, '');
  // First "word" including apostrophe-contractions (so "I've" matches whole).
  const firstWord = (s.match(/^[A-Za-z][A-Za-z'\u2019]*/) || [''])[0]!
    .toLowerCase()
    .replace(/\u2019/g, "'");

  // direct_address: starts with you/your/etc.
  if (/^you(?:'re|\u2019re|'d|\u2019d|r|rself|rs)?\b/i.test(s)) return 'direct_address';

  // first_person variants — crude past/present split via verb tense heuristic
  if (firstWord === 'i' || firstWord === "i'm" || firstWord === 'im' || firstWord === "i've" || firstWord === "i'll" || firstWord === "i'd") {
    const rest = s.slice(firstWord.length).trim();
    const verbMatch = rest.match(/^\W*(\w+)/);
    const verb = verbMatch ? verbMatch[1]!.toLowerCase() : '';
    // Past-tense heuristic: -ed ending (excluding common -ed adjectives is overkill at v1).
    if (/ed$/.test(verb) && verb.length > 3) return 'first_person_past';
    // Contraction forms i've / i'd typically signal past or present-perfect.
    if (firstWord === "i've" || firstWord === "i'd") return 'first_person_past';
    return 'first_person_present';
  }

  // concrete_observation: temporal/day-of-week openers first (these can also
  // shape-match the thesis pattern below, so they win on priority).
  if (/^(?:Friday|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday)\b/.test(s)) {
    return 'concrete_observation';
  }
  if (/^(?:When|While|After|Before|During|As|Today|Tomorrow|Yesterday)\b/.test(s)) {
    return 'concrete_observation';
  }

  // thesis: starts with an abstract noun + is/are. Must beat the short-frag
  // fallback below for cases like "Conditioning is everything." (3 words).
  if (/^[A-Z][a-z]+(?:\s+[a-z]+)?\s+(?:is|are|was|were)\b/.test(s)) {
    return 'thesis';
  }

  // Single-word or short fragment ending with terminator ("Sunshine!", "Friday.").
  const wordsInOpener = s.match(/\b\w+\b/g);
  if (wordsInOpener && wordsInOpener.length <= 3) {
    return 'concrete_observation';
  }

  return 'other';
}

function summarizeCategories(
  sentences: string[],
  categorize: (s: string) => string,
): OpenerOrCloserCategory[] {
  const grouped = new Map<string, string[]>();
  for (const s of sentences) {
    const cat = categorize(s);
    const bucket = grouped.get(cat) ?? [];
    bucket.push(s);
    grouped.set(cat, bucket);
  }
  return [...grouped.entries()]
    .map(([category, examples]) => ({
      category,
      count: examples.length,
      examples: examples.slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// Compact stop-word list. Not exhaustive but covers the high-frequency
// function-word noise so the "top content words" are actually content words.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'so', 'as', 'if', 'then', 'than', 'because',
  'the', 'this', 'that', 'these', 'those', 'there', 'here',
  'i', "i'm", 'im', "i've", "i'll", "i'd", 'me', 'my', 'mine', 'myself',
  'you', "you're", "you'd", "you've", 'your', 'yours', 'yourself',
  'he', "he's", 'him', 'his', 'himself',
  'she', "she's", 'her', 'hers', 'herself',
  'it', "it's", 'its', 'itself',
  'we', "we're", "we've", 'us', 'our', 'ours', 'ourselves',
  'they', "they're", "they've", 'them', 'their', 'theirs', 'themselves',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'up', 'down',
  'out', 'over', 'under', 'again', 'further', 'once', 'about', 'into', 'through',
  'before', 'after', 'above', 'below', 'between',
  'not', 'no', 'nor', 'only', 'just', 'very', 'too', 'also', 'still',
  'what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'when', 'where',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'own', 'same',
  's', 't', 'm', 're', 've', 'd', 'll', // contraction fragments
  'don', "don't", "doesn't", "didn't", "isn't", "wasn't", "weren't",
  "won't", "wouldn't", "shouldn't", "couldn't", "can't", "cannot",
  // generic verbs that aren't strong content signal
  'get', 'got', 'getting', 'go', 'went', 'going', 'gone',
  'one', 'two', 'three',
  'like', 'really', 'just', 'thing', 'things',
]);

// Crude lemmatization: lowercase, strip trailing `'s`, then strip `-ing`/`-ed`/`-s`
// if the resulting stem is still >=4 chars. Doesn't try to fix doubled
// consonants or vowel changes — that's a v2 problem.
function lemma(word: string): string {
  let w = word.toLowerCase();
  // strip possessive
  w = w.replace(/[\u2019']s$/, '');
  if (w.endsWith('ing') && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 4) w = w.slice(0, -1);
  return w;
}

function computeTopContentWords(concat: string, n: number = 100): TopContentWord[] {
  const tokens = concat.toLowerCase().match(/[a-z][a-z'\u2019-]{1,}/g) ?? [];
  const tally = new Map<string, number>();
  for (const tok of tokens) {
    if (STOP_WORDS.has(tok)) continue;
    const stem = lemma(tok);
    if (stem.length < 3) continue;
    if (STOP_WORDS.has(stem)) continue;
    tally.set(stem, (tally.get(stem) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function per1k(count: number, totalWords: number): number {
  if (totalWords === 0) return 0;
  return (count / totalWords) * 1000;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

function listCorpusFiles(corpusDir: string): string[] {
  const entries = readdirSync(corpusDir);
  return entries
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(corpusDir, f));
}

export function generateFingerprint(
  corpusDir: string,
  options: GenerateFingerprintOptions = {},
): VoiceFingerprint {
  const corpusFiles = listCorpusFiles(corpusDir);

  // Optionally fold in calibration-shorts.md, which lives one level up.
  if (options.includeShorts) {
    const shortsPath = join(corpusDir, '..', 'calibration-shorts.md');
    try {
      readFileSync(shortsPath, 'utf8'); // existence check
      corpusFiles.push(shortsPath);
    } catch {
      // calibration shorts not present — silently skip.
    }
  }

  const bodies: string[] = [];
  const openers: string[] = [];
  const closers: string[] = [];
  let totalWords = 0;

  for (const filePath of corpusFiles) {
    const raw = readFileSync(filePath, 'utf8');
    const body = stripFrontmatterAndTitle(raw);
    bodies.push(body);
    totalWords += countWords(body);
    const sentences = splitSentences(body);
    if (sentences.length > 0) {
      openers.push(sentences[0]!);
      closers.push(sentences[sentences.length - 1]!);
    }
  }

  const concat = bodies.join('\n\n');

  return {
    version: 1,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    corpus_source: options.corpusSourceLabel ?? 'tumblr-archive-2013-2014-sample',
    // Record just the basenames so the JSON is portable across checkouts.
    corpus_files: corpusFiles.map((p) => basename(p)),
    total_words: totalWords,
    total_posts: corpusFiles.length,
    sentence_distribution: computeSentenceDistribution(bodies),
    paragraph_distribution: computeParagraphDistribution(bodies),
    direct_address: computeDirectAddress(concat, totalWords),
    self_interruption: computeSelfInterruption(concat, totalWords),
    aussie_markers: computeAussieMarkers(concat, totalWords),
    profanity: computeProfanity(bodies, totalWords),
    large_numbers: computeLargeNumbers(concat, totalWords),
    opener_categories: summarizeCategories(openers, categorizeOpenerOrCloser),
    closer_categories: summarizeCategories(closers, categorizeOpenerOrCloser),
    top_content_words: computeTopContentWords(concat, 100),
    corpus_slop_score: scoreSlop(concat),
  };
}

export function writeFingerprintToFile(
  fingerprint: VoiceFingerprint,
  outputPath: string,
): void {
  writeFileSync(outputPath, JSON.stringify(fingerprint, null, 2) + '\n', 'utf8');
}

// Re-export the categorizer + extractors for the discrimination script,
// which needs to score arbitrary samples against the same yardstick.
export {
  categorizeOpenerOrCloser,
  computeAussieMarkers,
  computeDirectAddress,
  computeLargeNumbers,
  computeParagraphDistribution,
  computeProfanity,
  computeSelfInterruption,
  computeSentenceDistribution,
  computeTopContentWords,
};
