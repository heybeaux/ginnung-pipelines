// Shared types for the Phase 3 orchestration: IdeaBrief, Outline, EssayArtifact,
// SonderEvent, and step kind enums.
//
// SonderEvent is vendored locally as a minimal struct matching the v2 schema
// spec; Phase 4 will replace this with the real Sonder SDK import once that
// package is published.

// ---------------------------------------------------------------------------
// IdeaBrief — the user-supplied structured input for an essay
// ---------------------------------------------------------------------------

export interface IdeaBriefComparisonArtifact {
  exists: boolean;
  path: string;
  note?: string;
}

export interface IdeaBrief {
  /** ULID — stable id for the brief and downstream artifacts. */
  id: string;
  /** Working title. */
  title: string;
  /** 2-5 sentences in the user's own framing. >= 100 chars. */
  brief: string;
  /** Lived facts, each citable. Non-empty. */
  facts: string[];
  /** Sensory or scene anchors. May be empty. */
  anchors: string[];
  /** Things the drafter must not invent. May be empty (but recommended). */
  forbidden: string[];
  /** Optional register hint for the drafter. */
  register_hint?:
    | 'travel'
    | 'introspective'
    | 'training'
    | 'short-punchy'
    | 'emotional';
  /** Optional voice constraint to apply as a hard system-prompt rule. */
  voice?: string;
  /** Optional thesis line. */
  thesis?: string;
  /** Optional publish target description. */
  target?: string;
  /** Optional target word count; drafter aims within ±15%. */
  target_word_count?: number;
  /** Optional structural preferences. */
  structural_preferences?: string[];
  /** Optional comparison artifact — a user's own draft of the same essay. */
  comparison_artifact?: IdeaBriefComparisonArtifact;
}

// ---------------------------------------------------------------------------
// Outline — fact-routed 5-7 beats
// ---------------------------------------------------------------------------

export type OutlineBeatType =
  | 'opener'
  | 'scene'
  | 'turn'
  | 'reflection'
  | 'closer';

export interface OutlineBeat {
  type: OutlineBeatType;
  summary: string;
  /** Indices into IdeaBrief.facts that this beat will use. */
  uses_facts: number[];
  /** Indices into IdeaBrief.anchors that this beat will use. */
  uses_anchors: number[];
}

export interface Outline {
  beats: OutlineBeat[];
}

// ---------------------------------------------------------------------------
// SonderEvent v2 (local minimal struct)
// ---------------------------------------------------------------------------

export type SonderStep =
  | 'idea-capture'
  | 'research'
  | 'outline'
  | 'draft'
  | 'critique'
  | 'revise'
  | 'critique-again'
  | 'publish'
  | 'post-publish';

export type SonderPhase = 'entry' | 'exit';

export interface SonderChain {
  prev_hash: string | null;
  /** Hash of this event's canonical content (computed at write time). */
  content_hash: string;
}

export interface SonderGovernanceEvidence {
  ruleId: string;
  outcome: 'pass' | 'fail';
  detail?: string;
}

export interface SonderGovernance {
  tier: string[];
  evidence: SonderGovernanceEvidence[];
  validated: boolean;
}

export interface SonderCapability {
  cost_usd: number;
}

export interface SonderReasoning {
  rounds: number;
  dissent: unknown[];
}

export interface SonderMemory {
  refs: string[];
  recalled_ids?: string[];
}

export interface SonderIntent {
  planned: string;
  action?: string;
}

export interface SonderAction {
  type: 'tool_invocation' | 'noop' | 'output';
  tool?: string;
}

export interface SonderEvent {
  /** Event id — ULID per event. */
  event_id: string;
  /** Task id — common to all events of one essay run. */
  task_id: string;
  /** Parent event id (the entry event for an exit event). */
  parent_id: string | null;
  /** Agent id — pipeline identifier. */
  agent_id: string;
  step: SonderStep;
  phase: SonderPhase;
  /** ISO8601 timestamp. */
  timestamp: string;
  intent: SonderIntent;
  action: SonderAction;
  capability: SonderCapability;
  reasoning: SonderReasoning;
  memory: SonderMemory;
  governance: SonderGovernance;
  /** Step outputs (per-step shape). */
  outputs: Record<string, unknown>;
  /** Le-WM prediction stub. */
  prediction: {
    outcome: null;
    status: 'not-implemented';
    version: 'le-wm-stub-v0';
  };
  /** Chain hashing per Sonder v2. */
  chain: SonderChain;
  /** Phase 3 placeholder. Real ed25519 signing lands in Phase 4. */
  signature: 'phase3-unsigned-v0';
}

// ---------------------------------------------------------------------------
// EssayArtifact — final pipeline output
// ---------------------------------------------------------------------------

export interface EssayArtifactCritiqueScores {
  voice_match: number;
  slop_per_kilochar: number;
  slop_total: number;
}

export interface EssayArtifact {
  /** Pipeline status. */
  status: 'ok' | 'failed';
  /** task_id (matches idea.id). */
  task_id: string;
  /** Where the artifacts were written. */
  outDir: string;
  /** Final essay text (markers stripped). */
  essay: string | null;
  /** Per-stage scores for the report. */
  scores: {
    draft: EssayArtifactCritiqueScores | null;
    revise1: EssayArtifactCritiqueScores | null;
    revise2: EssayArtifactCritiqueScores | null;
  };
  /** Aggregate cost in USD across drafter + outline + reviser. */
  totalCostUsd: number;
  /** Fact-citation pass/fail summary. */
  factCitation: {
    invalidCount: number;
    totalClaims: number;
    citedClaims: number;
  } | null;
  /** Failure reason if status === 'failed'. */
  failureReason?: string;
}
