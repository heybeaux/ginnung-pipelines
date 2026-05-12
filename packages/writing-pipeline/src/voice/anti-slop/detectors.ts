// Anti-slop detectors.
//
// Each exported detector corresponds to a numbered pattern in `patterns.md`.
// Detectors are pure functions: same input, same Detection[] out. Spans are
// JavaScript string-index offsets (UTF-16 code units) — sufficient for the
// pipeline's use; consumers that need byte offsets must re-encode.
//
// Heuristics are intentionally permissive: false positives are cheap (the
// voice-critic agent reviews them) and false negatives let slop slip through.

export type PatternCategory =
  | 'significance'
  | 'notability'
  | 'participles'
  | 'promotional'
  | 'weasel-attribution'
  | 'outline-filler'
  | 'ai-vocabulary'
  | 'copula-avoidance'
  | 'negative-parallelism'
  | 'rule-of-three'
  | 'elegant-variation'
  | 'false-range'
  | 'em-dash-overuse'
  | 'boldface-overuse'
  | 'inline-header-list'
  | 'title-case-heading'
  | 'emoji'
  | 'curly-quotes'
  | 'chatbot-artifact'
  | 'knowledge-cutoff'
  | 'sycophancy'
  | 'filler-phrase'
  | 'hedging'
  | 'generic-conclusion';

export type Severity = 'high' | 'medium' | 'low';

export interface Detection {
  category: PatternCategory;
  severity: Severity;
  span: { start: number; end: number };
  matchedText: string;
  suggestion?: string;
}

export interface Detector {
  category: PatternCategory;
  detect: (text: string) => Detection[];
}

// --- helpers ----------------------------------------------------------------

/**
 * Run a regex against `text` and return every match as a Detection.
 * The regex MUST be global (`g`); we assert in dev to catch missing flag.
 */
function regexMatches(
  text: string,
  pattern: RegExp,
  category: PatternCategory,
  severity: Severity,
  suggestion?: string,
): Detection[] {
  if (!pattern.global) {
    throw new Error(`regexMatches: pattern for ${category} must be global`);
  }
  const out: Detection[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    out.push({
      category,
      severity,
      span: { start: m.index, end: m.index + m[0].length },
      matchedText: m[0],
      ...(suggestion ? { suggestion } : {}),
    });
    if (m[0].length === 0) pattern.lastIndex++; // guard against zero-width loops
  }
  return out;
}

/**
 * Build a regex that matches any phrase in `phrases` as a whole-word /
 * phrase-boundary match. Phrases may contain spaces, slashes, etc.
 */
function phraseRegex(phrases: readonly string[]): RegExp {
  const escaped = phrases.map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
  );
  // Use lookarounds so phrases like "rich" don't match inside "enriched".
  return new RegExp(`(?<![A-Za-z])(?:${escaped.join('|')})(?![A-Za-z])`, 'gi');
}

// --- 1. significance --------------------------------------------------------

const SIGNIFICANCE_PHRASES = [
  'stands as',
  'serves as',
  'testament',
  'pivotal',
  'underscores',
  'highlights its importance',
  'reflects broader',
  'symbolizing',
  'contributing to',
  'setting the stage',
  'evolving landscape',
  'key turning point',
  'marked a pivotal moment',
] as const;

const significanceDetector: Detector = {
  category: 'significance',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(SIGNIFICANCE_PHRASES),
      'significance',
      'medium',
      'cut the importance framing; state the concrete fact',
    ),
};

// --- 2. notability ----------------------------------------------------------

const NOTABILITY_PHRASES = [
  'independent coverage',
  'media outlets',
  'leading expert',
  'active social media presence',
  'widely discussed',
  'major publications',
  'industry circles',
] as const;

const notabilityDetector: Detector = {
  category: 'notability',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(NOTABILITY_PHRASES),
      'notability',
      'low',
      'replace with one specific source + year',
    ),
};

// --- 3. participles ---------------------------------------------------------

