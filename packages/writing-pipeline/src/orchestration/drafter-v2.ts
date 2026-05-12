// Drafter v2 — Phase 3, Track D.
//
// Takes IdeaBrief + Outline (not free-text idea) and produces a draft with
// inline [fact:N] markers per the no_invented_first_person_facts L0 rule.
//
// Differences from the Phase 2 drafter:
//   - Input is structured (IdeaBrief + Outline) instead of one-line idea.
//   - System prompt includes the IdeaBrief.voice constraint (when set) as a
//     hard rule, plus the forbidden directives.
//   - User message renders the outline beat-by-beat with fact/anchor indices.
//   - Drafter is instructed to emit [fact:N] markers after first-person
//     factual claims so the L0 rule can validate them.
//   - The drafter system prefix is the SAME prefix from the Phase 2 drafter,
//     so cache hits carry across drafter v1 -> v2 -> reviser -> outline.

import Anthropic from '@anthropic-ai/sdk';

import { DRAFTER_MODEL } from '../voice/drafter.js';
import type { IdeaBrief, Outline } from './types.js';

export interface DraftV2Options {
  client?: Pick<Anthropic, 'messages'>;
  /** The cached drafter system prefix from buildDrafterSystemPrompt(). */
  system: Anthropic.Messages.TextBlockParam[];
  /** Override model. Default DRAFTER_MODEL ('claude-opus-4-6'). */
  model?: string;
  /** Output cap. Default: 8192 (long-form essays need headroom). */
  maxTokens?: number;
}

export interface DraftV2Result {
  /** Raw draft text WITH [fact:N] markers inline. */
  draft: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  stopReason: string | null;
}

// ---------------------------------------------------------------------------
// User-message construction
// ---------------------------------------------------------------------------

export function buildDraftV2UserMessage(
  idea: IdeaBrief,
  outline: Outline,
): string {
  const lines: string[] = [];
  lines.push("Write the essay now. Follow the outline below beat-by-beat.");
  lines.push('');
  lines.push("## Title (working): " + idea.title);
  if (idea.thesis) {
    lines.push('');
    lines.push('## Thesis (do not state verbatim — let the prose carry it)');
    lines.push(idea.thesis);
  }
  lines.push('');
  if (idea.target_word_count) {
    lines.push(`## Length: target ${idea.target_word_count} words (acceptable range: ${Math.round(idea.target_word_count * 0.85)}-${Math.round(idea.target_word_count * 1.15)}).`);
    lines.push('');
  }

  lines.push('## Brief');
  lines.push(idea.brief.trim());
  lines.push('');

  lines.push('## Facts (numbered — cite by [fact:N] when used in first-person claims)');
  idea.facts.forEach((f, i) => lines.push(`${i}. ${f}`));
  lines.push('');

  lines.push('## Anchors (numbered)');
  if (idea.anchors.length === 0) lines.push('_(none)_');
  else idea.anchors.forEach((a, i) => lines.push(`${i}. ${a}`));
  lines.push('');

  if (idea.forbidden.length > 0) {
    lines.push('## Forbidden — strict prohibitions, breaking ANY of these fails the draft');
    idea.forbidden.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push('');
  }

  if (idea.structural_preferences && idea.structural_preferences.length > 0) {
    lines.push('## Structural preferences');
    idea.structural_preferences.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push('');
  }

  lines.push('## Outline (write each beat using ONLY the facts/anchors listed for that beat)');
  outline.beats.forEach((b, i) => {
    const facts = b.uses_facts.length > 0 ? b.uses_facts.join(', ') : '(none)';
    const anchors = b.uses_anchors.length > 0 ? b.uses_anchors.join(', ') : '(none)';
    lines.push(`### Beat ${i + 1} — ${b.type}`);
    lines.push(`Uses facts: ${facts}`);
    lines.push(`Uses anchors: ${anchors}`);
    lines.push(`Plan: ${b.summary}`);
    lines.push('');
  });

  lines.push('## Fact-citation rule (REQUIRED)');
  lines.push('');
  lines.push("- Any first-person factual claim — heights, ages, named persons, places you (the narrator) went to, relationship terms like \"my dad\" / \"my brother\" — MUST be followed immediately by an inline marker `[fact:N]` where N indexes into the Facts list above.");
  lines.push("- Example: `I run heybeaux [fact:35], a small dev shop.`");
  lines.push("- Multiple markers per claim are fine: `My brother John [fact:1] [fact:4] said...`");
  lines.push('- If a first-person factual claim has no corresponding fact in the list, you must NOT make the claim. Pick a fact that is in the list, or rewrite the sentence to avoid the claim entirely.');
  lines.push('- These markers stay inline in your draft. A later pass will strip them before publication.');
  lines.push('');

  if (idea.voice) {
    lines.push('## Voice constraint (HARD RULE)');
    lines.push(idea.voice);
    lines.push('');
  }

  lines.push('## Output');
  lines.push('Just the essay prose. No frontmatter, no outer commentary, no "Here is the draft:" preamble. Open with the prose itself. If the piece benefits from a single H1 title, put it on the first line; otherwise skip it.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function draftEssayV2(
  idea: IdeaBrief,
  outline: Outline,
  opts: DraftV2Options,
): Promise<DraftV2Result> {
  const client = opts.client ?? buildDefaultClient();
  const model = opts.model ?? DRAFTER_MODEL;
  const maxTokens = opts.maxTokens ?? 8192;
  const userText = buildDraftV2UserMessage(idea, outline);

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

  const draft = extractText(response);
  return {
    draft,
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

function buildDefaultClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
    throw new Error('draftEssayV2: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set.');
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
