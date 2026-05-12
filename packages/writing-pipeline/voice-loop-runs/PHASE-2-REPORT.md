# Phase 2 report — voice loop (draft → critique → revise)

**Run date:** 2026-05-12
**Model:** `anthropic/claude-opus-4.6` via OpenRouter (Anthropic Messages API)
**Loop:** `draftEssay` → `critiqueDraft` → `reviseDraft` → `critiqueDraft`
**Acceptance rule:** keep revision iff `voice_match − slop_per_kilochar/10` improves.

## Per-essay scores

| # | Idea | v1 voice | v2 voice | v1 slop | v2 slop | v1 issues | v2 issues | Accepted? |
|---|---|---|---|---|---|---|---|---|
| 01 | Power stretching at the academy in China | 0.491 | **0.599** | 2 | 1 | 6 | 3 | yes |
| 02 | Night bus from Vientiane to Luang Prabang | 0.246 | **0.352** | 2 | 0 | 9 | 6 | yes |
| 03 | The quiet bit in writing | 0.222 | **0.327** | 0 | 0 | 7 | 6 | yes |
| 04 | Buying a fridge | 0.184 | **0.345** | 0 | 0 | 8 | 6 | yes |
| 05 | Grandfather's voice message | 0.243 | **0.383** | 0 | 0 | 7 | 7 | yes |
| | **mean** | **0.277** | **0.401** | **0.8** | **0.2** | **7.4** | **5.6** | **5/5** |

**Headline:** every revision improved voice_match (mean +0.124). Slop fell or stayed flat in 5/5 runs. Zero API errors. Zero stop-condition triggers.

## Cost actuals (OpenRouter Opus 4.6, USD)

Estimates from `usage.input/output/cache_creation/cache_read` × Opus 4.6 rates. Cache-creation cost dominates the first call of every run; cache-read on the revise call is ~10% of base input rate.

| Essay | Draft | Revise | Total |
|---|---|---|---|
| 04 fridge | $0.0530 | $0.0228 | **$0.0758** |
| 01 power-stretching | $0.0433 | $0.0540 | **$0.0972** |
| 02 night-bus-laos | $0.0470 | $0.0558 | **$0.1028** |
| 03 quiet-bit | $0.0330 | $0.0418 | **$0.0748** |
| 05 grandfather | $0.0302 | $0.0393 | **$0.0696** |
| | | **5-essay total** | **~$0.42** |

(Numbers per the per-run `summary.md` files — these are estimates from `usage.*_tokens` × Opus 4.6 list rates, not the actual OpenRouter `cost` field which is also captured in raw responses if needed.)

Prompt cache is working better than expected: the ~6,500-token system prefix (identity block + 5 exemplars) was cache-created on the *first* drafter call (run 04) and **cache-read on every subsequent call** — including the drafter call of runs 01, 02, 03, 05, not just their reviser calls. The cache survived across runs because we used identical exemplars and identical fingerprint summary text. Net effect: only run 04 paid the cache-creation cost; everything after it ran at ~10% of the prefix's input rate. **This is a real money lever for Phase 3** — pin the system prefix to a versioned hash and reuse it across the whole pipeline.

## Three biggest surprises

### 1. The drafter's `mean_words_per_sentence` is consistently low

Corpus baseline is 12.89 words/sentence; drafts came in between 7.5 and 9.1. The model is over-rotating on "short punchy" because the don't-list and exemplars emphasise variation, and Opus 4.6 reads that as "lean shorter by default". The reviser pulls it up by 1-3 words on every run but never reaches the baseline. **Cause:** the system prompt tells Claude to "vary sentence length aggressively" and "use one-word sentences" without an equal-weight reminder that the *long* end of the distribution is just as load-bearing. Easy fix in Phase 3.

### 2. `direct_address_per_1000_words` runs hot — sometimes 5-7× baseline

Idea 03 ("the quiet bit in writing") clocked 56 direct-address hits per 1,000 words on the draft (baseline 8). The model latched onto "you know that feeling when…" and rode it. The reviser brought it down to 49.7, still way over. The drafter is reading "talk to the reader the way you'd talk to a mate over a beer" as a license rather than a behaviour, and the critic's tolerance of 3/1k is too generous for what's plainly broken voice. Phase 3 should tighten the direct-address tolerance, and possibly add a detector that fires when consecutive sentences both start with "you".

### 3. The deterministic critic catches drift the eye misses, but it overweights `aussie_markers`

Every run hit `aussie_markers_per_1000_words` drift = 1.0 (max) — both above and below baseline. The corpus baseline is 1.83/1k, and the drafter consistently produced 4-7/1k (over-using "whilst", "mate", "bloody"). The current tolerance of 1.0 means even 3/1k caps out the drift score. That's mathematically right but practically the essay reads fine — the markers are pulling the voice towards corpus, not away. **Phase 3 should split this into a signed score** (under-use is bad, modest over-use is fine).

A related surprise: the deterministic, no-LLM critic was actually the cheap and useful part. Every other agentic critic I've prototyped before has been brittle or expensive. This one runs in 15-30ms and produces structured `Issue[]` ready for a UI to render. Good architecture choice — keep going.

## Three Phase 3 recommendations

### 1. Tune the drafter system prompt against observed drift, not assumed slop

The don't-list works — `slop_total` is ~0-2 on every draft. The voice-fingerprint targeting is where the model is missing. Phase 3 should rewrite the identity block to lead with the **fingerprint deltas observed in Phase 2** (low mean sentence length, hot direct-address, parenthetical density volatility) rather than the abstract anti-slop list. Concretely: lead with "Your average sentence is **13 words**. Half your sentences are 11-20 words long. One-word sentences are a 25% minority, not the default."

### 2. Make the reviser two-pass with an explicit budget

Single-pass revision gained +0.12 voice_match on average but no run cracked 0.6 (vs the discrimination floor of 0.703 from Phase 1 corpus posts). A second pass on the issues that remain after pass 1, with a separate cached prefix that includes "here is what you tried last time and how it scored", should push the floor up. Budget: max 2 revisions, total cost ceiling $0.20/essay, cap revisions at the first one that regresses.

### 3. Promote `Issue[]` to a stable public schema and use it as the Phase 3 UI contract

The critic already emits structured diffs (kind, severity, location.line/col/offset, diagnosis, suggestion). Phase 3 will have a UI surface — the diffs map cleanly to inline annotations, much better than rendering a prose critique. Lock the `Issue` type as a public export from `@heybeaux/ginnung-writing-pipeline/voice`, version it, and write the inline-annotation renderer against it. The reviser's `renderIssueChecklist` is also the right starting point for "here's what got fixed" diffs between v1 and v2.

## Files of interest

- `voice-loop-runs/ideas/` — the 5 hand-picked ideas (training, travel, introspective, short-punchy, vulnerable).
- `voice-loop-runs/<timestamp>-<slug>/` — every run's `idea.md`, `draft.md`, `critique-v1.json`, `revised.md`, `critique-v2.json`, `summary.md`.
- `src/voice/drafter.ts` — Opus 4.6 + cached exemplars + anti-slop don't-list.
- `src/voice/critic.ts` — deterministic critic, structured `Issue[]` output.
- `src/voice/reviser.ts` — one-pass revise with composite-score accept/revert.
- `scripts/run-voice-loop.ts` — CLI runner.

**Tests:** 111 passing locally. Critic is deterministic (verified by `JSON.stringify(a) === JSON.stringify(b)` test). Drafter and reviser use mocked SDK; no network calls in tests.
