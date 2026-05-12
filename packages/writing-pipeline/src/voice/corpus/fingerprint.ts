// Voice corpus fingerprinting.
//
// Reads normalized corpus files from `voice-corpus/examples/`, computes a
// distributional fingerprint (sentence-length histogram, vocabulary stats,
// rhythm features), and writes `voice-corpus/fingerprint-v1.json` for the
// voice-critic agent to consult.
//
// Scaffold only — implementation lands in a subsequent dispatch.

export interface VoiceFingerprint {
  version: 'v1';
  sourceCount: number;
  sentenceLengthHistogram: number[]; // length-bucket counts
  averageSentenceLength: number;
  vocabularySize: number;
  // TODO: rhythm features, paragraph-shape stats, hapax legomena rate, etc.
}

export function computeFingerprint(_corpusDir: string): VoiceFingerprint {
  // TODO: implement in subsequent dispatch.
  throw new Error('computeFingerprint: not implemented');
}
