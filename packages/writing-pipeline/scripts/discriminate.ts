// Discrimination test: does the v1 fingerprint actually distinguish beaux's
// voice from generic AI slop?
//
// This is the falsifiable claim that anchors the whole voice-critic story.
// We score each sample against the corpus fingerprint using two signal groups:
//
// STRUCTURAL (always measurable; averaged with weight 0.7):
//   - Sentence-length std-dev proximity. Real voice has wide variance (~9);
//     AI prose clusters at ~5-7. We linearly map [3.0, target] -> [0, 1].
//   - Slop-density inverse. Anti-slop detectors firing per kilochar.
//     Real voice averages ~0.2; AI slop usually >3. We map [3.0, 0.5] -> [0, 1].
//
// LEXICAL (bonus signals; averaged with weight 0.3, neutral default = 0.5):
//   - Direct-address density (real voice ~8/1k, AI ~0).
//   - Aussie/British markers (real voice ~1.8/1k, AI ~0).
//   - Profanity rate (real voice >0, AI ~0).
// Each lexical signal: 0.5 when absent (neutral), 1.0 when at-or-above
// corpus rate, scaling linearly between. This stops short prose without
// markers from scoring zero on a clearly-human passage.
//
// Pass criteria (per the brief):
//   - Every user-prose sample scores > 0.5
//   - Every AI-slop sample scores < 0.3
//   - The gap between min(user) and max(AI) is clear (positive)
//
// If any of those fail the script exits non-zero and prints a diagnostic.

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countWords,
  computeAussieMarkers,
  computeDirectAddress,
  computeProfanity,
  computeSentenceDistribution,
  type VoiceFingerprint,
} from '../src/voice/corpus/fingerprint.js';
import { scoreSlop } from '../src/voice/anti-slop/slop-score.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const FINGERPRINT_PATH = join(PACKAGE_ROOT, 'voice-corpus', 'fingerprint-v1.json');

// ---------------------------------------------------------------------------
// Test samples
// ---------------------------------------------------------------------------

// Real beaux prose — drawn from the corpus but trimmed to ~150-200 word
// chunks so we're testing on excerpts, not the whole posts the fingerprint
// was built from.
const USER_PROSE_SAMPLES: { name: string; text: string }[] = [
  {
    name: 'kung-fu-conditioning',
    text: `Yesterday I was introduced to perhaps one of the most important aspects of martial arts… Conditioning. Our class went to the small training room when we were shown how to stand quietly and meditate in order to build our Chi. After 30 minutes of manipulating this internal energy and "washing my face" with it, we were lead outside to begin conditioning. I was feeling rather relaxed from the meditating session so wasn't really expecting anything too strenuous. I couldn't have been more wrong. I was allocated a tree with another student and told to hit the tree 200 times with each hand in a chopping motion. The first 30-40 hurt a lot. It was about -5 outside and the tree wasn't exactly smooth. He doesn't speak much English, but after showing me how to condition correctly, he said the all-to-familiar words: Go. Harder. Faster.`,
  },
  {
    name: 'baji-fist-beautiful',
    text: `Since I've started training at the academy, one of my Masters, Sifu Liu Ping, has told me that I should learn Baji fist as well as Wing Chun since they compliment each other. Now, initially I came to China to solely focus on Wing Chun, but he had a valid point and I started learning the basics. Today I was taught the first part of the first form in Baji fist. Now, to date I haven't enjoyed the basics because it's so high energy and intense, with lots of stomping and powerful moves. However, I've come this far, why not give it a chance? I let Sifu Liu show me the first part and then he went off and allowed me to practise alone. I did what I was told but didn't really enjoy it, it was much of the same. With 10 minutes left of class I was pretty bored and ready to stop, when my senior instructor, Sifu Guo came over and asked me to go through my form.`,
  },
  {
    name: 'blood-sparring',
    text: `Our second training session on Friday was dedicated to those of us who wished to participate in a sparring session with fellow classmates. Whilst we all learn different styles of Kung Fu, those participating in sparring would be competing using Sanda techniques. As far as I could see it was kick-boxing with a few take-downs included. The only strikes not allowed were elbows and knees. Each match consisted of two 3-minute bouts, separated by another pair of fighters. This allowed rolling fights and breaks for competitors. The first match seemed pretty even at first, however one of the guys appeared to be struggling in the cardio department after the first minute or so. It's really easy to sit back and watch and make judgements about what a competitor should and shouldn't be doing, however I really felt for the guys in the ring. They were trying to deal with so many different stimuli.`,
  },
];

