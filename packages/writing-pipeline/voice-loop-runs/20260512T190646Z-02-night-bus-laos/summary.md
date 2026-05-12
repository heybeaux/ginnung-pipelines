# Voice loop summary — 02-night-bus-laos

## Idea

> The night bus from Vientiane to Luang Prabang. 10 hours through the mountains in a "VIP sleeper" which was a converted regular bus where they'd bolted bunk beds in pairs of two strangers. I was 6'2", sharing a 5'10" bunk with a 5'5" French backpacker called Sophie who I had met 20 minutes earlier in the queue. Neither of us spoke the other's language well enough to negotiate the awkward parts. The road was switchback after switchback, every 15 minutes the driver took a corner like he was personally angry at it. I want to write about the absurd intimacy of sharing a bed with a stranger on a moving vehicle in a country where neither of you can read the signs out the window. About laughing in the dark because there's nothing else to do. About the moment the bus stopped at 3am and we all got out to pee on the side of a mountain in the rain and somehow that was the most awake I'd felt in years.

## Scores

| Stage | voice_match | slop_total | slop/kchar | issues |
|---|---|---|---|---|
| draft v1 | 0.246 | 2 | 0.29 | 9 |
| revised v2 | 0.352 | 0 | 0 | 6 |

Revision decision: **accepted** — Accepted revision: composite score went from 0.217 to 0.352 (delta +0.135).

## Costs and cache

| Stage | input | output | cache_create | cache_read | est. $ |
|---|---|---|---|---|---|
| draft | 246 | 1702 | 0 | 6453 | 0.0470 |
| revise | 2751 | 1551 | 0 | 6453 | 0.0558 |
| **total** | | | | | **0.1028** |

## Top issues from v1 critique

- **[high] fingerprint_drift** — mean_words_per_sentence is 4.34 below corpus baseline (observed 8.55, baseline 12.89).
- **[high] fingerprint_drift** — direct_address_per_1000_words is 8.79 above corpus baseline (observed 16.81, baseline 8.02).
- **[high] fingerprint_drift** — parentheticals_per_1000_words is 1.91 above corpus baseline (observed 4, baseline 2.09).
- **[high] fingerprint_drift** — aussie_markers_per_1000_words is 2.17 above corpus baseline (observed 4, baseline 1.83).
- **[high] fingerprint_drift** — profanity_per_1000_words is 1.63 above corpus baseline (observed 3.2, baseline 1.57).
- **[medium] fingerprint_drift** — std_dev_words_per_sentence is 2.08 below corpus baseline (observed 7.26, baseline 9.34).
- **[medium] fingerprint_drift** — mid_sentence_ellipses_per_1000_words is 1.79 above corpus baseline (observed 6.41, baseline 4.62).
- **[low] slop_pattern** — Anti-slop pattern "rule-of-three" fired on: "in the rain, pissing into the dark, and I thought."
- **[low] slop_pattern** — Anti-slop pattern "rule-of-three" fired on: "hours in a space too small for one person, let alone two, and then went our sep…"

## Fingerprint drift (v1 → v2)

| feature | v1 obs | v2 obs | baseline | v2 drift |
|---|---|---|---|---|
| mean_words_per_sentence | 8.55 | 10.22 | 12.89 | 0.89 |
| std_dev_words_per_sentence | 7.26 | 9.44 | 9.34 | 0.033 |
| mean_sentences_per_paragraph | 5.21 | 4.38 | 5.61 | 0.615 |
| direct_address_per_1000_words | 16.81 | 13.73 | 8.02 | 1 |
| parentheticals_per_1000_words | 4 | 0.86 | 2.09 | 0.82 |
| mid_sentence_ellipses_per_1000_words | 6.41 | 0 | 4.62 | 1 |
| em_dash_interruptions_per_1000_words | 0 | 0 | 0 | 0 |
| aussie_markers_per_1000_words | 4 | 4.29 | 1.83 | 1 |
| profanity_per_1000_words | 3.2 | 0.86 | 1.57 | 0.473 |

