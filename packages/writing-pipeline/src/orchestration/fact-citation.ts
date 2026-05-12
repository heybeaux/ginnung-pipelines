// no_invented_first_person_facts — Phase 3 L0 rule.
//
// Scans a draft for first-person factual claims (heights, ages, named persons,
// "I went to <place>", "my <relation>" terms) and requires each one to be
// immediately followed by a `[fact:N]` marker indexing into idea.facts[].
//
// Returns a structured result the orchestration runner uses to gate the draft
// and revise steps. The reviser strips the `[fact:N]` markers from the final
// output but they live in the intermediate draft artifacts so SonderEvent logs
// the citation chain.
//
// Scope of Phase 3:
// - Rule is intentionally rigid; semantic equivalence is NOT checked. A fact
//   listed as "I am 5'11"" with citation [fact:7] passes; the same height
//   written without [fact:7] fails even if the prose says "five eleven".
// - We're trading false-positives (over-strict matching) for the much worse
//   failure mode of silently inventing biographical detail. Phase 4 adds a
//   semantic check.

import type { IdeaBrief } from './types.js';

export interface FactCitationViolation {
  /** What category of first-person claim fired. */
  kind:
    | 'height'
    | 'age'
    | 'named_person'
    | 'place_visited'
    | 'relationship'
    | 'invalid_index';
  /** The matched span. */
  text: string;
  /** Character offset into the draft. */
  offset: number;
  /** Why this is a violation. */
  reason: string;
  /** The cited index if any (only set for kind === 'invalid_index'). */
  citedIndex?: number;
}

export interface FactCitationResult {
  /** All first-person factual claims found in the draft. */
  totalClaims: number;
  /** Claims that had a valid [fact:N] marker. */
  citedClaims: number;
  /** Violations — uncited claims or invalid indices. */
  violations: FactCitationViolation[];
  /** All [fact:N] markers found and their target indices. */
  citations: { index: number; offset: number; valid: boolean }[];
}

// ---------------------------------------------------------------------------
// Regex set for first-person factual patterns
// ---------------------------------------------------------------------------
//
// Each entry MUST match a first-person factual claim. The "look for [fact:N]
// after" check sweeps forward up to MARKER_WINDOW characters from the match
// end.
//
// kind decides the diagnostic shown when the claim is uncited.

interface PatternSpec {
  kind: FactCitationViolation['kind'];
  /** Must be global. */
  regex: RegExp;
}

const MARKER_WINDOW = 80;

