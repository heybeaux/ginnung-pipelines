// SonderEvent build + chain hash + verifyChain tests.
//
// These lock the canonical-stringify contract (sorted keys at every depth)
// and the prev_hash linkage rules so the audit chain is verifiable across
// runs and across machines.

import { describe, it, expect } from 'vitest';

import {
  buildSonderEvent,
  canonicalStringify,
  computeContentHash,
  verifyChain,
} from '../../src/orchestration/sonder.js';
import type {
  SonderAction,
  SonderEvent,
  SonderGovernance,
  SonderIntent,
} from '../../src/orchestration/types.js';

const intent: SonderIntent = { planned: 'do a thing' };
const action: SonderAction = { type: 'noop' };
const governance: SonderGovernance = {
  tier: ['L0'],
  evidence: [],
  validated: true,
};

function makeEvent(overrides: Partial<Parameters<typeof buildSonderEvent>[0]> = {}) {
  return buildSonderEvent({
    taskId: 'task1',
    agentId: 'test',
    step: 'idea-capture',
    phase: 'entry',
    parentId: null,
    intent,
    action,
    costUsd: 0,
    governance,
    outputs: {},
    prevHash: null,
    ...overrides,
  });
}

describe('canonicalStringify', () => {
  it('sorts keys at every object depth', () => {
    const a = canonicalStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalStringify({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null and primitives', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(42)).toBe('42');
    expect(canonicalStringify('hello')).toBe('"hello"');
  });
});

describe('computeContentHash', () => {
  it('returns sha256:<hex> and is deterministic', () => {
    const e1 = makeEvent();
    const e2 = makeEvent();
    const base1 = stripChainSig(e1);
    const base2 = stripChainSig(e2);
    // event_id + timestamp differ, so hashes will differ across instances;
    // but the same base should hash identically twice.
    expect(computeContentHash(base1)).toBe(computeContentHash(base1));
    expect(computeContentHash(base1)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeContentHash(base2)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('buildSonderEvent', () => {
  it('populates chain.prev_hash and signature placeholder', () => {
    const a = makeEvent({ prevHash: null });
    expect(a.chain.prev_hash).toBeNull();
    expect(a.chain.content_hash).toMatch(/^sha256:/);
    expect(a.signature).toBe('phase3-unsigned-v0');

    const b = makeEvent({ prevHash: a.chain.content_hash });
    expect(b.chain.prev_hash).toBe(a.chain.content_hash);
  });

  it('rounds costUsd to 4 decimals', () => {
    const e = makeEvent({ costUsd: 0.123456789 });
    expect(e.capability.cost_usd).toBe(0.1235);
  });
});

describe('verifyChain', () => {
  it('passes for a well-formed sequence', () => {
    const e1 = makeEvent({ prevHash: null });
    const e2 = makeEvent({ prevHash: e1.chain.content_hash });
    const e3 = makeEvent({ prevHash: e2.chain.content_hash });
    const r = verifyChain([e1, e2, e3]);
    expect(r.ok).toBe(true);
    expect(r.totalEvents).toBe(3);
    expect(r.errors).toEqual([]);
  });

  it('detects content_hash tampering', () => {
    const e1 = makeEvent({ prevHash: null });
    // Mutate outputs without re-hashing.
    const tampered: SonderEvent = {
      ...e1,
      outputs: { tampered: true },
    };
    const r = verifyChain([tampered]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((er) => er.error.includes('content_hash mismatch'))).toBe(true);
  });

  it('detects broken prev_hash linkage', () => {
    const e1 = makeEvent({ prevHash: null });
    // e2 points at a fabricated prev_hash, not e1's content_hash.
    const e2 = makeEvent({ prevHash: 'sha256:deadbeef'.padEnd(71, '0') });
    const r = verifyChain([e1, e2]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((er) => er.error.includes('prev_hash mismatch'))).toBe(true);
  });

  it('detects a non-null prev_hash on the first event', () => {
    const e1 = makeEvent({ prevHash: 'sha256:' + 'a'.repeat(64) });
    const r = verifyChain([e1]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((er) => er.error.includes('prev_hash mismatch'))).toBe(true);
  });
});

function stripChainSig(e: SonderEvent): Omit<SonderEvent, 'chain' | 'signature'> {
  const { chain: _c, signature: _s, ...rest } = e;
  return rest;
}
