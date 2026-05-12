// Tests for the no_invented_first_person_facts L0 rule.
//
// Six concrete cases + one .todo for the Phase 4 semantic-check escape hatch.

import { describe, it, expect } from 'vitest';

import {
  checkFactCitations,
  stripFactMarkers,
} from '../../src/orchestration/fact-citation.js';
import type { IdeaBrief } from '../../src/orchestration/types.js';

const baseIdea: Pick<IdeaBrief, 'facts'> = {
  facts: [
    'I am 5\'11"',
    'My grandfather is named John',
    'I live in Brisbane',
    'I have a brother',
    'I am 35 years old',
  ],
};

describe('checkFactCitations', () => {
  it('fails when a height is asserted without a [fact:N] marker', () => {
    const draft = "Standing 6'2 in the kitchen, I poured coffee.";
    // No "I am/I'm" pattern present, so height regex shouldn't match this
    // particular phrasing. Use a phrasing that DOES match:
    const draft2 = "I'm 6'2 in flat shoes, which is taller than I look.";
    const r = checkFactCitations(draft2, baseIdea);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    expect(r.violations[0]!.kind).toBe('height');
    expect(r.totalClaims).toBeGreaterThanOrEqual(1);
    expect(r.citedClaims).toBe(0);
  });

  it("passes when the height has a valid [fact:N] marker", () => {
    const draft = "I am 5'11\" [fact:0] in flat shoes.";
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations).toHaveLength(0);
    expect(r.totalClaims).toBe(1);
    expect(r.citedClaims).toBe(1);
  });

  it("fails when the [fact:N] marker points to an out-of-range index", () => {
    const draft = "I am 5'11\" [fact:99] in flat shoes.";
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    // Two violations expected: the invalid_index from the marker sweep AND
    // the height claim (since the marker is invalid, the claim is uncited).
    expect(r.violations.some((v) => v.kind === 'invalid_index')).toBe(true);
    expect(r.violations.some((v) => v.kind === 'height')).toBe(true);
  });

  it('fails when a named relationship lacks a marker', () => {
    const draft = 'My brother Tom called me yesterday.';
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    // named_person is the more-specific pattern; relationship is suppressed
    // for the same offset.
    expect(r.violations.some((v) => v.kind === 'named_person')).toBe(true);
  });

  it('passes a place-visited claim with a valid marker', () => {
    const draft = 'I went to Brisbane [fact:2] last weekend.';
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations).toHaveLength(0);
    expect(r.totalClaims).toBe(1);
    expect(r.citedClaims).toBe(1);
  });

  it('fails on a "my dad" relationship claim without a marker', () => {
    const draft = 'My dad always said the same thing.';
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    expect(r.violations.some((v) => v.kind === 'relationship')).toBe(true);
  });

  it('returns 0 violations on a draft with no first-person factual claims', () => {
    const draft =
      'Multi-agent systems fail 87% of the time. The MAST paper studied 1600+ traces.';
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations).toHaveLength(0);
    expect(r.totalClaims).toBe(0);
  });

  it('accepts multiple cited claims in one draft', () => {
    const draft =
      "I am 5'11\" [fact:0] and I live in Brisbane [fact:2]. My grandfather John [fact:1] was a quiet man.";
    const r = checkFactCitations(draft, baseIdea);
    expect(r.violations).toHaveLength(0);
    expect(r.totalClaims).toBeGreaterThanOrEqual(2);
    expect(r.citedClaims).toBe(r.totalClaims);
  });

  // Phase 4: semantic-check escape hatch.
  // The current rule treats "I'm five eleven" as uncited even if facts[]
  // contains the equivalent "I am 5'11"". Phase 4 will add an embedding-
  // based semantic match. For Phase 3 we accept the false positive and the
  // user is told to over-specify or paraphrase to match.
  it.todo(
    'PHASE 4: paraphrased fact ("I am five eleven") cites "5\'11"" semantically',
  );
});

describe('stripFactMarkers', () => {
  it('removes [fact:N] markers and the preceding single space', () => {
    const input = "I am 5'11\" [fact:0] and I live in Brisbane [fact:2].";
    const out = stripFactMarkers(input);
    expect(out).toBe("I am 5'11\" and I live in Brisbane.");
  });

  it('leaves text without markers unchanged', () => {
    const input = 'Multi-agent systems fail 87% of the time.';
    expect(stripFactMarkers(input)).toBe(input);
  });

  it('handles markers at end-of-line', () => {
    const input = "I am 35 [fact:4]\nand counting.";
    expect(stripFactMarkers(input)).toBe('I am 35\nand counting.');
  });
});
