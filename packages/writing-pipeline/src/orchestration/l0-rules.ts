// L0 policy rules wired into the Phase 3 orchestration.
//
// The Lattice generalisation is deliberately deferred — Phase 3 keeps this
// package-local so we can iterate on rule shape without churning the lattice
// repo. A future phase pulls these into @heybeaux/lattice-core as proper
// PolicyRule kinds.
//
// Rules implemented:
//   - tool_in_allowlist        — $.action.tool is in the writing-pipeline allowlist
//   - no_pii_in_outputs        — regex-deny against $.outputs.payload
//   - budget_under_cap         — $.capability.cost_usd <= cap_per_step
//   - reasoning_rounds_capped  — $.reasoning.rounds <= cap_per_step_type
//   - intent_planned_before_action — when action.type==='tool_invocation',
//                                    intent.planned is non-empty
//   - no_invented_first_person_facts — Phase 3-specific (Track A1)

import { checkFactCitations } from './fact-citation.js';
import type { IdeaBrief, SonderEvent } from './types.js';

export interface L0CheckOutcome {
  ruleId: string;
  passed: boolean;
  detail?: string;
}

export interface L0EvaluationContext {
  /** The brief — needed for the fact-citation rule. */
  idea: IdeaBrief;
  /** The draft text (for fact-citation). Pass for draft/revise steps; omit otherwise. */
  draft?: string;
}

/** Tool allowlist for the writing pipeline. */
export const TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'idea.capture',
  'engram.recall',
  'engram.write',
  'engram.ingest',
  'web.fetch',
  'parliament.deliberate',
  'lcm.expand',
  'git.commit',
  'deploy.vercel',
  'awm.log',
  'model.complete',
  'outline.generate',
  'draft.write',
  'critic.score',
  'revise.write',
  'publish.local',
  'baseline.run',
]);

/** Per-step cost caps in USD. Drafter/outline/reviser get their own headroom. */
export const COST_CAPS: Record<string, number> = {
  'idea-capture': 0.05,
  research: 0.05,
  outline: 0.10,
  draft: 0.25,
  critique: 0.05,
  revise: 0.25,
  'critique-again': 0.05,
  publish: 0.05,
  'post-publish': 0.05,
};

/** Per-step reasoning-round caps. */
export const REASONING_CAPS: Record<string, number> = {
  outline: 3,
  draft: 1,
  critique: 1,
  revise: 2,
  'critique-again': 1,
};

