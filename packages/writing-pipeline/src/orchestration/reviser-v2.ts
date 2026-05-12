// Reviser v2 — Phase 3, Track D.
//
// Two-pass revision with:
//   - Max 2 passes (configurable). Pipeline aborts further passes if a pass
//     regresses composite voice_match score.
//   - Total cost ceiling per essay (default $0.20). Aborts before pass N if
//     pass N-1 would push cumulative cost past the ceiling.
//   - Pass-N cached prefix includes "previous attempts and their scores" so
//     the model can avoid repeating the same mistakes.
//   - After the final accepted pass, `[fact:N]` markers are stripped from the
//     returned `final` string. Intermediate passes keep the markers (so the
//     L0 rule and the SonderEvent log retain them).

import Anthropic from '@anthropic-ai/sdk';

import { critiqueDraft } from '../voice/critic.js';
import { compositeScore } from '../voice/reviser.js';
import type { Critique } from '../voice/critic.js';
import type { VoiceFingerprint } from '../voice/corpus/fingerprint.js';
import { DRAFTER_MODEL } from '../voice/drafter.js';

import { stripFactMarkers } from './fact-citation.js';
import type { IdeaBrief } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviseV2Options {
  /** The voice fingerprint. */
  fingerprint: VoiceFingerprint;
  /** The base system prefix (drafter prefix). REQUIRED. */
  system: Anthropic.Messages.TextBlockParam[];
  /** The IdeaBrief (for forbidden directives + voice constraint passthrough). */
  idea: IdeaBrief;
  client?: Pick<Anthropic, 'messages'>;
  /** Max passes. Default 2. */
  maxPasses?: number;
  /** Cost ceiling in USD. Default 0.20. */
  costCeilingUsd?: number;
  /** Model. Default DRAFTER_MODEL. */
  model?: string;
  /** Output cap per pass. Default 8192. */
  maxTokens?: number;
  /** Override the cost-estimation function (for tests). */
  estimateCost?: (usage: PassUsage) => number;
}

export interface PassUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ReviseV2Pass {
  passIndex: number;
  draft: string;
  critique: Critique;
  /** Composite score (voice_match - slop/10) on this pass. */
  compositeScore: number;
  accepted: boolean;
  decisionNote: string;
  usage: PassUsage;
  costUsd: number;
}

