# Voice loop summary — 03-the-quiet-bit-in-writing

## Idea

> There's a moment in writing that nobody talks about. Not the moment you're typing — that's the loud bit, the productive bit, the bit you put on Instagram. I mean the moment before. The moment when you've decided you're going to write, you've got the coffee, you've got the laptop open, you've got the document with the cursor blinking. And then you don't write. You scroll. You wash a dish. You make a second coffee. You re-read the last thing you wrote. You decide to "research" something. You walk the dog. You're not procrastinating, exactly. You're waiting. For what? You don't know. Something has to land first. Some shape of a sentence, some angle into the idea. And then it does and you go. I want to write about the difference between procrastination and waiting. Why I think the quiet bit is actually the work, and why I've stopped feeling guilty about it.

## Scores

| Stage | voice_match | slop_total | slop/kchar | issues |
|---|---|---|---|---|
| draft v1 | 0.222 | 0 | 0 | 7 |
| revised v2 | 0.327 | 0 | 0 | 6 |

Revision decision: **accepted** — Accepted revision: composite score went from 0.222 to 0.327 (delta +0.105).

## Costs and cache

| Stage | input | output | cache_create | cache_read | est. $ |
|---|---|---|---|---|---|
| draft | 219 | 1147 | 0 | 6453 | 0.0330 |
| revise | 1996 | 1143 | 0 | 6453 | 0.0418 |
| **total** | | | | | **0.0748** |

## Top issues from v1 critique

- **[high] fingerprint_drift** — mean_words_per_sentence is 5.42 below corpus baseline (observed 7.47, baseline 12.89).
- **[high] fingerprint_drift** — std_dev_words_per_sentence is 2.88 below corpus baseline (observed 6.46, baseline 9.34).
- **[high] fingerprint_drift** — direct_address_per_1000_words is 48.5 above corpus baseline (observed 56.52, baseline 8.02).
- **[high] fingerprint_drift** — parentheticals_per_1000_words is 3.68 above corpus baseline (observed 5.77, baseline 2.09).
- **[high] fingerprint_drift** — mid_sentence_ellipses_per_1000_words is 2.3 above corpus baseline (observed 6.92, baseline 4.62).
- **[high] fingerprint_drift** — aussie_markers_per_1000_words is 2.78 above corpus baseline (observed 4.61, baseline 1.83).
- **[high] fingerprint_drift** — profanity_per_1000_words is 1.57 below corpus baseline (observed 0, baseline 1.57).

## Fingerprint drift (v1 → v2)

| feature | v1 obs | v2 obs | baseline | v2 drift |
|---|---|---|---|---|
| mean_words_per_sentence | 7.47 | 10.18 | 12.89 | 0.903 |
| std_dev_words_per_sentence | 6.46 | 10.79 | 9.34 | 0.483 |
| mean_sentences_per_paragraph | 5.52 | 4.14 | 5.61 | 0.735 |
| direct_address_per_1000_words | 56.52 | 49.66 | 8.02 | 1 |
| parentheticals_per_1000_words | 5.77 | 1.13 | 2.09 | 0.64 |
| mid_sentence_ellipses_per_1000_words | 6.92 | 0 | 4.62 | 1 |
| em_dash_interruptions_per_1000_words | 0 | 0 | 0 | 0 |
| aussie_markers_per_1000_words | 4.61 | 6.77 | 1.83 | 1 |
| profanity_per_1000_words | 0 | 1.13 | 1.57 | 0.293 |

