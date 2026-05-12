import { describe, expect, it } from 'vitest';
import { scoreSlop } from '../../src/voice/anti-slop/slop-score.js';

describe('scoreSlop', () => {
  it('returns zero for an empty string', () => {
    const s = scoreSlop('');
    expect(s.total).toBe(0);
    expect(s.detections).toEqual([]);
    expect(s.textLength).toBe(0);
    expect(s.perKilochar).toBe(0);
  });

  it('returns near-zero for clean human prose', () => {
    const text =
      'I rebuilt the dashboard last week. The old version was slow on Safari, especially after the 17.4 update — turned out we were re-rendering the chart on every scroll event. New version uses requestIdleCallback. It feels snappy now, but I want to see how it holds up under a real load before I get cocky about it.';
    const s = scoreSlop(text);
    // Some weak detectors may fire (e.g. promotional "rich" doesn't appear here,
    // but the em-dash might be touched). We just want the total to be small.
    expect(s.total).toBeLessThan(5);
  });

  it('produces a high score with multiple categories for pure slop', () => {
    const text = [
      "Overall, the company's rebranding in 2021 marked a pivotal moment in its evolution, reflecting broader shifts in the digital marketplace.",
      'Additionally, the dashboard serves as a central hub for analytics, providing seamless and intuitive insights.',
      "It's not just about speed, but also about reliability.",
      'Experts believe this approach will transform the industry.',
      'The platform supports everything from small startups to large enterprises.',
      'Great point, this is a really insightful observation.',
      'In order to improve performance, the system has the ability to process data faster.',
      'This might potentially lead to better outcomes.',
      'The future looks promising.',
    ].join(' ');
    const s = scoreSlop(text);
    expect(s.total).toBeGreaterThan(15);
    const firedCategories = Object.entries(s.byCategory)
      .filter(([, count]) => count > 0)
      .map(([cat]) => cat);
    expect(firedCategories.length).toBeGreaterThanOrEqual(6);
  });

  it('byCategory counts match the number of detections per category', () => {
    const text =
      'Experts argue that experts believe this is great. Industry reports say the same.';
    const s = scoreSlop(text);
    let summed = 0;
    for (const v of Object.values(s.byCategory)) summed += v;
    expect(summed).toBe(s.detections.length);
  });

  it('perKilochar normalizes total by length', () => {
    const slop =
      'Additionally, the system plays a crucial role in optimizing workflows.';
    const s1 = scoreSlop(slop);
    const s2 = scoreSlop(slop.repeat(3));
    // total scales (roughly) linearly with the slop content; perKilochar should
    // stay roughly stable (within a small tolerance from boundary effects).
    expect(s1.perKilochar).toBeGreaterThan(0);
    expect(s2.perKilochar).toBeGreaterThan(0);
    expect(Math.abs(s1.perKilochar - s2.perKilochar)).toBeLessThan(
      s1.perKilochar * 0.5,
    );
  });

  it('detections are returned in document order', () => {
    const text =
      'Overall, this might potentially work. Experts argue we should ship.';
    const s = scoreSlop(text);
    for (let i = 1; i < s.detections.length; i++) {
      expect(s.detections[i]!.span.start).toBeGreaterThanOrEqual(
        s.detections[i - 1]!.span.start,
      );
    }
  });
});
