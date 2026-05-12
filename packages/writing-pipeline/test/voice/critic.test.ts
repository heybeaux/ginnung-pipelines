// Tests for the deterministic voice critic.
//
// Coverage strategy:
//   1. Pure-function invariants — same input twice gives bit-identical output.
//   2. Issue shape — slop detectors produce `slop_pattern` issues with valid
//      line/col offsets.
//   3. Em-dash and rule-of-three patterns fire on synthetic samples.
//   4. Fingerprint drift produces `fingerprint_drift` issues only when the
//      observed feature crosses half-tolerance.
//   5. Score bounds — voice_match in [0,1].

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { critiqueDraft } from '../../src/voice/critic.js';
import type { VoiceFingerprint } from '../../src/voice/corpus/fingerprint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '../..');

function loadFingerprint(): VoiceFingerprint {
  return JSON.parse(
    readFileSync(
      join(PACKAGE_ROOT, 'voice-corpus', 'fingerprint-v1.json'),
      'utf8',
    ),
  ) as VoiceFingerprint;
}

describe('critiqueDraft', () => {
  it('is deterministic — same input gives identical output', () => {
    const fp = loadFingerprint();
    const draft = [
      'I rolled out of bed at 5am and put the kettle on.',
      '',
      'It was bloody freezing. The kind of cold that makes you swear at your own bedroom.',
      '',
      'Whilst the kettle boiled, I checked the weather. Sunny.',
      '',
      'Classic.',
    ].join('\n');
    const a = critiqueDraft(draft, { fingerprint: fp });
    const b = critiqueDraft(draft, { fingerprint: fp });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces voice_match in [0, 1]', () => {
    const fp = loadFingerprint();
    const draft = 'Just a short test sentence.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    expect(c.scores.voice_match).toBeGreaterThanOrEqual(0);
    expect(c.scores.voice_match).toBeLessThanOrEqual(1);
  });

  it('fires an em_dash_used issue when em-dashes appear', () => {
    const fp = loadFingerprint();
    const draft =
      'The dawn — soft and slow — broke over the city.\nThis sentence has another \u2014 right here.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const emDashIssues = c.issues.filter((i) => i.kind === 'em_dash_used');
    expect(emDashIssues.length).toBeGreaterThanOrEqual(2);
    // Issues have line/col anchors.
    for (const iss of emDashIssues) {
      expect(iss.location).toBeDefined();
      expect(iss.location!.line).toBeGreaterThanOrEqual(0);
      expect(iss.location!.column).toBeGreaterThanOrEqual(0);
      expect(iss.location!.excerpt).toBe('\u2014');
    }
  });

  it('flags rhythm_flat when sentences are too uniform', () => {
    const fp = loadFingerprint();
    // Eight sentences, all 8 words long. Std-dev should be 0.
    const draft = Array.from({ length: 8 }, (_, i) => `One two three four five six seven ${i}.`).join(
      ' ',
    );
    const c = critiqueDraft(draft, { fingerprint: fp });
    expect(c.issues.some((i) => i.kind === 'rhythm_flat')).toBe(true);
  });

  it('does NOT fire rhythm_flat on a draft with varied sentence lengths', () => {
    const fp = loadFingerprint();
    const draft = [
      'Yes.',
      'I rolled out of bed at 5am and put the kettle on, knowing the morning would be long.',
      'Cold.',
      'The kind of morning that makes you swear at your own bedroom and curse the heating bill, the landlord, and your own poor decision to live in a city that gets like this every year.',
      'I checked the weather app on my phone, which had been silent overnight, and read the forecast aloud to nobody in particular.',
      'Sunny.',
      'Classic.',
      'I made the coffee.',
    ].join(' ');
    const c = critiqueDraft(draft, { fingerprint: fp });
    expect(c.issues.some((i) => i.kind === 'rhythm_flat')).toBe(false);
  });

  it('flags voice_marker_missing when no Aussie markers appear in a long piece', () => {
    const fp = loadFingerprint();
    // ~600 words, no Aussie markers at all.
    const draft = Array.from({ length: 30 }, () =>
      'The dog walked to the door and waited for someone to open it. He did not bark. He looked patient.',
    ).join('\n\n');
    const c = critiqueDraft(draft, { fingerprint: fp });
    expect(c.issues.some((i) => i.kind === 'voice_marker_missing')).toBe(true);
  });

  it('does NOT flag voice_marker_missing on a piece with Aussie markers', () => {
    const fp = loadFingerprint();
    const draft = [
      'Whilst I waited at the bus stop, a mate of mine wandered up.',
      'He looked bloody freezing.',
      'I offered him a coffee.',
      'Cheers, he said.',
      'We sat in silence, watching the colour drain from the sky.',
    ].join(' ');
    const c = critiqueDraft(draft, { fingerprint: fp });
    expect(c.issues.some((i) => i.kind === 'voice_marker_missing')).toBe(false);
  });

  it('fires slop_pattern issues with valid line/col offsets', () => {
    const fp = loadFingerprint();
    const draft =
      'In a world where everything moves fast, leveraging robust solutions is critical.\n\nIt is worth noting that this matters.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const slopIssues = c.issues.filter((i) => i.kind === 'slop_pattern');
    expect(slopIssues.length).toBeGreaterThan(0);
    for (const iss of slopIssues) {
      expect(iss.location).toBeDefined();
      const loc = iss.location!;
      expect(loc.offset).toBeGreaterThanOrEqual(0);
      expect(loc.offset).toBeLessThan(c.bodyAnalysed.length);
      expect(loc.line).toBeGreaterThanOrEqual(0);
      expect(loc.column).toBeGreaterThanOrEqual(0);
    }
  });

  it('strips frontmatter before analysis', () => {
    const fp = loadFingerprint();
    const draft = '---\ntitle: Test\n---\n\n# Test\n\nA short body sentence.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    expect(c.bodyAnalysed).toBe('A short body sentence.');
  });

  it('sorts issues by severity then offset', () => {
    const fp = loadFingerprint();
    const draft =
      'In a world where everything is leveraged \u2014 and robust \u2014 it is worth noting that we delve.';
    const c = critiqueDraft(draft, { fingerprint: fp });
    const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < c.issues.length; i++) {
      const prev = c.issues[i - 1]!;
      const curr = c.issues[i]!;
      const r = sevRank[prev.severity]! - sevRank[curr.severity]!;
      expect(r).toBeLessThanOrEqual(0);
      if (r === 0) {
        const prevOff = prev.location?.offset ?? Number.MAX_SAFE_INTEGER;
        const currOff = curr.location?.offset ?? Number.MAX_SAFE_INTEGER;
        expect(prevOff).toBeLessThanOrEqual(currOff);
      }
    }
  });

  it('fingerprint_delta has expected feature names', () => {
    const fp = loadFingerprint();
    const c = critiqueDraft('Hi there. How are you doing today?', { fingerprint: fp });
    const featureNames = c.fingerprint_delta.features.map((f) => f.feature);
    expect(featureNames).toContain('mean_words_per_sentence');
    expect(featureNames).toContain('std_dev_words_per_sentence');
    expect(featureNames).toContain('em_dash_interruptions_per_1000_words');
    expect(featureNames).toContain('aussie_markers_per_1000_words');
  });
});
