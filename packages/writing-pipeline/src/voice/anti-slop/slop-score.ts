// Aggregate slop scoring over a piece of text.
//
// Runs every detector, collects every Detection, and produces a single
// `SlopScore`. Weighting: high = 3, medium = 2, low = 1. The total is the
// summed weight; `perKilochar` normalizes for length so a 5-paragraph essay
// is directly comparable to a 50-paragraph one.

import {
  detectors,
  type Detection,
  type PatternCategory,
} from './detectors.js';

export interface SlopScore {
  total: number;
  byCategory: Record<PatternCategory, number>;
  detections: Detection[];
  textLength: number;
  perKilochar: number;
}

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

function emptyByCategory(): Record<PatternCategory, number> {
  return {
    significance: 0,
    notability: 0,
    participles: 0,
    promotional: 0,
    'weasel-attribution': 0,
    'outline-filler': 0,
    'ai-vocabulary': 0,
    'copula-avoidance': 0,
    'negative-parallelism': 0,
    'rule-of-three': 0,
    'elegant-variation': 0,
    'false-range': 0,
    'em-dash-overuse': 0,
    'boldface-overuse': 0,
    'inline-header-list': 0,
    'title-case-heading': 0,
    emoji: 0,
    'curly-quotes': 0,
    'chatbot-artifact': 0,
    'knowledge-cutoff': 0,
    sycophancy: 0,
    'filler-phrase': 0,
    hedging: 0,
    'generic-conclusion': 0,
  };
}

export function scoreSlop(text: string): SlopScore {
  const detections: Detection[] = [];
  const byCategory = emptyByCategory();
  let total = 0;

  for (const detector of detectors) {
    const found = detector.detect(text);
    for (const d of found) {
      detections.push(d);
      byCategory[d.category] += 1;
      total += SEVERITY_WEIGHT[d.severity];
    }
  }

  // Sort by start offset so consumers see detections in document order.
  detections.sort((a, b) => a.span.start - b.span.start);

  const textLength = text.length;
  const perKilochar = textLength === 0 ? 0 : total / (textLength / 1000);

  return {
    total,
    byCategory,
    detections,
    textLength,
    perKilochar,
  };
}
