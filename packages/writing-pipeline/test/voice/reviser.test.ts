// Tests for the reviser — SDK mocked, no network.
//
// Covers:
//   - accepted vs reverted path based on composite score delta
//   - the cached system prefix is passed straight through
//   - renderIssueChecklist produces deterministic strings
//   - compositeScore math

import { describe, it, expect, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reviseDraft,
  renderIssueChecklist,
  compositeScore,
} from '../../src/voice/reviser.js';
import { critiqueDraft } from '../../src/voice/critic.js';
import { buildDrafterSystemPrompt, DRAFTER_EXEMPLAR_FILES } from '../../src/voice/drafter.js';
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

function loadExemplars(): { file: string; body: string }[] {
  return DRAFTER_EXEMPLAR_FILES.map((file) => ({
    file,
    body: readFileSync(join(PACKAGE_ROOT, 'voice-corpus', 'examples', file), 'utf8'),
  }));
}

function mockClient(responseText: string) {
  const create = vi.fn().mockResolvedValue({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text: responseText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 200,
      output_tokens: 400,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 15000,
    },
  });
  return {
    messages: { create },
    _create: create,
  } as const;
}

describe('renderIssueChecklist', () => {
  it('returns a no-op message when issues is empty', () => {
    const out = renderIssueChecklist([]);
    expect(out).toMatch(/No anti-slop/i);
  });

  it('renders located and global issues in separate sections', () => {
    const out = renderIssueChecklist([
      {
        kind: 'slop_pattern',
        severity: 'high',
        location: { line: 0, column: 4, offset: 4, length: 5, excerpt: 'delve' },
        diagnosis: 'Used "delve".',
        suggestion: 'Rewrite without "delve".',
      },
      {
        kind: 'fingerprint_drift',
        severity: 'medium',
        diagnosis: 'mean_words_per_sentence is 5 below baseline.',
        suggestion: 'Stretch some sentences out.',
      },
    ]);
    expect(out).toContain('Specific line-level issues');
    expect(out).toContain('Whole-piece drift');
    expect(out).toContain('line 1, col 5');
    expect(out).toContain('delve');
    expect(out).toContain('fingerprint_drift');
  });

  it('is deterministic for the same issue list', () => {
    const issues = [
      {
        kind: 'em_dash_used' as const,
        severity: 'medium' as const,
        location: { line: 2, column: 10, offset: 50, length: 1, excerpt: '\u2014' },
        diagnosis: 'em-dash detected',
        suggestion: 'replace with parens',
      },
    ];
    const a = renderIssueChecklist(issues);
    const b = renderIssueChecklist(issues);
    expect(a).toBe(b);
  });
});

describe('compositeScore', () => {
  it('combines voice_match and slop_per_kilochar', () => {
    const fp = loadFingerprint();
    const c = critiqueDraft('Just a short test sentence.', { fingerprint: fp });
    const composite = compositeScore(c);
    expect(composite).toBeCloseTo(
      c.scores.voice_match - c.scores.slop_per_kilochar / 10,
      4,
    );
  });
});

describe('reviseDraft', () => {
  it('accepts a revision when the composite score improves', async () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);

    // Original draft: full of slop.
    const badDraft = [
      'In a world where everything moves fast, leveraging robust solutions is critical.',
      '',
      'It is worth noting that we must delve into a number of important details.',
      '',
      'Stands as a testament to our values. It is important to recognise this.',
    ].join('\n');

    // Mocked revision: clean voice-y prose.
    const goodResponse = [
      'I rolled out of bed at 5am, whilst the rest of the house was still asleep.',
      '',
      'The kettle was already on. Bloody freezing morning.',
      '',
      'Classic.',
      '',
      "I made the coffee and sat at the bench, watching the sun come up over the neighbour's fence. You know that feeling when the day hasn't started yet and you've already had a small win? That.",
    ].join('\n');

    const client = mockClient(goodResponse);
    const result = await reviseDraft(badDraft, {
      idea: 'morning coffee',
      fingerprint: fp,
      system: sys,
      client,
    });
    expect(result.accepted).toBe(true);
    expect(result.finalDraft).toBe(goodResponse);
    expect(result.scoreDelta).toBeGreaterThan(0);
    expect(result.decisionNote).toMatch(/Accepted/);
  });

  it('reverts to the original when the revision regresses', async () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);

    // Original draft: reasonably clean.
    const okDraft = [
      'I rolled out of bed at 5am whilst the kettle warmed up.',
      '',
      "It was bloody cold. The kind of cold that makes you swear at your own bedroom. Whilst I checked the weather, the colour drained out of the sky.",
      '',
      'Classic.',
    ].join('\n');

    // Mocked "revision": worse, full of slop.
    const worseResponse =
      'In a world where mornings move fast, leveraging robust caffeine solutions \u2014 like coffee \u2014 stands as a testament to our resilience. It is worth noting that we delve into this every day.';

    const client = mockClient(worseResponse);
    const result = await reviseDraft(okDraft, {
      idea: 'morning',
      fingerprint: fp,
      system: sys,
      client,
    });
    expect(result.accepted).toBe(false);
    // finalDraft should match the analysed body of the original (which is the
    // post-strip body, not the raw input — they're equivalent here since
    // there's no frontmatter).
    expect(result.finalDraft).toContain('whilst the kettle');
    expect(result.scoreDelta).toBeLessThan(0);
    expect(result.decisionNote).toMatch(/Reverted/);
  });

  it('passes the cached system prefix straight through to the SDK', async () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);

    const client = mockClient('Some revision text.');
    await reviseDraft('Some draft.', {
      idea: 'x',
      fingerprint: fp,
      system: sys,
      client,
    });

    const callArgs = client._create.mock.calls[0]![0];
    expect(callArgs.system).toBe(sys);
    // Both blocks must still be marked ephemeral after passthrough.
    expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(callArgs.system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('throws when neither system nor exemplars are provided', async () => {
    const fp = loadFingerprint();
    const client = mockClient('x');
    await expect(
      reviseDraft('draft', {
        idea: 'x',
        fingerprint: fp,
        client,
      }),
    ).rejects.toThrow(/system.*exemplars/i);
  });

  it('throws on empty draft', async () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);
    const client = mockClient('x');
    await expect(
      reviseDraft('', { idea: 'x', fingerprint: fp, system: sys, client }),
    ).rejects.toThrow(/non-empty/);
  });
});
