# Voice loop summary — 04-buying-a-fridge

## Idea

> I bought a fridge yesterday. That's it. That's the post. Short and punchy. Just the absurd 2-hour ordeal of going to the store, being talked at by a salesman who was definitely on commission, comparing models that were all the same fridge with different stickers, and then the moment I realised I was about to spend more on a fridge than I'd spent on my first car. Some kind of small reflection on adulthood — not a profound one, just a single observation. Probably 200-400 words. Punchline ending.

## Scores

| Stage | voice_match | slop_total | slop/kchar | issues |
|---|---|---|---|---|
| draft v1 | 0.184 | 0 | 0 | 8 |
| revised v2 | 0.345 | 0 | 0 | 6 |

Revision decision: **accepted** — Accepted revision: composite score went from 0.184 to 0.345 (delta +0.161).

## Costs and cache

| Stage | input | output | cache_create | cache_read | est. $ |
|---|---|---|---|---|---|
| draft | 141 | 479 | 6453 | 0 | 0.0530 |
| revise | 1321 | 518 | 0 | 6453 | 0.0228 |
| **total** | | | | | **0.0758** |

## Top issues from v1 critique

- **[high] fingerprint_drift** — mean_words_per_sentence is 5.16 below corpus baseline (observed 7.73, baseline 12.89).
- **[high] fingerprint_drift** — direct_address_per_1000_words is 3.47 above corpus baseline (observed 11.49, baseline 8.02).
- **[high] fingerprint_drift** — parentheticals_per_1000_words is 3.66 above corpus baseline (observed 5.75, baseline 2.09).
- **[high] fingerprint_drift** — aussie_markers_per_1000_words is 3.92 above corpus baseline (observed 5.75, baseline 1.83).
- **[high] fingerprint_drift** — profanity_per_1000_words is 1.57 below corpus baseline (observed 0, baseline 1.57).
- **[medium] fingerprint_drift** — std_dev_words_per_sentence is 2.13 below corpus baseline (observed 7.21, baseline 9.34).
- **[medium] fingerprint_drift** — mean_sentences_per_paragraph is 1.52 below corpus baseline (observed 4.09, baseline 5.61).
- **[medium] fingerprint_drift** — mid_sentence_ellipses_per_1000_words is 1.75 below corpus baseline (observed 2.87, baseline 4.62).

## Fingerprint drift (v1 → v2)

| feature | v1 obs | v2 obs | baseline | v2 drift |
|---|---|---|---|---|
| mean_words_per_sentence | 7.73 | 9.95 | 12.89 | 0.98 |
| std_dev_words_per_sentence | 7.21 | 9.64 | 9.34 | 0.1 |
| mean_sentences_per_paragraph | 4.09 | 3.64 | 5.61 | 0.985 |
| direct_address_per_1000_words | 11.49 | 20.1 | 8.02 | 1 |
| parentheticals_per_1000_words | 5.75 | 0 | 2.09 | 1 |
| mid_sentence_ellipses_per_1000_words | 2.87 | 5.03 | 4.62 | 0.205 |
| em_dash_interruptions_per_1000_words | 0 | 0 | 0 | 0 |
| aussie_markers_per_1000_words | 5.75 | 5.03 | 1.83 | 1 |
| profanity_per_1000_words | 0 | 2.51 | 1.57 | 0.627 |

