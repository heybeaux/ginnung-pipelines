// IdeaBrief validation + loader.
//
// `loadIdeaBrief(path)` parses a JSON file from disk, validates required
// fields, and returns a typed IdeaBrief. Validation rules:
//   - id must be a non-empty string (ULID-shaped recommended but not enforced)
//   - title must be non-empty
//   - brief must be at least 100 characters
//   - facts must be a non-empty array of strings
//   - forbidden is allowed empty but recommended
//   - anchors may be empty

import { readFileSync } from 'node:fs';

import type { IdeaBrief } from './types.js';

export interface ValidationResult {
  ok: boolean;
  /** Field paths with violations. */
  errors: string[];
  /** Soft recommendations (no failure but caller should warn). */
  warnings: string[];
}

const BRIEF_MIN_CHARS = 100;

export function validateIdeaBrief(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['root is not an object'], warnings };
  }
  const o = raw as Record<string, unknown>;

  if (typeof o['id'] !== 'string' || !o['id']) errors.push('id: must be non-empty string');
  if (typeof o['title'] !== 'string' || !o['title']) errors.push('title: must be non-empty string');
  if (typeof o['brief'] !== 'string') {
    errors.push('brief: must be a string');
  } else if ((o['brief'] as string).trim().length < BRIEF_MIN_CHARS) {
    errors.push(`brief: must be at least ${BRIEF_MIN_CHARS} chars (got ${(o['brief'] as string).trim().length})`);
  }
  if (!Array.isArray(o['facts'])) {
    errors.push('facts: must be an array');
  } else {
    const arr = o['facts'] as unknown[];
    if (arr.length === 0) errors.push('facts: must be non-empty');
    arr.forEach((f, i) => {
      if (typeof f !== 'string' || !f.trim()) errors.push(`facts[${i}]: must be non-empty string`);
    });
  }
  if (!Array.isArray(o['anchors'])) {
    errors.push('anchors: must be an array (may be empty)');
  }
  if (!Array.isArray(o['forbidden'])) {
    errors.push('forbidden: must be an array (may be empty)');
  } else if ((o['forbidden'] as unknown[]).length === 0) {
    warnings.push('forbidden: empty — at least one prohibition is strongly recommended for ideas with hallucination risk');
  }

  // Optional fields — just type-check if present.
  if (o['register_hint'] !== undefined && typeof o['register_hint'] !== 'string') {
    errors.push('register_hint: must be a string or omitted');
  }
  if (o['voice'] !== undefined && typeof o['voice'] !== 'string') {
    errors.push('voice: must be a string or omitted');
  }
  if (o['thesis'] !== undefined && typeof o['thesis'] !== 'string') {
    errors.push('thesis: must be a string or omitted');
  }
  if (o['target'] !== undefined && typeof o['target'] !== 'string') {
    errors.push('target: must be a string or omitted');
  }
  if (o['target_word_count'] !== undefined && typeof o['target_word_count'] !== 'number') {
    errors.push('target_word_count: must be a number or omitted');
  }
  if (
    o['structural_preferences'] !== undefined &&
    !Array.isArray(o['structural_preferences'])
  ) {
    errors.push('structural_preferences: must be an array or omitted');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function loadIdeaBriefFromFile(path: string): IdeaBrief {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const r = validateIdeaBrief(raw);
  if (!r.ok) {
    throw new Error(
      `loadIdeaBriefFromFile: validation failed for ${path}:\n  - ${r.errors.join('\n  - ')}`,
    );
  }
  return raw as IdeaBrief;
}

/**
 * Generate a Crockford-base32 ULID-ish 26-char id. Not RFC compliant — the
 * pipeline needs uniqueness, not interoperability with other ULID libraries.
 */
export function generateUlid(now: number = Date.now()): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // 10 chars of timestamp (48 bits ~ 281 trillion ms since epoch).
  let ts = '';
  let n = now;
  for (let i = 0; i < 10; i++) {
    ts = alphabet[n % 32]! + ts;
    n = Math.floor(n / 32);
  }
  // 16 chars of randomness.
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += alphabet[Math.floor(Math.random() * 32)]!;
  }
  return ts + rand;
}