// Comma + lowercase -ing verb + (optional words) — heuristic for fake-depth
// participial phrases. We restrict to a watchlist of -ing words to reduce
// false positives; voice-critic gets the final say.
const PARTICIPLE_WORDS = [
  'highlighting',
  'emphasizing',
  'ensuring',
  'reflecting',
  'contributing',
  'fostering',
  'showcasing',
  'creating',
  'reinforcing',
  'enabling',
  'underscoring',
  'symbolizing',
  'illustrating',
  'demonstrating',
  'representing',
] as const;

const PARTICIPLE_REGEX = new RegExp(
  `,\\s+(?:${PARTICIPLE_WORDS.join('|')})\\b[^.]{0,120}`,
  'gi',
);

const participlesDetector: Detector = {
  category: 'participles',
  detect: (text) =>
    regexMatches(
      text,
      PARTICIPLE_REGEX,
      'participles',
      'medium',
      'drop the participial clause or turn it into a second sentence with a concrete subject',
    ),
};

// --- 4. promotional ---------------------------------------------------------

const PROMOTIONAL_PHRASES = [
  'vibrant',
  'rich',
  'breathtaking',
  'renowned',
  'nestled',
  'showcasing',
  'seamless',
  'intuitive',
  'powerful platform',
  'unlock',
  'unlock their full potential',
  'full potential',
  'cutting-edge',
  'state-of-the-art',
  'world-class',
  'best-in-class',
  'next-generation',
] as const;

const promotionalDetector: Detector = {
  category: 'promotional',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(PROMOTIONAL_PHRASES),
      'promotional',
      'medium',
      'replace marketing adjective with a specific behavior or measurement',
    ),
};

// --- 5. weasel-attribution --------------------------------------------------

const WEASEL_PHRASES = [
  'experts argue',
  'experts believe',
  'experts say',
  'some critics',
  'critics argue',
  'observers',
  'industry reports',
  'studies show',
  'research suggests',
  'many believe',
  'it is widely believed',
] as const;

const weaselDetector: Detector = {
  category: 'weasel-attribution',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(WEASEL_PHRASES),
      'weasel-attribution',
      'medium',
      'name the source: who, when, in what venue',
    ),
};

// --- 6. outline-filler ------------------------------------------------------

const OUTLINE_FILLER_PHRASES = [
  'challenges and future prospects',
  'challenges and opportunities',
  'despite its success',
  'faces challenges such as',
  'looking ahead',
  'going forward',
  'in conclusion',
  'in summary',
  'to summarize',
] as const;

const outlineFillerDetector: Detector = {
  category: 'outline-filler',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(OUTLINE_FILLER_PHRASES),
      'outline-filler',
      'low',
      'cut the section header or replace with a concrete observation',
    ),
};

// --- 7. ai-vocabulary -------------------------------------------------------

const AI_VOCAB_PHRASES = [
  'additionally',
  'moreover',
  'furthermore',
  'crucial role',
  'plays a crucial role',
  'plays a key role',
  'plays a significant role',
  'plays a pivotal role',
  'optimizing workflows',
  'in today',
  "in today's",
  'leverage',
  'leveraging',
  'utilize',
  'utilizing',
  'delve into',
  'delves into',
  'navigate the',
  'navigating the',
  'tapestry',
  'realm',
  'multifaceted',
  'paradigm shift',
  'holistic',
] as const;

const aiVocabDetector: Detector = {
  category: 'ai-vocabulary',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(AI_VOCAB_PHRASES),
      'ai-vocabulary',
      'medium',
      'use the plainest English word: "also" not "additionally", "use" not "leverage"',
    ),
};

// --- 8. copula-avoidance ----------------------------------------------------

const COPULA_REGEX =
  /\b(?:serves as|acts as|functions as|stands as|operates as)\b/gi;

const copulaDetector: Detector = {
  category: 'copula-avoidance',
  detect: (text) =>
    regexMatches(
      text,
      COPULA_REGEX,
      'copula-avoidance',
      'medium',
      'replace with "is" / "does" — copula avoidance reads as AI hedge',
    ),
};

// --- 9. negative-parallelism ------------------------------------------------

