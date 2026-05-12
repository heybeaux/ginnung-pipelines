// Tests for IdeaBrief validation and ULID generation.

import { describe, it, expect } from 'vitest';

import {
  validateIdeaBrief,
  generateUlid,
  loadIdeaBriefFromFile,
} from '../../src/orchestration/idea-brief.js';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '../..');

describe('validateIdeaBrief', () => {
  it('accepts a well-formed brief', () => {
    const brief = {
      id: '01HXTEST',
      title: 'Test',
      brief: 'A'.repeat(120),
      facts: ['I am a developer'],
      anchors: [],
      forbidden: ['no inventing names'],
    };
    const r = validateIdeaBrief(brief);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects when brief is too short', () => {
    const brief = {
      id: '01HXTEST',
      title: 'T',
      brief: 'too short',
      facts: ['x'],
      anchors: [],
      forbidden: [],
    };
    const r = validateIdeaBrief(brief);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('brief'))).toBe(true);
  });

  it('rejects when facts is empty', () => {
    const brief = {
      id: '01HXTEST',
      title: 'T',
      brief: 'A'.repeat(120),
      facts: [],
      anchors: [],
      forbidden: [],
    };
    const r = validateIdeaBrief(brief);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('facts'))).toBe(true);
  });

  it('warns (but accepts) empty forbidden array', () => {
    const brief = {
      id: '01HXTEST',
      title: 'T',
      brief: 'A'.repeat(120),
      facts: ['x'],
      anchors: [],
      forbidden: [],
    };
    const r = validateIdeaBrief(brief);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('rejects when root is not an object', () => {
    const r = validateIdeaBrief('not an object');
    expect(r.ok).toBe(false);
  });
});

describe('generateUlid', () => {
  it('produces a 26-character id', () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
  });

  it('produces sortable timestamp-prefixed ids', () => {
    const a = generateUlid(1_000_000_000_000);
    const b = generateUlid(1_000_000_000_001);
    // First 10 chars are timestamp — must be lexicographically increasing.
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
});

describe('loadIdeaBriefFromFile', () => {
  it('loads the lattice brief and returns a valid IdeaBrief', () => {
    const path = join(
      PACKAGE_ROOT,
      'voice-loop-runs',
      'ideas-real',
      '01-lattice-400-handoffs.json',
    );
    const idea = loadIdeaBriefFromFile(path);
    expect(idea.id).toBeTruthy();
    expect(idea.title).toBeTruthy();
    expect(idea.facts.length).toBeGreaterThan(0);
    expect(idea.forbidden.length).toBeGreaterThan(0);
  });
});
