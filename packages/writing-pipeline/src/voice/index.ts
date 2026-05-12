export * as antiSlop from './anti-slop/index.js';
export * as corpus from './corpus/index.js';

export { draftEssay, DRAFTER_MODEL, DRAFTER_EXEMPLAR_FILES, buildDrafterSystemPrompt } from './drafter.js';
export type { DraftEssayOptions, DraftEssayResult } from './drafter.js';

export { critiqueDraft } from './critic.js';
export type {
  Critique,
  CritiqueOptions,
  CritiqueScores,
  FeatureDelta,
  FingerprintDelta,
  Issue,
  IssueKind,
  IssueLocation,
  IssueSeverity,
} from './critic.js';

export { reviseDraft, renderIssueChecklist, compositeScore } from './reviser.js';
export type { ReviseDraftOptions, ReviseDraftResult } from './reviser.js';
