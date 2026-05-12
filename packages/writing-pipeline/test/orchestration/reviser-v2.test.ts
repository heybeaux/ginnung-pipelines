// Reviser v2 tests — two-pass logic, cost ceiling, regression abort.

import { describe, it, expect, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviseDraftV2 } from '../../src/orchestration/reviser-v2.js';
import type { IdeaBrief } from '../../src/orchestration/types.js';
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

const idea: IdeaBrief = {
  id: '01HXTEST',
  title: 'Test',
  brief: 'A'.repeat(120),
  facts: ['Fact A'],
  anchors: [],
  forbidden: [],
};

function mockClient(responses: string[]) {
  const create = vi.fn();
  responses.forEach((r) =>
    create.mockResolvedValueOnce({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: r }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 15000,
      },
    }),
  );
  return { messages: { create }, _create: create };
}

const SLOPPY_DRAFT = [
  'In a world where everything moves fast, leveraging robust solutions is critical.',
  'It is worth noting that we must delve into a number of important details.',
  'Stands as a testament to our values.',
].join('\n\n');

const CLEAN_DRAFT = [
  'I rolled out of bed at 5am whilst the kettle hummed.',
  '',
  "The kettle clicked, the kitchen quieted, and I sat at the bench watching the sun come up over the neighbour's fence. You know that feeling when the day hasn't started yet?",
  '',
  'Classic.',
].join('\n');

describe('reviseDraftV2', () => {
  it('runs up to maxPasses passes when each accepts', async () => {
    const fp = loadFingerprint();
    const client = mockClient([CLEAN_DRAFT, CLEAN_DRAFT]);
    const sys: any = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
    const r = await reviseDraftV2(SLOPPY_DRAFT, {
      fingerprint: fp,
      system: sys,
      idea,
      client,
      maxPasses: 2,
      costCeilingUsd: 10,
    });
    expect(r.passes.length).toBeGreaterThanOrEqual(1);
    expect(r.passes[0]!.accepted).toBe(true);
    // final should be the last accepted draft (markers stripped).
    expect(r.final).not.toContain('[fact:');
  });

  it('aborts on voice_match regression', async () => {
    const fp = loadFingerprint();
    // Original draft: clean. Pass 1 mock returns a sloppy regression.
    const client = mockClient([SLOPPY_DRAFT, SLOPPY_DRAFT]);
    const sys: any = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
    const r = await reviseDraftV2(CLEAN_DRAFT, {
      fingerprint: fp,
      system: sys,
      idea,
      client,
      maxPasses: 2,
    });
    // Pass 1 should be recorded (rejected) and the loop should stop.
    expect(r.passes.length).toBeGreaterThanOrEqual(1);
    expect(r.passes[0]!.accepted).toBe(false);
    expect(['regression', 'cost_ceiling', 'pass_cap']).toContain(r.stopReason);
    // final should still be the original (cleanish) draft.
    expect(r.final).toContain('whilst');
  });

  it('aborts on cost ceiling', async () => {
    const fp = loadFingerprint();
    const client = mockClient([CLEAN_DRAFT, CLEAN_DRAFT]);
    const sys: any = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
    const r = await reviseDraftV2(SLOPPY_DRAFT, {
      fingerprint: fp,
      system: sys,
      idea,
      client,
      maxPasses: 5,
      costCeilingUsd: 0.0001, // absurdly low so any pass exceeds it
      estimateCost: () => 1, // each pass "costs" $1
    });
    // Exactly one pass should run before the loop aborts on cost.
    expect(r.passes).toHaveLength(1);
    expect(r.stopReason).toBe('cost_ceiling');
  });

  it('strips [fact:N] markers from final output', async () => {
    const fp = loadFingerprint();
    const draftWithMarkers =
      "I rolled out of bed at 5am whilst the kettle hummed. I run heybeaux [fact:0], my own shop.";
    const client = mockClient([draftWithMarkers]);
    const sys: any = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
    const r = await reviseDraftV2(SLOPPY_DRAFT, {
      fingerprint: fp,
      system: sys,
      idea,
      client,
      maxPasses: 1,
    });
    expect(r.final).not.toContain('[fact:');
    // finalWithMarkers should preserve them for the audit log.
    expect(r.finalWithMarkers).toContain('[fact:0]');
  });
});
