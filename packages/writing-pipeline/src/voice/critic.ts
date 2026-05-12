// Voice critic — Phase 2B.
//
// Deterministic, no-LLM. Given a draft and the corpus fingerprint baseline,
// returns a structured `Critique` with:
//   - slop_detections: every anti-slop pattern that fired, with span + suggestion
//   - fingerprint_delta: per-feature drift vs the corpus baseline
//   - issues: a normalised Issue[] feed (the load-bearing payload for the
//             reviser and for any future UI)
//   - scores: voice_match, slop_per_kilochar, total
//
// Same input → same output. No randomness, no API calls. Tested with vitest.

import {
  type AussieMarkerStats,
  type DirectAddressStats,
  type LargeNumberStats,
  type OpenerOrCloserCategory,
  type ParagraphDistribution,
  type ProfanityStats,
  type SelfInterruptionStats,
  type SentenceDistribution,
  type VoiceFingerprint,
  categorizeOpenerOrCloser,
  computeAussieMarkers,
  computeDirectAddress,
  computeLargeNumbers,
  computeParagraphDistribution,
  computeProfanity,
  computeSelfInterruption,
  computeSentenceDistribution,
  splitSentences,
  stripFrontmatterAndTitle,
  countWords,
} from './corpus/fingerprint.js';
import { scoreSlop, type SlopScore } from './anti-slop/slop-score.js';
import type { Detection } from './anti-slop/detectors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IssueKind =
  | 'slop_pattern'
  | 'fingerprint_drift'
  | 'voice_marker_missing'
  | 'rhythm_flat'
  | 'em_dash_used'
  | 'curly_quote_used';

export type IssueSeverity = 'high' | 'medium' | 'low';

export interface IssueLocation {
  /** 0-indexed line in the draft body (after frontmatter/title strip). */
  line: number;
  /** 0-indexed UTF-16 column. */
  column: number;
  /** Character offset into the stripped body. */
  offset: number;
  /** Optional length of the offending span. */
  length?: number;
  /** The matched text, if applicable. */
  excerpt?: string;
}

export interface Issue {
  /** Stable kind tag — what category of problem this is. */
  kind: IssueKind;
  /** Severity. Currently mirrors detector severity (or computed for drift). */
  severity: IssueSeverity;
  /** Optional pinpoint location. Drift issues may have no location. */
  location?: IssueLocation;
  /** Plain-text description of what's wrong. */
  diagnosis: string;
  /** Plain-text suggested action. */
  suggestion: string;
}

export interface FeatureDelta {
  feature: string;
  observed: number;
  baseline: number;
  /** observed minus baseline. Negative = below baseline, positive = above. */
  delta: number;
  /** abs(delta) / max(baseline, tolerance). 0 = perfect, 1 = off by a baseline. */
  normalisedDrift: number;
  /** 'under' (observed below baseline), 'over' (above), 'normal' (in band). */
  direction: 'under' | 'over' | 'normal';
  /** Severity assigned by the asymmetric scoring policy ('low' | 'medium' | 'high'). */
  severity: 'low' | 'medium' | 'high';
}

export interface FingerprintDelta {
  total_words: number;
  features: FeatureDelta[];
  /** Mean of per-feature `normalisedDrift`, clamped to [0, 1]. */
  meanDrift: number;
}

export interface CritiqueScores {
  /** 1 - clamp01(meanDrift). Higher is closer to the corpus baseline. */
  voice_match: number;
  /** Direct passthrough of SlopScore.perKilochar. */
  slop_per_kilochar: number;
  /** Direct passthrough of SlopScore.total. */
  slop_total: number;
}

export interface Critique {
  /** Draft body after frontmatter/title strip. The issues' offsets are into
   *  THIS string, not the raw input. */
  bodyAnalysed: string;
  slop: SlopScore;
  fingerprint_delta: FingerprintDelta;
  issues: Issue[];
  scores: CritiqueScores;
}

