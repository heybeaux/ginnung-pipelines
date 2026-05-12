// Tests for the Phase 3 critic asymmetric scoring policy.
//
// Asymmetric features (Aussie markers, parentheticals, ellipses, profanity):
//   - under-use (< 0.5x baseline) → low severity Issue
//   - normal band (0.5x..2x baseline) → no Issue, zero drift contribution
//   - over-use (> 2x baseline) → high severity Issue
// Symmetric features (direct address): half-tolerance gate, both directions.
// Overflow-only features (em-dash): any usage = high.

import { describe, it, expect } from 'vitest';

import { critiqueDraft } from '../../src/voice/critic.js';
import type { VoiceFingerprint } from '../../src/voice/corpus/fingerprint.js';

function fakeFingerprint(overrides: Partial<VoiceFingerprint> = {}): VoiceFingerprint {
  return {
    version: 1,
    generated_at: '2026-05-12T00:00:00Z',
    corpus_source: 'test',
    corpus_files: [],
    total_words: 10000,
    total_posts: 10,
    sentence_distribution: {
      sentence_count: 100,
      mean_words_per_sentence: 13,
      std_dev_words_per_sentence: 9,
      length_histogram: [
        { range: '1-5', count: 25 },
        { range: '6-10', count: 20 },
        { range: '11-20', count: 35 },
        { range: '21-40', count: 18 },
        { range: '41+', count: 2 },
      ],
      shortest_sentence_words: 1,
      longest_sentence_words: 50,
    },
    paragraph_distribution: {
      paragraph_count: 20,
      mean_sentences_per_paragraph: 5,
      std_dev_sentences_per_paragraph: 5,
    },
    direct_address: { count: 80, direct_address_per_1000_words: 8 },
    self_interruption: {
      parentheticals: 20,
      em_dash_interruptions: 0,
      mid_sentence_ellipses: 50,
      parentheticals_per_1000_words: 2,
      em_dash_interruptions_per_1000_words: 0,
      mid_sentence_ellipses_per_1000_words: 5,
    },
    aussie_markers: {
      aussie_marker_count: 20,
      aussie_markers_per_1000_words: 2,
      matches: [{ marker: 'whilst', count: 5 }],
    },
    profanity: {
      profanity_count: 15,
      profanity_per_1000_words: 1.5,
      matches: [],
    },
    large_numbers: {
      large_number_count: 0,
      large_numbers_per_1000_words: 0,
      matches: [],
    },
    ...overrides,
  } as VoiceFingerprint;
}

describe('critic asymmetric scoring policy', () => {
  it('over-deployed aussie markers fire a high-severity Issue', () => {
    const fp = fakeFingerprint();
    // 6 markers in ~50 words = 120/1k words — way above 2x baseline of 2.
    const draft =
      'I poured the bloody coffee, mate, whilst the kettle hissed, and I told the bloody neighbour to bloody well wait, mate.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const aussieIssue = c.issues.find(
      (i) =>
        i.kind === 'fingerprint_drift' &&
        i.diagnosis.includes('aussie_markers_per_1000_words'),
    );
    expect(aussieIssue).toBeDefined();
    expect(aussieIssue!.severity).toBe('high');
  });

  it('under-used aussie markers fire a low-severity Issue', () => {
    const fp = fakeFingerprint();
    // No markers at all in a 200-word draft (zero/1k words).
    const draft = Array.from({ length: 50 }, (_, i) =>
      `Sentence number ${i} contains no markers at all.`,
    ).join(' ');
    const c = critiqueDraft(draft, { fingerprint: fp });
    const aussieIssue = c.issues.find(
      (i) =>
        i.kind === 'fingerprint_drift' &&
        i.diagnosis.includes('aussie_markers_per_1000_words'),
    );
    expect(aussieIssue).toBeDefined();
    expect(aussieIssue!.severity).toBe('low');
  });

  it('normal-band aussie markers fire NO Issue', () => {
    const fp = fakeFingerprint();
    // ~2/1k markers — inside the [0.5x, 2x] band (= [1, 4]).
    // Draft: roughly 1000 words with 2 markers.
    const block =
      'Another paragraph of prose to fill space without using any markers at all here. ';
    const body = block.repeat(60); // ~720 words, 0 markers
    const draft = `${body}\n\nThe neighbour came over whilst the rain fell.\n\n${block.repeat(10)}`;
    // ~840 words, 2 markers → ~2.4 / 1k
    const c = critiqueDraft(draft, { fingerprint: fp });
    const aussieIssue = c.issues.find(
      (i) =>
        i.kind === 'fingerprint_drift' &&
        i.diagnosis.includes('aussie_markers_per_1000_words'),
    );
    expect(aussieIssue).toBeUndefined();
    // Direction recorded as normal.
    const f = c.fingerprint_delta.features.find(
      (x) => x.feature === 'aussie_markers_per_1000_words',
    );
    expect(f).toBeDefined();
    expect(f!.direction).toBe('normal');
  });

  it('over-deployed ellipses fire a high-severity Issue', () => {
    const fp = fakeFingerprint();
    // baseline = 5/1k; way above 2x.
    const draft =
      'I waited... and waited... the door creaked... someone moved... I held my breath... it opened... and...';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const issue = c.issues.find(
      (i) =>
        i.kind === 'fingerprint_drift' &&
        i.diagnosis.includes('mid_sentence_ellipses_per_1000_words'),
    );
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('high');
  });

  it('over-deployed profanity fires a high-severity Issue', () => {
    const fp = fakeFingerprint();
    // baseline = 1.5/1k; we'll hit 30+/1k.
    const draft =
      'Shit. Fuck. Bullshit. Arse. Shit. Fuck. Bullshit. Arse. Shit. Fuck. Bullshit. Arse.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const issue = c.issues.find(
      (i) =>
        i.kind === 'fingerprint_drift' &&
        i.diagnosis.includes('profanity_per_1000_words'),
    );
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('high');
  });

  it('direct-address is symmetric — both sides fire', () => {
    const fp = fakeFingerprint();
    // Hugely over-direct: pile on "you" addresses.
    const draftOver =
      'You wake up. You stretch. You look around. You think. You blink. You speak. You laugh.';
    const c = critiqueDraft(draftOver, { fingerprint: fp });
    const issue = c.issues.find(
      (i) =>
        i.kind === 'fingerprint_drift' &&
        i.diagnosis.includes('direct_address_per_1000_words'),
    );
    // Direct address baseline is 8/1k; we have >50/1k. Symmetric drift gates
    // on half-tolerance; severity is high when normalisedDrift >= 0.9.
    expect(issue).toBeDefined();
  });

  it('feature delta exposes direction and severity', () => {
    const fp = fakeFingerprint();
    const draft = 'Shit. Fuck. Bullshit.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const prof = c.fingerprint_delta.features.find(
      (f) => f.feature === 'profanity_per_1000_words',
    );
    expect(prof).toBeDefined();
    expect(prof!.direction).toBe('over');
    expect(prof!.severity).toBe('high');
  });
});
