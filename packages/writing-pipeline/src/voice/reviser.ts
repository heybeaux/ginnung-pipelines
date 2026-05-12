// Diff reviser — Phase 2C.
//
// One revision pass. Calls Claude Opus 4.6 with the same cached system prefix
// the drafter used (so the prompt cache hits), plus the previous draft and a
// structured critique checklist. Accepts the revision if the critic's
// composite score improves; reverts (with a note) if it regresses.
//
// This module is intentionally minimal — Phase 2 is "can we close the loop
// once, deterministically?", not "let's chase the score down to zero". Any
// adaptive multi-pass logic belongs to Phase 3.

import Anthropic from '@anthropic-ai/sdk';

import type { Critique, Issue } from './critic.js';
import { critiqueDraft } from './critic.js';
import { buildDrafterSystemPrompt, DRAFTER_MODEL } from './drafter.js';
import type { VoiceFingerprint } from './corpus/fingerprint.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviseDraftOptions {
  /** Original idea (kept so the reviser knows what was being written about). */
  idea: string;
  /** The fingerprint the critic used. Same one the reviser will compare to. */
  fingerprint: VoiceFingerprint;
  /** Cached system prefix from the drafter. If omitted, reviser will rebuild
   *  it from `fingerprint` + exemplars (but reuse is cheaper). */
  system?: Anthropic.Messages.TextBlockParam[];
  /** Pre-built exemplars (only needed if `system` is omitted). */
  exemplars?: { file: string; body: string }[];
  /** Override the Anthropic client (for tests). */
  client?: Pick<Anthropic, 'messages'>;
  /** Override the model id. Default: claude-opus-4-6. */
  model?: string;
  /** Override max_tokens. Default: 4096. */
  maxTokens?: number;
  /** Composite-score improvement threshold. Default: 0 (any non-regression
   *  wins). Set higher to require a meaningful gain. */
  minImprovement?: number;
}

export interface ReviseDraftResult {
  finalDraft: string;
  finalCritique: Critique;
  initialCritique: Critique;
  revisedDraft: string;
  revisedCritique: Critique;
  /** True if the revision was kept; false if reverted to original. */
  accepted: boolean;
  /** Reason recorded with the decision. */
  decisionNote: string;
  /** Composite score delta (revised - initial). Positive = improvement. */
  scoreDelta: number;
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
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * One-pass revision loop. Critiques the input, asks Claude for a revision
 * given the structured issue list, critiques the result, and accepts iff the
 * composite score improves.
 *
 * Composite score = voice_match - (slop_per_kilochar / 10). Higher is better.
 */
export async function reviseDraft(
  draft: string,
  opts: ReviseDraftOptions,
): Promise<ReviseDraftResult> {
  if (!draft || !draft.trim()) {
    throw new Error('reviseDraft: draft must be non-empty');
  }

  const initialCritique = critiqueDraft(draft, {
    fingerprint: opts.fingerprint,
  });

  const model = opts.model ?? DRAFTER_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const client = opts.client ?? buildDefaultClient();

  const system =
    opts.system ??
    (opts.exemplars
      ? buildDrafterSystemPrompt(opts.fingerprint, opts.exemplars)
      : undefined);

  if (!system) {
    throw new Error(
      'reviseDraft: pass either `system` (preferred — reuses the drafter cache) or `exemplars` so the system prefix can be rebuilt.',
    );
  }

  const checklist = renderIssueChecklist(initialCritique.issues);

  const userText =
    `You wrote this draft. Now revise it once.\n\n` +
    `## The original idea\n\n${opts.idea.trim()}\n\n` +
    `## Your previous draft\n\n` +
    "```\n" +
    initialCritique.bodyAnalysed +
    "\n```\n\n" +
    `## Voice & slop issues to fix\n\n` +
    `${checklist}\n\n` +
    `## Revision instructions\n\n` +
    "- Output the revised essay in full. Do not output a diff, a list of changes, or commentary.\n" +
    "- Fix the issues above, but do not over-correct. If a fix would require fabricating new content or changing the meaning, leave the original.\n" +
    "- Preserve the voice. The revision should still sound like you.\n" +
    "- No frontmatter, no outer headers explaining the revision. Just the essay.";

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    ],
  });

  const revisedDraft = extractText(response);
  const revisedCritique = critiqueDraft(revisedDraft, {
    fingerprint: opts.fingerprint,
  });

  const initialScore = compositeScore(initialCritique);
  const revisedScore = compositeScore(revisedCritique);
  const scoreDelta = revisedScore - initialScore;
  const minImprovement = opts.minImprovement ?? 0;

  const accepted = scoreDelta >= minImprovement;
  const decisionNote = accepted
    ? `Accepted revision: composite score went from ${round3(initialScore)} to ${round3(revisedScore)} (delta ${signed(round3(scoreDelta))}).`
    : `Reverted revision: composite score went from ${round3(initialScore)} to ${round3(revisedScore)} (delta ${signed(round3(scoreDelta))}). Keeping the original draft.`;

  return {
    finalDraft: accepted ? revisedDraft : initialCritique.bodyAnalysed,
    finalCritique: accepted ? revisedCritique : initialCritique,
    initialCritique,
    revisedDraft,
    revisedCritique,
    accepted,
    decisionNote,
    scoreDelta: round3(scoreDelta),
    model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    stopReason: response.stop_reason,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compose Issue[] into a numbered checklist with line/col anchors. Hidden
 * fingerprint-drift issues without locations come last under a "Drift" heading.
 */
export function renderIssueChecklist(issues: Issue[]): string {
  if (issues.length === 0) {
    return "No anti-slop or voice-drift issues fired. Polish for clarity if anything still bothers you, otherwise return the draft unchanged.";
  }
  const located: Issue[] = [];
  const global: Issue[] = [];
  for (const i of issues) {
    if (i.location) located.push(i);
    else global.push(i);
  }

  const lines: string[] = [];
  if (located.length > 0) {
    lines.push("### Specific line-level issues");
    lines.push("");
    located.forEach((iss, idx) => {
      const loc = iss.location!;
      const where = `line ${loc.line + 1}, col ${loc.column + 1}`;
      const excerpt = loc.excerpt ? ` (\u201C${loc.excerpt}\u201D)` : '';
      lines.push(
        `${idx + 1}. **[${iss.severity}]** ${iss.kind} @ ${where}${excerpt}`,
      );
      lines.push(`   - Diagnosis: ${iss.diagnosis}`);
      lines.push(`   - Fix: ${iss.suggestion}`);
      lines.push("");
    });
  }
  if (global.length > 0) {
    lines.push("### Whole-piece drift");
    lines.push("");
    global.forEach((iss, idx) => {
      lines.push(`${idx + 1}. **[${iss.severity}]** ${iss.kind}`);
      lines.push(`   - Diagnosis: ${iss.diagnosis}`);
      lines.push(`   - Fix: ${iss.suggestion}`);
      lines.push("");
    });
  }
  return lines.join('\n').trim();
}

/**
 * Composite score used for accept/revert. Higher is better.
 * voice_match is in [0,1]; slop_per_kilochar is unbounded so we divide by 10
 * to keep it in the same rough magnitude.
 */
export function compositeScore(c: Critique): number {
  return c.scores.voice_match - c.scores.slop_per_kilochar / 10;
}

function buildDefaultClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
    throw new Error(
      'reviseDraft: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set. ' +
        'Export one before running the voice loop (or pass `client` for tests).',
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

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function signed(x: number): string {
  return x >= 0 ? `+${x}` : `${x}`;
}
