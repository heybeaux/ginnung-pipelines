// SonderEvent builder + chain hashing + NDJSON writer.
//
// Phase 3 vendors a minimal SonderEvent struct (see types.ts) instead of
// importing from a not-yet-published sonder SDK package. Chain hashing is
// SHA-256 of canonical JSON content; signing is a placeholder string until
// Phase 4 wires ed25519.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { generateUlid } from './idea-brief.js';
import type {
  SonderAction,
  SonderEvent,
  SonderGovernance,
  SonderIntent,
  SonderMemory,
  SonderPhase,
  SonderReasoning,
  SonderStep,
} from './types.js';

export interface BuildSonderEventInput {
  taskId: string;
  agentId: string;
  step: SonderStep;
  phase: SonderPhase;
  parentId: string | null;
  intent: SonderIntent;
  action: SonderAction;
  costUsd: number;
  reasoning?: Partial<SonderReasoning>;
  memory?: Partial<SonderMemory>;
  governance: SonderGovernance;
  outputs: Record<string, unknown>;
  /** prev_hash for the chain — caller must supply. Null for the first event. */
  prevHash: string | null;
}

/**
 * Build a fully-populated SonderEvent and compute its content hash. The
 * caller must persist the returned object (e.g. with `appendSonderEvent`).
 */
export function buildSonderEvent(input: BuildSonderEventInput): SonderEvent {
  const event_id = generateUlid();
  const timestamp = new Date().toISOString();
  const eventBase: Omit<SonderEvent, 'chain' | 'signature'> = {
    event_id,
    task_id: input.taskId,
    parent_id: input.parentId,
    agent_id: input.agentId,
    step: input.step,
    phase: input.phase,
    timestamp,
    intent: input.intent,
    action: input.action,
    capability: { cost_usd: round4(input.costUsd) },
    reasoning: {
      rounds: input.reasoning?.rounds ?? 0,
      dissent: input.reasoning?.dissent ?? [],
    },
    memory: {
      refs: input.memory?.refs ?? [],
      ...(input.memory?.recalled_ids ? { recalled_ids: input.memory.recalled_ids } : {}),
    },
    governance: input.governance,
    outputs: input.outputs,
    prediction: { outcome: null, status: 'not-implemented', version: 'le-wm-stub-v0' },
  };
  const content_hash = computeContentHash(eventBase);
  return {
    ...eventBase,
    chain: {
      prev_hash: input.prevHash,
      content_hash,
    },
    // Phase 3 placeholder. Phase 4 replaces with ed25519 detached signature
    // over the canonical event bytes.
    signature: 'phase3-unsigned-v0',
  };
}

/**
 * Compute the sha256 content hash over the canonical event (event before
 * chain + signature were attached). The hash binds every field of the event
 * EXCEPT chain and signature — the chain is what links events, and signature
 * is computed over (event ++ chain).
 */
export function computeContentHash(event: Omit<SonderEvent, 'chain' | 'signature'>): string {
  const canonical = canonicalStringify(event);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonical JSON: sorted keys at every object depth so the same logical event
 * produces the same hash regardless of source key ordering.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value as object).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

/**
 * Append a single SonderEvent to the NDJSON log at `path`. Events are written
 * one-per-line, canonical key ordering for byte stability.
 */
export function appendSonderEvent(path: string, event: SonderEvent): void {
  const line = canonicalStringify(event) + '\n';
  appendFileSync(path, line, 'utf8');
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Chain verifier (used by scripts/verify-chain.ts and tests)
// ---------------------------------------------------------------------------

export interface ChainVerificationResult {
  ok: boolean;
  totalEvents: number;
  errors: { eventIndex: number; eventId: string; error: string }[];
}

/**
 * Walk an array of SonderEvents in order. For each event, recompute the
 * content hash and check that:
 *   - the recomputed hash matches the persisted content_hash
 *   - the prev_hash points to the previous event's content_hash (or null for
 *     the first event)
 */
export function verifyChain(events: SonderEvent[]): ChainVerificationResult {
  const errors: ChainVerificationResult['errors'] = [];
  let prevHash: string | null = null;
  events.forEach((e, idx) => {
    // Strip chain + signature for the recompute.
    const base: Omit<SonderEvent, 'chain' | 'signature'> = {
      event_id: e.event_id,
      task_id: e.task_id,
      parent_id: e.parent_id,
      agent_id: e.agent_id,
      step: e.step,
      phase: e.phase,
      timestamp: e.timestamp,
      intent: e.intent,
      action: e.action,
      capability: e.capability,
      reasoning: e.reasoning,
      memory: e.memory,
      governance: e.governance,
      outputs: e.outputs,
      prediction: e.prediction,
    };
    const recomputed = computeContentHash(base);
    if (recomputed !== e.chain.content_hash) {
      errors.push({
        eventIndex: idx,
        eventId: e.event_id,
        error: `content_hash mismatch: stored=${e.chain.content_hash}, recomputed=${recomputed}`,
      });
    }
    if (e.chain.prev_hash !== prevHash) {
      errors.push({
        eventIndex: idx,
        eventId: e.event_id,
        error: `prev_hash mismatch: stored=${e.chain.prev_hash}, expected=${prevHash}`,
      });
    }
    prevHash = e.chain.content_hash;
  });
  return {
    ok: errors.length === 0,
    totalEvents: events.length,
    errors,
  };
}

// Re-export for callers.
export { randomBytes };
