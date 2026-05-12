// Drafter v2 tests — SDK mocked, no network.

import { describe, it, expect, vi } from 'vitest';

import {
  draftEssayV2,
  buildDraftV2UserMessage,
} from '../../src/orchestration/drafter-v2.js';
import type { IdeaBrief, Outline } from '../../src/orchestration/types.js';

const idea: IdeaBrief = {
  id: '01HXTEST',
  title: 'Lattice 400',
  brief: 'A'.repeat(120),
  facts: ['Pass rate 93%', 'L2 escalated 91/100', 'I run heybeaux'],
  anchors: ['threading-libraries analogy'],
  forbidden: ['Do not use the editorial we'],
  voice: 'First-person singular only.',
  target_word_count: 2000,
};

const outline: Outline = {
  beats: [
    { type: 'opener', summary: 'Lead with L2 finding', uses_facts: [1], uses_anchors: [] },
    { type: 'scene', summary: 'Set up benchmark', uses_facts: [0], uses_anchors: [] },
    { type: 'turn', summary: 'L2 was almost useless', uses_facts: [1], uses_anchors: [0] },
    { type: 'reflection', summary: 'What this means', uses_facts: [], uses_anchors: [] },
    { type: 'closer', summary: 'What is next', uses_facts: [2], uses_anchors: [] },
  ],
};

function mockClient(text: string) {
  const create = vi.fn().mockResolvedValue({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 15000,
    },
  });
  return { messages: { create }, _create: create };
}

describe('buildDraftV2UserMessage', () => {
  it('numbers facts and anchors so the drafter can reference them', () => {
    const msg = buildDraftV2UserMessage(idea, outline);
    expect(msg).toContain('0. Pass rate 93%');
    expect(msg).toContain('2. I run heybeaux');
    expect(msg).toContain('0. threading-libraries');
  });

  it('renders outline beats with their fact/anchor index lists', () => {
    const msg = buildDraftV2UserMessage(idea, outline);
    expect(msg).toContain('Beat 1');
    expect(msg).toContain('Beat 5');
    expect(msg).toContain('Uses facts:');
  });

  it('includes the [fact:N] citation rule', () => {
    const msg = buildDraftV2UserMessage(idea, outline);
    expect(msg).toContain('[fact:N]');
    expect(msg).toContain('Fact-citation rule');
  });

  it('includes the voice constraint and forbidden block', () => {
    const msg = buildDraftV2UserMessage(idea, outline);
    expect(msg).toContain('Voice constraint');
    expect(msg).toContain('First-person singular only');
    expect(msg).toContain('Forbidden');
    expect(msg).toContain('Do not use the editorial we');
  });

  it('honours target_word_count when set', () => {
    const msg = buildDraftV2UserMessage(idea, outline);
    expect(msg).toContain('target 2000 words');
  });
});

describe('draftEssayV2 (SDK mocked)', () => {
  it('calls the SDK with the system prefix and returns the draft', async () => {
    const client = mockClient(
      'I built Lattice. 400 handoffs. 93% pass rate [fact:0]. The interesting number is the L2 escalation finding [fact:1].',
    );
    const sys: any = [
      { type: 'text', text: 'identity', cache_control: { type: 'ephemeral' } },
    ];
    const r = await draftEssayV2(idea, outline, { client, system: sys });
    expect(r.draft).toContain('[fact:0]');
    expect(client._create).toHaveBeenCalledTimes(1);
    const call = client._create.mock.calls[0]![0];
    expect(call.system).toBe(sys);
  });
});
