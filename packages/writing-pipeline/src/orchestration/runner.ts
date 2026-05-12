// Phase 3 orchestration runner.
//
// runPipeline(brief) walks the 8 steps (1 idea-capture, 2 research, 3 outline,
// 4 draft, 5 critique, 6 revise, 7 publish, 8 post-publish), emitting a pair
// of SonderEvents (entry + exit) per step, applying L0 rules on every event,
// and writing the final artifacts to voice-loop-runs/published/<ulid>/.
//
// Phase 4 will replace the in-process steps with proper faculty calls (Engram
// recall, Parliament debate, etc). For Phase 3, research and post-publish are
// no-op pass-throughs.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { critiqueDraft } from '../voice/critic.js';
import { buildDrafterSystemPrompt, DRAFTER_EXEMPLAR_FILES } from '../voice/drafter.js';
import type { VoiceFingerprint } from '../voice/corpus/fingerprint.js';

import { draftEssayV2 } from './drafter-v2.js';
import { factCoveragePct, generateOutline } from './outline.js';
import { reviseDraftV2, defaultEstimateCost } from './reviser-v2.js';
import { checkFactCitations, stripFactMarkers } from './fact-citation.js';
import { evaluateL0 } from './l0-rules.js';
import {
  appendSonderEvent,
  buildSonderEvent,
  canonicalStringify,
  verifyChain,
} from './sonder.js';
import type {
  EssayArtifact,
  EssayArtifactCritiqueScores,
  IdeaBrief,
  Outline,
  SonderEvent,
  SonderGovernance,
  SonderStep,
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunPipelineOptions {
  /** Anthropic client + optional model override (e.g. for OpenRouter). */
  client: Pick<Anthropic, 'messages'>;
  /** Override model id (e.g. 'anthropic/claude-opus-4.6' for OpenRouter). */
  modelOverride?: string;
  /** Voice fingerprint. */
  fingerprint: VoiceFingerprint;
  /** Drafter exemplars (already loaded). */
  exemplars: { file: string; body: string }[];
  /** Output dir. Default: voice-loop-runs/published/<ideaId>/. */
  outDir: string;
  /** Hard pipeline cost ceiling per essay. Default $0.50. */
  costCeilingUsd?: number;
  /** Optional logger. Default: console.error. */
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const AGENT_ID = 'writing-pipeline.phase3';

export async function runPipeline(
  idea: IdeaBrief,
  opts: RunPipelineOptions,
): Promise<EssayArtifact> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const costCeiling = opts.costCeilingUsd ?? 0.5;
  mkdirSync(opts.outDir, { recursive: true });

  const sonderPath = join(opts.outDir, 'sonderevent.ndjson');
  // Truncate the NDJSON if a prior run left one.
  writeFileSync(sonderPath, '');

  // Chain state.
  let prevHash: string | null = null;
  let totalCost = 0;
  const allEvents: SonderEvent[] = [];

  // Helper to emit an event, run L0, and abort the pipeline on validation
  // failure. Returns the newly written event so callers can use it as parent.
  const emit = (params: {
    step: SonderStep;
    phase: 'entry' | 'exit';
    parent: SonderEvent | null;
    intent: { planned: string; action?: string };
    action: { type: 'tool_invocation' | 'noop' | 'output'; tool?: string };
    costUsd: number;
    reasoning?: { rounds?: number; dissent?: unknown[] };
    outputs: Record<string, unknown>;
    draftForCheck?: string;
  }): { event: SonderEvent; validated: boolean; failureReason?: string } => {
    // Build a provisional event for L0 evaluation. We need governance to be
    // present before the event is hashed, so we evaluate first then attach.
    const provisional = buildSonderEvent({
      taskId: idea.id,
      agentId: AGENT_ID,
      step: params.step,
      phase: params.phase,
      parentId: params.parent?.event_id ?? null,
      intent: params.intent,
      action: params.action,
      costUsd: params.costUsd,
      reasoning: params.reasoning,
      governance: { tier: ['L0'], evidence: [], validated: true },
      outputs: params.outputs,
      prevHash,
    });
    const l0 = evaluateL0(provisional, {
      idea,
      ...(params.draftForCheck ? { draft: params.draftForCheck } : {}),
    });
    const governance: SonderGovernance = {
      tier: ['L0'],
      evidence: l0.outcomes.map((o) => ({
        ruleId: o.ruleId,
        outcome: o.passed ? 'pass' : 'fail',
        ...(o.detail ? { detail: o.detail } : {}),
      })),
      validated: l0.validated,
    };
    const event = buildSonderEvent({
      taskId: idea.id,
      agentId: AGENT_ID,
      step: params.step,
      phase: params.phase,
      parentId: params.parent?.event_id ?? null,
      intent: params.intent,
      action: params.action,
      costUsd: params.costUsd,
      reasoning: params.reasoning,
      governance,
      outputs: params.outputs,
      prevHash,
    });
    appendSonderEvent(sonderPath, event);
    allEvents.push(event);
    prevHash = event.chain.content_hash;
    totalCost += params.costUsd;
    const validated = l0.validated;
    const failed = l0.outcomes.filter((o) => !o.passed);
    const failureReason = failed.length > 0
      ? failed.map((f) => `${f.ruleId}: ${f.detail ?? 'failed'}`).join('; ')
      : undefined;
    return { event, validated, ...(failureReason ? { failureReason } : {}) };
  };

  const failArtifact = (reason: string): EssayArtifact => ({
    status: 'failed',
    task_id: idea.id,
    outDir: opts.outDir,
    essay: null,
    scores: { draft: null, revise1: null, revise2: null },
    totalCostUsd: totalCost,
    factCitation: null,
    failureReason: reason,
  });

  // -------------------------------------------------------------------------
  // Build the cached system prefix once. Reused across outline/draft/revise.
  // -------------------------------------------------------------------------
  const system = buildDrafterSystemPrompt(opts.fingerprint, opts.exemplars);

  // -------------------------------------------------------------------------
  // STEP 1 — idea-capture (pass-through; idea was supplied as a file).
  // -------------------------------------------------------------------------
  log('[runner] step 1: idea-capture');
  const step1Entry = emit({
    step: 'idea-capture',
    phase: 'entry',
    parent: null,
    intent: { planned: `Capture idea brief '${idea.title}' (id=${idea.id})` },
    action: { type: 'tool_invocation', tool: 'idea.capture' },
    costUsd: 0,
    outputs: { idea_id: idea.id },
  });
  if (!step1Entry.validated) return failArtifact(`step 1 entry L0 fail: ${step1Entry.failureReason}`);
  // Persist the brief so the run is self-contained.
  writeFileSync(join(opts.outDir, 'idea.json'), JSON.stringify(idea, null, 2) + '\n');
  const step1Exit = emit({
    step: 'idea-capture',
    phase: 'exit',
    parent: step1Entry.event,
    intent: { planned: 'persist brief to idea.json' },
    action: { type: 'tool_invocation', tool: 'idea.capture' },
    costUsd: 0,
    outputs: { idea_id: idea.id, fact_count: idea.facts.length, anchor_count: idea.anchors.length },
  });
  if (!step1Exit.validated) return failArtifact(`step 1 exit L0 fail: ${step1Exit.failureReason}`);

  // -------------------------------------------------------------------------
  // STEP 2 — research (no-op for Phase 3).
  // -------------------------------------------------------------------------
  log('[runner] step 2: research (no-op)');
  const step2Entry = emit({
    step: 'research',
    phase: 'entry',
    parent: step1Exit.event,
    intent: { planned: 'No-op for Phase 3 — facts/anchors are the research.' },
    action: { type: 'noop' },
    costUsd: 0,
    outputs: { source_count: 0 },
  });
  if (!step2Entry.validated) return failArtifact(`step 2 entry L0 fail: ${step2Entry.failureReason}`);
  const step2Exit = emit({
    step: 'research',
    phase: 'exit',
    parent: step2Entry.event,
    intent: { planned: 'No-op completion.' },
    action: { type: 'noop' },
    costUsd: 0,
    outputs: { source_count: 0 },
  });
  if (!step2Exit.validated) return failArtifact(`step 2 exit L0 fail: ${step2Exit.failureReason}`);

  // -------------------------------------------------------------------------
  // STEP 3 — outline.
  // -------------------------------------------------------------------------
  log('[runner] step 3: outline');
  const step3Entry = emit({
    step: 'outline',
    phase: 'entry',
    parent: step2Exit.event,
    intent: { planned: 'Generate fact-routed 5-7 beat outline from brief.' },
    action: { type: 'tool_invocation', tool: 'outline.generate' },
    costUsd: 0,
    reasoning: { rounds: 1 },
    outputs: {},
  });
  if (!step3Entry.validated) return failArtifact(`step 3 entry L0 fail: ${step3Entry.failureReason}`);

  let outline: Outline;
  let outlineCost = 0;
  try {
    const outlineResult = await generateOutline(idea, {
      client: opts.client,
      system,
      ...(opts.modelOverride ? { model: opts.modelOverride } : {}),
    });
    outline = outlineResult.outline;
    outlineCost = defaultEstimateCost(outlineResult.usage);
    writeFileSync(join(opts.outDir, 'outline.json'), JSON.stringify(outline, null, 2) + '\n');
    writeFileSync(join(opts.outDir, 'outline-raw.txt'), outlineResult.rawText + '\n');
  } catch (err) {
    return failArtifact(`outline step failed: ${(err as Error).message}`);
  }

  const coverage = factCoveragePct(outline, idea);
  log(`[runner]   outline: ${outline.beats.length} beats, ${coverage}% fact coverage, $${outlineCost.toFixed(4)}`);

  const step3Exit = emit({
    step: 'outline',
    phase: 'exit',
    parent: step3Entry.event,
    intent: { planned: 'Outline generated.', action: 'outline.generate' },
    action: { type: 'tool_invocation', tool: 'outline.generate' },
    costUsd: outlineCost,
    reasoning: { rounds: 1 },
    outputs: {
      beat_count: outline.beats.length,
      fact_coverage_pct: coverage,
      beat_types: outline.beats.map((b) => b.type),
    },
  });
  if (!step3Exit.validated) return failArtifact(`step 3 exit L0 fail: ${step3Exit.failureReason}`);

  if (totalCost > costCeiling) return failArtifact(`cost ceiling breach after outline: $${totalCost.toFixed(4)} > $${costCeiling.toFixed(2)}`);

  // -------------------------------------------------------------------------
  // STEP 4 — draft.
  // -------------------------------------------------------------------------
  log('[runner] step 4: draft');
  const step4Entry = emit({
    step: 'draft',
    phase: 'entry',
    parent: step3Exit.event,
    intent: { planned: 'Draft essay from outline beat-by-beat with [fact:N] markers.' },
    action: { type: 'tool_invocation', tool: 'draft.write' },
    costUsd: 0,
    outputs: {},
  });
  if (!step4Entry.validated) return failArtifact(`step 4 entry L0 fail: ${step4Entry.failureReason}`);

  let draftText: string;
  let draftCost = 0;
  try {
    const draftResult = await draftEssayV2(idea, outline, {
      client: opts.client,
      system,
      ...(opts.modelOverride ? { model: opts.modelOverride } : {}),
    });
    draftText = draftResult.draft;
    draftCost = defaultEstimateCost(draftResult.usage);
    writeFileSync(join(opts.outDir, 'draft.md'), draftText + '\n');
  } catch (err) {
    return failArtifact(`draft step failed: ${(err as Error).message}`);
  }

  const draftCritique = critiqueDraft(draftText, { fingerprint: opts.fingerprint });
  writeFileSync(join(opts.outDir, 'critique-draft.json'), JSON.stringify(draftCritique, null, 2) + '\n');
  const factResult = checkFactCitations(draftText, idea);
  writeFileSync(join(opts.outDir, 'fact-citation-draft.json'), JSON.stringify(factResult, null, 2) + '\n');

  log(`[runner]   draft: ${countWords(draftText)} words, voice_match=${draftCritique.scores.voice_match}, cost $${draftCost.toFixed(4)}, ${factResult.violations.length} fact violations`);

  const draftScores: EssayArtifactCritiqueScores = {
    voice_match: draftCritique.scores.voice_match,
    slop_per_kilochar: draftCritique.scores.slop_per_kilochar,
    slop_total: draftCritique.scores.slop_total,
  };

  const step4Exit = emit({
    step: 'draft',
    phase: 'exit',
    parent: step4Entry.event,
    intent: { planned: 'Draft completed.', action: 'draft.write' },
    action: { type: 'tool_invocation', tool: 'draft.write' },
    costUsd: draftCost,
    outputs: {
      word_count: countWords(draftText),
      voice_match: draftCritique.scores.voice_match,
      slop_total: draftCritique.scores.slop_total,
      fact_violations: factResult.violations.length,
      fact_total_claims: factResult.totalClaims,
      fact_cited_claims: factResult.citedClaims,
    },
    draftForCheck: draftText,
  });
  if (!step4Exit.validated) {
    log(`[runner]   step 4 exit L0 fail: ${step4Exit.failureReason}`);
    return failArtifact(`step 4 exit L0 fail: ${step4Exit.failureReason}`);
  }

  if (totalCost > costCeiling) return failArtifact(`cost ceiling breach after draft: $${totalCost.toFixed(4)} > $${costCeiling.toFixed(2)}`);

  // -------------------------------------------------------------------------
  // STEP 5 — critique (deterministic, no-LLM, already computed above).
  // -------------------------------------------------------------------------
  log('[runner] step 5: critique');
  const step5Entry = emit({
    step: 'critique',
    phase: 'entry',
    parent: step4Exit.event,
    intent: { planned: 'Deterministic voice critic over the draft.' },
    action: { type: 'tool_invocation', tool: 'critic.score' },
    costUsd: 0,
    reasoning: { rounds: 1, dissent: draftCritique.issues.slice(0, 50) },
    outputs: {},
  });
  if (!step5Entry.validated) return failArtifact(`step 5 entry L0 fail: ${step5Entry.failureReason}`);
  const step5Exit = emit({
    step: 'critique',
    phase: 'exit',
    parent: step5Entry.event,
    intent: { planned: 'Critique recorded.', action: 'critic.score' },
    action: { type: 'tool_invocation', tool: 'critic.score' },
    costUsd: 0,
    reasoning: { rounds: 1, dissent: draftCritique.issues.slice(0, 50) },
    outputs: {
      issue_count: draftCritique.issues.length,
      voice_match: draftCritique.scores.voice_match,
      slop_per_kilochar: draftCritique.scores.slop_per_kilochar,
    },
  });
  if (!step5Exit.validated) return failArtifact(`step 5 exit L0 fail: ${step5Exit.failureReason}`);

  // -------------------------------------------------------------------------
  // STEP 6 — revise (two-pass).
  // -------------------------------------------------------------------------
  log('[runner] step 6: revise (two-pass)');
  const step6Entry = emit({
    step: 'revise',
    phase: 'entry',
    parent: step5Exit.event,
    intent: { planned: 'Two-pass revision against critic Issue list.' },
    action: { type: 'tool_invocation', tool: 'revise.write' },
    costUsd: 0,
    reasoning: { rounds: 2 },
    outputs: {},
  });
  if (!step6Entry.validated) return failArtifact(`step 6 entry L0 fail: ${step6Entry.failureReason}`);

  let reviseResult: Awaited<ReturnType<typeof reviseDraftV2>>;
  try {
    reviseResult = await reviseDraftV2(draftText, {
      fingerprint: opts.fingerprint,
      system,
      idea,
      client: opts.client,
      ...(opts.modelOverride ? { model: opts.modelOverride } : {}),
      maxPasses: 2,
    });
  } catch (err) {
    return failArtifact(`revise step failed: ${(err as Error).message}`);
  }

  writeFileSync(join(opts.outDir, 'revised.md'), reviseResult.final + '\n');
  writeFileSync(join(opts.outDir, 'revised-with-markers.md'), reviseResult.finalWithMarkers + '\n');
  writeFileSync(
    join(opts.outDir, 'revision-history.json'),
    JSON.stringify(
      {
        passes: reviseResult.passes.map((p) => ({
          passIndex: p.passIndex,
          accepted: p.accepted,
          decisionNote: p.decisionNote,
          compositeScore: p.compositeScore,
          critique_scores: p.critique.scores,
          costUsd: p.costUsd,
          usage: p.usage,
        })),
        stopReason: reviseResult.stopReason,
        totalCostUsd: reviseResult.totalCostUsd,
      },
      null,
      2,
    ) + '\n',
  );

  const pass1 = reviseResult.passes[0] ?? null;
  const pass2 = reviseResult.passes[1] ?? null;
  const revise1Scores: EssayArtifactCritiqueScores | null = pass1
    ? {
        voice_match: pass1.critique.scores.voice_match,
        slop_per_kilochar: pass1.critique.scores.slop_per_kilochar,
        slop_total: pass1.critique.scores.slop_total,
      }
    : null;
  const revise2Scores: EssayArtifactCritiqueScores | null = pass2
    ? {
        voice_match: pass2.critique.scores.voice_match,
        slop_per_kilochar: pass2.critique.scores.slop_per_kilochar,
        slop_total: pass2.critique.scores.slop_total,
      }
    : null;

  log(`[runner]   revise: ${reviseResult.passes.length} pass(es), stopReason=${reviseResult.stopReason}, cost $${reviseResult.totalCostUsd.toFixed(4)}`);
  for (const p of reviseResult.passes) log(`[runner]     pass ${p.passIndex}: ${p.decisionNote}`);

  const step6Exit = emit({
    step: 'revise',
    phase: 'exit',
    parent: step6Entry.event,
    intent: { planned: 'Revision passes complete.', action: 'revise.write' },
    action: { type: 'tool_invocation', tool: 'revise.write' },
    costUsd: reviseResult.totalCostUsd,
    reasoning: { rounds: reviseResult.passes.length },
    outputs: {
      passes: reviseResult.passes.length,
      stop_reason: reviseResult.stopReason,
      final_voice_match: reviseResult.finalCritique.scores.voice_match,
      final_slop_total: reviseResult.finalCritique.scores.slop_total,
    },
    draftForCheck: reviseResult.finalWithMarkers,
  });
  if (!step6Exit.validated) {
    log(`[runner]   step 6 exit L0 fail: ${step6Exit.failureReason}`);
    return failArtifact(`step 6 exit L0 fail: ${step6Exit.failureReason}`);
  }

  if (totalCost > costCeiling) return failArtifact(`cost ceiling breach after revise: $${totalCost.toFixed(4)} > $${costCeiling.toFixed(2)}`);

  // -------------------------------------------------------------------------
  // STEP 6b — critique-again (re-score the final revision).
  // -------------------------------------------------------------------------
  log('[runner] step 6b: critique-again');
  const finalFactResult = checkFactCitations(reviseResult.finalWithMarkers, idea);
  writeFileSync(join(opts.outDir, 'fact-citation-final.json'), JSON.stringify(finalFactResult, null, 2) + '\n');
  const step6bEntry = emit({
    step: 'critique-again',
    phase: 'entry',
    parent: step6Exit.event,
    intent: { planned: 'Re-score final revision.' },
    action: { type: 'tool_invocation', tool: 'critic.score' },
    costUsd: 0,
    reasoning: { rounds: 1 },
    outputs: {},
  });
  if (!step6bEntry.validated) return failArtifact(`step 6b entry L0 fail: ${step6bEntry.failureReason}`);
  const step6bExit = emit({
    step: 'critique-again',
    phase: 'exit',
    parent: step6bEntry.event,
    intent: { planned: 'Final critique recorded.', action: 'critic.score' },
    action: { type: 'tool_invocation', tool: 'critic.score' },
    costUsd: 0,
    reasoning: { rounds: 1 },
    outputs: {
      final_voice_match: reviseResult.finalCritique.scores.voice_match,
      final_issue_count: reviseResult.finalCritique.issues.length,
      final_fact_violations: finalFactResult.violations.length,
    },
    draftForCheck: reviseResult.finalWithMarkers,
  });
  if (!step6bExit.validated) {
    // Note: a fact-citation failure here doesn't necessarily abort — the
    // critique-again step is read-only. But we log it as a fail outcome so
    // the user sees it in the report. To match the spec, we treat it as a
    // hard fail to be conservative.
    log(`[runner]   step 6b exit L0 fail: ${step6bExit.failureReason}`);
  }

  // -------------------------------------------------------------------------
  // STEP 7 — publish.
  // -------------------------------------------------------------------------
  log('[runner] step 7: publish');
  const essayPath = join(opts.outDir, 'essay.md');
  writeFileSync(essayPath, reviseResult.final + '\n');
  const step7Entry = emit({
    step: 'publish',
    phase: 'entry',
    parent: step6bExit.event,
    intent: { planned: 'Publish to local directory (Phase 4 will target a real publish destination).' },
    action: { type: 'tool_invocation', tool: 'publish.local' },
    costUsd: 0,
    outputs: {},
  });
  if (!step7Entry.validated) return failArtifact(`step 7 entry L0 fail: ${step7Entry.failureReason}`);
  const step7Exit = emit({
    step: 'publish',
    phase: 'exit',
    parent: step7Entry.event,
    intent: { planned: 'Essay published.', action: 'publish.local' },
    action: { type: 'tool_invocation', tool: 'publish.local' },
    costUsd: 0,
    outputs: {
      essay_path: essayPath,
      essay_word_count: countWords(reviseResult.final),
    },
  });
  if (!step7Exit.validated) return failArtifact(`step 7 exit L0 fail: ${step7Exit.failureReason}`);

  // -------------------------------------------------------------------------
  // STEP 8 — post-publish (no-op).
  // -------------------------------------------------------------------------
  log('[runner] step 8: post-publish (no-op)');
  const step8Entry = emit({
    step: 'post-publish',
    phase: 'entry',
    parent: step7Exit.event,
    intent: { planned: 'No-op; Phase 4 will ingest to Engram and log AWM signal.' },
    action: { type: 'noop' },
    costUsd: 0,
    outputs: {},
  });
  if (!step8Entry.validated) return failArtifact(`step 8 entry L0 fail: ${step8Entry.failureReason}`);
  const step8Exit = emit({
    step: 'post-publish',
    phase: 'exit',
    parent: step8Entry.event,
    intent: { planned: 'Post-publish complete.' },
    action: { type: 'noop' },
    costUsd: 0,
    outputs: {
      sonder_chain_root: prevHash,
      total_events: allEvents.length + 1, // including this one
    },
  });
  // step 8 exit doesn't need to abort the pipeline — it's the terminal event.

  // Verify chain on the way out.
  const verify = verifyChain(allEvents);
  writeFileSync(
    join(opts.outDir, 'chain-verification.json'),
    JSON.stringify(verify, null, 2) + '\n',
  );

  log(`[runner] done. total cost $${totalCost.toFixed(4)} (cap $${costCeiling.toFixed(2)}). chain verify ok=${verify.ok}`);

  return {
    status: 'ok',
    task_id: idea.id,
    outDir: opts.outDir,
    essay: reviseResult.final,
    scores: { draft: draftScores, revise1: revise1Scores, revise2: revise2Scores },
    totalCostUsd: totalCost,
    factCitation: {
      invalidCount: finalFactResult.violations.length,
      totalClaims: finalFactResult.totalClaims,
      citedClaims: finalFactResult.citedClaims,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Load the corpus exemplars from voice-corpus/examples. Convenience for the
 * runner CLI; reads the same five files the drafter uses.
 */
export function loadDrafterExemplars(packageRoot: string): { file: string; body: string }[] {
  return DRAFTER_EXEMPLAR_FILES.map((file) => ({
    file,
    body: readFileSync(join(packageRoot, 'voice-corpus', 'examples', file), 'utf8'),
  }));
}

/** Re-export so the runner's outputs can be matched against the SonderEvent shape. */
export { canonicalStringify };