// Generic AI slop — the kind of text the voice-critic agent should reject.
// Notice: medium-length sentences, no direct address, no aussie markers,
// formal vocabulary, hedging, and "it is not X but Y" parallels.
const AI_SLOP_SAMPLES: { name: string; text: string }[] = [
  {
    name: 'generic-blog-intro',
    text: `In today's rapidly evolving technological landscape, it has become increasingly important to consider the multifaceted implications of artificial intelligence on modern society. This is not merely a question of technological advancement but rather a profound exploration of human values and ethical considerations. As we navigate this complex terrain, it is crucial to acknowledge that the path forward requires careful deliberation and thoughtful engagement with diverse perspectives. Many experts have noted that the integration of these systems into daily life presents both unprecedented opportunities and significant challenges. The transformative potential of these innovations cannot be overstated, and stakeholders across various sectors must work collaboratively to ensure that progress is both sustainable and equitable. Furthermore, the role of governance frameworks in shaping outcomes deserves particular attention. Ultimately, the journey ahead will require a nuanced understanding of the interplay between technology, policy, and human agency.`,
  },
  {
    name: 'corporate-thought-leadership',
    text: `Leveraging cutting-edge methodologies, organizations are increasingly recognizing the value of holistic approaches to digital transformation. The synergy between strategic vision and operational excellence creates a robust foundation for sustainable growth. It is essential to highlight that this paradigm shift represents not just a technological evolution but a fundamental reimagining of business processes. By embracing data-driven insights and fostering a culture of continuous improvement, enterprises can unlock significant value across their operations. The implications extend beyond mere efficiency gains to encompass broader considerations of customer experience and stakeholder engagement. Moreover, the integration of advanced analytics with human expertise yields outcomes that neither could achieve in isolation. As industry leaders chart their course through this dynamic environment, the importance of agile thinking and adaptive strategy cannot be understated.`,
  },
  {
    name: 'ai-summary-conclusion',
    text: `In conclusion, the analysis presented here underscores several key takeaways. First, the data clearly demonstrates a positive correlation between the variables under consideration. Second, while limitations exist within the current methodology, the findings remain robust under various sensitivity tests. Third, future research should explore the underlying mechanisms in greater depth. It is worth noting that these results align with existing literature on the subject. The implications for both theory and practice are significant. Practitioners may find these insights particularly valuable when designing interventions. Researchers, on the other hand, may wish to extend this work through longitudinal studies. Ultimately, this work contributes to a growing body of evidence supporting the proposed framework. The path forward involves continued investigation and rigorous validation.`,
  },
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface SampleScore {
  name: string;
  totalWords: number;
  structural: {
    sentence_std_dev: number;
    slop_inverse: number;
  };
  lexical: {
    direct_address: number;
    aussie_marker: number;
    profanity: number;
  };
  signal_values: {
    sentence_std_dev: number;
    direct_address_per_1k: number;
    aussie_markers_per_1k: number;
    profanity_per_1k: number;
    slop_per_kilochar: number;
  };
  voice_match: number;
}

/**
 * Linear scoring of a positive value against a target. Returns 0 at `floor`,
 * 1.0 at `target` and above. Used for structural signals where the floor
 * (zero variance / heavy slop) is unambiguously bad.
 */
function linearScore(value: number, floor: number, target: number): number {
  if (target <= floor) return 0;
  if (value <= floor) return 0;
  if (value >= target) return 1;
  return (value - floor) / (target - floor);
}

/**
 * Slop-inverse: real prose lands at perKilochar ~0.2 (corpus avg 0.16).
 * Generic AI slop sits at 3+. We map [3.0, 0.5] -> [0, 1] linearly so
 * 0.5/kchar still scores 1.0 (the bar for "clean enough"), and 3+/kchar
 * scores 0 (clearly slop).
 */
function slopInverseScore(perKilochar: number): number {
  if (perKilochar <= 0.5) return 1;
  if (perKilochar >= 3.0) return 0;
  return 1 - (perKilochar - 0.5) / (3.0 - 0.5);
}

/**
 * Lexical-bonus signal. When absent (value=0) we return 0.5 — neutral,
 * neither positive nor negative — because short prose may legitimately
 * lack the marker. When present at corpus rate we return 1.0. Linear in
 * between, capped at 1.0.
 */
function lexicalBonus(value: number, target: number): number {
  if (target <= 0) return 0.5;
  if (value <= 0) return 0.5;
  if (value >= target) return 1;
  // Map (0, target] -> (0.5, 1.0].
  return 0.5 + 0.5 * (value / target);
}

function scoreSample(
  name: string,
  text: string,
  fp: VoiceFingerprint,
): SampleScore {
  const totalWords = countWords(text);

  const sentDist = computeSentenceDistribution([text]);
  const da = computeDirectAddress(text, totalWords);
  const am = computeAussieMarkers(text, totalWords);
  const pf = computeProfanity([text], totalWords);
  const slop = scoreSlop(text);

  const targetStdDev = fp.sentence_distribution.std_dev_words_per_sentence;
  const targetDirectAddress = fp.direct_address.direct_address_per_1000_words;
  const targetAussieMarkers = fp.aussie_markers.aussie_markers_per_1000_words;
  const targetProfanity = Math.max(fp.profanity.profanity_per_1000_words, 1.0);

  const structural = {
    sentence_std_dev: linearScore(sentDist.std_dev_words_per_sentence, 3.0, targetStdDev),
    slop_inverse: slopInverseScore(slop.perKilochar),
  };
  const lexical = {
    direct_address: lexicalBonus(da.direct_address_per_1000_words, targetDirectAddress),
    aussie_marker: lexicalBonus(am.aussie_markers_per_1000_words, targetAussieMarkers),
    profanity: lexicalBonus(pf.profanity_per_1000_words, targetProfanity),
  };

  const structuralMean = (structural.sentence_std_dev + structural.slop_inverse) / 2;
  const lexicalMean = (lexical.direct_address + lexical.aussie_marker + lexical.profanity) / 3;
  const voice_match = 0.7 * structuralMean + 0.3 * lexicalMean;

  return {
    name,
    totalWords,
    structural,
    lexical,
    signal_values: {
      sentence_std_dev: sentDist.std_dev_words_per_sentence,
      direct_address_per_1k: da.direct_address_per_1000_words,
      aussie_markers_per_1k: am.aussie_markers_per_1000_words,
      profanity_per_1k: pf.profanity_per_1000_words,
      slop_per_kilochar: slop.perKilochar,
    },
    voice_match,
  };
}

// ---------------------------------------------------------------------------
// Pretty print
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmt(x: number, places = 2): string {
  return x.toFixed(places);
}

function printGroup(label: string, scores: SampleScore[]): void {
  console.log(`\n=== ${label} ===`);
  console.log(
    pad('name', 32) +
      pad('words', 8) +
      pad('std', 7) +
      pad('sl', 7) +
      pad('da', 7) +
      pad('au', 7) +
      pad('pf', 7) +
      'voice',
  );
  for (const s of scores) {
    console.log(
      pad(s.name, 32) +
        pad(`${s.totalWords}`, 8) +
        pad(fmt(s.structural.sentence_std_dev), 7) +
        pad(fmt(s.structural.slop_inverse), 7) +
        pad(fmt(s.lexical.direct_address), 7) +
        pad(fmt(s.lexical.aussie_marker), 7) +
        pad(fmt(s.lexical.profanity), 7) +
        fmt(s.voice_match),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const fpRaw = readFileSync(FINGERPRINT_PATH, 'utf8');
  const fp: VoiceFingerprint = JSON.parse(fpRaw);

  const userScores = USER_PROSE_SAMPLES.map((s) => scoreSample(s.name, s.text, fp));
  const aiScores = AI_SLOP_SAMPLES.map((s) => scoreSample(s.name, s.text, fp));

  printGroup('USER PROSE (must score > 0.5)', userScores);
  printGroup('AI SLOP (must score < 0.3)', aiScores);

  const minUser = Math.min(...userScores.map((s) => s.voice_match));
  const maxAi = Math.max(...aiScores.map((s) => s.voice_match));
  const gap = minUser - maxAi;

  console.log(`\n--- summary ---`);
  console.log(`  min(user voice_match) = ${fmt(minUser, 3)}`);
  console.log(`  max(ai   voice_match) = ${fmt(maxAi, 3)}`);
  console.log(`  gap = ${fmt(gap, 3)}`);

  const userPass = userScores.every((s) => s.voice_match > 0.5);
  const aiPass = aiScores.every((s) => s.voice_match < 0.3);
  const gapPass = gap > 0;

  console.log(`  user > 0.5 ? ${userPass}`);
  console.log(`  ai   < 0.3 ? ${aiPass}`);
  console.log(`  gap  > 0   ? ${gapPass}`);

  if (userPass && aiPass && gapPass) {
    console.log('\nDISCRIMINATION TEST PASSED');
    process.exit(0);
  } else {
    console.log('\nDISCRIMINATION TEST FAILED');
    if (!userPass) {
      const failing = userScores.filter((s) => s.voice_match <= 0.5);
      console.log('  failing user samples:');
      for (const s of failing) console.log(`    - ${s.name}: ${fmt(s.voice_match, 3)}`);
    }
    if (!aiPass) {
      const failing = aiScores.filter((s) => s.voice_match >= 0.3);
      console.log('  failing ai samples:');
      for (const s of failing) console.log(`    - ${s.name}: ${fmt(s.voice_match, 3)}`);
    }
    if (!gapPass) {
      console.log('  no separation between user min and ai max');
    }
    process.exit(1);
  }
}

main();
