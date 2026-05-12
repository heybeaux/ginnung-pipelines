// Phase 3 outline step — single-model, fact-routed.
//
// Calls Opus 4.6 with the IdeaBrief and returns an Outline of 5-7 beats. Each
// beat declares which facts/anchors it will use, so the drafter (Track D) can
// write each beat against ONLY those facts and the L0 fact-citation rule has
// something to check.
//
// Prompt caching: the same drafter system prefix (identity + exemplars) is
// reused here so the model has the voice context even when generating an
// outline. Cache key matches the drafter / reviser cache key — a draft round-
// trip pays cache-creation once.

import Anthropic from '@anthropic-ai/sdk';

import type { IdeaBrief, Outline, OutlineBeat, OutlineBeatType } from './types.js';
import { DRAFTER_MODEL } from '../voice/drafter.js';

export interface OutlineCallOptions {
  client?: Pick<Anthropic, 'messages'>;
  /** System prefix from the drafter (reused for cache hits). REQUIRED. */
  system: Anthropic.Messages.TextBlockParam[];
  /** Override model. Default DRAFTER_MODEL ('claude-opus-4-6'). */
  model?: string;
  /** Max output tokens. Default: 2048 — outlines are short. */
  maxTokens?: number;
}

export interface OutlineCallResult {
  outline: Outline;
  rawText: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  model: string;
  stopReason: string | null;
}

const VALID_BEAT_TYPES: ReadonlySet<OutlineBeatType> = new Set([
  'opener',
  'scene',
  'turn',
  'reflection',
  'closer',
]);

// ---------------------------------------------------------------------------
// User-message construction
// ---------------------------------------------------------------------------

export function renderIdeaForOutline(idea: IdeaBrief): string {
  const lines: string[] = [];
  lines.push(`## Title (working): ${idea.title}`);
  if (idea.thesis) {
    lines.push('');
    lines.push(`## Thesis: ${idea.thesis}`);
  }
  if (idea.register_hint) {
    lines.push('');
    lines.push(`## Register: ${idea.register_hint}`);
  }
  if (idea.target_word_count) {
    lines.push('');
    lines.push(`## Target word count: ~${idea.target_word_count}`);
  }
  lines.push('');
  lines.push('## Brief');
  lines.push(idea.brief.trim());
  lines.push('');
  lines.push('## Facts (numbered — beats MUST reference these by index)');
  idea.facts.forEach((f, i) => lines.push(`${i}. ${f}`));
  lines.push('');
  lines.push('## Anchors (numbered)');
  if (idea.anchors.length === 0) {
    lines.push('_(none)_');
  } else {
    idea.anchors.forEach((a, i) => lines.push(`${i}. ${a}`));
  }
  lines.push('');
  if (idea.forbidden.length > 0) {
    lines.push('## Forbidden (must obey)');
    idea.forbidden.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push('');
  }
  if (idea.structural_preferences && idea.structural_preferences.length > 0) {
    lines.push('## Structural preferences');
    idea.structural_preferences.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function buildOutlineUserMessage(idea: IdeaBrief): string {
  const briefBlock = renderIdeaForOutline(idea);
  return [
    'Produce an outline for the blog essay described below. The drafter will write the prose against this outline beat-by-beat.',
    '',
    briefBlock,
    '',
    '## Outline contract — STRICT',
    '',
    '- Produce 5-7 beats.',
    "- Each beat is an object with the shape: { \"type\": one of [opener, scene, turn, reflection, closer], \"summary\": string (one-paragraph plan for the beat), \"uses_facts\": int[] (indices into the Facts list above), \"uses_anchors\": int[] (indices into the Anchors list above) }.",
    '- Every numeric index in `uses_facts` must be a valid index in the Facts list (0..N-1). Same for `uses_anchors`.',
    '- The drafter will write each beat using ONLY the facts/anchors listed for that beat. So distribute the load — pick the facts that actually belong to each beat.',
    '- The first beat must be type "opener" and the last must be type "closer".',
    '',
    '## Output format — STRICT',
    '',
    'Output a single JSON object with one top-level key, `beats`, whose value is the array. No prose, no markdown fences, no commentary. Just the JSON object.',
    '',
    'Example shape (do NOT copy values):',
    '',
    '{"beats":[{"type":"opener","summary":"...","uses_facts":[0,3],"uses_anchors":[0]}, ...]}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function generateOutline(
  idea: IdeaBrief,
  opts: OutlineCallOptions,
): Promise<OutlineCallResult> {
  const client = opts.client ?? buildDefaultClient();
  const model = opts.model ?? DRAFTER_MODEL;
  const maxTokens = opts.maxTokens ?? 2048;
  const userText = buildOutlineUserMessage(idea);

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: opts.system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    ],
  });

  const rawText = extractText(response);
  const outline = parseOutline(rawText, idea);
  return {
    outline,
    rawText,
    model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    stopReason: response.stop_reason,
  };
}

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------