const NEG_PARALLEL_REGEX =
  /\bnot\s+(?:just|only|merely|simply)\b[^.?!]{0,80}?\bbut\s+(?:also|rather)\b/gi;

const negativeParallelismDetector: Detector = {
  category: 'negative-parallelism',
  detect: (text) =>
    regexMatches(
      text,
      NEG_PARALLEL_REGEX,
      'negative-parallelism',
      'medium',
      'state the second claim positively on its own',
    ),
};

// --- 10. rule-of-three ------------------------------------------------------

// Heuristic: "<item>, <item>, and <item>." right before sentence end.
// Items are 1–6 words each. Voice-critic decides whether the triple is
// genuinely earned or AI cadence.
const RULE_OF_THREE_REGEX =
  /\b([A-Za-z][A-Za-z\s-]{2,40}),\s+([A-Za-z][A-Za-z\s-]{2,40}),\s+and\s+([A-Za-z][A-Za-z\s-]{2,40})\./g;

const ruleOfThreeDetector: Detector = {
  category: 'rule-of-three',
  detect: (text) =>
    regexMatches(
      text,
      RULE_OF_THREE_REGEX,
      'rule-of-three',
      'low',
      'pick the two items that matter; let the third go',
    ),
};

// --- 11. elegant-variation (no-op v0) ---------------------------------------

// TODO: detecting elegant variation requires noun-coreference and synonym
// awareness. Skip for v0; export a no-op so the catalog count stays at 24
// and downstream consumers can rely on the slot being present.
const elegantVariationDetector: Detector = {
  category: 'elegant-variation',
  detect: (_text) => [],
};

// --- 12. false-range --------------------------------------------------------

const FALSE_RANGE_REGEX =
  /\b(?:everything from|ranging from|ranges from)\b[^.?!]{0,120}?\bto\b[^.?!]{0,80}?(?=[.,?!]|$)/gi;

const falseRangeDetector: Detector = {
  category: 'false-range',
  detect: (text) =>
    regexMatches(
      text,
      FALSE_RANGE_REGEX,
      'false-range',
      'low',
      'list two real examples instead of bracketing the whole space',
    ),
};

// --- 13. em-dash-overuse ----------------------------------------------------

const emDashOveruseDetector: Detector = {
  category: 'em-dash-overuse',
  detect: (text) => {
    const positions: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\u2014') positions.push(i);
    }
    if (positions.length === 0) return [];
    const density = positions.length / (text.length / 1000);
    if (density <= 4) return [];
    return positions.map((p) => ({
      category: 'em-dash-overuse' as const,
      severity: 'low' as const,
      span: { start: p, end: p + 1 },
      matchedText: '\u2014',
      suggestion:
        'use a comma, colon, or period; em-dash density is an AI tell',
    }));
  },
};

// --- 14. boldface-overuse ---------------------------------------------------

// Find every **...** run; if >3 fall within a 500-char window, flag the run.
const BOLD_REGEX = /\*\*([^*\n]+)\*\*/g;

const boldfaceOveruseDetector: Detector = {
  category: 'boldface-overuse',
  detect: (text) => {
    const runs: { start: number; end: number; matchedText: string }[] = [];
    BOLD_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BOLD_REGEX.exec(text)) !== null) {
      runs.push({
        start: m.index,
        end: m.index + m[0].length,
        matchedText: m[0],
      });
    }
    if (runs.length <= 3) return [];
    const out: Detection[] = [];
    const flagged = new Set<number>();
    for (let i = 0; i < runs.length; i++) {
      // count runs within 500 chars after this one's start
      let count = 1;
      const winStart = runs[i]!.start;
      for (let j = i + 1; j < runs.length; j++) {
        if (runs[j]!.start - winStart > 500) break;
        count++;
      }
      if (count > 3) {
        for (let j = i; j < runs.length && runs[j]!.start - winStart <= 500; j++) {
          flagged.add(j);
        }
      }
    }
    for (const idx of flagged) {
      const r = runs[idx]!;
      out.push({
        category: 'boldface-overuse',
        severity: 'low',
        span: { start: r.start, end: r.end },
        matchedText: r.matchedText,
        suggestion: 'drop the bolding; if everything is bold, nothing is',
      });
    }
    return out;
  },
};

