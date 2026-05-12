# Voice loop summary — 01-power-stretching

## Idea

> The first time I did power stretching at the academy in China. I'd been training for two weeks, thought I was getting fit, and then a senior student calmly walked me into a room where two other students bent me into shapes I didn't think a human body could hold. I cried. Not figuratively. Actual tears, while a translator very politely told me I needed to relax my breathing. I want to write about that session — the room, the smell of the mats, the senior student who I'll just call Brother Tom, the moment I realised my idea of "fit" was a children's birthday party version of the real thing. The piece should land somewhere between funny and humbling. The takeaway, if there is one, isn't "push through the pain" — it's that I had no idea what my body could do until someone else made the decision for me.

## Scores

| Stage | voice_match | slop_total | slop/kchar | issues |
|---|---|---|---|---|
| draft v1 | 0.491 | 2 | 0.305 | 6 |
| revised v2 | 0.599 | 1 | 0.153 | 3 |

Revision decision: **accepted** — Accepted revision: composite score went from 0.461 to 0.584 (delta +0.123).

## Costs and cache

| Stage | input | output | cache_create | cache_read | est. $ |
|---|---|---|---|---|---|
| draft | 205 | 1560 | 0 | 6453 | 0.0433 |
| revise | 2376 | 1555 | 0 | 6453 | 0.0540 |
| **total** | | | | | **0.0972** |

## Top issues from v1 critique

- **[high] fingerprint_drift** — mean_words_per_sentence is 3.8 below corpus baseline (observed 9.09, baseline 12.89).
- **[high] fingerprint_drift** — aussie_markers_per_1000_words is 2.37 above corpus baseline (observed 4.2, baseline 1.83).
- **[high] fingerprint_drift** — profanity_per_1000_words is 1.57 below corpus baseline (observed 0, baseline 1.57).
- **[medium] fingerprint_drift** — parentheticals_per_1000_words is 1.25 below corpus baseline (observed 0.84, baseline 2.09).
- **[low] slop_pattern** — Anti-slop pattern "rule-of-three" fired on: "odd years, doing nothing, and were now being evicted against their will."
- **[low] slop_pattern** — Anti-slop pattern "rule-of-three" fired on: "They did this every day, to themselves and to each other, and probably had sinc…"

## Fingerprint drift (v1 → v2)

| feature | v1 obs | v2 obs | baseline | v2 drift |
|---|---|---|---|---|
| mean_words_per_sentence | 9.09 | 9.52 | 12.89 | 1 |
| std_dev_words_per_sentence | 9.04 | 9.56 | 9.34 | 0.073 |
| mean_sentences_per_paragraph | 5.04 | 4.81 | 5.61 | 0.4 |
| direct_address_per_1000_words | 7.56 | 7.56 | 8.02 | 0.153 |
| parentheticals_per_1000_words | 0.84 | 2.52 | 2.09 | 0.287 |
| mid_sentence_ellipses_per_1000_words | 5.04 | 4.2 | 4.62 | 0.21 |
| em_dash_interruptions_per_1000_words | 0 | 0 | 0 | 0 |
| aussie_markers_per_1000_words | 4.2 | 4.2 | 1.83 | 1 |
| profanity_per_1000_words | 0 | 0.84 | 1.57 | 0.487 |