export interface CritiqueOptions {
  /** Override the corpus baseline. Default: load from voice-corpus/. */
  fingerprint: VoiceFingerprint;
  /** Per-feature drift tolerances used to normalise. Optional. */
  driftTolerances?: Partial<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Tolerances used to normalise the per-feature drift score. They reflect how
 * much variation the corpus itself shows post-to-post, so a single essay
 * outside ±1 tolerance is genuinely off-voice (not just noise).
 *
 * Each tolerance is in the natural units of the feature.
 */
const DEFAULT_DRIFT_TOLERANCES: Record<string, number> = {
  mean_words_per_sentence: 3,
  std_dev_words_per_sentence: 3,
  direct_address_per_1000_words: 3,
  parentheticals_per_1000_words: 1.5,
  mid_sentence_ellipses_per_1000_words: 2,
  em_dash_interruptions_per_1000_words: 0.5, // tight: corpus is zero
  aussie_markers_per_1000_words: 1,
  profanity_per_1000_words: 1.5,
  mean_sentences_per_paragraph: 2,
};

/**
 * Phase 3 asymmetric scoring policy.
 *
 * For markers / ellipses / profanity / parentheticals: under-use is a low-
 * severity flag ("feels slightly off"), over-use beyond 200% baseline is a
 * high-severity flag ("performance detected"), and 50%-200% is the normal
 * band where no Issue fires.
 *
 * Direct address remains symmetric: both under- and over-use are register-
 * breaking. Em-dash is overflow-only (corpus is zero, so any usage is over).
 *
 * Features absent from this map default to symmetric behaviour with the
 * existing half-tolerance gate.
 */
type AsymmetryPolicy = 'asymmetric' | 'symmetric' | 'overflow_only';

const FEATURE_ASYMMETRY: Record<string, AsymmetryPolicy> = {
  aussie_markers_per_1000_words: 'asymmetric',
  parentheticals_per_1000_words: 'asymmetric',
  mid_sentence_ellipses_per_1000_words: 'asymmetric',
  profanity_per_1000_words: 'asymmetric',
  direct_address_per_1000_words: 'symmetric',
  em_dash_interruptions_per_1000_words: 'overflow_only',
};

/**
 * For asymmetric features, the lower and upper multiples of the baseline that
 * bound the "normal" band. <50% of baseline = under-use; >200% = over-use.
 */
const ASYMMETRIC_UNDER_RATIO = 0.5;
const ASYMMETRIC_OVER_RATIO = 2.0;

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Critique a draft against the corpus fingerprint. Pure function.
 */
export function critiqueDraft(draft: string, opts: CritiqueOptions): Critique {
  const body = stripFrontmatterAndTitle(draft);
  // Build a concrete Record<string, number> — strip undefined overrides.
  const tolerances: Record<string, number> = { ...DEFAULT_DRIFT_TOLERANCES };
  if (opts.driftTolerances) {
    for (const [k, v] of Object.entries(opts.driftTolerances)) {
      if (typeof v === 'number') tolerances[k] = v;
    }
  }

  const slop = scoreSlop(body);
  const totalWords = countWords(body);

  const observedFeatures = computeObservedFeatures(body);

  const fingerprint_delta = buildFingerprintDelta(
    observedFeatures,
    opts.fingerprint,
    totalWords,
    tolerances,
  );

  const issues = buildIssues(body, slop, fingerprint_delta, observedFeatures);

  const voice_match = clamp01(1 - fingerprint_delta.meanDrift);

  return {
    bodyAnalysed: body,
    slop,
    fingerprint_delta,
    issues,
    scores: {
      voice_match: round3(voice_match),
      slop_per_kilochar: round3(slop.perKilochar),
      slop_total: slop.total,
    },
  };
}

// ---------------------------------------------------------------------------
// Observed feature extraction
// ---------------------------------------------------------------------------

interface ObservedFeatures {
  sentence_distribution: SentenceDistribution;
  paragraph_distribution: ParagraphDistribution;
  direct_address: DirectAddressStats;
  self_interruption: SelfInterruptionStats;
  aussie_markers: AussieMarkerStats;
  profanity: ProfanityStats;
  large_numbers: LargeNumberStats;
  opener_category: string;
  closer_category: string;
}

function computeObservedFeatures(body: string): ObservedFeatures {
  const totalWords = countWords(body);
  const sentences = splitSentences(body);
  const opener = sentences[0] ?? '';
  const closer = sentences[sentences.length - 1] ?? '';

  return {
    sentence_distribution: computeSentenceDistribution([body]),
    paragraph_distribution: computeParagraphDistribution([body]),
    direct_address: computeDirectAddress(body, totalWords),
    self_interruption: computeSelfInterruption(body, totalWords),
    aussie_markers: computeAussieMarkers(body, totalWords),
    profanity: computeProfanity([body], totalWords),
    large_numbers: computeLargeNumbers(body, totalWords),
    opener_category: categorizeOpenerOrCloser(opener),
    closer_category: categorizeOpenerOrCloser(closer),
  };
}

// ---------------------------------------------------------------------------
// Fingerprint delta
// ---------------------------------------------------------------------------

function buildFingerprintDelta(
  obs: ObservedFeatures,
  base: VoiceFingerprint,
  totalWords: number,
  tolerances: Record<string, number>,
): FingerprintDelta {
  const features: FeatureDelta[] = [];

  const pushFeature = (
    feature: string,
    observed: number,
    baseline: number,
  ) => {
    const delta = round3(observed - baseline);
    const tol = tolerances[feature] ?? Math.max(baseline, 1);
    const norm = clamp01(Math.abs(delta) / Math.max(tol, 0.0001));
    const { direction, severity } = classifyAsymmetry(
      feature,
      observed,
      baseline,
      norm,
    );
    features.push({
      feature,
      observed: round3(observed),
      baseline: round3(baseline),
      delta,
      normalisedDrift: round3(norm),
      direction,
      severity,
    });
  };

  pushFeature(
    'mean_words_per_sentence',
    obs.sentence_distribution.mean_words_per_sentence,
    base.sentence_distribution.mean_words_per_sentence,
  );
  pushFeature(
    'std_dev_words_per_sentence',
    obs.sentence_distribution.std_dev_words_per_sentence,
    base.sentence_distribution.std_dev_words_per_sentence,
  );
  pushFeature(
    'mean_sentences_per_paragraph',
    obs.paragraph_distribution.mean_sentences_per_paragraph,
    base.paragraph_distribution.mean_sentences_per_paragraph,
  );
  pushFeature(
    'direct_address_per_1000_words',
    obs.direct_address.direct_address_per_1000_words,
    base.direct_address.direct_address_per_1000_words,
  );
  pushFeature(
    'parentheticals_per_1000_words',
    obs.self_interruption.parentheticals_per_1000_words,
    base.self_interruption.parentheticals_per_1000_words,
  );
  pushFeature(
    'mid_sentence_ellipses_per_1000_words',
    obs.self_interruption.mid_sentence_ellipses_per_1000_words,
    base.self_interruption.mid_sentence_ellipses_per_1000_words,
  );
  pushFeature(
    'em_dash_interruptions_per_1000_words',
    obs.self_interruption.em_dash_interruptions_per_1000_words,
    base.self_interruption.em_dash_interruptions_per_1000_words,
  );
  pushFeature(
    'aussie_markers_per_1000_words',
    obs.aussie_markers.aussie_markers_per_1000_words,
    base.aussie_markers.aussie_markers_per_1000_words,
  );
  pushFeature(
    'profanity_per_1000_words',
    obs.profanity.profanity_per_1000_words,
    base.profanity.profanity_per_1000_words,
  );

  // meanDrift only counts features whose direction is not 'normal'. In the
  // asymmetric policy, a feature inside the [0.5x, 2x] band contributes zero
  // to drift — that's the whole point of "don't suppress, don't over-target".
  // Features still in 'normal' are kept in the array (so the report can show
  // them) but their drift contribution is zeroed.
  const driftContributions = features.map((f) =>
    f.direction === 'normal' ? 0 : f.normalisedDrift,
  );
  const meanDrift =
    features.length === 0
      ? 0
      : driftContributions.reduce((a, x) => a + x, 0) / features.length;

  return {
    total_words: totalWords,
    features,
    meanDrift: round3(clamp01(meanDrift)),
  };
}

/**
 * Apply the asymmetric scoring policy to a single feature.
 *
 * Returns the direction (under / over / normal) and the severity tag (low /
 * medium / high) that `buildIssues` uses to decide whether to emit an Issue.
 *
 * Policy summary:
 *   - 'asymmetric': over-use beyond 2x baseline = high; under-use below
 *     0.5x baseline = low; otherwise normal.
 *   - 'symmetric': either direction emits at half-tolerance (legacy
 *     behaviour); severity scales with normalisedDrift.
 *   - 'overflow_only': any observed > baseline triggers high severity.
 *   - default (no entry): same as 'symmetric'.
 */
function classifyAsymmetry(
  feature: string,
  observed: number,
  baseline: number,
  normalisedDrift: number,
): {
  direction: 'under' | 'over' | 'normal';
  severity: 'low' | 'medium' | 'high';
} {
  const policy = FEATURE_ASYMMETRY[feature] ?? 'symmetric';
  const direction: 'under' | 'over' | 'normal' =
    observed < baseline ? 'under' : observed > baseline ? 'over' : 'normal';

  if (policy === 'overflow_only') {
    if (observed <= baseline) {
      return { direction: 'normal', severity: 'low' };
    }
    return { direction: 'over', severity: 'high' };
  }

  if (policy === 'asymmetric') {
    // For asymmetric features, only fire if observed is OUTSIDE the
    // [0.5x, 2x] band around baseline. Baseline of zero is a special case
    // — any observed > 0 counts as over-use because there's no normal band.
    if (baseline === 0) {
      if (observed === 0) return { direction: 'normal', severity: 'low' };
      return { direction: 'over', severity: 'high' };
    }
    const ratio = observed / baseline;
    if (ratio < ASYMMETRIC_UNDER_RATIO) {
      return { direction: 'under', severity: 'low' };
    }
    if (ratio > ASYMMETRIC_OVER_RATIO) {
      return { direction: 'over', severity: 'high' };
    }
    return { direction: 'normal', severity: 'low' };
  }

  // Symmetric (default) — fire when normalisedDrift >= 0.5, severity scales
  // with normalisedDrift. Preserves the legacy behaviour for direct-address
  // and the sentence-shape features.
  if (normalisedDrift < 0.5) {
    return { direction: 'normal', severity: 'low' };
  }
  return {
    direction,
    severity: normalisedDrift >= 0.9 ? 'high' : 'medium',
  };
}

// ---------------------------------------------------------------------------
// Issue construction
// ---------------------------------------------------------------------------

function buildIssues(
  body: string,
  slop: SlopScore,
  delta: FingerprintDelta,
  obs: ObservedFeatures,
): Issue[] {
  const issues: Issue[] = [];

  // 1. Anti-slop detections → one Issue per detection.
  for (const det of slop.detections) {
    issues.push({
      kind: 'slop_pattern',
      severity: det.severity,
      location: locationFromOffset(body, det.span.start, det.span.end - det.span.start, det.matchedText),
      diagnosis: diagnosisForDetection(det),
      suggestion: det.suggestion ?? defaultSlopSuggestion(det),
    });
  }

  // 2. Em-dash usage gets a dedicated kind so the reviser can act on it
  //    even if the slop detector missed an unpaired dash.
  const emDashMatches = findAllOffsets(body, /\u2014/g);
  for (const offset of emDashMatches) {
    issues.push({
      kind: 'em_dash_used',
      severity: 'medium',
      location: locationFromOffset(body, offset, 1, '\u2014'),
      diagnosis: 'Em-dash detected. The corpus has zero em-dash interruptions.',
      suggestion: 'Replace with parentheses (...), an ellipsis ..., or a comma+conjunction.',
    });
  }

  // 3. Curly quotes / apostrophes — fingerprint expects ASCII output.
  const curlyMatches = findAllOffsets(body, /[\u2018\u2019\u201C\u201D]/g);
  if (curlyMatches.length >= 3) {
    // Only flag if there are enough to be a real stylistic pattern, not a
    // single edge case from a copy-pasted quote.
    issues.push({
      kind: 'curly_quote_used',
      severity: 'low',
      location: locationFromOffset(body, curlyMatches[0]!, 1, body[curlyMatches[0]!] ?? '"'),
      diagnosis: `Curly quote/apostrophe used ${curlyMatches.length} times. Corpus uses ASCII " and '.`,
      suggestion: 'Convert curly quotes/apostrophes to ASCII " and \'.',
    });
  }

  // 4. Per-feature fingerprint drift — gated by the asymmetric policy.
  //    Issue severity comes from FeatureDelta.severity (computed at classify
  //    time). Features in 'normal' direction get no Issue.
  for (const f of delta.features) {
    if (f.direction === 'normal') continue;
    issues.push({
      kind: 'fingerprint_drift',
      severity: f.severity,
      diagnosis: diagnosisForFeature(f),
      suggestion: suggestionForFeature(f),
    });
  }

  // 5. Voice-marker-missing: zero Aussie markers in a piece long enough that
  //    the corpus baseline says we should see some.
  const expectedMarkers = (obs.direct_address.direct_address_per_1000_words >= 0) // noop guard
    ? (delta.total_words / 1000) * 1.83
    : 0;
  if (obs.aussie_markers.aussie_marker_count === 0 && expectedMarkers >= 1) {
    issues.push({
      kind: 'voice_marker_missing',
      severity: 'medium',
      diagnosis: `Zero Australian-English markers found. The corpus uses ${expectedMarkers.toFixed(1)} markers for a piece of this length.`,
      suggestion: 'Spell -our (colour/favour/honour), -ise (recognise/realise), and let "whilst" / "mate" / "bloody" appear where they\'d be natural.',
    });
  }

  // 6. Flat rhythm: std-dev below 6 (corpus is ~9.3) almost always means the
  //    drafter produced same-length sentences in a row.
  if (obs.sentence_distribution.std_dev_words_per_sentence < 6
      && obs.sentence_distribution.sentence_count >= 8) {
    issues.push({
      kind: 'rhythm_flat',
      severity: 'medium',
      diagnosis: `Sentence-length std-dev is ${obs.sentence_distribution.std_dev_words_per_sentence} (corpus is ~9.3). Sentences are too uniform in length.`,
      suggestion: 'Break up the rhythm. Drop in a one-word or two-word sentence ("Classic." "Bonus."). Stretch one sentence out with a parenthetical aside.',
    });
  }

  // Sort issues for stable test output: high → medium → low, then by offset.
  const sevRank: Record<IssueSeverity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => {
    const r = sevRank[a.severity] - sevRank[b.severity];
    if (r !== 0) return r;
    const ao = a.location?.offset ?? Number.MAX_SAFE_INTEGER;
    const bo = b.location?.offset ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Diagnosis & suggestion strings
// ---------------------------------------------------------------------------

function diagnosisForDetection(d: Detection): string {
  return `Anti-slop pattern "${d.category}" fired on: "${truncate(d.matchedText, 80)}"`;
}

function defaultSlopSuggestion(d: Detection): string {
  return `Rewrite the "${d.category}" construction. See the don't-list in the system prompt for the family of patterns to avoid.`;
}

function diagnosisForFeature(f: FeatureDelta): string {
  const direction = f.delta > 0 ? 'above' : 'below';
  return `${f.feature} is ${Math.abs(f.delta)} ${direction} corpus baseline (observed ${f.observed}, baseline ${f.baseline}).`;
}

function suggestionForFeature(f: FeatureDelta): string {
  switch (f.feature) {
    case 'mean_words_per_sentence':
      return f.delta > 0
        ? 'Shorten. Break long sentences into two or three. Add a one-word sentence.'
        : 'Stretch one or two sentences out. Add an aside in parens.';
    case 'std_dev_words_per_sentence':
      return f.delta < 0
        ? 'Vary sentence length aggressively. Mix one-word punches with long, comma-rich sentences.'
        : 'Tighten the runaway long sentences a touch.';
    case 'direct_address_per_1000_words':
      return f.delta < 0
        ? 'Talk to the reader. "You know that feeling when..." / "Picture this:"'
        : 'Pull back on direct address; not every paragraph needs to address the reader.';
    case 'parentheticals_per_1000_words':
      return f.delta < 0
        ? 'Add a parenthetical aside or two — they\'re part of the voice.'
        : 'Trim asides; the piece is starting to feel like a footnote sequence.';
    case 'mid_sentence_ellipses_per_1000_words':
      return f.delta < 0
        ? 'Use a mid-sentence ellipsis where you want a beat or a trailing-off.'
        : 'Trim ellipses; not every sentence needs to drift off.';
    case 'em_dash_interruptions_per_1000_words':
      return 'Replace em-dash pairs with parentheses, ellipses, or comma+conjunction. Corpus has zero em-dash interruptions.';
    case 'aussie_markers_per_1000_words':
      return f.delta < 0
        ? 'Use Australian/British spellings (colour, favour, recognise) and let "whilst" / "mate" / "bloody" appear naturally.'
        : 'You\'re piling on Aussie markers; one or two per paragraph is plenty.';
    case 'profanity_per_1000_words':
      return f.delta < 0
        ? 'Mild profanity is welcome where it fits — "shit" / "fuck" / "arse" used for emphasis.'
        : 'Cool the swearing; corpus is sparing.';
    case 'mean_sentences_per_paragraph':
      return f.delta > 0
        ? 'Break paragraphs more often. The voice uses paragraph breaks for emphasis.'
        : 'Consolidate. Some paragraphs may be single sentences but most aren\'t.';
    default:
      return 'Bring closer to corpus baseline.';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function locationFromOffset(
  body: string,
  offset: number,
  length: number,
  excerpt: string,
): IssueLocation {
  // Compute line + column by walking newlines up to `offset`.
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < body.length; i++) {
    if (body[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  const column = offset - (lastNewline + 1);
  return {
    line,
    column,
    offset,
    length,
    excerpt: truncate(excerpt, 120),
  };
}

function findAllOffsets(body: string, pattern: RegExp): number[] {
  if (!pattern.global) throw new Error('findAllOffsets: pattern must be global');
  const out: number[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    out.push(m.index);
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export {
  // Re-export `OpenerOrCloserCategory` so callers don't have to reach into corpus/.
  type OpenerOrCloserCategory,
};