// --- 15. inline-header-list -------------------------------------------------

// Markdown list items starting with `**Header**:` or `*Header:*`, followed by
// a body fragment on the same line.
const INLINE_HEADER_LIST_REGEX =
  /^(\s*[-*+]\s+)(?:\*\*([A-Z][A-Za-z0-9 -]{1,40})\*\*:|\*([A-Z][A-Za-z0-9 -]{1,40}):\*)\s+\S/gm;

const inlineHeaderListDetector: Detector = {
  category: 'inline-header-list',
  detect: (text) =>
    regexMatches(
      text,
      INLINE_HEADER_LIST_REGEX,
      'inline-header-list',
      'low',
      'turn the list into prose, or drop the bold header',
    ),
};

// --- 16. title-case-heading -------------------------------------------------

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'but',
  'or',
  'nor',
  'for',
  'so',
  'yet',
  'as',
  'at',
  'by',
  'in',
  'of',
  'on',
  'to',
  'up',
  'via',
  'with',
  'from',
  'into',
  'over',
  'per',
  'is',
  'be',
]);

const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*$/gm;

const titleCaseHeadingDetector: Detector = {
  category: 'title-case-heading',
  detect: (text) => {
    HEADING_REGEX.lastIndex = 0;
    const out: Detection[] = [];
    let m: RegExpExecArray | null;
    while ((m = HEADING_REGEX.exec(text)) !== null) {
      const heading = m[2] ?? '';
      const words = heading.split(/\s+/).filter((w) => w.length > 0);
      if (words.length < 3) continue; // single-word or two-word headings are fine
      const eligible = words.filter(
        (w) => !STOP_WORDS.has(w.toLowerCase()) && /[A-Za-z]/.test(w),
      );
      if (eligible.length === 0) continue;
      const titleCased = eligible.filter((w) => /^[A-Z]/.test(w));
      const ratio = titleCased.length / eligible.length;
      if (ratio > 0.5) {
        const headingStart = m.index + (m[1]?.length ?? 0) + 1;
        out.push({
          category: 'title-case-heading',
          severity: 'low',
          span: { start: headingStart, end: headingStart + heading.length },
          matchedText: heading,
          suggestion: 'use sentence case in headings',
        });
      }
    }
    return out;
  },
};

// --- 17. emoji --------------------------------------------------------------

// Unicode emoji ranges via `\p{Extended_Pictographic}`. Requires ES2018+ /u.
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

const emojiDetector: Detector = {
  category: 'emoji',
  detect: (text) =>
    regexMatches(text, EMOJI_REGEX, 'emoji', 'high', 'remove the emoji'),
};

// --- 18. curly-quotes -------------------------------------------------------

const CURLY_QUOTES_REGEX = /[\u2018\u2019\u201C\u201D]/g;

const curlyQuotesDetector: Detector = {
  category: 'curly-quotes',
  detect: (text) =>
    regexMatches(
      text,
      CURLY_QUOTES_REGEX,
      'curly-quotes',
      'high',
      'use straight quotes (\' and ")',
    ),
};

// --- 19. chatbot-artifact ---------------------------------------------------

const CHATBOT_ARTIFACT_PHRASES = [
  'here is a breakdown',
  'here is the breakdown',
  "here's a breakdown",
  "here's the breakdown",
  'let me know if you need',
  'let me know if you have',
  'hope this helps',
  'i hope this helps',
  'feel free to ask',
  "i'd be happy to",
  'i would be happy to',
  'as an ai',
  'as a language model',
  "i'll provide",
  'i will provide',
  "certainly! here",
  'sure! here',
] as const;

const chatbotArtifactDetector: Detector = {
  category: 'chatbot-artifact',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(CHATBOT_ARTIFACT_PHRASES),
      'chatbot-artifact',
      'high',
      'delete; chat artifacts have no place in a published essay',
    ),
};

// --- 20. knowledge-cutoff ---------------------------------------------------

