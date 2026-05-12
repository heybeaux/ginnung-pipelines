# Phase 3 — Ginnung dogfood writing pipeline — run report

**Date**: 2026-05-12
**Idea**: 01HXSXLATTICE400HANDOFFSV1 — *Multi-agent systems fail 87% of the time. I ran 400 real handoffs through a coordination layer. Here's what I found.*
**Spec**: `/Users/beauxwalton/Dev/ops/specs/ginnung-dogfood-writing-pipeline-phase3.md`

## What shipped

Seven tracks delivered against the Phase 3 brief.

- **Track A1 — Fact-citation rule (no_invented_first_person_facts).** `src/orchestration/fact-citation.ts` detects first-person biographical claims (height, age, named-person, place-visited, relationship) and requires an inline `[fact:N]` marker within 80 chars pointing at a valid `IdeaBrief.facts` index. 40 marker validations on the lattice essay; 0 uncited claims, 0 invalid indices.
- **Track A2 — Asymmetric voice critic.** `src/voice/critic.ts` now classifies each feature delta as `under` / `normal` / `over` with per-feature asymmetry policy (aussie-markers / parentheticals / ellipses / profanity are asymmetric; mean-drift zeroes normal-band contributions). Drafter system prompt rewritten to "Australian English is native, not performed... do not insert markers to hit a target."
- **Track B — IdeaBrief schema + capture CLI.** `src/orchestration/idea-brief.ts` + `scripts/capture-idea.ts` validate brief (>=100 chars), non-empty facts, warn on empty forbidden. ULID generator (Crockford base32, 26 chars).
- **Track C — Outline + drafter-v2.** `src/orchestration/outline.ts` generates 5-7 fact-routed beats (opener -> closer, each declaring `uses_facts[]` / `uses_anchors[]`). `src/orchestration/drafter-v2.ts` numbers facts and renders beat-by-beat with the `[fact:N]` rule.
- **Track D — Reviser-v2.** `src/orchestration/reviser-v2.ts` runs up to 2 passes, aborts on voice_match regression or cost-ceiling breach ($0.20/essay default), accumulates "previous attempts and their scores" in the per-pass user message.
- **Track E — Orchestration runner + SonderEvent v2.** `src/orchestration/runner.ts` walks 8 steps with entry+exit events (18 events total per run), L0 invariants on every event, sha256 chain hashing over canonical JSON, NDJSON output. `scripts/run-pipeline.ts` is the CLI; `scripts/verify-chain.ts` walks the NDJSON and rehashes.
- **Track F — Sidecar baseline.** `scripts/run-baseline.ts` — Opus 4.6 with idea brief + self-critique + revise, no Ginnung machinery, $0.40 cap.

## Tests + CI

- **Test files**: 13 (was 11 at Phase 2).
- **Tests**: **167 passing** (1 todo), up from 111 at Phase 2 start. Net +56.
- **New tests**: fact-citation (12), idea-brief (8), outline (9), drafter-v2 (6), reviser-v2 (4), sonder (10), critic-asymmetric (7).
- **typecheck**: clean (`tsc --noEmit`).
- **Phase 2 tests preserved**: 111 + new tests = 156 passing + 1 todo + new (no regressions).

## End-to-end run — lattice idea

Pipeline took the 39-fact / 8-anchor / 8-forbidden IdeaBrief through outline → draft → critique → revise → critique-again → publish.

**Outline**: 6 beats, 100% fact coverage.

**Voice scores**:

| Stage | voice_match | slop/kchar | slop_total | cost |
|---|---|---|---|---|
| draft | 0.389 | 0.11 | 1 | $0.0850 |
| revise pass 1 (accepted) | **0.597** | 0.12 | 1 | $0.0817 |
| revise pass 2 (rejected, regression) | 0.483 | 0.121 | 1 | $0.0790 |

Pass 2 regressed voice_match by 0.114, the two-pass loop correctly aborted with `stopReason=regression` and kept pass 1. The reviser-v2 regression guard worked exactly as specified.

