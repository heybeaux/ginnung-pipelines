import { describe, expect, it } from 'vitest';
import {
  detectors,
  type PatternCategory,
  type Detection,
} from '../../src/voice/anti-slop/detectors.js';

function findByCategory(category: PatternCategory) {
  const d = detectors.find((x) => x.category === category);
  if (!d) throw new Error(`no detector for ${category}`);
  return d;
}

function spansValid(text: string, detections: Detection[]) {
  for (const d of detections) {
    const slice = text.slice(d.span.start, d.span.end);
    expect(slice).toBe(d.matchedText);
  }
}

describe('detectors catalog', () => {
  it('has exactly 24 detectors with unique categories', () => {
    expect(detectors.length).toBe(24);
    const categories = new Set(detectors.map((d) => d.category));
    expect(categories.size).toBe(24);
  });
});

describe('significance detector', () => {
  const det = findByCategory('significance');
  it('matches the patterns.md before sample', () => {
    const text =
      "The company's rebranding in 2021 marked a pivotal moment in its evolution, reflecting broader shifts in the digital marketplace.";
    const found = det.detect(text);
    expect(found.length).toBeGreaterThan(0);
    spansValid(text, found);
  });
  it('does not match the patterns.md after sample', () => {
    const text =
      'The company rebranded in 2021 to target smaller teams instead of enterprise clients.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('notability detector', () => {
  const det = findByCategory('notability');
  it('matches "major publications" and "industry circles"', () => {
    const text =
      'His work has been featured in major publications and widely discussed across industry circles.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(1);
    spansValid(text, found);
  });
  it('does not match concrete attribution', () => {
    const text =
      'In a 2023 Wired interview, he explained why most AI tools fail after initial adoption.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('participles detector', () => {
  const det = findByCategory('participles');
  it('matches comma + -ing participial phrase', () => {
    const text =
      'The interface uses soft colors, creating a calming experience and reinforcing a sense of simplicity.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThan(0);
    spansValid(text, found);
  });
  it('does not match plain prose without participial clauses', () => {
    const text =
      'The interface uses muted colors. The designer said the goal was to make it feel less overwhelming.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('promotional detector', () => {
  const det = findByCategory('promotional');
  it('matches seamless / intuitive / unlock', () => {
    const text =
      'This powerful platform offers a seamless and intuitive experience, helping teams unlock their full potential.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThan(0);
    spansValid(text, found);
  });
  it('does not match a behavior-focused description', () => {
    const text =
      'The platform handles task tracking and reporting in one place, which cuts down on tool switching.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('weasel-attribution detector', () => {
  const det = findByCategory('weasel-attribution');
  it('matches "Experts believe"', () => {
    const text = 'Experts believe this approach will transform the industry.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThan(0);
    spansValid(text, found);
  });
  it('does not match a named source', () => {
    const text =
      'A 2022 McKinsey report found that companies using this approach reduced costs by 18%.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('outline-filler detector', () => {
  const det = findByCategory('outline-filler');
  it('matches "faces challenges such as"', () => {
    const text =
      'Despite its success, the product faces challenges such as scalability and user retention.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThan(0);
    spansValid(text, found);
  });
  it('does not match a concrete observation', () => {
    const text =
      'The product started losing users after the free tier was removed in late 2022.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('ai-vocabulary detector', () => {
  const det = findByCategory('ai-vocabulary');
  it('matches "Additionally" and "crucial role"', () => {
    const text =
      'Additionally, the system plays a crucial role in optimizing workflows.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(1);
    spansValid(text, found);
  });
  it('does not match plain wording', () => {
    const text =
      'The system also helps teams move faster by automating repetitive steps.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('copula-avoidance detector', () => {
  const det = findByCategory('copula-avoidance');
  it('matches "serves as"', () => {
    const text =
      'The dashboard serves as a central hub for analytics and provides multiple insights.';
    const found = det.detect(text);
    expect(found.length).toBe(1);
    expect(found[0]!.matchedText.toLowerCase()).toBe('serves as');
    spansValid(text, found);
  });
  it('does not match direct copula prose', () => {
    const text =
      'The dashboard is where you see your analytics. It shows traffic, conversions, and trends.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('negative-parallelism detector', () => {
  const det = findByCategory('negative-parallelism');
  it('matches "not just X, but also Y"', () => {
    const text = "It's not just about speed, but also about reliability.";
    const found = det.detect(text);
    expect(found.length).toBe(1);
    spansValid(text, found);
  });
  it('does not match plain contrast', () => {
    const text = 'Speed matters, but reliability is just as important.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('rule-of-three detector', () => {
  const det = findByCategory('rule-of-three');
  it('matches three comma-separated items before a period', () => {
    const text =
      'The tool improves efficiency, reduces costs, and enhances collaboration.';
    const found = det.detect(text);
    expect(found.length).toBe(1);
    spansValid(text, found);
  });
  it('does not match a two-item clause', () => {
    const text =
      'The tool reduces manual work and makes collaboration easier.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('elegant-variation detector (no-op v0)', () => {
  const det = findByCategory('elegant-variation');
  it('always returns []', () => {
    const text =
      'The app loads slowly. The application also crashes under heavy use.';
    expect(det.detect(text)).toEqual([]);
  });
  it('returns [] for clean text too', () => {
    const text = 'The app loads slowly and sometimes crashes under heavy use.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('false-range detector', () => {
  const det = findByCategory('false-range');
  it('matches "everything from X to Y"', () => {
    const text =
      'The platform supports everything from small startups to large enterprises.';
    const found = det.detect(text);
    expect(found.length).toBe(1);
    spansValid(text, found);
  });
  it('does not match concrete examples', () => {
    const text = 'The platform is used by small startups and mid-sized companies.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('em-dash-overuse detector', () => {
  const det = findByCategory('em-dash-overuse');
  it('flags when density > 4 per 1000 chars', () => {
    // 5 em-dashes in ~80 chars => density ~62 per kilo.
    const text =
      'A \u2014 B \u2014 C \u2014 D \u2014 E \u2014 F is a short test string.';
    const found = det.detect(text);
    expect(found.length).toBe(5);
    spansValid(text, found);
  });
  it('does not flag one em-dash in long text', () => {
    // 1 em-dash in ~1200 chars => density well under 4/1000.
    const text =
      'The update improves performance, especially on older devices. '.repeat(
        20,
      ) + 'A small aside \u2014 noted in passing.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('boldface-overuse detector', () => {
  const det = findByCategory('boldface-overuse');
  it('flags 4+ bold runs in a 500-char window', () => {
    const text =
      'It integrates with tools like **Slack**, **Notion**, **Stripe**, and **Linear**.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(4);
    spansValid(text, found);
  });
  it('does not flag 1-3 bold runs', () => {
    const text = 'It uses **Slack** and **Notion** to coordinate.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('inline-header-list detector', () => {
  const det = findByCategory('inline-header-list');
  it('flags markdown list items with bold headers', () => {
    const text = [
      '- **Speed**: Faster load times',
      '- **Security**: Better encryption',
      '- **UX**: Cleaner interface',
    ].join('\n');
    const found = det.detect(text);
    expect(found.length).toBe(3);
    spansValid(text, found);
  });
  it('does not flag plain prose', () => {
    const text =
      'The update improves load times, strengthens encryption, and simplifies the interface.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('title-case-heading detector', () => {
  const det = findByCategory('title-case-heading');
  it('flags title-case markdown headings', () => {
    const text = '## Product Features And Benefits';
    const found = det.detect(text);
    expect(found.length).toBe(1);
    spansValid(text, found);
  });
  it('does not flag sentence-case headings', () => {
    const text = '## Product features and benefits';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('emoji detector', () => {
  const det = findByCategory('emoji');
  it('matches a heart emoji', () => {
    const text = 'Ship it \u{1F680} fast.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThan(0);
    spansValid(text, found);
  });
  it('does not match ASCII-only text', () => {
    const text = 'Ship it fast.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('curly-quotes detector', () => {
  const det = findByCategory('curly-quotes');
  it('matches curly quotes', () => {
    const text = 'He said \u201Chello\u201D and walked away.';
    const found = det.detect(text);
    expect(found.length).toBe(2);
    spansValid(text, found);
  });
  it('does not match straight quotes', () => {
    const text = 'He said "hello" and walked away.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('chatbot-artifact detector', () => {
  const det = findByCategory('chatbot-artifact');
  it('matches "Let me know if you need"', () => {
    const text =
      'Here is a breakdown of the process. Let me know if you need more details!';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(1);
    spansValid(text, found);
  });
  it('does not match a plain breakdown', () => {
    const text =
      'The process has three main steps: data collection, processing, and analysis.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('knowledge-cutoff detector', () => {
  const det = findByCategory('knowledge-cutoff');
  it('matches "While details are limited"', () => {
    const text =
      'While details are limited, the feature appears to have been introduced recently.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(1);
    spansValid(text, found);
  });
  it('does not match a dated fact', () => {
    const text = 'The feature was introduced in March 2024.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('sycophancy detector', () => {
  const det = findByCategory('sycophancy');
  it('matches "Great point" + "insightful observation"', () => {
    const text = 'Great point, this is a really insightful observation.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(2);
    spansValid(text, found);
  });
  it('does not match neutral critique', () => {
    const text =
      'This point highlights a real limitation in the current approach.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('filler-phrase detector', () => {
  const det = findByCategory('filler-phrase');
  it('matches "in order to" and "has the ability to"', () => {
    const text =
      'In order to improve performance, the system has the ability to process data faster.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(2);
    spansValid(text, found);
  });
  it('does not match tightened prose', () => {
    const text = 'To improve performance, the system processes data faster.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('hedging detector', () => {
  const det = findByCategory('hedging');
  it('matches stacked hedges', () => {
    const text = 'This might potentially lead to better outcomes.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(1);
    spansValid(text, found);
  });
  it('does not match a single, decisive hedge', () => {
    const text = 'This may lead to better outcomes.';
    expect(det.detect(text)).toEqual([]);
  });
});

describe('generic-conclusion detector', () => {
  const det = findByCategory('generic-conclusion');
  it('matches "Overall" + "the future looks promising"', () => {
    const text = 'Overall, the outlook is positive and the future looks promising.';
    const found = det.detect(text);
    expect(found.length).toBeGreaterThanOrEqual(2);
    spansValid(text, found);
  });
  it('does not match a concrete next step', () => {
    const text = 'The team plans to launch a mobile version later this year.';
    expect(det.detect(text)).toEqual([]);
  });
});
