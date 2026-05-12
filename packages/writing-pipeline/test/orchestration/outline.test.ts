// Tests for the outline step — SDK is mocked, no network.

import { describe, it, expect, vi } from 'vitest';

import {
  generateOutline,
  parseOutline,
  factCoveragePct,
  buildOutlineUserMessage,
} from '../../src/orchestration/outline.js';
import type { IdeaBrief, Outline } from '../../src/orchestration/types.js';

const baseIdea: IdeaBrief = {
  id: '01HXTEST',
  title: 'Test Essay',
  brief: 'A'.repeat(120),
  facts: ['Fact A', 'Fact B', 'Fact C', 'Fact D'],
  anchors: ['Anchor A', 'Anchor B'],
  forbidden: ['no inventing'],
};

const VALID_RESPONSE = JSON.stringify({
  beats: [
    { type: 'opener', summary: 'Start with the boring number', uses_facts: [0], uses_anchors: [0] },
    { type: 'scene', summary: 'Set up the system', uses_facts: [1, 2], uses_anchors: [] },
    { type: 'turn', summary: 'The L2 surprise', uses_facts: [3], uses_anchors: [1] },
    { type: 'reflection', summary: 'What this means', uses_facts: [], uses_anchors: [] },
    { type: 'closer', summary: 'What is next', uses_facts: [], uses_anchors: [] },
  ],
});

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
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 15000,
    },
  });
  return { messages: { create }, _create: create };
}

describe('buildOutlineUserMessage', () => {
  it('renders facts with numeric indices the drafter can reference', () => {
    const msg = buildOutlineUserMessage(baseIdea);
    expect(msg).toContain('0. Fact A');
    expect(msg).toContain('3. Fact D');
    expect(msg).toContain('0. Anchor A');
    expect(msg).toContain('STRICT');
  });
});

describe('parseOutline', () => {
  it('parses a valid outline', () => {
    const outline = parseOutline(VALID_RESPONSE, baseIdea);
    expect(outline.beats).toHaveLength(5);
    expect(outline.beats[0]!.type).toBe('opener');
    expect(outline.beats[4]!.type).toBe('closer');
  });

  it('strips code fences before parsing', () => {
    const wrapped = '```json\n' + VALID_RESPONSE + '\n```';
    const outline = parseOutline(wrapped, baseIdea);
    expect(outline.beats).toHaveLength(5);
  });

  it('rejects a beat with out-of-range uses_facts', () => {
    const bad = JSON.stringify({
      beats: [
        { type: 'opener', summary: 'x', uses_facts: [99], uses_anchors: [] },
        { type: 'scene', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'turn', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'reflection', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'closer', summary: 'x', uses_facts: [], uses_anchors: [] },
      ],
    });
    expect(() => parseOutline(bad, baseIdea)).toThrow(/out-of-range/);
  });

  it('rejects too few beats', () => {
    const bad = JSON.stringify({
      beats: [
        { type: 'opener', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'closer', summary: 'x', uses_facts: [], uses_anchors: [] },
      ],
    });
    expect(() => parseOutline(bad, baseIdea)).toThrow(/5-7 beats/);
  });

  it('rejects when first beat is not opener', () => {
    const bad = JSON.stringify({
      beats: [
        { type: 'scene', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'scene', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'scene', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'scene', summary: 'x', uses_facts: [], uses_anchors: [] },
        { type: 'closer', summary: 'x', uses_facts: [], uses_anchors: [] },
      ],
    });
    expect(() => parseOutline(bad, baseIdea)).toThrow(/first beat must be 'opener'/);
  });
});

describe('factCoveragePct', () => {
  it('returns 100% when all facts are covered', () => {
    const outline: Outline = {
      beats: [
        { type: 'opener', summary: 'x', uses_facts: [0, 1], uses_anchors: [] },
        { type: 'closer', summary: 'x', uses_facts: [2, 3], uses_anchors: [] },
      ],
    };
    expect(factCoveragePct(outline, baseIdea)).toBe(100);
  });

  it('returns the right percentage on partial coverage', () => {
    const outline: Outline = {
      beats: [
        { type: 'opener', summary: 'x', uses_facts: [0, 1], uses_anchors: [] },
        { type: 'closer', summary: 'x', uses_facts: [], uses_anchors: [] },
      ],
    };
    expect(factCoveragePct(outline, baseIdea)).toBe(50);
  });
});

describe('generateOutline (SDK mocked)', () => {
  it('calls the SDK and returns a parsed outline', async () => {
    const client = mockClient(VALID_RESPONSE);
    const result = await generateOutline(baseIdea, {
      client,
      system: [
        { type: 'text', text: 'identity', cache_control: { type: 'ephemeral' } },
      ],
    });
    expect(client._create).toHaveBeenCalledTimes(1);
    expect(result.outline.beats).toHaveLength(5);
    expect(result.usage.cache_read_input_tokens).toBe(15000);
  });
});