const PATTERNS: PatternSpec[] = [
  // Heights: "I am 6'2"", "I'm 5 foot 11", "I stand 1.8m tall"
  {
    kind: 'height',
    regex: /\bI(?:'m| am| stand)\s+(?:\d{1,2}\s*(?:'|\u2019|foot|feet|ft)\s*\d{0,2}(?:\"|\u201D)?|\d(?:\.\d{1,2})?\s*m\b|\d{2,3}\s*cm\b)/gi,
  },
  // Ages: "I am 35", "I'm 42 years old", "at 30 I", "when I was 19"
  {
    kind: 'age',
    regex: /\b(?:I(?:'m| am)\s+\d{1,3}(?:\s+years?\s+old)?|when I was\s+\d{1,3}|at\s+\d{1,3}\s+I\b)/gi,
  },
  // Named persons attached to "my ___": "my brother Tom", "my friend Sarah",
  // "my dad John". Also handles "my late grandfather John".
  // The relationship prefix is case-insensitive (so we catch sentence-initial
  // "My"); the name part requires a real capital letter so we don't false-
  // positive on common nouns like "my dad always".
  {
    kind: 'named_person',
    regex: /\b[Mm]y\s+(?:late\s+|older\s+|younger\s+|step[- ])?(?:brother|sister|mum|mother|dad|father|uncle|aunt|nan|nana|nanna|nanny|gran|granny|grandma|grandmother|grandpa|grandfather|son|daughter|wife|husband|partner|girlfriend|boyfriend|cousin|nephew|niece|mate|friend|colleague|coworker|boss|neighbour|neighbor)\s+(?:named\s+)?(?:[A-Z][a-z]{2,}|"[^"]+")/g,
  },
  // Place-tied "I went to <Proper Noun>": "I went to Brisbane", "I moved to Bangkok"
  // Case-insensitive on the verb, but the placename capture still requires
  // an initial capital so we don't match common nouns.
  {
    kind: 'place_visited',
    regex: /\bI\s+(?:went|flew|drove|moved|relocated|travelled|traveled|lived|stayed)\s+(?:to|in|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
  },
  // Relationship terms: "my dad", "my brother", "my partner" — even without a
  // named person attached. These need citation too because "my dad is X" is a
  // first-person factual claim about a relationship.
  {
    kind: 'relationship',
    regex: /\b[Mm]y\s+(?:late\s+|older\s+|younger\s+|step[- ])?(?:brother|sister|mum|mother|dad|father|uncle|aunt|nan|nana|nanna|nanny|gran|granny|grandma|grandmother|grandpa|grandfather|son|daughter|wife|husband|partner|girlfriend|boyfriend|cousin|nephew|niece)\b/g,
  },
];

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Scan a draft for first-person factual claims and validate that each is
 * followed by a [fact:N] marker pointing to a valid index in idea.facts.
 */
export function checkFactCitations(
  draft: string,
  idea: Pick<IdeaBrief, 'facts'>,
): FactCitationResult {
  const violations: FactCitationViolation[] = [];

  // First, collect every [fact:N] marker offset so we can match claims to them.
  const markerRegex = /\[fact:(\d+)\]/g;
  const markers: { index: number; offset: number; valid: boolean }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = markerRegex.exec(draft)) !== null) {
    const idx = parseInt(mm[1]!, 10);
    const valid = idx >= 0 && idx < idea.facts.length;
    markers.push({ index: idx, offset: mm.index, valid });
    if (!valid) {
      violations.push({
        kind: 'invalid_index',
        text: mm[0]!,
        offset: mm.index,
        reason: `[fact:${idx}] references out-of-range index (facts array has ${idea.facts.length} entries: valid indices are 0..${idea.facts.length - 1}).`,
        citedIndex: idx,
      });
    }
  }

  let totalClaims = 0;
  let citedClaims = 0;

  // Each pattern is scanned independently. We dedupe per-offset so the same
  // span isn't double-counted across overlapping patterns (e.g. "my dad John"
  // matches both `named_person` and `relationship`). Named-person wins because
  // it's the more specific pattern.
  const seenOffsets = new Set<number>();

  for (const pat of PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(draft)) !== null) {
      const offset = m.index;
      // Skip overlapping match (more-specific pattern already counted it).
      if (seenOffsets.has(offset)) {
        if (m[0].length === 0) pat.regex.lastIndex++;
        continue;
      }
      seenOffsets.add(offset);
      totalClaims++;
      const matchEnd = offset + m[0].length;
      // Look ahead up to MARKER_WINDOW for a [fact:N] marker.
      const window = draft.slice(matchEnd, matchEnd + MARKER_WINDOW);
      const after = window.match(/\[fact:(\d+)\]/);
      if (!after) {
        violations.push({
          kind: pat.kind,
          text: m[0]!,
          offset,
          reason: `First-person factual claim ("${truncate(m[0]!, 60)}") has no [fact:N] citation within ${MARKER_WINDOW} chars.`,
        });
      } else {
        const idx = parseInt(after[1]!, 10);
        if (idx < 0 || idx >= idea.facts.length) {
          // The marker exists but points to an invalid index. This is also
          // logged as an invalid_index violation by the marker sweep above —
          // but we still don't count the claim as cited.
          violations.push({
            kind: pat.kind,
            text: m[0]!,
            offset,
            reason: `First-person factual claim ("${truncate(m[0]!, 60)}") cites [fact:${idx}] which is out of range.`,
          });
        } else {
          citedClaims++;
        }
      }
      if (m[0].length === 0) pat.regex.lastIndex++;
    }
  }

  return {
    totalClaims,
    citedClaims,
    violations,
    citations: markers,
  };
}

/**
 * Strip every `[fact:N]` marker from the draft. Used by the reviser after the
 * final pass so the published essay contains no inline citation noise.
 */
export function stripFactMarkers(draft: string): string {
  // Also collapse stray whitespace immediately before the marker if the marker
  // was preceded by a single space, so we don't leave double spaces.
  return draft.replace(/\s?\[fact:\d+\]/g, '');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}