export interface ReviseV2Result {
  /** Final accepted draft with [fact:N] markers STRIPPED. */
  final: string;
  /** Final accepted draft WITH markers (for SonderEvent log). */
  finalWithMarkers: string;
  /** Final critique. */
  finalCritique: Critique;
  /** All revision attempts in order. */
  passes: ReviseV2Pass[];
  /** Sum of pass costs. */
  totalCostUsd: number;
  /** Reason the loop stopped (budget / regression / pass-cap). */
  stopReason: 'pass_cap' | 'regression' | 'cost_ceiling' | 'no_issues';
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function reviseDraftV2(
  initialDraft: string,
  opts: ReviseV2Options,
): Promise<ReviseV2Result> {
  if (!initialDraft || !initialDraft.trim()) {
    throw new Error('reviseDraftV2: initialDraft must be non-empty');
  }

  const client = opts.client ?? buildDefaultClient();
  const model = opts.model ?? DRAFTER_MODEL;
  const maxTokens = opts.maxTokens ?? 8192;
  const maxPasses = opts.maxPasses ?? 2;
  const costCeiling = opts.costCeilingUsd ?? 0.20;
  const estimateCost = opts.estimateCost ?? defaultEstimateCost;

  // Initial critique of the input draft. This becomes the baseline that pass 1
  // must beat.
  const initialCritique = critiqueDraft(initialDraft, { fingerprint: opts.fingerprint });
  const initialScore = compositeScore(initialCritique);

  const passes: ReviseV2Pass[] = [];
  let currentDraft = initialDraft;
  let currentCritique = initialCritique;
  let currentScore = initialScore;
  let totalCost = 0;
  let stopReason: ReviseV2Result['stopReason'] = 'pass_cap';

  // No issues at all on the original draft — skip revision entirely.
  if (initialCritique.issues.length === 0) {
    return {
      final: stripFactMarkers(initialDraft),
      finalWithMarkers: initialDraft,
      finalCritique: initialCritique,
      passes: [],
      totalCostUsd: 0,
      stopReason: 'no_issues',
    };
  }

  for (let passIndex = 1; passIndex <= maxPasses; passIndex++) {
    // Build the per-pass user message. Earlier passes accumulate in the prompt
    // as "here's what you tried and how it scored" — so the model can avoid
    // repeating itself.
    const userText = buildPassUserMessage({
      idea: opts.idea,
      currentDraft,
      currentCritique,
      passIndex,
      maxPasses,
      previousPasses: passes,
    });

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

    const newDraft = extractText(response);
    const newCritique = critiqueDraft(newDraft, { fingerprint: opts.fingerprint });
    const newScore = compositeScore(newCritique);
    const usage: PassUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const costUsd = estimateCost(usage);
    totalCost += costUsd;

    const previousVoiceMatch = currentCritique.scores.voice_match;
    const newVoiceMatch = newCritique.scores.voice_match;

    // Accept if composite score did not regress.
    const accepted = newScore >= currentScore;
    let decisionNote: string;

    if (accepted) {
      decisionNote = `Pass ${passIndex} accepted: composite ${currentScore.toFixed(3)} -> ${newScore.toFixed(3)}; voice_match ${previousVoiceMatch.toFixed(3)} -> ${newVoiceMatch.toFixed(3)}.`;
    } else {
      decisionNote = `Pass ${passIndex} rejected: composite regressed ${currentScore.toFixed(3)} -> ${newScore.toFixed(3)}; voice_match ${previousVoiceMatch.toFixed(3)} -> ${newVoiceMatch.toFixed(3)}. Keeping previous draft.`;
    }

    passes.push({
      passIndex,
      draft: newDraft,
      critique: newCritique,
      compositeScore: newScore,
      accepted,
      decisionNote,
      usage,
      costUsd,
    });

    if (accepted) {
      currentDraft = newDraft;
      currentCritique = newCritique;
      currentScore = newScore;
    }

    // Voice-match regression is the spec's "abort if pass N regresses
    // voice_match" condition. We've already recorded the pass; now decide
    // whether to keep going. Cost ceiling is the second exit.
    if (!accepted && newVoiceMatch < previousVoiceMatch) {
      stopReason = 'regression';
      break;
    }

    if (totalCost > costCeiling) {
      stopReason = 'cost_ceiling';
      break;
    }
  }

  return {
    final: stripFactMarkers(currentDraft),
    finalWithMarkers: currentDraft,
    finalCritique: currentCritique,
    passes,
    totalCostUsd: totalCost,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Per-pass user message
// ---------------------------------------------------------------------------

interface BuildPassMessageInput {
  idea: IdeaBrief;
  currentDraft: string;
  currentCritique: Critique;
  passIndex: number;
  maxPasses: number;
  previousPasses: ReviseV2Pass[];
}

export function buildPassUserMessage(input: BuildPassMessageInput): string {
  const lines: string[] = [];
  lines.push(`You wrote this draft. Revise it once more. This is pass ${input.passIndex} of ${input.maxPasses}.`);
  lines.push('');

  // History block — what was tried before, what each score was. Only present
  // from pass 2 onwards.
  if (input.previousPasses.length > 0) {
    lines.push('## Previous attempts');
    for (const p of input.previousPasses) {
      lines.push(`- Pass ${p.passIndex} scored composite=${p.compositeScore.toFixed(3)} (voice_match=${p.critique.scores.voice_match.toFixed(3)}, slop/kchar=${p.critique.scores.slop_per_kilochar.toFixed(3)}). ${p.accepted ? 'Accepted.' : 'Rejected (regressed).'}`);
    }
    lines.push('Do not repeat the same edits that did not help.');
    lines.push('');
  }

  if (input.idea.forbidden.length > 0) {
    lines.push('## Forbidden — still applies, do not break any of these');
    input.idea.forbidden.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push('');
  }

  if (input.idea.voice) {
    lines.push('## Voice constraint (HARD RULE)');
    lines.push(input.idea.voice);
    lines.push('');
  }

  lines.push('## Facts (numbered — keep [fact:N] markers inline for first-person factual claims)');
  input.idea.facts.forEach((f, i) => lines.push(`${i}. ${f}`));
  lines.push('');

  lines.push('## Current draft');
  lines.push('```');
  lines.push(input.currentDraft);
  lines.push('```');
  lines.push('');

  lines.push('## Issues to fix in this pass');
  lines.push(renderIssueChecklist(input.currentCritique));
  lines.push('');

  lines.push('## Revision instructions');
  lines.push('- Output the revised essay in full. No diff, no commentary.');
  lines.push('- Fix the issues but do not over-correct. If a fix would require inventing a new fact, leave the original.');
  lines.push('- Keep all `[fact:N]` markers inline after first-person factual claims — they will be stripped later, but they are required for now.');
  lines.push('- Do not add new first-person factual claims unless you cite a fact from the list.');
  lines.push('- Preserve the voice. Output should still sound like the author.');
  return lines.join('\n');
}

// Internal: simplified critique renderer focused on the high/medium-severity
// issues. We don't reuse the Phase 2 renderIssueChecklist because that file
// targets the Phase 2 single-pass reviser; this one's shorter and pass-aware.
function renderIssueChecklist(c: Critique): string {
  const issues = c.issues.filter((i) => i.severity !== 'low').slice(0, 12);
  if (issues.length === 0) return '_(no high-severity issues — polish for clarity only.)_';
  const lines: string[] = [];
  issues.forEach((iss, idx) => {
    const loc = iss.location
      ? ` (line ${(iss.location.line ?? 0) + 1}, col ${(iss.location.column ?? 0) + 1})`
      : '';
    lines.push(`${idx + 1}. [${iss.severity}] ${iss.kind}${loc}`);
    lines.push(`   - ${iss.diagnosis}`);
    lines.push(`   - Fix: ${iss.suggestion}`);
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Opus 4.6 cost estimate. Same rates as the Phase 2 summary helper.
 * input $5/Mtok, output $25/Mtok, cache reads at 10% of input, cache writes
 * at 125%.
 */
export function defaultEstimateCost(usage: PassUsage): number {
  const inputBase = usage.input_tokens / 1_000_000;
  const outputBase = usage.output_tokens / 1_000_000;
  const cacheCreate = usage.cache_creation_input_tokens / 1_000_000;
  const cacheRead = usage.cache_read_input_tokens / 1_000_000;
  return inputBase * 5 + outputBase * 25 + cacheCreate * 5 * 1.25 + cacheRead * 5 * 0.1;
}

function buildDefaultClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
    throw new Error('reviseDraftV2: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set.');
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
