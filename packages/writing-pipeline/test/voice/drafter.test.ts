// Tests for the drafter — SDK is mocked, no network calls.

import { describe, it, expect, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  draftEssay,
  buildDrafterSystemPrompt,
  DRAFTER_EXEMPLAR_FILES,
} from '../../src/voice/drafter.js';
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
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 15000,
      cache_read_input_tokens: 0,
    },
  });
  return {
    messages: { create },
    _create: create,
  } as const;
}

describe('buildDrafterSystemPrompt', () => {
  it('produces two text blocks, both marked cache_control: ephemeral', () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);
    expect(sys).toHaveLength(2);
    for (const block of sys) {
      expect(block.type).toBe('text');
      expect(block.cache_control).toEqual({ type: 'ephemeral' });
      expect(typeof block.text).toBe('string');
      expect(block.text.length).toBeGreaterThan(100);
    }
  });

  it('embeds the five exemplar file labels in the second block', () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);
    const exemplarBlock = sys[1]!.text;
    for (const file of DRAFTER_EXEMPLAR_FILES) {
      expect(exemplarBlock).toContain(file);
    }
  });

  it("includes the anti-slop don't-list in the identity block", () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);
    const identityBlock = sys[0]!.text;
    expect(identityBlock).toContain('DO NOT');
    expect(identityBlock).toContain('em-dash');
    expect(identityBlock).toContain('emoji');
    // Sanity: fingerprint numbers are interpolated.
    expect(identityBlock).toMatch(/per 1000 words/);
  });
});

describe('draftEssay', () => {
  it('calls the SDK with the supplied system prompt and idea', async () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);
    const client = mockClient('Drafted essay body.\n\nSecond paragraph.');
    const result = await draftEssay('test idea', { client, system: sys });
    expect(client._create).toHaveBeenCalledTimes(1);
    const args = client._create.mock.calls[0]![0];
    expect(args.model).toBe('claude-opus-4-6');
    expect(args.system).toBe(sys);
    expect(args.messages[0].role).toBe('user');
    expect(args.messages[0].content[0].text).toContain('test idea');
    expect(result.draft).toBe('Drafted essay body.\n\nSecond paragraph.');
  });

  it('extracts cache usage from the response', async () => {
    const fp = loadFingerprint();
    const ex = loadExemplars();
    const sys = buildDrafterSystemPrompt(fp, ex);
    const client = mockClient('Body.');
    const result = await draftEssay('idea', { client, system: sys });
    expect(result.usage.cache_creation_input_tokens).toBe(15000);
    expect(result.usage.cache_read_input_tokens).toBe(0);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(200);
  });

  it('throws on empty idea', async () => {
    const client = mockClient('x');
    await expect(draftEssay('', { client, system: [] })).rejects.toThrow(
      /non-empty/,
    );
    await expect(draftEssay('   ', { client, system: [] })).rejects.toThrow(
      /non-empty/,
    );
  });

  it('throws when ANTHROPIC_API_KEY is unset and no client is provided', async () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      await expect(draftEssay('idea')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (orig !== undefined) process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });
});