const KNOWLEDGE_CUTOFF_PHRASES = [
  'while details are limited',
  'as of my last update',
  'as of my knowledge cutoff',
  'as of my last knowledge update',
  'i do not have information',
  'i do not have access to',
  'i am not able to browse',
  'appears to have been introduced recently',
  'recent developments suggest',
  'up to my knowledge cutoff',
] as const;

const knowledgeCutoffDetector: Detector = {
  category: 'knowledge-cutoff',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(KNOWLEDGE_CUTOFF_PHRASES),
      'knowledge-cutoff',
      'high',
      'fetch the actual date or remove the claim',
    ),
};

// --- 21. sycophancy ---------------------------------------------------------

const SYCOPHANCY_PHRASES = [
  'great point',
  'great question',
  'excellent point',
  'excellent question',
  'insightful observation',
  'really insightful',
  'thoughtful question',
  "what a great",
  'absolutely right',
  'you are absolutely right',
  "that's a fantastic",
  "you've raised an important",
] as const;

const sycophancyDetector: Detector = {
  category: 'sycophancy',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(SYCOPHANCY_PHRASES),
      'sycophancy',
      'high',
      'delete; sycophancy adds nothing and signals AI provenance',
    ),
};

// --- 22. filler-phrase ------------------------------------------------------

const FILLER_PHRASES = [
  'in order to',
  'has the ability to',
  'have the ability to',
  'in the event that',
  'at this point in time',
  'due to the fact that',
  'for the purpose of',
  'in spite of the fact that',
  'on a regular basis',
  'a number of',
  'a wide variety of',
  'a wide range of',
  'in terms of',
  'with respect to',
  'with regard to',
] as const;

const fillerPhraseDetector: Detector = {
  category: 'filler-phrase',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(FILLER_PHRASES),
      'filler-phrase',
      'low',
      'cut to a single verb: "to" not "in order to", "can" not "has the ability to"',
    ),
};

// --- 23. hedging ------------------------------------------------------------

// Stacked hedges (might + potentially, could possibly, may potentially, etc.)
// We also flag isolated "potentially" which is almost always slop.
const HEDGING_REGEX =
  /\b(?:might|may|could|would)\s+(?:potentially|possibly|perhaps|conceivably)\b|\bpotentially\b/gi;

const hedgingDetector: Detector = {
  category: 'hedging',
  detect: (text) =>
    regexMatches(
      text,
      HEDGING_REGEX,
      'hedging',
      'medium',
      'pick one hedge ("may") or drop hedging entirely',
    ),
};

// --- 24. generic-conclusion -------------------------------------------------

const GENERIC_CONCLUSION_PHRASES = [
  'overall,',
  'in conclusion,',
  'all in all,',
  'to wrap up',
  'to wrap things up',
  'the future looks promising',
  'the outlook is positive',
  'the future is bright',
  'only time will tell',
  'remains to be seen',
  'a step in the right direction',
] as const;

const genericConclusionDetector: Detector = {
  category: 'generic-conclusion',
  detect: (text) =>
    regexMatches(
      text,
      phraseRegex(GENERIC_CONCLUSION_PHRASES),
      'generic-conclusion',
      'high',
      'replace with the next concrete action or observation',
    ),
};

// --- registry ---------------------------------------------------------------

export const detectors: Detector[] = [
  significanceDetector,
  notabilityDetector,
  participlesDetector,
  promotionalDetector,
  weaselDetector,
  outlineFillerDetector,
  aiVocabDetector,
  copulaDetector,
  negativeParallelismDetector,
  ruleOfThreeDetector,
  elegantVariationDetector,
  falseRangeDetector,
  emDashOveruseDetector,
  boldfaceOveruseDetector,
  inlineHeaderListDetector,
  titleCaseHeadingDetector,
  emojiDetector,
  curlyQuotesDetector,
  chatbotArtifactDetector,
  knowledgeCutoffDetector,
  sycophancyDetector,
  fillerPhraseDetector,
  hedgingDetector,
  genericConclusionDetector,
];
