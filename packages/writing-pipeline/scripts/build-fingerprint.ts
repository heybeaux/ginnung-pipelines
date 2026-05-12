// Build voice-corpus/fingerprint-v1.json from voice-corpus/examples/*.
//
// Usage (from the package root):
//   pnpm exec tsx scripts/build-fingerprint.ts
//
// Idempotent; re-running just overwrites the JSON with current corpus stats.

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateFingerprint,
  writeFingerprintToFile,
} from '../src/voice/corpus/fingerprint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const CORPUS_DIR = join(PACKAGE_ROOT, 'voice-corpus', 'examples');
const OUTPUT = join(PACKAGE_ROOT, 'voice-corpus', 'fingerprint-v1.json');

function main(): void {
  // Use a stable timestamp so re-running the script doesn't churn the JSON
  // unless the corpus itself changed. Bump this manually when re-baselining.
  const fp = generateFingerprint(CORPUS_DIR, {
    corpusSourceLabel: 'tumblr-archive-2013-2014-sample',
    generatedAt: '2026-05-12T00:00:00.000Z',
  });
  writeFingerprintToFile(fp, OUTPUT);
  console.log(
    `wrote ${OUTPUT}\n` +
      `  posts: ${fp.total_posts}\n` +
      `  words: ${fp.total_words}\n` +
      `  sentences: ${fp.sentence_distribution.sentence_count}\n` +
      `  mean WPS: ${fp.sentence_distribution.mean_words_per_sentence}\n` +
      `  std-dev WPS: ${fp.sentence_distribution.std_dev_words_per_sentence}\n` +
      `  direct-address / 1k: ${fp.direct_address.direct_address_per_1000_words}\n` +
      `  aussie markers: ${fp.aussie_markers.aussie_marker_count}\n` +
      `  profanity count: ${fp.profanity.count}\n` +
      `  slop perKilochar: ${fp.corpus_slop_score.perKilochar}`,
  );
}

main();