/**
 * Parse the model's JSON output into a typed Outline. Validates that:
 *   - the JSON parses
 *   - beats is a 5-7 element array
 *   - each beat has the required fields
 *   - each uses_facts/uses_anchors index is in-range
 *   - first beat is 'opener', last is 'closer'
 */
export function parseOutline(rawText: string, idea: IdeaBrief): Outline {
  // The model may wrap in code fences despite the instruction. Strip them.
  const cleaned = stripCodeFences(rawText).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `parseOutline: JSON parse failed: ${(err as Error).message}\nraw: ${cleaned.slice(0, 200)}...`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || !('beats' in parsed)) {
    throw new Error('parseOutline: expected an object with a "beats" key');
  }
  const beatsRaw = (parsed as { beats: unknown }).beats;
  if (!Array.isArray(beatsRaw)) {
    throw new Error('parseOutline: beats must be an array');
  }
  if (beatsRaw.length < 5 || beatsRaw.length > 7) {
    throw new Error(`parseOutline: expected 5-7 beats, got ${beatsRaw.length}`);
  }

  const beats: OutlineBeat[] = beatsRaw.map((b, idx) => {
    if (typeof b !== 'object' || b === null) {
      throw new Error(`parseOutline: beat ${idx} is not an object`);
    }
    const ob = b as Record<string, unknown>;
    const type = ob['type'];
    if (typeof type !== 'string' || !VALID_BEAT_TYPES.has(type as OutlineBeatType)) {
      throw new Error(`parseOutline: beat ${idx} has invalid type: ${String(type)}`);
    }
    if (typeof ob['summary'] !== 'string' || !ob['summary']) {
      throw new Error(`parseOutline: beat ${idx} has missing/empty summary`);
    }
    const usesFacts = ob['uses_facts'];
    if (!Array.isArray(usesFacts) || usesFacts.some((x) => typeof x !== 'number')) {
      throw new Error(`parseOutline: beat ${idx} has invalid uses_facts`);
    }
    for (const f of usesFacts as number[]) {
      if (f < 0 || f >= idea.facts.length) {
        throw new Error(
          `parseOutline: beat ${idx} uses_facts contains out-of-range index ${f} (facts has ${idea.facts.length} entries)`,
        );
      }
    }
    const usesAnchors = ob['uses_anchors'];
    if (!Array.isArray(usesAnchors) || usesAnchors.some((x) => typeof x !== 'number')) {
      throw new Error(`parseOutline: beat ${idx} has invalid uses_anchors`);
    }
    for (const a of usesAnchors as number[]) {
      if (a < 0 || a >= idea.anchors.length) {
        throw new Error(
          `parseOutline: beat ${idx} uses_anchors contains out-of-range index ${a} (anchors has ${idea.anchors.length} entries)`,
        );
      }
    }
    return {
      type: type as OutlineBeatType,
      summary: ob['summary'] as string,
      uses_facts: usesFacts as number[],
      uses_anchors: usesAnchors as number[],
    };
  });

  if (beats[0]!.type !== 'opener') {
    throw new Error(`parseOutline: first beat must be 'opener', got '${beats[0]!.type}'`);
  }
  if (beats[beats.length - 1]!.type !== 'closer') {
    throw new Error(
      `parseOutline: last beat must be 'closer', got '${beats[beats.length - 1]!.type}'`,
    );
  }

  return { beats };
}

/** Coverage % = fraction of facts referenced by at least one beat. */
export function factCoveragePct(outline: Outline, idea: IdeaBrief): number {
  if (idea.facts.length === 0) return 0;
  const covered = new Set<number>();
  for (const b of outline.beats) for (const f of b.uses_facts) covered.add(f);
  return Math.round((covered.size / idea.facts.length) * 100);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripCodeFences(s: string): string {
  let trimmed = s.trim();
  // Strip a leading ```json or ``` and trailing ```.
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return trimmed;
}

function buildDefaultClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
    throw new Error(
      'generateOutline: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set.',
    );
  }
  return new Anthropic();
}

function extractText(response: Anthropic.Messages.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}