**Fact citation rate (final essay)**: 40 `[fact:N]` markers across the draft. 0 uncited first-person biographical claims. 0 invalid fact indices. Below the 30% invalid-marker stop condition by a wide margin.

**Total cost**: **$0.3367** ($0.0910 outline + $0.0850 draft + $0.1607 revise) vs $0.50 cap.

**Sonder chain**: 18 events (9 entry/exit pairs across idea-capture, research no-op, outline, draft, critique, revise, critique-again, publish, post-publish). `verifyChain` returned `ok=true`, content hashes recomputed cleanly, prev_hash linkage intact end-to-end.

**Baseline (sidecar)**: 2011-word essay, $0.2273, no voice critic / fingerprint / fact-citation / chain. Reads as a competent technical post but slips into 2nd-person ("you'll burn") and inserts hedge phrasing ("agonising over borderline cases"). The Ginnung essay holds first-person singular cleanly per the voice constraint.

## First-impression honest read (against user's own `/Users/beauxwalton/Dev/ops/reports/blog-lattice-thesis-2026-05-08.md`)

The Ginnung output and the user's own draft converge on the same hook — the L2 escalation finding, not the 93% topline. The Ginnung essay is tighter (1268 words vs the user's draft using tables and clear sections), correctly switches to first-person singular per the voice constraint (the user's draft uses "we" plural), and lands the threading-libraries analogy in one paragraph as the structural preferences requested. It's a credible 1200-word version of the same essay, not a 2000-word version — see "things to fix" below.

## Three surprises

1. **The reviser regression-abort fired on the first real essay.** Pass 1 lifted voice_match 0.389 -> 0.597; pass 2 then over-corrected and dropped it back to 0.483. The two-pass cap + regression detector turned out to be load-bearing — without it the pipeline would have shipped a worse essay.
2. **Zero `[fact:N]` violations even though the drafter wasn't asked to cite every claim.** The lattice idea has 39 facts and the drafter naturally wove them in with markers. Track A1's design — "only block when an *uncited* first-person factual claim slips in" rather than mandating cite-everything — turned out to be the right severity bar.
3. **The baseline isn't visibly worse than Ginnung.** It's longer, breathier, more 2nd-personal, and doesn't have a Sonder chain or voice scores. But on prose quality alone, Opus 4.6 with a careful brief is already a competent essayist. The Ginnung win is verifiability and voice-constraint enforcement, not raw prose quality.

## Three things to fix

1. **Drafter undershot the 2000-word target by 37% (1268 actual).** `target_word_count` is rendered as "target 2000 words" with a "±15%" envelope, but the drafter ignored it. Phase 4 should either tighten the prompt ("strict word budget") or add a length-check rule in L0 that flags <85% of target as a fact-violation-class warning.
2. **`compositeScore = voice_match - slop_per_kilochar/10` is too noisy for the "regression abort" decision.** Pass 2 dropped 0.114 on voice_match for an essentially identical slop count; the revisor was caught oscillating between two acceptable revisions. Phase 4: tighten the abort threshold to "regress by >0.05" rather than ">=0", or run 3 passes with a best-of-N policy.
3. **L0 rule outputs leak into the SonderEvent `governance.evidence[]` even when there's no work to do** (idea-capture and post-publish carry a "pass" entry per rule). That's a chatty audit log. Phase 4 should only include `evidence` items for rules that *apply* to the event's step.

## Stop-condition summary

| Condition | Threshold | Actual | Status |
|---|---|---|---|
| Drafter invalid `[fact:N]` markers | >30% | 0 of 40 (0%) | clear |
| Reviser regresses voice_match on first essay | abort if regressed | pass 2 regressed, loop aborted as designed | working as spec |
| L0 false-positive rate | >25% | 0% (no false positives in 18 events) | clear |
| Cost ceiling per essay | $0.50 | $0.3367 | clear |
| Baseline visibly better than Ginnung | n/a (qualitative) | no — baseline is longer + breathier; doesn't enforce voice constraint | clear |

Phase 3 ships. No stop conditions hit.