const PII_PATTERNS: { name: string; re: RegExp }[] = [
  // Email — must have @ and a TLD.
  { name: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // US-style SSN: 3-2-4 digits.
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit-card-ish: 13-19 digit run.
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/g },
  // Phone numbers — international or US-style. Permissive but bounded.
  { name: 'phone', re: /\b(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g },
];

// ---------------------------------------------------------------------------
// Individual rule evaluators
// ---------------------------------------------------------------------------

export function ruleToolInAllowlist(event: Pick<SonderEvent, 'action'>): L0CheckOutcome {
  const tool = event.action.tool;
  if (event.action.type !== 'tool_invocation') {
    return { ruleId: 'tool_in_allowlist', passed: true, detail: 'non-tool action' };
  }
  if (!tool) {
    return {
      ruleId: 'tool_in_allowlist',
      passed: false,
      detail: 'tool_invocation event missing action.tool',
    };
  }
  const ok = TOOL_ALLOWLIST.has(tool);
  return {
    ruleId: 'tool_in_allowlist',
    passed: ok,
    detail: ok ? `tool '${tool}' allowed` : `tool '${tool}' not in allowlist`,
  };
}

export function ruleNoPiiInOutputs(event: Pick<SonderEvent, 'outputs'>): L0CheckOutcome {
  // Serialize outputs to text and scan with the PII regex set.
  const payload = JSON.stringify(event.outputs ?? {});
  for (const p of PII_PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(payload);
    if (m) {
      return {
        ruleId: 'no_pii_in_outputs',
        passed: false,
        detail: `${p.name} pattern matched: "${m[0].slice(0, 24)}..."`,
      };
    }
  }
  return { ruleId: 'no_pii_in_outputs', passed: true };
}

export function ruleBudgetUnderCap(
  event: Pick<SonderEvent, 'step' | 'capability'>,
): L0CheckOutcome {
  const cap = COST_CAPS[event.step] ?? 0.5;
  const cost = event.capability.cost_usd;
  const ok = cost <= cap;
  return {
    ruleId: 'budget_under_cap',
    passed: ok,
    detail: ok
      ? `cost ${cost.toFixed(4)} <= cap ${cap.toFixed(2)} for step '${event.step}'`
      : `cost ${cost.toFixed(4)} EXCEEDS cap ${cap.toFixed(2)} for step '${event.step}'`,
  };
}

export function ruleReasoningRoundsCapped(
  event: Pick<SonderEvent, 'step' | 'reasoning'>,
): L0CheckOutcome {
  const cap = REASONING_CAPS[event.step] ?? 5;
  const rounds = event.reasoning.rounds;
  const ok = rounds <= cap;
  return {
    ruleId: 'reasoning_rounds_capped',
    passed: ok,
    detail: ok
      ? `rounds ${rounds} <= cap ${cap}`
      : `rounds ${rounds} EXCEEDS cap ${cap}`,
  };
}

export function ruleIntentPlannedBeforeAction(
  event: Pick<SonderEvent, 'intent' | 'action'>,
): L0CheckOutcome {
  if (event.action.type !== 'tool_invocation') {
    return { ruleId: 'intent_planned_before_action', passed: true };
  }
  const ok = !!event.intent.planned && event.intent.planned.trim().length > 0;
  return {
    ruleId: 'intent_planned_before_action',
    passed: ok,
    detail: ok ? 'plan set' : 'tool_invocation with empty intent.planned',
  };
}

export function ruleNoInventedFirstPersonFacts(
  draft: string,
  idea: IdeaBrief,
): L0CheckOutcome {
  const r = checkFactCitations(draft, idea);
  if (r.violations.length === 0) {
    return {
      ruleId: 'no_invented_first_person_facts',
      passed: true,
      detail: `0 violations; ${r.citedClaims}/${r.totalClaims} first-person claims cited`,
    };
  }
  const first = r.violations[0]!;
  return {
    ruleId: 'no_invented_first_person_facts',
    passed: false,
    detail: `${r.violations.length} violation(s): ${first.kind} "${first.text}" — ${first.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Composite check applied at every step boundary
// ---------------------------------------------------------------------------

export interface L0Evaluation {
  validated: boolean;
  outcomes: L0CheckOutcome[];
}

/**
 * Evaluate the rule set that applies to every step. The fact-citation rule is
 * only evaluated on draft/revise steps (when `ctx.draft` is provided AND step
 * is draft|revise|critique-again).
 */
export function evaluateL0(
  event: SonderEvent,
  ctx: L0EvaluationContext,
): L0Evaluation {
  const outcomes: L0CheckOutcome[] = [];
  outcomes.push(ruleToolInAllowlist(event));
  outcomes.push(ruleNoPiiInOutputs(event));
  outcomes.push(ruleBudgetUnderCap(event));
  outcomes.push(ruleReasoningRoundsCapped(event));
  outcomes.push(ruleIntentPlannedBeforeAction(event));

  const stepNeedsFactCheck =
    (event.step === 'draft' ||
      event.step === 'revise' ||
      event.step === 'critique-again') &&
    event.phase === 'exit' &&
    typeof ctx.draft === 'string';
  if (stepNeedsFactCheck) {
    outcomes.push(ruleNoInventedFirstPersonFacts(ctx.draft!, ctx.idea));
  }

  return {
    validated: outcomes.every((o) => o.passed),
    outcomes,
  };
}
